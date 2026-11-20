/**
 * 真实平台调用的公共设施：token 缓存 + JSON 请求 + multipart 文件上传。
 * 只使用 Node 内置 fetch，不引入第三方 SDK。
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config';

/**
 * 手工拼 multipart/form-data 请求体。
 * 不用全局 FormData/Blob 是为了兼容「只装了 @types/node、没有 DOM lib」的服务端编译环境，
 * 同时让文件内容始终以 Buffer 在内存里走一趟，不落盘（演示环境无需临时目录）。
 */
export interface MultipartPart {
  /** 表单字段名（平台各异：飞书 file / 钉钉 media） */
  field: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

export function buildMultipart(
  fields: Array<{ name: string; value: string }>,
  part: MultipartPart,
): { body: Buffer; contentType: string } {
  const boundary = `----LinkHub${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  const push = (s: string) => chunks.push(Buffer.from(s, 'utf8'));

  for (const f of fields) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`);
  }
  // 文件名里的引号/换行会破坏头部结构，统一替换成下划线
  const safeName = part.filename.replace(/["\r\n]/g, '_');
  push(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${safeName}"\r\n`);
  push(`Content-Type: ${part.contentType}\r\n\r\n`);
  chunks.push(part.content);
  push(`\r\n--${boundary}--\r\n`);

  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * 发请求并把响应解析成 JSON；非 JSON 文本回落为 { raw: text }，非 2xx 抛错。
 * postMultipart / postJson / getJson 共用的响应处理。
 */
async function requestAndParse(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

/** 上传文件到平台媒体接口，返回平台原始 JSON 响应（调用方按平台取 media_id / file_key） */
export async function postMultipart(
  url: string,
  fields: Array<{ name: string; value: string }>,
  part: MultipartPart,
  headers: Record<string, string> = {},
  timeoutMs = config.platformTimeoutMs,
): Promise<any> {
  const { body, contentType } = buildMultipart(fields, part);
  return requestAndParse(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...headers },
    body: body as unknown as BodyInit,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

interface CachedToken {
  token: string;
  exp: number;
}

const tokens = new Map<string, CachedToken>();

export function resetTokenCache(): void {
  tokens.clear();
}

/**
 * token 缓存骨架：命中且未过期直接返回；否则调用 fetchToken 换新 token
 * （校验与错误消息由各平台自己把关），统一提前 120s 过期、下限 60s。
 */
async function withTokenCache(
  cacheKey: string,
  fetchToken: () => Promise<{ token: string; expire?: unknown }>,
): Promise<string> {
  const hit = tokens.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.token;

  const { token, expire } = await fetchToken();
  const ttl = Math.max(60, Number(expire ?? 7200) - 120);
  tokens.set(cacheKey, { token, exp: Date.now() + ttl * 1000 });
  return token;
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = config.platformTimeoutMs,
): Promise<any> {
  return requestAndParse(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** GET 取 JSON（部分平台只认 GET 的接口）。 */
export async function getJson(url: string, timeoutMs = config.platformTimeoutMs): Promise<any> {
  return requestAndParse(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
}

/** 附件下载上限：平台单个文件远小于此值；防止异常响应把内存打满 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface BinaryResponse {
  buffer: Buffer;
  contentType?: string;
  contentDisposition?: string;
}

/** 错误信息里只保留 origin + path，绝不把 access_token 等 query 打进日志/前端 */
function safeUrlForError(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'platform';
  }
}

/**
 * GET 二进制资源（飞书消息资源等）。
 *
 * 平台在 HTTP 200 里也可能返回 JSON 错误（如飞书 `{code,msg}`），
 * 这里统一识别并抛可读错误；错误信息不带 query，避免 access_token 泄露到界面或日志。
 */
export async function getBinary(
  url: string,
  headers: Record<string, string> = {},
  opts: { timeoutMs?: number; label?: string; maxBytes?: number } = {},
): Promise<BinaryResponse> {
  const label = opts.label ?? '平台资源';
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? config.platformTimeoutMs),
  });
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  const contentDisposition = res.headers.get('content-disposition') ?? undefined;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label}下载失败（HTTP ${res.status}）：${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label}文件过大（${Math.round(declared / 1024 / 1024)}MB），超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
  }

  // 平台把错误包在 200 JSON 里：先按文本判断，再决定是否当文件读。
  // 注意：用户也可能真的发一个 .json 文件，所以只有「带非 0 错误码」才当失败；
  // 没有错误码的 JSON 按文件字节原样返回，不能把正常附件误判成接口错误。
  if (contentType.includes('application/json')) {
    const text = await res.text().catch(() => '');
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${label}返回了无法解析的 JSON（${safeUrlForError(url)}）`);
    }
    const code = json?.code ?? json?.errcode ?? json?.error?.code;
    if (code !== undefined && Number(code) !== 0) {
      const message = json?.msg ?? json?.errmsg ?? json?.message ?? json?.error?.message ?? '';
      throw new Error(`${label}返回错误 ${String(code)}${message ? `：${String(message).slice(0, 160)}` : ''}`);
    }
    if (typeof json?.error === 'string' && json.error) {
      throw new Error(`${label}返回错误：${json.error.slice(0, 160)}`);
    }
    const buffer = Buffer.from(text);
    if (buffer.byteLength === 0) throw new Error(`${label}返回了空文件`);
    if (buffer.byteLength > maxBytes) {
      throw new Error(`${label}文件过大（${Math.round(buffer.byteLength / 1024 / 1024)}MB），超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
    }
    return { buffer, contentType: contentType || undefined, contentDisposition };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`${label}文件过大（${Math.round(buffer.byteLength / 1024 / 1024)}MB），超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
  }
  if (buffer.byteLength === 0) throw new Error(`${label}返回了空文件`);

  return { buffer, contentType: contentType || undefined, contentDisposition };
}

export async function feishuTenantToken(): Promise<string> {
  const { appId, appSecret } = config.platforms.feishu;
  if (!appId || !appSecret) throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置');

  return withTokenCache(`feishu:${appId}`, async () => {
    const data = await postJson(`${config.platforms.feishu.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      app_id: appId,
      app_secret: appSecret,
    });
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`飞书 tenant_access_token 获取失败: ${data.code} ${data.msg ?? ''}`);
    }
    return { token: data.tenant_access_token, expire: data.expire };
  });
}

export async function dingtalkAccessToken(): Promise<string> {
  const { appKey, appSecret } = config.platforms.dingtalk;
  if (!appKey || !appSecret) throw new Error('DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET 未配置');

  return withTokenCache(`dingtalk:${appKey}`, async () => {
    const data = await postJson(`${config.platforms.dingtalk.baseUrl}/v1.0/oauth2/accessToken`, { appKey, appSecret });
    if (!data.accessToken) {
      throw new Error(`钉钉 accessToken 获取失败: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return { token: data.accessToken, expire: data.expireIn };
  });
}

