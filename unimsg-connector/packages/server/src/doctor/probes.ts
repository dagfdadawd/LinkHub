/**
 * doctor 探针层：一切探测均为【只读】，绝不发送业务消息。
 *
 *  - token 类探针不复用 connectors/real.ts 的 token 获取（它的错误只有 code），
 *    而是自己用 fetch 发结构化请求，把 errcode 映射成中文原因 + 修复建议；
 *  - 邮箱探针复用生产客户端：IMAP 只做 登录 + SELECT + UID SEARCH 立基线（不取正文），
 *    SMTP 用 verifySmtpAuth 只登录 + QUIT（不投递）；地址一律 maskAddress 脱敏；
 *  - 单测通过 stub globalThis.fetch / 注入假实现，绝不联网。
 */
import { Platform, type DeliveryMode, type IdentityPolicy } from '@unimsg/shared';
import type { MailAccount } from '../config';
import {
  DEFAULT_DINGTALK_BASE_URL,
  DEFAULT_FEISHU_BASE_URL,
  MODE_ENV_KEYS,
  PLATFORM_LABELS,
  type ModePolicy,
} from '../config/runtime';
import { fetchNewMails } from '../connectors/mail/imapClient';
import { verifySmtpAuth } from '../connectors/mail/smtpClient';
import { feishuUserAuth } from '../connectors/feishuUserAuth';
import {
  FEISHU_USER_RECEIVE_SCOPES,
  describeFeishuError,
} from '../connectors/feishuUserReceive';
import {
  dingtalkPersonalClient,
  type DwsAuthStatus,
} from '../connectors/dingtalkPersonal';
import { maskAddress } from '../services/account';
import { LlmService } from '../services/llm';
import { probeWechatBridge } from '../services/wechatBridge';
import { MsgStatus } from '@unimsg/shared';
import type { CheckResult } from './report';

/** 单个探针的默认超时（任务要求 8s） */
export const PROBE_TIMEOUT_MS = 8_000;
/**
 * 邮箱探针单独放宽到 25s：IMAP/SMTP 登录要做 DNS + TCP + TLS + 登录多次往返，
 * QQ/163 在风控或网络抖动时 8s 会假超时（真实轮询客户端的连接超时本来就是 20s）。
 */
export const MAIL_PROBE_TIMEOUT_MS = 25_000;
/** 出口 IP 探测的默认超时（附加信息，失败不影响主结论） */
/** 大模型探针超时：真实 flash 实测 P100 约 9.3s，不能用 8s 的通用值 */
export const LLM_PROBE_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// 探针输入
// ---------------------------------------------------------------------------

export interface FeishuProbeInput {
  appId: string;
  appSecret: string;
  baseUrl: string;
}

export interface DingtalkProbeInput {
  appKey: string;
  appSecret: string;
  robotCode: string;
  /** DINGTALK_ROBOT_CODE 是否在 .env 里显式填写（否则由 Client ID 回退而来） */
  robotCodeExplicit: boolean;
  aesToken: string;
  aesKey: string;
  /** 是否开启 Stream 长连接（config.dingtalkStream） */
  stream: boolean;
  /** 固定本人身份且本人接收已启用：此时机器人收信通道是有意关闭，不是故障 */
  personalReceive?: boolean;
  baseUrl: string;
}

export interface MailProbeInput {
  accounts: MailAccount[];
  enabled: boolean;
}

export interface LlmProbeInput {
  /** 是否已具备真实调用条件（config.llm.ready） */
  ready: boolean;
  provider: string;
  model: string;
  endpoint: string;
  apiKey: string;
  minConfidence: number;
  /** 未就绪时的原因（直接写进 SKIP 说明） */
  reason?: string;
}

/** 探针只需要平台运行画像的这几个字段（config.runtime 的条目可直接传入） */
export interface PlatformProbeRuntime {
  policy: ModePolicy;
  mode: DeliveryMode;
  canSend: boolean;
  canReceive: boolean;
  missing: string[];
  warnings: string[];
}

export interface ProbeInput {
  feishu: FeishuProbeInput;
  dingtalk: DingtalkProbeInput;
  mail: MailProbeInput;
  llm: LlmProbeInput;
  runtime: Record<Platform, PlatformProbeRuntime>;
  /** 微信 RPA 桥地址（不传则用 config 里的 bridgeUrl） */
  wechat?: { bridgeUrl?: string };
  /** 本人身份策略（不传则不跑身份探针，保持旧调用方兼容） */
  identity?: IdentityProbeInput;
}

/** 身份探针输入：只含策略与开关，不含任何凭据/令牌 */
export interface IdentityProbeInput {
  feishu: { policy: IdentityPolicy; receiveEnabled: boolean };
  dingtalk: { policy: IdentityPolicy; receiveEnabled: boolean };
}

/** 身份探针注入点（单测用；生产不传，走真实只读实现） */
export interface IdentityProbeDeps {
  feishu?: {
    status?: () => { state: 'none' | 'active' | 'refreshable' | 'expired' | 'invalid'; accessExpiresAt?: string; refreshExpiresAt?: string };
    canAuthorize?: () => boolean;
    accessToken?: () => Promise<string>;
    fetchImpl?: typeof fetch;
  };
  dingtalk?: {
    version?: () => Promise<{ version?: string; error?: string }>;
    authStatus?: () => Promise<DwsAuthStatus>;
    eventListAvailable?: () => Promise<{ ok: boolean; detail: string }>;
    loginCommand?: () => string;
  };
}

export interface RunProbesOptions {
  /** 只探测指定平台（--platform 过滤）；指定时跳过与大模型无关的全局探针 */
  platformFilter?: Platform[];
  timeoutMs?: number;
  /** 邮箱探针超时（默认 25s，比 HTTP 探针宽：要完成 TLS + IMAP/SMTP 登录往返） */
  mailTimeoutMs?: number;
  /** 大模型探针超时（默认 20s，真实 flash P100 实测 9.3s） */
  llmTimeoutMs?: number;
  /** 邮箱探针的注入点：单测传假实现，生产不传（走真实客户端，只读） */
  deps?: MailProbeDeps;
  /** 本人身份探针注入点（单测用） */
  identityDeps?: IdentityProbeDeps;
}

export interface RunProbesResult {
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

export interface ErrorAdvice {
  detail: string;
  hint: string;
}

/** 把任意 Error 压成一行可读文本（会带出 cause 的 message） */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? `（${cause.message}）` : '';
    return `${err.message}${causeMsg}`.trim();
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 取 Node 网络错误码（含 err.cause.code，如 fetch 的 ENOTFOUND） */
function errorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e.code ?? e.cause?.code;
  return typeof code === 'string' ? code : '';
}

function shortError(err: unknown, max = 160): string {
  return errorMessage(err).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 从 URL 或 host:port 里取主机名（用于提示 nslookup / 检查 host） */
export function hostOf(value: string): string {
  const raw = value.trim();
  // 注意：'imap.qq.com:993' 会被 new URL 当成 scheme='imap.qq.com'，必须先判协议前缀
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('//')) {
    try {
      const normalized = raw.startsWith('//') ? `http:${raw}` : raw;
      const host = new URL(normalized).hostname;
      if (host) return host;
    } catch {
      // 不是合法 URL，继续按 host:port 处理
    }
  }
  const stripped = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return stripped.split('/')[0].split(':')[0];
}

function trimBaseUrl(baseUrl: string, fallback: string): string {
  const raw = (baseUrl ?? '').trim();
  return (raw || fallback).replace(/\/+$/, '');
}

function previewBody(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '（空响应体）';
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function httpHint(name: string, baseUrl: string): string {
  return `检查本机网络/代理能否访问 ${baseUrl}；如果企业网络有网关或代理，确认 HTTPS_PROXY 配置正确，或为 ${name} 域名放行。`;
}


// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

interface ProbeHttpResponse {
  status: number;
  ok: boolean;
  data: any;
  text: string;
}

/** 发一个只读 JSON 请求（带 8s AbortSignal 超时），HTTP 状态不抛错，交给调用方映射 */
async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<ProbeHttpResponse> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { status: res.status, ok: res.ok, data, text };
}

// ---------------------------------------------------------------------------
// 网络错误 → 中文建议
// ---------------------------------------------------------------------------

export type NetworkErrorKind = 'timeout' | 'dns' | 'refused' | 'tls' | 'other';

/** 把网络错误归类：超时 / DNS / 拒绝连接 / TLS / 其他 */
export function classifyNetworkError(err: unknown): NetworkErrorKind {
  const text = `${errorCode(err)} ${errorMessage(err)}`.toLowerCase();
  if (/(timeouterror|aborterror|etimedout|timed out|timeout|超时)/.test(text)) return 'timeout';
  if (/(enotfound|eai_again|getaddrinfo|nxdomain|dns)/.test(text)) return 'dns';
  if (/(econnrefused|econnreset|ehostunreach|enetunreach|连接被拒绝|连接已关闭)/.test(text)) return 'refused';
  // 注意不要用裸 'tls'：'STARTTLS' 里也包含 tls，会被误判成握手失败
  if (
    /(wrong version number|ssl3|tls handshake|tls connect|tlsv1|certificate|cert_|self[- ]signed|unable_to_verify|hostname mismatch|证书)/.test(
      text,
    )
  ) {
    return 'tls';
  }
  return 'other';
}

/**
 * 网络类错误的统一中文说明；非网络类错误返回 null（调用方继续按平台错误码映射）。
 * target 可以是 host:port（IMAP/SMTP）或 baseUrl（HTTP 探针）。
 */
export function explainNetworkError(err: unknown, target: string, timeoutMs = PROBE_TIMEOUT_MS): ErrorAdvice | null {
  const kind = classifyNetworkError(err);
  if (kind === 'other') return null;
  const host = hostOf(target);
  switch (kind) {
    case 'timeout':
      return {
        detail: `连接 ${target} 超时（超过 ${Math.round(timeoutMs / 1000)}s）`,
        hint: `网络不通或端口被拦截：确认本机能访问外网；公司网络/防火墙/VPN 可能拦住 ${target}（25/465/587 端口尤其常见）。可先换手机热点或排查代理设置，再重跑 doctor。`,
      };
    case 'dns':
      return {
        detail: `域名解析失败：${target}（${shortError(err)}）`,
        hint: `host 写错或本机 DNS 异常：检查 .env 里的 host 是否为服务商域名（如 imap.qq.com / smtp.qq.com / open.feishu.cn），不要带端口、协议前缀或空格。可用 nslookup ${host} 验证；代理/VPN 的 DNS 也可能导致解析失败。`,
      };
    case 'refused':
      return {
        detail: `连接被拒绝：${target}（${shortError(err)}）`,
        hint: `目标端口未开放或被中间设备拒绝：核对 .env 的 host/端口是否与服务商一致（IMAP 993、SMTP 465/587）；若开了代理/VPN，尝试关闭后重试。`,
      };
    case 'tls':
      return {
        detail: `TLS/证书握手失败：${target}（${shortError(err)}）`,
        hint: `加密方式与端口不匹配：993/465 用隐式 TLS，143/587 用 STARTTLS；若使用公司代理，可能需要导入代理根证书。检查 .env 的 *_IMAP_SECURE / *_SMTP_SECURE 与端口是否匹配。`,
      };
  }
}

/** HTTP 探针异常：网络类走 explainNetworkError，其余给通用提示 */
function explainProbeError(err: unknown, target: string, timeoutMs: number): ErrorAdvice {
  const network = explainNetworkError(err, target, timeoutMs);
  if (network) return network;
  return {
    detail: `请求失败：${shortError(err)}`,
    hint: `检查网络/代理能否访问 ${target}；如果是自建网关，确认 .env 的 *_BASE_URL 指向正确地址。`,
  };
}

// ---------------------------------------------------------------------------
// 飞书
// ---------------------------------------------------------------------------

/** 飞书错误码 → 中文原因 + 修复建议（纯函数，单测覆盖 21001 / 10014 / 超时） */
export function explainFeishuError(code: number | undefined, msg?: string): ErrorAdvice {
  const m = (msg ?? '').trim();
  const suffix = m ? `（${m}）` : '';
  switch (code) {
    case 21001:
      return {
        detail: `飞书返回错误码 21001${suffix}：应用所在租户的策略/合规限制，导致无法获取 tenant_access_token`,
        hint: '21001 是租户级策略，改代码/改 Secret 都救不了：① 该应用必须挂在已完成企业认证的租户下（个人版、未认证租户常被拒）；② 飞书开放平台 → 开发者后台，检查「安全设置 → 租户策略」是否禁止自建应用获取 token，以及「可用成员/部门范围」是否为空；③ 实在开不通就换一个合规租户重新创建自建应用，只需改 .env 的 FEISHU_APP_ID / FEISHU_APP_SECRET。',
      };
    case 10014:
      return {
        detail: `飞书返回错误码 10014${suffix}：App Secret 不正确`,
        hint: '到飞书开放平台 → 应用 → 凭证与基础信息，重新复制 App Secret（注意别复制成 App ID），更新 .env 的 FEISHU_APP_SECRET 后重跑 doctor。如果是刚重置过 Secret，旧值会立刻失效。',
      };
    case 10003:
      return {
        detail: `飞书返回错误码 10003${suffix}：App ID 不存在或应用已被删除`,
        hint: '核对 .env 的 FEISHU_APP_ID 是否与开放平台一致（不要带空格）；确认应用没有被删除、当前账号仍能看到该应用。',
      };
    case 99991663:
      return {
        detail: `飞书返回错误码 99991663${suffix}：tenant_access_token 无效`,
        hint: '更换 App Secret 后旧 token 会失效；重跑 doctor 即可。若持续出现，确认 FEISHU_BASE_URL 与创建应用的数据中心一致（国内 open.feishu.cn / 国际版 open.larksuite.com）。',
      };
    default:
      return {
        detail: `飞书返回错误码 ${code ?? '未知'}${suffix}`,
        hint: '对照飞书开放平台错误码文档排查：https://open.feishu.cn/document/server-docs/getting-started/server-error-codes；同时确认应用已发布版本、已开通所需权限。',
      };
  }
}

/** 飞书探针：POST tenant_access_token/internal（只换 token，不发消息） */
export async function probeFeishuToken(input: FeishuProbeInput, timeoutMs = PROBE_TIMEOUT_MS): Promise<CheckResult> {
  const id = 'feishu:token';
  const title = '飞书 tenant_access_token（应用凭据校验）';
  if (!input.appId || !input.appSecret) {
    return {
      group: Platform.FEISHU,
      id,
      title,
      status: 'FAIL',
      detail: '缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，无法获取 tenant_access_token',
      hint: '到飞书开放平台 → 应用 → 凭证与基础信息，复制 App ID / App Secret 填入 .env（注意别把 App Secret 粘成 App ID）。',
    };
  }
  const baseUrl = trimBaseUrl(input.baseUrl, DEFAULT_FEISHU_BASE_URL);
  const url = `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
  try {
    const r = await requestJson('POST', url, { app_id: input.appId, app_secret: input.appSecret }, timeoutMs);
    const code = Number(r.data?.code);
    if (r.ok && code === 0 && r.data?.tenant_access_token) {
      const expire = Number(r.data?.expire ?? 0) || '未知';
      return {
        group: Platform.FEISHU,
        id,
        title,
        status: 'PASS',
        detail: `tenant_access_token 获取成功（有效期 ${expire}s；只换取 token，未发送任何消息）。`,
      };
    }
    if (Number.isFinite(code) || r.data?.msg) {
      const advice = explainFeishuError(Number.isFinite(code) ? code : undefined, r.data?.msg);
      return { group: Platform.FEISHU, id, title, status: 'FAIL', ...advice };
    }
    return {
      group: Platform.FEISHU,
      id,
      title,
      status: 'FAIL',
      detail: `飞书接口返回 HTTP ${r.status}：${previewBody(r.text)}`,
      hint: httpHint('飞书', baseUrl),
    };
  } catch (e) {
    const advice = explainProbeError(e, `飞书接口 ${hostOf(baseUrl)}`, timeoutMs);
    return { group: Platform.FEISHU, id, title, status: 'FAIL', ...advice };
  }
}

// ---------------------------------------------------------------------------
// 钉钉
// ---------------------------------------------------------------------------

/** 钉钉错误响应 → 中文原因 + 修复建议（纯函数） */
export function explainDingtalkError(payload: {
  code?: unknown;
  errcode?: unknown;
  message?: unknown;
  errmsg?: unknown;
}): ErrorAdvice {
  const code = String(payload.errcode ?? payload.code ?? '').trim();
  const msg = String(payload.errmsg ?? payload.message ?? '').trim();
  const text = `${code} ${msg}`.toLowerCase();
  const suffix = msg ? `（${msg}）` : '';

  if (/invalidauthentication|不合法的clientid|不合法的clientsecret|invalid client/.test(text)) {
    return {
      detail: `钉钉返回认证失败${code ? `（${code}）` : ''}${suffix}：Client ID / Client Secret 不正确`,
      hint: '钉钉开放平台 → 应用 → 凭证与基础信息，重新复制 Client ID / Client Secret（旧版后台叫 AppKey / AppSecret），更新 .env 的 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET 后重跑 doctor。',
    };
  }
  if (/40089/.test(text)) {
    return {
      detail: `钉钉返回错误码 40089${suffix}：不合法的 Client ID / Client Secret`,
      hint: '同上：核对 .env 的 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET；如果是刚重置过 Secret，旧值已失效。',
    };
  }
  if (/40001|40014/.test(text)) {
    return {
      detail: `钉钉返回 access_token 相关错误${code ? `（${code}）` : ''}${suffix}`,
      hint: 'doctor 是直接换新 token，出现该错误通常说明 baseUrl 指向了错误环境或代理改写了响应；核对 DINGTALK_BASE_URL，并确认应用已发布。',
    };
  }
  if (/forbidden|no permission|无权限|权限|scope/.test(text)) {
    return {
      detail: `钉钉返回权限错误${code ? `（${code}）` : ''}${suffix}`,
      hint: '到钉钉开放平台 → 应用 → 权限管理，开通消息/机器人相关权限并重新发布版本；同时确认机器人已添加到目标群/企业。',
    };
  }
  return {
    detail: `钉钉返回错误 ${code || '未知'}${suffix}`,
    hint: '核对 .env 的 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET；确认应用已发布版本、已添加机器人能力；旧版后台变量名为 DINGTALK_APP_KEY / DINGTALK_APP_SECRET（仍兼容）。',
  };
}

/** 钉钉探针：POST /v1.0/oauth2/accessToken（只换 token，不发消息） */
export async function probeDingtalkToken(input: DingtalkProbeInput, timeoutMs = PROBE_TIMEOUT_MS): Promise<CheckResult> {
  const id = 'dingtalk:token';
  const title = '钉钉 accessToken（应用凭据校验）';
  if (!input.appKey || !input.appSecret) {
    return {
      group: Platform.DINGTALK,
      id,
      title,
      status: 'FAIL',
      detail: '缺少 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET，无法获取 accessToken',
      hint: '到钉钉开放平台 → 应用 → 凭证与基础信息，复制 Client ID / Client Secret 填入 .env（旧版后台叫 AppKey / AppSecret，也兼容）。',
    };
  }
  const baseUrl = trimBaseUrl(input.baseUrl, DEFAULT_DINGTALK_BASE_URL);
  const url = `${baseUrl}/v1.0/oauth2/accessToken`;
  try {
    const r = await requestJson('POST', url, { appKey: input.appKey, appSecret: input.appSecret }, timeoutMs);
    const accessToken = r.data?.accessToken;
    const code = r.data?.code;
    if (accessToken && (code === undefined || Number(code) === 0)) {
      const expire = Number(r.data?.expireIn ?? 0) || '未知';
      return {
        group: Platform.DINGTALK,
        id,
        title,
        status: 'PASS',
        detail: `accessToken 获取成功（有效期 ${expire}s；只换取 token，未发送任何消息）。`,
      };
    }
    if (code !== undefined || r.data?.errcode !== undefined || r.data?.message || r.data?.errmsg) {
      const advice = explainDingtalkError(r.data ?? {});
      return { group: Platform.DINGTALK, id, title, status: 'FAIL', ...advice };
    }
    return {
      group: Platform.DINGTALK,
      id,
      title,
      status: 'FAIL',
      detail: `钉钉接口返回 HTTP ${r.status}：${previewBody(r.text)}`,
      hint: httpHint('钉钉', baseUrl),
    };
  } catch (e) {
    const advice = explainProbeError(e, `钉钉接口 ${hostOf(baseUrl)}`, timeoutMs);
    return { group: Platform.DINGTALK, id, title, status: 'FAIL', ...advice };
  }
}

/** 钉钉的收发配置检查（机器人编码 / Stream vs HTTP 回调），纯函数，不联网 */
export function dingtalkConfigChecks(input: DingtalkProbeInput): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1) 机器人编码 = 真实发送能力
  if (input.robotCode.trim()) {
    checks.push({
      group: Platform.DINGTALK,
      id: 'dingtalk:robot',
      title: '钉钉机器人编码（DINGTALK_ROBOT_CODE）',
      status: 'PASS',
      detail: input.robotCodeExplicit
        ? '已显式配置 DINGTALK_ROBOT_CODE：具备真实发送机器人消息的能力。'
        : '未显式配置 DINGTALK_ROBOT_CODE，已自动回退使用 Client ID（企业内部应用通常可用）；若发送报机器人相关错误，请到开放平台复制 RobotCode 填上。',
    });
  } else {
    checks.push({
      group: Platform.DINGTALK,
      id: 'dingtalk:robot',
      title: '钉钉机器人编码（DINGTALK_ROBOT_CODE）',
      status: 'FAIL',
      detail: '未配置 DINGTALK_ROBOT_CODE：无法真实发送机器人消息（只能换 token）。',
      hint: '钉钉开放平台 → 应用 → 应用能力 → 机器人，获取 RobotCode（企业内部应用通常与 Client ID 相同），写入 .env 的 DINGTALK_ROBOT_CODE。',
    });
  }

  // 2) 收消息通道 = Stream 长连接 或 HTTP 回调
  if (input.stream) {
    checks.push({
      group: Platform.DINGTALK,
      id: 'dingtalk:stream',
      title: '钉钉收消息通道（Stream 长连接 / HTTP 回调）',
      status: 'PASS',
      detail:
        'DINGTALK_STREAM=true：使用 Stream 长连接收消息，本机无需公网回调。请确认开放平台「机器人 → 消息接收模式」选的是 Stream，且应用版本已发布。',
    });
  } else if (input.aesToken && input.aesKey) {
    checks.push({
      group: Platform.DINGTALK,
      id: 'dingtalk:stream',
      title: '钉钉收消息通道（Stream 长连接 / HTTP 回调）',
      status: 'PASS',
      detail: '未开启 Stream，但已配置 DINGTALK_AES_TOKEN / DINGTALK_AES_KEY：走 HTTP 回调收消息，需要公网可访问的回调地址。',
    });
  } else if (input.personalReceive) {
    // 仅本人身份部署：机器人 Stream 与 dws 个人事件流是两条独立通道，同时开会重复入库，
    // 因此「关掉机器人收信」是预期配置而不是故障。真实收信能力由下方本人身份探针判定。
    checks.push({
      group: Platform.DINGTALK,
      id: 'dingtalk:stream',
      title: '钉钉收消息通道（本人事件流）',
      status: 'PASS',
      detail:
        'DINGTALK_STREAM=false 且未配置 HTTP 回调：机器人收信通道已按「仅本人身份」有意关闭，收信由 dws 本人事件流承担（与机器人 Stream 同时开会重复入库）。模式表的「收信」列只统计机器人凭据通道，请以「钉钉本人身份（dws CLI）」探针为准。',
      hint: '收不到消息时先确认本人身份探针为 PASS、账号页钉钉本人身份已连接；要恢复机器人接收，把 .env 的 DINGTALK_STREAM 改回 true 并重启后端。',
    });
  } else {
    checks.push({
      group: Platform.DINGTALK,
      id: 'dingtalk:stream',
      title: '钉钉收消息通道（Stream 长连接 / HTTP 回调）',
      status: 'FAIL',
      detail: 'DINGTALK_STREAM=false 且未配置 DINGTALK_AES_TOKEN / DINGTALK_AES_KEY：当前收不到任何消息。',
      hint: '二选一：① 开放平台开启 Stream 长连接（推荐，本机无需公网），设置 .env 的 DINGTALK_STREAM=true；② 配置 HTTP 回调的 AES Token / Key 并暴露公网回调地址。改完都要重新发布应用版本。',
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 邮箱（IMAP 只 SEARCH 立基线 / SMTP 只登录 QUIT）
// ---------------------------------------------------------------------------

/** 邮箱探针注入点（单测传假实现；生产不传） */
export interface MailProbeDeps {
  fetchNewMails?: typeof fetchNewMails;
  verifySmtpAuth?: typeof verifySmtpAuth;
}

type ImapTarget = Pick<MailAccount, 'key' | 'address' | 'imapHost' | 'imapPort'>;
type SmtpTarget = Pick<MailAccount, 'key' | 'address' | 'smtpHost' | 'smtpPort'>;

function mailEnvPrefix(key: string): string {
  return `MAIL_${key.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

/** IMAP 错误 → 中文原因 + 修复建议（Unsafe Login / 登录失败 / 网络） */
export function explainImapError(err: unknown, account: ImapTarget): ErrorAdvice {
  const raw = errorMessage(err);
  const target = `${account.imapHost}:${account.imapPort}`;
  const masked = maskAddress(account.address);
  const prefix = mailEnvPrefix(account.key);

  const network = explainNetworkError(err, target);
  if (network) return network;

  if (/unsafe\s*login/i.test(raw)) {
    return {
      detail: `IMAP 登录被服务端风控拒绝（Unsafe Login）：${shortError(err)}`,
      hint: `网易/QQ 会把不报客户端身份的连接判为 Unsafe Login：① 确认 ${prefix}_AUTH_CODE 是网页端生成的「授权码」而不是登录密码；② 到邮箱网页版「设置 → POP3/SMTP/IMAP」重新开启 IMAP 服务并生成授权码；③ 163/126 如有「第三方客户端登录限制 / 安全登录」需按提示关闭或改用授权码；④ 本项目的 IMAP 客户端已自动补齐 ID 命令，若仍报错通常是服务商风控，换网络重试或联系邮箱服务商。`,
    };
  }
  if (/登录失败|authenticationfailed|login failed|invalid credentials|auth/i.test(raw)) {
    return {
      detail: `IMAP 登录失败（${masked} @ ${target}）：${shortError(err)}`,
      hint: `99% 是授权码问题：① 检查 .env 的 ${prefix}_AUTH_CODE 是否为邮箱网页端生成的授权码（通常 16 位，不是登录密码，别带空格）；② QQ 邮箱：设置 → 账号与安全 → 安全设置 → POP3/IMAP/SMTP 服务 → 开启并生成授权码；③ 163/126：设置 → POP3/SMTP/IMAP → 开启服务并新增授权密码（只显示一次）；④ 刚改过密码/授权码时以最新授权码为准。`,
    };
  }
  if (/选择目录|select/i.test(raw)) {
    return {
      detail: `IMAP 登录成功但选择目录失败（${masked} @ ${target}）：${shortError(err)}`,
      hint: `检查 .env 的 ${prefix}_FOLDERS 目录名：QQ/163 收件箱用 INBOX、垃圾箱用 Junk（区分大小写、不要带引号）；多个目录用逗号分隔。`,
    };
  }
  if (/检索|search/i.test(raw)) {
    return {
      detail: `IMAP 检索失败（${masked} @ ${target}）：${shortError(err)}`,
      hint: '服务端不支持 UID SEARCH 或连接被中断：换网络重试；如果邮箱服务商有安全限制，先在网页端确认 IMAP 服务正常。',
    };
  }
  if (/STARTTLS/i.test(raw)) {
    return {
      detail: `IMAP STARTTLS 升级失败（${masked} @ ${target}）：${shortError(err)}`,
      hint: `该端口不支持 STARTTLS：优先改用 993 隐式 TLS（设置 ${prefix}_IMAP_PORT=993、${prefix}_IMAP_SECURE=true）；143 端口才走 STARTTLS（${prefix}_IMAP_SECURE=false）；公司代理可能拦截 STARTTLS，可换网络重试。`,
    };
  }
  return {
    detail: `IMAP 探针失败（${masked} @ ${target}）：${shortError(err)}`,
    hint: `核对 .env 的 ${prefix}_IMAP_HOST / ${prefix}_IMAP_PORT / ${prefix}_IMAP_SECURE 与邮箱服务商一致（QQ/163：imap.xxx.com:993 + 隐式 TLS）；必要时换网络重试。`,
  };
}

/** SMTP 错误 → 中文原因 + 修复建议（535 授权码 / STARTTLS / 网络） */
export function explainSmtpError(err: unknown, account: SmtpTarget): ErrorAdvice {
  const raw = errorMessage(err);
  const target = `${account.smtpHost}:${account.smtpPort}`;
  const masked = maskAddress(account.address);
  const prefix = mailEnvPrefix(account.key);

  const network = explainNetworkError(err, target);
  if (network) return network;

  const smtpCode = raw.match(/SMTP\s+(\d{3})\b/i)?.[1];
  switch (smtpCode) {
    case '535':
    case '534':
    case '530':
      return {
        detail: `SMTP ${smtpCode} 认证失败（${masked} @ ${target}）：${shortError(err)}`,
        hint: `535 基本就是授权码错误或服务商未开启 SMTP：① 确认 .env 的 ${prefix}_AUTH_CODE 是网页端生成的授权码（不是网页登录密码，别带空格）；② QQ：设置 → 账号与安全 → 安全设置 → POP3/IMAP/SMTP 服务 → 开启并生成授权码；③ 163/126：设置 → POP3/SMTP/IMAP → 开启服务并新增授权密码；④ QQ/网易要求发信地址与登录账号一致，项目已按此实现；⑤ 若授权码刚重置，用最新授权码重跑 doctor。`,
      };
    case '550':
    case '553':
      return {
        detail: `SMTP ${smtpCode} 请求被拒（${masked} @ ${target}）：${shortError(err)}`,
        hint: '发信请求被服务端拒绝：确认发信地址与登录账号一致；检查收件人地址是否被服务商限制；企业邮箱可能要求先在管理后台开通外发权限。',
      };
    case '421':
    case '450':
    case '451':
    case '452':
      return {
        detail: `SMTP ${smtpCode} 临时限制（${masked} @ ${target}）：${shortError(err)}`,
        hint: '服务商临时限流/反垃圾拦截：降低发送频率，稍后重试；频繁自测同一账号可能被临时限制，可换账号验证。',
      };
    case '554':
      return {
        detail: `SMTP ${smtpCode} 被判定为垃圾邮件/未开通发信（${masked} @ ${target}）：${shortError(err)}`,
        hint: '检查邮箱是否已开通 SMTP 发信服务、是否触发反垃圾策略；新账号可能需要先用网页端正常收发几封邮件，或联系服务商解封。',
      };
    default:
      break;
  }
  if (/STARTTLS|未声明 STARTTLS/i.test(raw)) {
    return {
      detail: `SMTP STARTTLS 不可用（${masked} @ ${target}）：${shortError(err)}`,
      hint: `该端口不支持 STARTTLS：优先改用 465 隐式 TLS（设置 ${prefix}_SMTP_PORT=465、${prefix}_SMTP_SECURE=true）；587 端口走 STARTTLS（${prefix}_SMTP_SECURE=false）；25 端口常被云厂商封禁，不建议使用。`,
    };
  }
  return {
    detail: `SMTP 探针失败（${masked} @ ${target}）：${shortError(err)}`,
    hint: `核对 .env 的 ${prefix}_SMTP_HOST / ${prefix}_SMTP_PORT / ${prefix}_SMTP_SECURE：465=隐式TLS，587=STARTTLS；企业网络可能封 25/465/587，换网络重试。`,
  };
}

/** 给 Promise 加超时（超时后原 Promise 的迟到结果会被吞掉，不会造成未处理拒绝） */
function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 单个邮箱账号的探测：IMAP 登录基线 + SMTP 登录自检（各 8s 超时）。
 * 只读：IMAP 只 SEARCH、SMTP 只登录 + QUIT，都不投递。
 */
export async function probeMailAccount(
  account: MailAccount,
  opts: { deps?: MailProbeDeps; timeoutMs?: number } = {},
): Promise<CheckResult[]> {
  const deps = opts.deps ?? {};
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const imapFn = deps.fetchNewMails ?? fetchNewMails;
  const smtpFn = deps.verifySmtpAuth ?? verifySmtpAuth;
  const masked = maskAddress(account.address);
  const folder = account.folders[0] ?? 'INBOX';
  const checks: CheckResult[] = [];

  // IMAP：登录 + SELECT + UID SEARCH 立基线（不取正文，不改已读状态）
  const imapId = `mail:${account.key}:imap`;
  const imapTitle = `邮箱 IMAP 登录基线（${masked}）`;
  try {
    const result = await withTimeout(imapFn(account, null, 0, folder), timeoutMs, 'IMAP 探针');
    checks.push({
      group: Platform.MAIL,
      id: imapId,
      title: imapTitle,
      status: 'PASS',
      detail: `登录 ${account.imapHost}:${account.imapPort} 成功并 SELECT ${folder}，当前 UID 基线 ${result.maxUid}（只做 UID SEARCH，未读取正文、未标记已读）。`,
    });
  } catch (e) {
    checks.push({
      group: Platform.MAIL,
      id: imapId,
      title: imapTitle,
      status: 'FAIL',
      ...explainImapError(e, account),
    });
  }

  // SMTP：只做登录认证自检 + QUIT（不发送邮件）
  const smtpId = `mail:${account.key}:smtp`;
  const smtpTitle = `邮箱 SMTP 登录自检（${masked}）`;
  try {
    const result = await withTimeout(smtpFn(account), timeoutMs, 'SMTP 探针');
    checks.push({
      group: Platform.MAIL,
      id: smtpId,
      title: smtpTitle,
      status: 'PASS',
      detail: `登录 ${account.smtpHost}:${account.smtpPort} 认证成功（${result.auth.toUpperCase()} 机制，${result.secure ? '链路已加密' : '链路未加密'}）；只登录 + QUIT，未发送任何邮件。`,
    });
  } catch (e) {
    checks.push({
      group: Platform.MAIL,
      id: smtpId,
      title: smtpTitle,
      status: 'FAIL',
      ...explainSmtpError(e, account),
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 编排：按平台模式决定探测 or SKIP
// ---------------------------------------------------------------------------

/** 平台当前是否该跑真实探针：实际走 real，或用户显式强制 real */
function shouldProbe(runtime: PlatformProbeRuntime): boolean {
  return runtime.mode === 'real' || runtime.policy === 'real';
}

/** 未启用真实通道时的 SKIP 结果（说明原因 + 如何切换到真实接入） */
export function skipProbe(platform: Platform, runtime: PlatformProbeRuntime): CheckResult {
  const label = PLATFORM_LABELS[platform];
  const modeKey = MODE_ENV_KEYS[platform];
  const missingText = runtime.missing.length > 0 ? `缺失环境变量：${runtime.missing.join(' / ')}。` : '';
  return {
    group: platform,
    id: `${platform}:skipped`,
    title: `${label} 真实通道探针`,
    status: 'SKIP',
    detail: `未启用真实通道（策略 ${runtime.policy} → 实际 ${runtime.mode}），按约定跳过真实探针。`,
    hint: `${missingText}补齐后 auto 会自动切到真实接口；也可临时设置 ${modeKey}=real 强制自检（凭据不全时会显式 FAIL，不会静默假成功）。`,
  };
}

/**
 * 执行全部探针（只读）。
 * 仅对 mode=real 或 policy=real 的平台执行；其余输出 SKIP 并说明原因。
 */
// ---------------------------------------------------------------------------
// 大模型探针
// ---------------------------------------------------------------------------

const LLM_PROBE_SAMPLE = '麻烦把 Q3 复盘的材料在周五下班前发我一份';

function llmFailureHint(reason: string): string {
  if (/401|403/.test(reason)) return '鉴权失败：检查 LLM_API_KEY 是否正确、是否已过期。';
  if (/404|does not exist|not activated|has not activated|model.*not.*found/i.test(reason)) {
    return '模型 ID 或端点不存在 / 未开通：LLM_MODEL 必须填服务商控制台里的「模型 ID」（不是显示名，例如 doubao-seed-1-6-250615）；火山方舟还需在控制台「开通管理」里激活该模型，激活后重试。端点也要与该模型的协议路径一致。';
  }
  if (/429/.test(reason)) return '被限流：稍后重试，或确认账户额度是否用尽。';
  if (/timeout/i.test(reason)) return '超时：检查网络/代理是否可达，或调大 LLM_TIMEOUT_MS（真实 flash P100 约 9.3s）。';
  if (/empty_content/.test(reason)) {
    return '模型返回空正文：推理模型（豆包 seed / R1 一类）默认开启深度思考，会把输出预算全部耗在思维链上，返回 content="" + finish_reason=length。服务端已对火山方舟自动传 thinking:{"type":"disabled"}，并在被截断时自动放大输出预算重试一次；若仍失败，请改用非推理/更快档模型，或确认该模型支持关闭思考。';
  }
  if (/low_confidence/.test(reason)) {
    return '模型返回了合法结果但置信不足：这不是接口故障，也不再回退规则。低把握的结果仍会被采用，只是标为「低精度」、草稿更简短；先用一条信息量明确的业务消息（如「请在本周五前把周报发给我」）复测，纯数字/问候语被判低精度属正常。若所有消息都低精度，再检查 LLM_MIN_CONFIDENCE（默认 0.6，现为精度分档线）是否设得过高，或换用更强的模型。';
  }
  if (/invalid_json|missing_fields|invalid_intent|invalid_confidence/.test(reason)) {
    return '模型没有按 JSON 约束输出：检查 LLM_MODEL 是否存在，或换用更强的模型。';
  }
  if (/network|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(reason)) {
    return '网络不可达：确认 LLM_ENDPOINT 正确、机器能直连该域名（必要时配置代理）。';
  }
  return '真实调用未成功，已自动回退规则识别；先确认 .env 的 LLM_* 配置与网络。';
}

/**
 * 只用一条固定样例走一次真实调用，确认鉴权、协议与 JSON 输出约束。
 * 复用生产 LlmService，保证自检结论与实际链路一致。
 */
export async function probeLlm(input: LlmProbeInput, timeoutMs = LLM_PROBE_TIMEOUT_MS): Promise<CheckResult> {
  const base = { group: 'llm' as const, id: 'llm:chat', title: '大模型连通性（意图识别）' };

  if (!input.ready) {
    return {
      ...base,
      status: 'SKIP',
      detail: `当前走内置规则识别，未调用大模型。${input.reason ?? ''}`.trim(),
      hint: '启用真实大模型：在「连接账号 → AI 模型」填 提供方=openai（火山方舟 / DeepSeek / 通义 / 智谱等 OpenAI 兼容服务都填 openai，不要填厂商中文名）、API Key、API Base URL、模型 ID，保存后重启后端；等价 .env：LLM_PROVIDER=openai、LLM_API_KEY、LLM_ENDPOINT、LLM_MODEL。模型 ID 要填控制台里的 ID 且该模型已开通，改配置必须重启才生效。',
    };
  }

  const svc = new LlmService({
    mode: 'real',
    provider: input.provider,
    endpoint: input.endpoint,
    model: input.model,
    apiKey: input.apiKey,
    timeoutMs,
    minConfidence: input.minConfidence,
  });

  let r;
  try {
    r = await svc.analyze({
      traceId: 'doctor-llm',
      platform: Platform.FEISHU,
      externalId: 'doctor-llm',
      sender: { name: 'doctor', id: 'doctor' },
      type: 'text',
      body: LLM_PROBE_SAMPLE,
      status: MsgStatus.RECEIVED,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return {
      ...base,
      status: 'FAIL',
      detail: `调用异常：${errorMessage(e)}`,
      hint: '检查网络/代理与 LLM_ENDPOINT 是否可达。',
    };
  }

  if (r.ok && r.source === 'llm') {
    return {
      ...base,
      status: 'PASS',
      detail: `${input.model} 响应 ${r.latencyMs ?? 0}ms，示例「${LLM_PROBE_SAMPLE}」识别为「${r.intent}」（置信度 ${r.confidence}，${r.tokens ?? 0} tokens）`,
    };
  }

  const reason = r.ok ? (r.fallbackReason ?? 'unknown') : r.reason;
  return { ...base, status: 'FAIL', detail: `真实调用失败：${reason}`, hint: llmFailureHint(reason) };
}

// ---------------------------------------------------------------------------
// 本人身份探针（飞书 user_access_token / 钉钉 dws）
// ---------------------------------------------------------------------------
//
// 约定（契约 §7）：全部只读。未配置/未安装/未连接一律 SKIP（增强项缺失不判失败，
// 不能因为没连本人身份就把整轮 doctor 打成失败）；显式固定本人身份却不可用、
// 或已连接但探测失败时才 FAIL（此时发送/接收确实会失败，必须让用户看到并修复）。

const USER_IDENTITY_TIMEOUT_MS = 8_000;

function feishuIdentityBase() {
  return { group: Platform.FEISHU as const, id: 'feishu:user-identity', title: '飞书本人身份（user_access_token）' };
}

/**
 * 飞书本人身份探针：
 *  1. 令牌状态（未授权 / 有效 / 需续期 / 过期 / 损坏）；
 *  2. 已连接时用 user token 只读拉一次 `im/v1/chats?page_size=1`，验证「用户身份读消息」权限。
 */
export async function probeFeishuIdentity(
  input: { mode: DeliveryMode; policy: IdentityPolicy; receiveEnabled: boolean; baseUrl: string },
  deps: IdentityProbeDeps = {},
  timeoutMs = USER_IDENTITY_TIMEOUT_MS,
): Promise<CheckResult[]> {
  const base = feishuIdentityBase();
  const connectHint = '在 LinkHub「平台账号」页点飞书卡片的「连接本人账号」完成 OAuth 授权（需在飞书开放平台配置重定向 URL 并开启「刷新 user_access_token」）。';
  const statusFn = deps.feishu?.status ?? (() => feishuUserAuth().status());
  const canAuthorize = deps.feishu?.canAuthorize ?? (() => feishuUserAuth().canAuthorize());

  if (input.mode === 'mock') {
    return [{
      ...base,
      status: 'SKIP',
      detail: '飞书当前为模拟模式：本人身份通道不启动，也不探测（切到 real 后才连接）。',
      hint: '把 FEISHU_MODE 设为 real（或配齐飞书应用凭据让 auto 自动切真实）后再运行 doctor。',
    }];
  }

  const status = statusFn();
  if (status.state === 'none') {
    if (!canAuthorize()) {
      return [{
        ...base,
        status: 'SKIP',
        detail: '未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，无法连接飞书本人身份。',
        hint: '在 .env 填写飞书自建应用的 App ID / App Secret 后重试；当前机器人链路不受影响。',
      }];
    }
    return [{
      ...base,
      status: input.policy === 'user' ? 'FAIL' : 'SKIP',
      detail: input.policy === 'user'
        ? 'FEISHU_IDENTITY=user 但尚未连接本人身份：发送会显式失败（绝不悄悄回退机器人）。'
        : '尚未连接飞书本人身份：当前用机器人收发（连接后自动切换为本人，免把机器人拉进每个群）。',
      hint: connectHint,
    }];
  }
  if (status.state === 'expired' || status.state === 'invalid') {
    return [{
      ...base,
      status: 'FAIL',
      detail: status.state === 'expired'
        ? '飞书本人身份授权已过期：发送会显式失败，本人接收不会启动。'
        : '飞书本人身份令牌状态异常（文件损坏或属于其他应用）：需要重新授权。',
      hint: `到 LinkHub「平台账号」页点「重新连接」或「重新授权」。${connectHint}`,
    }];
  }

  const tokenHint = status.accessExpiresAt ? `access_token 有效至 ${status.accessExpiresAt}` : '令牌有效';
  const checks: CheckResult[] = [{
    ...base,
    status: 'PASS',
    detail: status.state === 'refreshable'
      ? `已连接本人身份（access_token 已过期，将用 refresh_token 自动续期）。${tokenHint}`
      : `已连接本人身份，发送将以本人身份发出。${tokenHint}`,
  }];

  // 2) 用户身份读消息连通性（只读）
  if (!input.receiveEnabled || input.policy === 'bot') {
    checks.push({
      group: Platform.FEISHU,
      id: 'feishu:user-receive',
      title: '飞书本人身份接收（用户轮询）',
      status: 'SKIP',
      detail: input.policy === 'bot'
        ? 'FEISHU_IDENTITY=bot：固定机器人身份，本人接收未启用。'
        : 'FEISHU_USER_RECEIVE=false：本人接收已关闭。',
      hint: '需要以本人身份收消息时，把 FEISHU_IDENTITY 设为 auto/user 且 FEISHU_USER_RECEIVE 设为 auto/true。',
    });
    return checks;
  }

  try {
    const token = deps.feishu?.accessToken
      ? await deps.feishu.accessToken()
      : await feishuUserAuth().accessToken();
    const fetchImpl = deps.feishu?.fetchImpl ?? globalThis.fetch;
    const url = `${input.baseUrl.replace(/\/+$/, '')}/open-apis/im/v1/chats?user_id_type=open_id&page_size=1`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    const code = typeof json?.code === 'number' ? json.code : undefined;
    if (!res.ok || (code !== undefined && code !== 0)) {
      const info = describeFeishuError(code ?? res.status, json?.msg);
      checks.push({
        group: Platform.FEISHU,
        id: 'feishu:user-receive',
        title: '飞书本人身份接收（用户轮询）',
        status: 'FAIL',
        detail: `读取会话列表失败（HTTP ${res.status}，code=${code ?? 'n/a'}）：${String(json?.msg ?? '').slice(0, 160)}`,
        hint: info.hint,
      });
      return checks;
    }
    const count = Array.isArray(json?.data?.items) ? json.data.items.length : 0;
    checks.push({
      group: Platform.FEISHU,
      id: 'feishu:user-receive',
      title: '飞书本人身份接收（用户轮询）',
      status: 'PASS',
      detail: `用户身份读消息可用（chats 返回 ${count} 条，page_size=1 仅验证连通性）；`
        + '轮询延迟 5–30s，且只能读到本人可见的会话。',
      hint: `如后续报权限错误，需在开放平台「权限管理 → 用户身份权限」开通：${FEISHU_USER_RECEIVE_SCOPES.join('、')}。`,
    });
  } catch (e) {
    checks.push({
      group: Platform.FEISHU,
      id: 'feishu:user-receive',
      title: '飞书本人身份接收（用户轮询）',
      status: 'FAIL',
      detail: `用户身份读消息探测失败：${errorMessage(e)}`,
      hint: `检查网络/代理；权限需开通 ${FEISHU_USER_RECEIVE_SCOPES.join('、')}，并确认令牌未过期（过期请重新授权）。`,
    });
  }
  return checks;
}

function dingtalkIdentityBase() {
  return { group: Platform.DINGTALK as const, id: 'dingtalk:user-identity', title: '钉钉本人身份（dws CLI）' };
}

/**
 * 钉钉本人身份探针：dws 版本 → 登录状态 → 个人事件目录可用性。
 * dws 未安装/未登录：auto 下 SKIP，显式 user 下 FAIL（发送会失败必须暴露），并给出安装/登录命令。
 */
export async function probeDingtalkIdentity(
  input: { mode: DeliveryMode; policy: IdentityPolicy; receiveEnabled: boolean },
  deps: IdentityProbeDeps = {},
  timeoutMs = USER_IDENTITY_TIMEOUT_MS,
): Promise<CheckResult[]> {
  const base = dingtalkIdentityBase();
  const client = dingtalkPersonalClient();
  const versionFn = deps.dingtalk?.version ?? (() => client.version());
  const statusFn = deps.dingtalk?.authStatus ?? (() => client.authStatus({ force: true }));
  const eventListFn = deps.dingtalk?.eventListAvailable ?? (() => client.eventListAvailable());
  const loginCommand = deps.dingtalk?.loginCommand ?? (() => client.loginCommand());
  const installHint = '安装钉钉官方 CLI：下载 release 的 dws 可执行文件放到 PATH（https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli），'
    + '或在 .env 把 DWS_BIN 指向可执行文件完整路径；离线演示可设 DWS_BIN=node scripts/fake-dws.mjs。';

  if (input.mode === 'mock') {
    return [{
      ...base,
      status: 'SKIP',
      detail: '钉钉当前为模拟模式：本人身份通道不启动，也不探测（显式 DINGTALK_IDENTITY=user + 仅本人身份部署除外）。',
      hint: '如需仅用本人身份（不配机器人），设 DINGTALK_MODE=real 或 DINGTALK_IDENTITY=user；详见 docs/personal-identity.md。',
    }];
  }

  const checks: CheckResult[] = [];
  const version: { version?: string; error?: string } = await versionFn().catch((e) => ({ error: errorMessage(e) }));
  if (!version.version) {
    checks.push({
      ...base,
      status: input.policy === 'user' ? 'FAIL' : 'SKIP',
      detail: `未找到可用的 dws CLI${version.error ? `：${version.error}` : ''}。`,
      hint: installHint,
    });
    return checks;
  }

  const status = await statusFn().catch((e): DwsAuthStatus => ({
    available: false,
    authenticated: false,
    checkedAt: Date.now(),
    error: errorMessage(e),
  }));

  if (!status.authenticated) {
    checks.push({
      ...base,
      status: input.policy === 'user' ? 'FAIL' : 'SKIP',
      detail: `dws ${version.version} 已安装，但本人身份未登录${status.message ? `（${status.message}）` : ''}：`
        + (input.policy === 'user' ? '发送会显式失败，本人接收不会启动。' : '当前用机器人收发，登录后自动切换为本人。'),
      hint: `在终端执行 \`${loginCommand()}\` 完成设备码/浏览器授权，或到 LinkHub「平台账号」页点「连接本人账号」（未安装 dws 时点「查看连接步骤」）。`,
    });
  } else {
    checks.push({
      ...base,
      status: 'PASS',
      detail: `dws ${version.version}：本人身份已登录，发送将以本人身份发出`
        + (input.receiveEnabled ? '，接收走 dws 个人事件。' : '（本人接收已关闭）。'),
      hint: '以本人身份发送的消息会带平台 AI 发送角标（--ai-tag 默认开启），这是平台的透明标注。',
    });
  }

  if (status.authenticated && input.receiveEnabled && input.policy !== 'bot') {
    try {
      const r = await withTimeout(eventListFn(), timeoutMs, 'dws event list');
      checks.push({
        group: Platform.DINGTALK,
        id: 'dingtalk:dws-event-list',
        title: '钉钉个人事件目录（dws event list）',
        status: r.ok ? 'PASS' : 'FAIL',
        detail: r.detail,
        ...(r.ok ? {} : { hint: '确认 dws 版本（pnpm exec dws version）与企业「CLI 访问管理」已开启；离线演示可用 fake-dws。' }),
      });
    } catch (e) {
      checks.push({
        group: Platform.DINGTALK,
        id: 'dingtalk:dws-event-list',
        title: '钉钉个人事件目录（dws event list）',
        status: 'FAIL',
        detail: `探测失败：${errorMessage(e)}`,
        hint: 'dws 事件目录需要登录且网络可达；不影响发送，仅影响本人身份接收。',
      });
    }
  }

  return checks;
}

export async function runProbes(input: ProbeInput, options: RunProbesOptions = {}): Promise<RunProbesResult> {
  const checks: CheckResult[] = [];
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const filter = options.platformFilter && options.platformFilter.length > 0 ? new Set(options.platformFilter) : undefined;
  const want = (platform: Platform): boolean => !filter || filter.has(platform);
  const runtimeOf = (platform: Platform): PlatformProbeRuntime => input.runtime[platform];

  // 大模型不属于任何平台：未按平台过滤时才探测
  if (!filter) {
    checks.push(await probeLlm(input.llm, options.llmTimeoutMs ?? LLM_PROBE_TIMEOUT_MS));
  }

  if (want(Platform.FEISHU)) {
    const runtime = runtimeOf(Platform.FEISHU);
    if (shouldProbe(runtime)) checks.push(await probeFeishuToken(input.feishu, timeoutMs));
    else checks.push(skipProbe(Platform.FEISHU, runtime));
    if (input.identity) {
      checks.push(...await probeFeishuIdentity(
        {
          mode: runtime.mode,
          policy: input.identity.feishu.policy,
          receiveEnabled: input.identity.feishu.receiveEnabled,
          baseUrl: input.feishu.baseUrl,
        },
        options.identityDeps,
        timeoutMs,
      ));
    }
  }

  if (want(Platform.DINGTALK)) {
    const runtime = runtimeOf(Platform.DINGTALK);
    if (shouldProbe(runtime)) {
      checks.push(await probeDingtalkToken(input.dingtalk, timeoutMs));
      checks.push(...dingtalkConfigChecks({
        ...input.dingtalk,
        personalReceive: input.identity?.dingtalk.policy === 'user'
          && input.identity.dingtalk.receiveEnabled,
      }));
    } else {
      checks.push(skipProbe(Platform.DINGTALK, runtime));
    }
    if (input.identity) {
      // 与运行时同一套判定：显式 mock 不探测；auto 因缺机器人凭据降级但显式固定本人时仍算真实（仅本人身份部署）
      const channelsReal = runtime.mode === 'real'
        || (runtime.policy === 'auto' && input.identity.dingtalk.policy === 'user' && !runtime.canSend && !runtime.canReceive);
      checks.push(...await probeDingtalkIdentity(
        {
          mode: channelsReal ? 'real' : 'mock',
          policy: input.identity.dingtalk.policy,
          receiveEnabled: input.identity.dingtalk.receiveEnabled,
        },
        options.identityDeps,
        timeoutMs,
      ));
    }
  }

  if (want(Platform.WECHAT)) {
    // 微信走本地 RPA 桥：不探测任何官方接口，只问本机桥"你是谁、能不能收"（GET /health，只读）。
    // 这一步必须真做：WECHAT_MODE=real 只说明配置允许真实操作，不代表桥起来了或在 rpa 模式。
    const runtime = runtimeOf(Platform.WECHAT);
    if (runtime.mode === 'real') {
      const bridge = await probeWechatBridge({ timeoutMs, url: input.wechat?.bridgeUrl });
      if (!bridge.reachable) {
        checks.push({
          group: Platform.WECHAT,
          id: 'wechat:bridge',
          title: '微信 RPA 桥',
          status: 'FAIL',
          detail: `连不上本机 RPA 桥（${bridge.url}）：${bridge.error ?? '未知原因'}`,
          hint: '先启动桥：python scripts/wechat-rpa/rpa_bridge.py --mode rpa；若后端在 Docker 里，桥必须监听在后端可访问的地址（127.0.0.1 在容器内指向容器自身）。',
        });
      } else if (bridge.mode !== 'rpa') {
        checks.push({
          group: Platform.WECHAT,
          id: 'wechat:bridge',
          title: '微信 RPA 桥',
          status: 'FAIL',
          detail: `桥可达，但运行在 ${bridge.mode ?? '未知'} 模式：发送不会真的操作微信（后端会如实拒绝，不会标成 real）。`,
          hint: '用 --mode rpa 重启桥；缺 pyautogui/pyperclip/pywin32/uiautomation 时桥会以退出码 2 报出缺失项。',
        });
      } else {
        checks.push({
          group: Platform.WECHAT,
          id: 'wechat:bridge',
          title: '微信 RPA 桥（发送）',
          status: 'PASS',
          detail: '桥以 rpa 模式运行，发送会真实操作本机微信桌面端（RPA 键鼠）。',
          hint: '保持微信桌面端登录并置于可操作状态；鼠标移到屏幕左上角可紧急停止 RPA。',
        });
        // 4.x 没有控件树：自动轮询这条路"不适用"，不是"没配好"。
        // 报 FAIL 会让人以为整条通道坏了，而它其实可以用按需拉取。
        const isWeixin4 = bridge.client?.kind === 'weixin4';
        checks.push({
          group: Platform.WECHAT,
          id: 'wechat:receive',
          title: '微信 RPA 桥（接收）',
          status: bridge.canReceive ? 'PASS' : isWeixin4 ? 'SKIP' : 'FAIL',
          detail: bridge.canReceive
            ? bridge.receiveReason
            : isWeixin4
              ? '微信 4.x 不暴露可访问性控件树，自动轮询不适用；接收请用「按需拉取」（POST /api/wechat/pull，拖选复制原文）。发送不受影响。'
              : bridge.receiveReason,
          hint: bridge.canReceive
            ? '入站由桥轮询窗口消息并转发 /api/webhook/wechat；会切换会话，属于 RPA 的固有限制。'
            : isWeixin4
              ? '收件箱 → 渠道选微信 →「从微信拉取当前会话」；或 POST /api/wechat/pull。只想自动收就换装微信 3.9.x。'
              : '接收依赖 Windows UI Automation：安装 uiautomation、登录并打开微信桌面端；只看当前会话可加 --no-switch。',
        });
      }
    } else {
      checks.push(skipProbe(Platform.WECHAT, runtime));
    }
  }

  if (want(Platform.MAIL)) {
    const runtime = runtimeOf(Platform.MAIL);
    if (!shouldProbe(runtime)) {
      checks.push(skipProbe(Platform.MAIL, runtime));
    } else if (input.mail.accounts.length === 0) {
      checks.push({
        group: Platform.MAIL,
        id: 'mail:accounts',
        title: '邮箱账号配置',
        status: 'FAIL',
        detail: '真实通道没有可探测的邮箱账号：当前策略是 real，但 .env 未解析出任何账号。',
        hint: '在 .env 填写 MAIL_QQ_ADDRESS / MAIL_QQ_AUTH_CODE（或 MAIL_ACCOUNTS + MAIL_<KEY>_ADDRESS / MAIL_<KEY>_AUTH_CODE）；授权码需要先在邮箱网页端开启 IMAP/SMTP 后生成。',
      });
    } else {
      for (const account of input.mail.accounts) {
        checks.push(
          ...(await probeMailAccount(account, {
            deps: options.deps,
            timeoutMs: options.mailTimeoutMs ?? MAIL_PROBE_TIMEOUT_MS,
          })),
        );
      }
    }
  }

  return { checks };
}
