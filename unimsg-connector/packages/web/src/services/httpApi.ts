/**
 * 真实后端适配器：实现 MessageApi，对接 packages/server 的 REST 接口。
 *
 * 与 MockApi 的三点差异全部封装在本文件内，页面与 store 零感知：
 *  1. 信封解包：后端统一返回 { ok, data, ... }，这里统一取出 data；
 *  2. 入口鉴权：所有请求携带 Authorization: Bearer <API_TOKEN>；
 *  3. markDone：后端 done 接口只回 {ok:true}（完整消息走 WS 广播），
 *     这里在 POST 成功后重取一次消息返回，双保险兜住状态一致性。
 *
 * 筛选约定：后端 /api/messages 仅支持 platform/status 两个查询参数，
 * type / keyword / onlyReview 在本地补齐（与 AppStore 的本地过滤一致）。
 */
import type {
  ComposeAck, ComposeRequest, IdentityRole, OutboundAttachment, SendCapabilities,
} from '@unimsg/shared';
import type { Platform, TraceEntry, UnifiedMessage } from '../types';
import type {
  AccountInfo,
  AppConfigField,
  AppConfigFieldMap,
  AppConfigPlatformId,
  AppConfigSaveResult,
  AppConfigSource,
  AppConfigUpdate,
  AppConfigView,
  AuthStatus,
  ContactDirectory,
  PublicUser,
  DingtalkLoginOptions,
  DingtalkLoginStart,
  DingtalkPersonalStatus,
  FeishuOAuthStart,
  HealthInfo,
  MailAccountInput,
  MailAccountTestResult,
  MailAccountView,
  MessageApi,
  MessageFilter,
  OnboardingView,
  ReanalyzeResult,
  ReplyAck,
  TraceResult,
} from './api';
import { APP_CONFIG_LLM_FIELD_KEYS, APP_CONFIG_PLATFORM_FIELD_KEYS } from './api';
import { clearSession, getSession } from './session';
import { sortMessages } from '../utils/format';

/** 后端业务错误：携带 HTTP 状态码，便于上层按 401/404 等分类处理 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 这些接口的 401 表示「提交的凭证不对」，不是「登录态失效」：
 * 要原样展示后端文案，且绝不能顺手清掉本地会话。
 */
const CREDENTIAL_CHECK_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/reset-password',
  '/api/auth/password',
] as const;

function isCredentialCheckPath(path: string): boolean {
  return CREDENTIAL_CHECK_PATHS.some((p) => path === p || path.startsWith(`${p}?`));
}

export class HttpApi implements MessageApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    /** 令牌来源：登录后是会话令牌，未登录时回退部署令牌（每次请求实时求值） */
    private readonly token: string | (() => string),
    timeoutMs = 8_000,
  ) {
    // 去掉末尾斜杠，避免拼出 //api 这种双斜杠路径
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    // 请求超时兜底：后端/网络异常时不让 UI 永久 loading
    this.timeoutMs = timeoutMs;
  }

  /** 每次请求实时求值：登录/退出后立刻切换令牌，不需要重建 HttpApi */
  private authToken(): string {
    return typeof this.token === 'function' ? this.token() : this.token;
  }

  async list(filter?: MessageFilter): Promise<UnifiedMessage[]> {
    const params = new URLSearchParams();
    if (filter?.platform) params.set('platform', filter.platform);
    if (filter?.status) params.set('status', filter.status);
    const qs = params.toString();
    const body = await this.request<{ data?: UnifiedMessage[] }>(`/api/messages${qs ? `?${qs}` : ''}`);

    let items = body.data ?? [];
    // 后端不支持的筛选维度在本地补齐
    if (filter?.type) items = items.filter((m) => m.type === filter.type);
    if (filter?.onlyReview) items = items.filter((m) => Boolean(m.needsReview));
    if (filter?.keyword) {
      const k = filter.keyword.trim().toLowerCase();
      items = items.filter(
        (m) =>
          m.body.toLowerCase().includes(k) ||
          m.sender.name.toLowerCase().includes(k) ||
          m.traceId.toLowerCase().includes(k) ||
          (m.intent ?? '').toLowerCase().includes(k),
      );
    }
    return sortMessages(items);
  }

  async get(id: string): Promise<UnifiedMessage | undefined> {
    try {
      const body = await this.request<{ data?: UnifiedMessage }>(`/api/messages/${encodeURIComponent(id)}`);
      return body.data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return undefined;
      throw e;
    }
  }

  async reply(
    id: string,
    text: string,
    attachments?: OutboundAttachment[],
    identity?: IdentityRole,
    quoteTraceId?: string,
  ): Promise<ReplyAck> {
    // 后端返回 202 { ok, message, taskId }，入队即返回，sent/synced 走 WS 推送
    const body = await this.request<{ message: UnifiedMessage; taskId: string }>(
      `/api/messages/${encodeURIComponent(id)}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          // 不传 = 跟随后端平台策略；传了就按这个身份发，不可用时后端回 400 中文错误
          ...(identity ? { identity } : {}),
          // 显式引用：只有用户点了某条消息的「回复」才有
          ...(quoteTraceId ? { quoteTraceId } : {}),
        }),
      },
    );
    return { message: body.message, taskId: body.taskId };
  }

  async compose(req: ComposeRequest): Promise<ComposeAck> {
    const body = await this.request<{ message: UnifiedMessage; taskId: string }>(
      '/api/messages/compose',
      { method: 'POST', body: JSON.stringify(req) },
    );
    return { message: body.message, taskId: body.taskId };
  }

  async capabilities(): Promise<SendCapabilities[]> {
    const body = await this.request<{ data?: SendCapabilities[] }>('/api/capabilities');
    return body.data ?? [];
  }

  /**
   * 注册成功即返回会话令牌（后端省掉"注册完再登录一次"）。
   * 令牌与用户信息由调用方写进 session 存储，这里只透传。
   */
  async register(input: {
    username: string;
    password: string;
    displayName?: string;
    signupCode?: string;
  }): Promise<{ user: PublicUser; token: string; recoveryCode: string }> {
    const body = await this.request<{
      data?: { user: PublicUser; token: string; recoveryCode: string };
    }>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
    if (!body.data) throw new ApiError('注册失败：后端没有返回会话', 500);
    return body.data;
  }

  async login(input: { username: string; password: string }): Promise<{ user: PublicUser; token: string }> {
    const body = await this.request<{ data?: { user: PublicUser; token: string } }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify(input) },
    );
    if (!body.data) throw new ApiError('登录失败：后端没有返回会话', 500);
    return body.data;
  }

  async logout(): Promise<void> {
    await this.request('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
  }

  async me(): Promise<PublicUser | undefined> {
    try {
      const body = await this.request<{ data?: { user: PublicUser } }>('/api/auth/me');
      return body.data?.user;
    } catch {
      return undefined;
    }
  }

  /**
   * 登录态/策略。旧后端没有这个接口 → 按「不要求登录」处理（单机演示零改动）。
   */
  async authStatus(): Promise<AuthStatus> {
    const fallback: AuthStatus = { requireLogin: false, hasUsers: false, machineOwner: null, user: null };
    try {
      const body = await this.request<{ data?: Partial<AuthStatus> }>('/api/auth/status');
      const data = body.data ?? {};
      const reg = (data as { registration?: { open?: unknown; requireCode?: unknown; reason?: unknown } }).registration;
      return {
        requireLogin: Boolean(data.requireLogin),
        hasUsers: Boolean(data.hasUsers),
        ...(reg && typeof reg === 'object'
          ? {
              registration: {
                open: reg.open !== false,
                requireCode: reg.requireCode === true,
                ...(typeof reg.reason === 'string' && reg.reason ? { reason: reg.reason } : {}),
              },
            }
          : {}),
        machineOwner: data.machineOwner ?? null,
        user: data.user ?? null,
      };
    } catch {
      return fallback;
    }
  }

  /** 改口令：后端会作废全部会话，调用方必须紧接着清本地会话并跳登录 */
  async changePassword(input: { oldPassword: string; newPassword: string }): Promise<{ revoked: number }> {
    const body = await this.request<{ data?: { revoked: number } }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return { revoked: body.data?.revoked ?? 0 };
  }

  async logoutAll(): Promise<{ revoked: number }> {
    const body = await this.request<{ data?: { revoked: number } }>('/api/auth/logout-all', {
      method: 'POST',
      body: '{}',
    });
    return { revoked: body.data?.revoked ?? 0 };
  }

  async claimMessages(): Promise<{ claimed: number }> {
    const body = await this.request<{ data?: { claimed: number } }>('/api/messages/claim', {
      method: 'POST',
      body: '{}',
    });
    return { claimed: body.data?.claimed ?? 0 };
  }

  async resetPassword(input: {
    username: string;
    recoveryCode: string;
    newPassword: string;
  }): Promise<{ revoked: number; recoveryCode?: string }> {
    const body = await this.request<{ data?: { revoked: number; recoveryCode?: string } }>(
      '/api/auth/reset-password',
      { method: 'POST', body: JSON.stringify(input) },
    );
    return { revoked: body.data?.revoked ?? 0, ...(body.data?.recoveryCode ? { recoveryCode: body.data.recoveryCode } : {}) };
  }

  /** 发送目标名录：旧后端没有该接口时返回空名录（前端退回「只列已有会话」） */
  async contacts(platform: Platform): Promise<ContactDirectory> {
    try {
      const body = await this.request<{ data?: ContactDirectory }>(
        `/api/contacts?platform=${encodeURIComponent(platform)}`,
      );
      if (body.data) return body.data;
    } catch {
      // 旧后端 / 网络异常：不阻断发送，退回空名录
    }
    return { platform, available: false, items: [] };
  }

  async feishuOAuthStart(): Promise<FeishuOAuthStart> {
    const body = await this.request<{ data?: FeishuOAuthStart }>(
      '/api/feishu/oauth/start',
      { method: 'POST', body: '{}' },
    );
    if (!body.data?.url) throw new ApiError('后端未返回飞书授权地址', 0);
    return body.data;
  }

  async dingtalkPersonalLogin(options: DingtalkLoginOptions = {}): Promise<DingtalkLoginStart> {
    // 后端会立即返回（后台拉起 dws 登录），不会阻塞 HTTP 线程。
    // body 透传 {mode,force}：mode=browser 时后端走本机 loopback OAuth，device 走设备码。
    const body = await this.request<{ data?: DingtalkLoginStart }>(
      '/api/dingtalk/personal/login',
      { method: 'POST', body: JSON.stringify(options) },
    );
    if (!body.data) throw new ApiError('后端未返回钉钉登录指引', 0);
    return body.data;
  }

  async dingtalkPersonalStatus(): Promise<DingtalkPersonalStatus> {
    const body = await this.request<{ data?: DingtalkPersonalStatus }>(
      '/api/dingtalk/personal/status',
    );
    if (!body.data) throw new ApiError('后端未返回钉钉身份状态', 0);
    return body.data;
  }

  async dingtalkPersonalLogout(): Promise<void> {
    await this.request('/api/dingtalk/personal/logout', { method: 'POST', body: '{}' });
  }

  async onboarding(): Promise<OnboardingView> {
    // 后端聚合「连接账号」需要的全部状态；旧后端没有此接口时由页面给出升级提示
    const body = await this.request<{ data?: OnboardingView }>('/api/onboarding');
    if (!body.data || !Array.isArray(body.data.steps)) {
      throw new ApiError('后端未返回授权中心数据（可能需要重启或升级后端）', 0);
    }
    return body.data;
  }

  async mailAccounts(): Promise<MailAccountView[]> {
    const body = await this.request<{ data?: unknown }>('/api/mail/accounts');
    // 兼容 data 直接是数组 / data.accounts 两种后端返回
    return normalizeMailAccounts(body.data);
  }

  async mailAccountTest(input: MailAccountInput): Promise<MailAccountTestResult> {
    // 只做 IMAP / SMTP 登录自检：后端不落盘、不回显授权码。
    // 测试失败时后端返回 200 + {ok:false, imap/smtp 明细}：不能当业务异常丢掉明细。
    const body = await this.request<Record<string, unknown>>(
      '/api/mail/accounts/test',
      { method: 'POST', body: JSON.stringify(input) },
      { allowOkFalse: true },
    );
    return normalizeMailTestResult(body);
  }

  async mailAccountCreate(input: MailAccountInput): Promise<void> {
    await this.request('/api/mail/accounts', { method: 'POST', body: JSON.stringify(input) });
  }

  async mailAccountDelete(key: string): Promise<void> {
    await this.request(`/api/mail/accounts/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }

  async mailAccountVerify(key: string): Promise<MailAccountTestResult> {
    // 对已保存账号跑真实 IMAP/SMTP 自检；失败也是 200 + 明细，不能当业务异常吞掉
    const body = await this.request<Record<string, unknown>>(
      `/api/mail/accounts/${encodeURIComponent(key)}/verify`,
      { method: 'POST', body: '{}' },
      { allowOkFalse: true },
    );
    const outer = asRecord(body) ?? {};
    const payload = asRecord(outer.data) ?? outer;
    const ok = payload.verified === true;
    const details: string[] = [];
    for (const [label, field] of [['IMAP', 'imap'], ['SMTP', 'smtp']] as const) {
      const item = asRecord(payload[field]);
      if (!item) continue;
      const detail = typeof item.detail === 'string' ? item.detail : item.ok === true ? '连接正常' : '连接失败';
      const hint = typeof item.hint === 'string' && item.hint.trim() ? `（${item.hint.trim()}）` : '';
      details.push(`${label}：${detail}${hint}`);
    }
    return {
      ok,
      message: ok
        ? '验证通过：邮箱账号可以使用'
        : (typeof payload.error === 'string' ? payload.error : '验证失败：请检查授权码与 IMAP 设置'),
      ...(details.length > 0 ? { details } : {}),
    };
  }

  async getAppConfig(): Promise<AppConfigView> {
    // 平台应用凭据 / 身份模式 / 重启状态；secret 已在服务端脱敏（前端绝不回显明文）
    const body = await this.request<Record<string, unknown>>('/api/app-config');
    return normalizeAppConfig(body);
  }

  async updateAppConfig(patch: AppConfigUpdate): Promise<AppConfigSaveResult> {
    const body = await this.request<Record<string, unknown>>('/api/app-config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return normalizeAppConfigSaveResult(body);
  }

  /** 重新生成 AI 建议：后端返回完整消息 + 当前 LLM 通道结论，兼容旧后端只回 {ok:true} */
  async reanalyze(id: string): Promise<ReanalyzeResult> {
    const body = await this.request<{
      data?: UnifiedMessage;
      llm?: {
        mode?: string; reason?: string; providerLabel?: string;
        precision?: 'high' | 'low'; confidence?: number;
      };
    }>(`/api/messages/${encodeURIComponent(id)}/reanalyze`, { method: 'POST', body: '{}' });
    const message = body.data ?? await this.get(id);
    if (!message) throw new ApiError('资源不存在', 404);
    return {
      message,
      llm: {
        mode: body.llm?.mode === 'real' ? 'real' : 'mock',
        reason: body.llm?.reason ?? '',
        providerLabel: body.llm?.providerLabel ?? '',
        precision: body.llm?.precision,
        confidence: body.llm?.confidence,
      },
    };
  }

  async markDone(id: string): Promise<UnifiedMessage> {
    // 后端只回 {ok:true}；完整消息同时经 WS 广播，这里重取一次作为兜底（幂等）
    await this.request(`/api/messages/${encodeURIComponent(id)}/done`, { method: 'POST', body: '{}' });
    const updated = await this.get(id);
    if (!updated) throw new ApiError('资源不存在', 404);
    return updated;
  }

  async markTodo(id: string): Promise<UnifiedMessage> {
    const body = await this.request<{ data?: UnifiedMessage }>(
      `/api/messages/${encodeURIComponent(id)}/todo`,
      { method: 'POST', body: '{}' },
    );
    if (body.data) return body.data;
    const updated = await this.get(id);
    if (!updated) throw new ApiError('资源不存在', 404);
    return updated;
  }

  async markRead(id: string, read: boolean): Promise<UnifiedMessage> {
    const action = read ? 'read' : 'unread';
    const body = await this.request<{ data?: UnifiedMessage }>(
      `/api/messages/${encodeURIComponent(id)}/${action}`,
      { method: 'POST', body: '{}' },
    );
    if (body.data) return body.data;
    // 后端未回消息体时重取一次（与 markDone 同样的兜底策略）
    const updated = await this.get(id);
    if (!updated) throw new ApiError('资源不存在', 404);
    return updated;
  }

  async markAllRead(ids?: string[]): Promise<number> {
    const body = await this.request<{ changed?: number }>('/api/messages/read-all', {
      method: 'POST',
      body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
    });
    return body.changed ?? 0;
  }

  async trace(id: string): Promise<TraceResult> {
    const body = await this.request<{ data?: UnifiedMessage[]; log?: TraceEntry[] }>(
      `/api/messages/trace/${encodeURIComponent(id)}`,
    );
    return { data: body.data ?? [], log: body.log ?? [] };
  }

  async accounts(): Promise<AccountInfo[]> {
    const body = await this.request<{ data?: AccountInfo[] }>('/api/accounts');
    return body.data ?? [];
  }

  async health(): Promise<HealthInfo> {
    // /api/health 为公共接口，返回 { ok, ts, received, deduped, sent, failed, dlq, sentMock?, startedAt?, envFile? }
    const body = await this.request<Partial<HealthInfo>>('/api/health');
    return {
      received: body.received ?? 0,
      deduped: body.deduped ?? 0,
      sent: body.sent ?? 0,
      failed: body.failed ?? 0,
      dlq: body.dlq ?? 0,
      // 仅在后端返回时透传：旧后端没有该字段时不要伪装成 0 次模拟发送
      ...(typeof body.sentMock === 'number' ? { sentMock: body.sentMock } : {}),
      // 指标口径与「.env 改动需重启」提示依赖这两个字段；旧后端缺失时前端不提示
      ...(typeof body.startedAt === 'string' ? { startedAt: body.startedAt } : {}),
      ...(body.envFile === null || (body.envFile && typeof body.envFile === 'object')
        ? { envFile: body.envFile as { path: string; mtime: string } | null }
        : {}),
      // 本地配置文件（DATA_DIR/linkhub-config.json）：同样只透传 path+mtime
      ...(body.settingsFile === null || (body.settingsFile && typeof body.settingsFile === 'object')
        ? { settingsFile: body.settingsFile as { path: string; mtime: string } | null }
        : {}),
    };
  }

  /** 统一请求入口：鉴权头 + 超时控制 + 信封解包 + 错误码映射 */
  private async request<T>(
    path: string,
    init?: RequestInit,
    opts: { allowOkFalse?: boolean } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken()}`,
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        throw new ApiError('请求超时，请检查后端服务状态', 0);
      }
      // 网络层异常（后端未启动 / 断网 / CORS 拒绝）
      throw new ApiError('无法连接后端服务，请确认服务已启动', 0);
    } finally {
      clearTimeout(timer);
    }

    const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;

    // 401 有三种含义，不能都笼统说成「API Token 无效」：
    //  - 凭证校验类接口（登录/注册/重置/改口令）的 401 = 用户名或口令不对，
    //    必须原样透出后端文案，且**不能**清本地会话（旧密码填错不该被踢下线）；
    //  - 带着会话令牌的一般接口 401 = 会话过期/被作废（改口令、退出所有设备、重启丢会话），
    //    这时必须清掉本地会话，AuthGate 会立刻把用户送回登录页；
    //  - 没有会话（部署令牌）→ 才是令牌配错了。
    if (res.status === 401) {
      if (isCredentialCheckPath(path)) {
        throw new ApiError(String(body?.error ?? '用户名或口令不正确'), 401);
      }
      if (getSession()) {
        clearSession();
        throw new ApiError('登录已过期，请重新登录', 401);
      }
      throw new ApiError('未授权：API Token 无效或缺失', 401);
    }
    if (res.status === 404) {
      // 账号接口是新增的：旧后端没有这些路由，提示「重启」比「资源不存在」有用得多
      throw new ApiError(
        path.startsWith('/api/auth/') || path === '/api/messages/claim'
          ? '当前后端版本过旧，没有账号接口：请重启 LinkHub Server 后再试'
          : '资源不存在',
        404,
      );
    }
    if (!res.ok) throw new ApiError(String(body?.error ?? `请求失败（HTTP ${res.status}）`), res.status);
    // 少数接口把「自检未通过」放在 200 + ok:false（如邮箱测试）：需要明细的调用方跳过这里
    if (body && body.ok === false && !opts.allowOkFalse) {
      throw new ApiError(String(body.error ?? '业务处理失败'), res.status);
    }

    return (body ?? {}) as T;
  }
}

/** 只把对象转成 Record；数组/原始值返回 undefined，便于宽松兼容后端字段包法 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 兼容两种邮箱账号返回：data 直接是数组，或 data.accounts 数组。
 * 只保留带 key 的条目（source 缺失时按本地文件处理，避免误删 .env 账号）。
 */
export function normalizeMailAccounts(raw: unknown): MailAccountView[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw)?.accounts) ? (asRecord(raw)!.accounts as unknown[]) : [];
  const accounts: MailAccountView[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec || typeof rec.key !== 'string' || rec.key.length === 0) continue;
    const source = rec.source === 'env' ? 'env' : 'file';
    accounts.push({
      key: rec.key,
      ...(typeof rec.label === 'string' ? { label: rec.label } : {}),
      ...(typeof rec.address === 'string' ? { address: rec.address } : {}),
      ...(typeof rec.maskedAddress === 'string' ? { maskedAddress: rec.maskedAddress } : {}),
      ...(typeof rec.addressMasked === 'string' ? { addressMasked: rec.addressMasked } : {}),
      ...(typeof rec.provider === 'string' ? { provider: rec.provider } : {}),
      source,
      ...(typeof rec.removable === 'boolean' ? { removable: rec.removable } : {}),
      ...(typeof rec.verified === 'boolean' ? { verified: rec.verified } : {}),
      ...(typeof rec.verifiedAt === 'string' ? { verifiedAt: rec.verifiedAt } : {}),
      ...(Array.isArray(rec.folders) ? { folders: rec.folders.filter((f): f is string => typeof f === 'string') } : {}),
      ...(rec.mode === 'real' || rec.mode === 'mock' ? { mode: rec.mode } : {}),
    });
  }
  return accounts;
}

/**
 * 兼容邮箱测试结果的几种后端写法：
 *  {ok,message} / {data:{ok,message}} / {data:{ok,imap:{ok,message},smtp:{...}}}
 * 统一成中文可展示结构，前端绝不回显授权码。
 */
export function normalizeMailTestResult(body: unknown): MailAccountTestResult {
  const outer = asRecord(body) ?? {};
  const payload = asRecord(outer.data) ?? outer;
  const ok = payload.ok === true;
  const rawMessage = payload.message ?? payload.reason ?? payload.error;
  const details: string[] = [];
  for (const [label, key] of [['IMAP', 'imap'], ['SMTP', 'smtp']] as const) {
    const check = asRecord(payload[key]) ?? asRecord(asRecord(payload.checks)?.[key]);
    if (!check) continue;
    const itemOk = check.ok === true;
    const itemDetail =
      typeof check.detail === 'string'
        ? check.detail
        : typeof check.message === 'string'
          ? check.message
          : itemOk
            ? '连接正常'
            : '连接失败';
    const itemHint = typeof check.hint === 'string' && check.hint.trim() ? `（${check.hint.trim()}）` : '';
    details.push(`${label}：${itemDetail}${itemHint}`);
  }
  const rawDetails = Array.isArray(payload.details) ? payload.details : Array.isArray(asRecord(payload.checks)?.details) ? (asRecord(payload.checks)!.details as unknown[]) : [];
  for (const item of rawDetails) if (typeof item === 'string' && item.length > 0) details.push(item);
  return {
    ok,
    ...(typeof rawMessage === 'string' && rawMessage.length > 0 ? { message: rawMessage } : {}),
    ...(details.length > 0 ? { details } : {}),
  };
}

// ---------------------------------------------------------------------------
// /api/app-config 归一化（后端字段可能演进：这里把多种包法统一成页面可渲染结构）
// ---------------------------------------------------------------------------

const APP_CONFIG_PLATFORMS: AppConfigPlatformId[] = ['feishu', 'dingtalk', 'wecom'];
const PLATFORM_KEY_PREFIX: Record<AppConfigPlatformId, string[]> = {
  feishu: ['FEISHU_'],
  dingtalk: ['DINGTALK_'],
  wecom: ['WECOM_'],
};

function normalizeConfigSource(value: unknown): AppConfigSource {
  return value === 'env' || value === 'local' || value === 'none' ? value : 'unknown';
}

/** 长字符串不当展示值（避免旧后端把明文 secret 放在 value，页面二次泄露） */
function safeDisplay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 64 ? `${trimmed.slice(0, 8)}…` : trimmed;
}

/** 单个字段归一化：{configured,masked,source,key} / 字符串 / 布尔 / null 都能吃 */
export function normalizeAppConfigField(raw: unknown, key: string): AppConfigField {
  if (raw === null || raw === undefined) {
    return { configured: false, source: 'none', key };
  }
  if (typeof raw === 'string') {
    return {
      configured: raw.trim().length > 0,
      ...(raw.trim() ? { display: safeDisplay(raw) } : {}),
      source: 'unknown',
      key,
    };
  }
  if (typeof raw === 'boolean') {
    return { configured: raw, ...(raw ? { display: '已配置' } : {}), source: 'unknown', key };
  }
  const rec = asRecord(raw);
  if (!rec) return { configured: false, source: 'none', key };
  const display = safeDisplay(rec.masked) ?? safeDisplay(rec.maskedValue) ?? safeDisplay(rec.display);
  const rawValue = rec.value;
  const enumOrBool = typeof rawValue === 'string' || typeof rawValue === 'boolean';
  const configured =
    rec.configured === true || rec.present === true || display !== undefined || enumOrBool;
  return {
    configured,
    ...(configured && display ? { display } : {}),
    ...(configured && !display ? { display: typeof rawValue === 'boolean' ? String(rawValue) : '已配置' } : {}),
    source: normalizeConfigSource(rec.source),
    ...(typeof rawValue === 'string' || typeof rawValue === 'boolean' ? { value: rawValue } : {}),
    ...(typeof rec.envKey === 'string' && rec.envKey
      ? { key: rec.envKey }
      : typeof rec.key === 'string' && rec.key
        ? { key: rec.key }
        : { key }),
  };
}

function normalizeFieldMap(raw: Record<string, unknown> | undefined, keys: string[]): AppConfigFieldMap {
  const out: AppConfigFieldMap = {};
  for (const key of keys) out[key] = normalizeAppConfigField(raw?.[key], key);
  // 后端若返回了额外字段（未来新增），也保留下来供高级展示
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (['missing', 'fields', 'configured', 'label'].includes(key) || key in out) continue;
    out[key] = normalizeAppConfigField(value, key);
  }
  return out;
}

function normalizeFileInfo(value: unknown): { path: string; mtime: string | null } | null | undefined {
  if (value === null) return null;
  const rec = asRecord(value);
  if (!rec || typeof rec.path !== 'string') return undefined;
  // 后端 settingsFile.mtime 可为 null（文件不存在/尚未写入）：保留 path，不要整体丢弃
  return rec.mtime === null || rec.mtime === undefined
    ? { path: rec.path, mtime: null }
    : typeof rec.mtime === 'string'
      ? { path: rec.path, mtime: rec.mtime }
      : undefined;
}

function normalizeMissingList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

/**
 * 兼容后端两种返回：`{ok:true,data:{...}}` 或直接 `{...}`。
 * 平台字段以 `platforms.<id>.<field>` 为主，也兼容顶层 `feishu.appId` 的旧写法。
 */
export function normalizeAppConfig(body: unknown): AppConfigView {
  const outer = asRecord(body) ?? {};
  const payload = asRecord(outer.data) ?? outer;
  const platformsRaw = asRecord(payload.platforms) ?? {};

  const platforms = {} as AppConfigView['platforms'];
  for (const id of APP_CONFIG_PLATFORMS) {
    const group = asRecord(platformsRaw[id]) ?? asRecord(payload[id]) ?? {};
    // 后端最终契约：platforms.<id> = { fields: Record<string, FieldView>, missing: string[], configured }
    const fieldsRaw = asRecord(group.fields) ?? group;
    platforms[id] = {
      fields: normalizeFieldMap(fieldsRaw, APP_CONFIG_PLATFORM_FIELD_KEYS[id]),
      missing: normalizeMissingList(group.missing),
    };
  }

  // 顶层 missing（环境变量名）按前缀分配到平台，供卡片显示「还缺：飞书 App ID」
  for (const key of normalizeMissingList(payload.missing)) {
    const target = APP_CONFIG_PLATFORMS.find((id) =>
      PLATFORM_KEY_PREFIX[id].some((prefix) => key.toUpperCase().startsWith(prefix)),
    );
    if (target && !platforms[target].missing.includes(key)) platforms[target].missing.push(key);
  }

  const identityRaw = asRecord(payload.identity) ?? {};
  const identity: Record<string, string | boolean | undefined> = {};
  const identitySources: Record<string, 'env' | 'local' | 'none'> = {};
  for (const [key, value] of Object.entries(identityRaw)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      identity[key] = value;
    } else {
      const rec = asRecord(value);
      if (rec && typeof rec.mode === 'string') identity[key] = rec.mode;
      else if (rec && (typeof rec.value === 'string' || typeof rec.value === 'boolean')) identity[key] = rec.value;
      else if (rec && typeof rec.identity === 'string') identity[key] = rec.identity;
      if (rec) {
        const source = normalizeConfigSource(rec.source);
        if (source === 'env' || source === 'local' || source === 'none') identitySources[key] = source;
      }
    }
  }

  const modesRaw = asRecord(payload.modes) ?? {};
  const modes: Record<string, string> = {};
  for (const [key, value] of Object.entries(modesRaw)) {
    if (typeof value === 'string') {
      modes[key] = value;
      continue;
    }
    // 后端也可能把 modes 每项也包成 FieldView
    const rec = asRecord(value);
    if (rec && typeof rec.value === 'string') modes[key] = rec.value;
  }

  return {
    identity,
    ...(Object.keys(identitySources).length > 0 ? { identitySources } : {}),
    platforms,
    llm: normalizeFieldMap(asRecord(payload.llm), APP_CONFIG_LLM_FIELD_KEYS),
    modes,
    restartRequired: payload.restartRequired === true,
    ...(normalizeFileInfo(payload.envFile) !== undefined ? { envFile: normalizeFileInfo(payload.envFile) ?? null } : {}),
    ...(normalizeFileInfo(payload.settingsFile) !== undefined
      ? { settingsFile: normalizeFileInfo(payload.settingsFile) ?? null }
      : {}),
  };
}

/** PUT /api/app-config 返回归一化：后端可能外包一层 data */
export function normalizeAppConfigSaveResult(body: unknown): AppConfigSaveResult {
  const outer = asRecord(body) ?? {};
  const payload = asRecord(outer.data) ?? outer;
  const changedKeys = Array.isArray(payload.changedKeys)
    ? payload.changedKeys.filter((key): key is string => typeof key === 'string')
    : [];
  const ignoredByEnv = Array.isArray(payload.ignoredByEnv)
    ? payload.ignoredByEnv.filter((key): key is string => typeof key === 'string')
    : [];
  return {
    saved: payload.saved !== false,
    restartRequired: payload.restartRequired === true,
    ...(payload.hotApplied === true ? { hotApplied: true } : {}),
    ...(ignoredByEnv.length > 0 ? { ignoredByEnv } : {}),
    ...(typeof payload.message === 'string' && payload.message ? { message: payload.message } : {}),
    ...(Array.isArray(payload.warnings) ? { warnings: payload.warnings.filter((w): w is string => typeof w === 'string') } : {}),
    ...(Array.isArray(payload.hotAppliedKeys) ? { hotAppliedKeys: payload.hotAppliedKeys.filter((k): k is string => typeof k === 'string') } : {}),
    changedKeys,
  };
}

