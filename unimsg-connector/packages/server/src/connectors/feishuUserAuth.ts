/**
 * 飞书用户身份授权（user_access_token）。
 *
 * 负责三件事，彼此解耦、可单测：
 *  1. OAuth：生成授权页 URL、用授权码换 token；
 *  2. 令牌生命周期：落盘 / 读取状态 / 临期自动 refresh（refresh_token 单次有效，刷新后立即保存）；
 *  3. 身份判定：FEISHU_SEND_AS=auto|bot|user 下本次到底用机器人还是本人。
 *
 * 安全约定：令牌只存在于服务端令牌文件与内存，绝不通过 API/日志/错误信息下发。
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config';
import type { FeishuSendAs } from '../config/runtime';

/** access_token 临期提前量：距过期不足 60 秒就 refresh，避免边界失效 */
const EXPIRY_SKEW_MS = 60_000;
const TOKEN_TIMEOUT_MS = 10_000;

export type FeishuTokenState = 'none' | 'active' | 'refreshable' | 'expired' | 'invalid';

export interface FeishuUserTokenRecord {
  /** 令牌所属应用；换 App ID 后旧文件视为不可用，避免把 A 应用凭证发给 B */
  appId: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  authorizedAt: string;
}

/** 可安全下发前端/doctor 的状态摘要（不含任何令牌值） */
export interface FeishuUserTokenStatus {
  state: FeishuTokenState;
  /** 令牌文件存在、格式合法且 App ID 匹配 */
  configured: boolean;
  appIdMatches: boolean;
  accessValid: boolean;
  refreshValid: boolean;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  scope?: string;
  reason: string;
}

export interface FeishuIdentityView {
  sendAs: FeishuSendAs;
  effective: 'bot' | 'user';
  tokenState: FeishuTokenState;
  configured: boolean;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  hint: string;
}

export interface FeishuUserAuthOptions {
  appId: string;
  appSecret: string;
  accountsBaseUrl: string;
  tokenFile: string;
  redirectUri: string;
  scopes: string[];
  sendAs: FeishuSendAs;
  /** 单测注入时钟（毫秒） */
  now?: () => number;
  /** 单测注入 fetch，生产不传 */
  fetchImpl?: typeof fetch;
}

export interface FeishuUserAuthErrorDetails {
  /** OAuth token 接口返回的 HTTP 状态；网络错误为空 */
  status?: number;
  /** 飞书错误码（可能是数字 20037，也可能是字符串 invalid_grant） */
  code?: string | number;
}

/** 用户授权相关错误：message 直接给用户看，包含可操作的下一步 */
export class FeishuUserAuthError extends Error {
  readonly details: FeishuUserAuthErrorDetails;

  constructor(message: string, details: FeishuUserAuthErrorDetails = {}) {
    super(message);
    this.name = 'FeishuUserAuthError';
    this.details = details;
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isTokenRecord(value: unknown): value is FeishuUserTokenRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.appId === 'string'
    && typeof v.accessToken === 'string'
    && typeof v.accessExpiresAt === 'number'
    && typeof v.refreshExpiresAt === 'number'
    && (v.refreshToken === undefined || typeof v.refreshToken === 'string');
}

export class FeishuUserAuth {
  private refreshPromise?: Promise<FeishuUserTokenRecord>;
  /**
   * 刷新成功后落盘失败的兜底：refresh_token 已被飞书消费，磁盘上的旧值已作废。
   * 新令牌留在内存里继续服务本次进程，重启前账号页/发送都读它；重启后需重新授权。
   */
  private memoryRecord?: FeishuUserTokenRecord;
  /** 授权代数：重新授权会递增，防止在途 refresh 结果覆盖刚换上的新令牌 */
  private authEpoch = 0;

  constructor(private readonly opts: FeishuUserAuthOptions) {}

  get tokenFile(): string {
    return this.opts.tokenFile;
  }

  get redirectUri(): string {
    return this.opts.redirectUri;
  }

  get scopes(): string[] {
    return [...this.opts.scopes];
  }

  /** 是否具备发起 OAuth 的最低条件（App 凭证） */
  canAuthorize(): boolean {
    return Boolean(this.opts.appId && this.opts.appSecret);
  }

  /** 飞书授权页 URL（state 由调用方生成并保存，用于回调防 CSRF） */
  authorizeUrl(state: string): string {
    if (!this.canAuthorize()) {
      throw new FeishuUserAuthError('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置，无法发起飞书用户授权');
    }
    const url = new URL(`${this.base()}/open-apis/authen/v1/authorize`);
    url.searchParams.set('client_id', this.opts.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.opts.redirectUri);
    url.searchParams.set('scope', this.opts.scopes.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** 用授权码换 user_access_token + refresh_token，并立即落盘 */
  async exchange(code: string): Promise<FeishuUserTokenStatus> {
    if (!this.canAuthorize()) {
      throw new FeishuUserAuthError('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置，无法完成飞书用户授权');
    }
    const payload = await this.requestToken({
      grant_type: 'authorization_code',
      client_id: this.opts.appId,
      client_secret: this.opts.appSecret,
      code,
      redirect_uri: this.opts.redirectUri,
    });
    const record = this.recordFromPayload(payload);
    this.save(record);
    this.memoryRecord = record;
    this.authEpoch += 1;
    return this.status();
  }

  /** 本次发送实际使用哪种身份（auto 的判定规则见下） */
  effectiveIdentity(): 'bot' | 'user' {
    if (this.opts.sendAs === 'bot') return 'bot';
    if (this.opts.sendAs === 'user') return 'user';
    const state = this.status().state;
    // auto：只有「从未连接过」才保持机器人；连接过但过期/文件损坏/换 AppID
    // 一律按本人并严格报错，绝不悄悄换身份（损坏文件也视为已连接过）。
    return state === 'none' ? 'bot' : 'user';
  }

  /** 只读状态（任何调用都不会刷新令牌） */
  status(): FeishuUserTokenStatus {
    const { record, error } = this.load();
    if (!record) {
      return {
        state: error ? 'invalid' : 'none',
        configured: false,
        appIdMatches: false,
        accessValid: false,
        refreshValid: false,
        reason: error ?? '未连接飞书用户身份',
      };
    }
    if (record.appId !== this.opts.appId) {
      return {
        state: 'invalid',
        configured: false,
        appIdMatches: false,
        accessValid: false,
        refreshValid: false,
        reason: '本地令牌属于其他飞书应用，请重新授权',
      };
    }

    const now = this.now();
    const accessValid = record.accessExpiresAt > now + EXPIRY_SKEW_MS;
    // refreshExpiresAt=0 表示飞书未返回 refresh_token_expires_in：按「未知」处理，
    // 先允许继续使用；真过期时 refresh 会失败，再提示重新授权。
    const refreshValid = Boolean(record.refreshToken)
      && (record.refreshExpiresAt === 0 || record.refreshExpiresAt > now + EXPIRY_SKEW_MS);
    const state: FeishuTokenState = accessValid ? 'active' : refreshValid ? 'refreshable' : 'expired';
    return {
      state,
      configured: true,
      appIdMatches: true,
      accessValid,
      refreshValid,
      accessExpiresAt: new Date(record.accessExpiresAt).toISOString(),
      refreshExpiresAt: record.refreshToken && record.refreshExpiresAt > 0
        ? new Date(record.refreshExpiresAt).toISOString()
        : undefined,
      scope: record.scope,
      reason: state === 'active'
        ? '用户授权有效'
        : state === 'refreshable'
          ? 'access_token 已过期，将使用 refresh_token 自动续期'
          : '用户授权已过期，请重新授权',
    };
  }

  /** 账号页 / doctor 用的身份摘要（不含令牌） */
  identityView(): FeishuIdentityView {
    const status = this.status();
    const effective = this.effectiveIdentity();
    return {
      sendAs: this.opts.sendAs,
      effective,
      tokenState: status.state,
      configured: status.configured,
      ...(status.accessExpiresAt ? { accessExpiresAt: status.accessExpiresAt } : {}),
      ...(status.refreshExpiresAt ? { refreshExpiresAt: status.refreshExpiresAt } : {}),
      hint: this.hint(status, effective),
    };
  }

  /**
   * 发送前取有效的 user_access_token：
   *  - 未授权 / 已失效 → 抛可操作错误（不上报令牌内容）；
   *  - 临期 → 用 refresh_token 续期，成功后原子落盘；
   *  - 并发发送共享同一次刷新，避免 refresh_token 被并发消费。
   */
  async accessToken(): Promise<string> {
    const status = this.status();
    if (status.state === 'none') {
      throw new FeishuUserAuthError('飞书用户身份未授权：请在 LinkHub「平台账号」页点飞书卡片的「连接本人账号」完成授权');
    }
    if (status.state === 'invalid') {
      throw new FeishuUserAuthError(`飞书用户身份不可用：${status.reason}`);
    }
    if (status.state === 'expired') {
      throw new FeishuUserAuthError('飞书用户授权已过期：请在 LinkHub「平台账号」页重新授权（点「重新连接」）');
    }

    const record = this.load().record!;
    if (status.state === 'active') return record.accessToken;
    const refreshed = await this.refreshSingleFlight(record);
    return refreshed.accessToken;
  }

  private base(): string {
    return this.opts.accountsBaseUrl.replace(/\/+$/, '');
  }

  private tokenUrl(): string {
    return `${this.base()}/oauth/v3/token`;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private hint(status: FeishuUserTokenStatus, effective: 'bot' | 'user'): string {
    if (this.opts.sendAs === 'bot') return 'FEISHU_SEND_AS=bot：固定以机器人身份发送';
    if (status.state === 'active') return '发送身份：本人（用户授权有效）';
    if (status.state === 'refreshable') return '发送身份：本人（access_token 将自动续期）';
    if (status.state === 'none') {
      return this.opts.sendAs === 'user'
        ? '未连接用户身份，发送会失败；请到「平台账号」页点「连接本人账号」'
        : '未连接用户身份，当前以机器人发送；连接后自动切换为本人';
    }
    if (status.state === 'expired') return '用户授权已过期，请到「平台账号」页重新授权（点「重新连接」）；否则发送会失败';
    return `${status.reason}；当前${effective === 'user' ? '发送会失败' : '以机器人发送'}`;
  }

  private load(): { record?: FeishuUserTokenRecord; error?: string } {
    if (this.memoryRecord) return { record: this.memoryRecord };
    let raw: string;
    try {
      raw = readFileSync(this.opts.tokenFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      return { error: '读取飞书用户令牌文件失败，请重新授权' };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isTokenRecord(parsed)) return { error: '飞书用户令牌文件格式不正确，请重新授权' };
      return { record: parsed };
    } catch {
      return { error: '飞书用户令牌文件不是合法 JSON，请重新授权' };
    }
  }

  private save(record: FeishuUserTokenRecord): void {
    try {
      const dir = dirname(this.opts.tokenFile);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.opts.tokenFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
      try {
        renameSync(tmp, this.opts.tokenFile);
      } catch {
        // Windows 上极少数情况下 rename 覆盖已存在文件会失败：退化为直接写入
        writeFileSync(this.opts.tokenFile, JSON.stringify(record, null, 2), { mode: 0o600 });
        try { unlinkSync(tmp); } catch { /* 临时文件清理失败不影响主流程 */ }
      }
      try { chmodSync(this.opts.tokenFile, 0o600); } catch { /* Windows 无 POSIX 权限，忽略 */ }
    } catch (e) {
      // 不把令牌内容写进错误信息；refresh 路径会捕获保存失败并在内存继续使用新令牌
      throw new FeishuUserAuthError(`保存飞书用户令牌失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private recordFromPayload(payload: any): FeishuUserTokenRecord {
    const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
    if (!accessToken) {
      throw new FeishuUserAuthError('飞书 OAuth 未返回 access_token，请重新授权');
    }
    const expiresIn = positiveNumber(payload?.expires_in, 7200);
    const refreshToken = typeof payload?.refresh_token === 'string' && payload.refresh_token
      ? payload.refresh_token
      : undefined;
    const refreshExpiresIn = refreshToken ? positiveNumber(payload?.refresh_token_expires_in, 0) : 0;
    const now = this.now();
    return {
      appId: this.opts.appId,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof payload?.token_type === 'string' ? { tokenType: payload.token_type } : {}),
      ...(typeof payload?.scope === 'string' ? { scope: payload.scope } : {}),
      accessExpiresAt: now + expiresIn * 1000,
      // 0 = 飞书未返回 refresh_token_expires_in，状态层按「未知」处理
      refreshExpiresAt: refreshToken && refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : 0,
      authorizedAt: new Date(now).toISOString(),
    };
  }

  private async requestToken(params: Record<string, string>): Promise<any> {
    const body = new URLSearchParams(params).toString();
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await fetchImpl(this.tokenUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body,
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (e) {
      throw new FeishuUserAuthError(`连接飞书 OAuth 服务失败：${e instanceof Error ? e.message : String(e)}`);
    }

    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    const payload = json?.data ?? json;
    const code = payload?.code ?? json?.code;
    const error = payload?.error ?? json?.error;
    if (!res.ok || error || (typeof code === 'number' && code !== 0) || !payload?.access_token) {
      const reason = payload?.error_description ?? payload?.msg ?? json?.msg ?? `HTTP ${res.status}`;
      throw new FeishuUserAuthError(
        `飞书 OAuth 令牌请求失败（${String(error ?? code ?? res.status)}）：${String(reason).slice(0, 200)}`,
        {
          status: res.status,
          ...(typeof error === 'string' || typeof error === 'number'
            ? { code: error }
            : typeof code === 'string' || typeof code === 'number' ? { code } : {}),
        },
      );
    }
    return payload;
  }

  private refreshSingleFlight(record: FeishuUserTokenRecord): Promise<FeishuUserTokenRecord> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh(record).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(record: FeishuUserTokenRecord): Promise<FeishuUserTokenRecord> {
    if (!record.refreshToken) {
      throw new FeishuUserAuthError('飞书用户授权已过期：缺少 refresh_token，请重新授权');
    }
    const epoch = this.authEpoch;
    let payload: any;
    try {
      payload = await this.requestToken({
        grant_type: 'refresh_token',
        client_id: this.opts.appId,
        client_secret: this.opts.appSecret,
        refresh_token: record.refreshToken,
      });
    } catch (e) {
      // 在途期间用户重新授权：以新授权为准，旧刷新失败不应把它标记为失效
      if (epoch !== this.authEpoch) {
        const current = this.validCurrentRecord();
        if (current) return current;
      }
      const status = e instanceof FeishuUserAuthError ? e.details.status : undefined;
      const tokenInvalid = e instanceof FeishuUserAuthError
        && (status === 400 || status === 401 || /invalid_grant|refresh_token/i.test(e.message));
      if (tokenInvalid) {
        // 必须落一个「没有 refresh_token」的状态，否则 refreshExpiresAt=0 会让账号页
        // 一直显示「将自动续期」，直到用户发送时才看到失败。
        const dead: FeishuUserTokenRecord = { ...record, refreshToken: undefined, refreshExpiresAt: 0 };
        this.memoryRecord = dead;
        try {
          this.save(dead);
        } catch {
          // 落盘失败也要在内存里标记失效，至少本次进程状态正确
        }
        throw new FeishuUserAuthError('飞书用户授权已失效（refresh_token 无效或已被使用）：请在 LinkHub「平台账号」页重新授权（点「重新连接」）');
      }
      throw e;
    }
    const next = this.recordFromPayload(payload);
    if (epoch !== this.authEpoch) {
      const current = this.validCurrentRecord();
      if (current) return current;
      throw new FeishuUserAuthError('飞书用户身份已在别处重新授权，请重试发送');
    }
    // refresh_token 已被飞书消费，新值必须保留：落盘失败也要在内存里继续用，否则下次必然失效
    this.memoryRecord = next;
    try {
      this.save(next);
    } catch (e) {
      console.warn(
        '[feishu-auth] 令牌已续期但落盘失败，本次进程继续使用内存令牌；重启后需重新授权：',
        e instanceof Error ? e.message : String(e),
      );
    }
    return next;
  }

  /** 当前是否已有一份可用的新令牌（重新授权竞态时优先用它） */
  private validCurrentRecord(): FeishuUserTokenRecord | undefined {
    const current = this.load().record;
    if (current && current.appId === this.opts.appId && current.accessExpiresAt > this.now() + EXPIRY_SKEW_MS) {
      return current;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 生产单例：配置变化时自动重建；单测可直接 new FeishuUserAuth
// ---------------------------------------------------------------------------

let cached: { key: string; auth: FeishuUserAuth } | undefined;

export function feishuUserAuth(): FeishuUserAuth {
  const opts: FeishuUserAuthOptions = {
    appId: config.platforms.feishu.appId,
    appSecret: config.platforms.feishu.appSecret,
    accountsBaseUrl: config.feishuAuth.accountsBaseUrl,
    tokenFile: config.feishuAuth.tokenFile,
    redirectUri: config.feishuAuth.redirectUri,
    scopes: config.feishuAuth.scopes,
    sendAs: config.feishuAuth.sendAs,
  };
  const key = JSON.stringify([
    opts.appId, opts.appSecret, opts.accountsBaseUrl, opts.tokenFile,
    opts.redirectUri, opts.scopes, opts.sendAs,
  ]);
  if (!cached || cached.key !== key) cached = { key, auth: new FeishuUserAuth(opts) };
  return cached.auth;
}

/** 单测/热更新用：清掉单例缓存 */
export function resetFeishuUserAuthCache(): void {
  cached = undefined;
}