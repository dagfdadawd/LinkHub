/**
 * 飞书「本人身份」接收（user_access_token 轮询）。
 *
 * 平台事实：飞书官方没有「个人消息推送事件」（机器人事件 im.message.receive_v1 只推给机器人），
 * 但官方 API 允许 user_access_token 读取**用户本人可见**的会话与消息。因此这里采用：
 *   1) `GET /open-apis/im/v1/chats` 列出用户所在会话（分页）；
 *   2) 对每个会话 `GET /open-apis/im/v1/messages?container_id_type=chat&container_id=...&start_time=<秒>`
 *      拉增量（升序 + start_time），用本地水位记录每个会话最后一条消息时间（毫秒）；
 *   3) 映射为 UnifiedMessage 交给消息中枢入库（receivedAs='user'）。
 *
 * 设计约束：
 *  - 纯函数 + 注入 fetch（与 connectors/feishuUserAuth.ts 同风格），单测不联网；
 *  - 轮询天然有延迟（5–30s），文档/UI 如实标注，不假装实时；
 *  - 只能读到「用户本人可见」的会话（不含他人私聊/未加入的群），如实写文档；
 *  - externalId 使用裸 `message_id`：与机器人事件里的 open_message_id 是同一 ID 空间，
 *    双通道同时开启时才能按 (platform, externalId) 幂等去重（契约 §5）；若加前缀会造成重复展示。
 */
import {
  MsgStatus, Platform, type AttachmentInfo, type UnifiedMessage,
} from '@unimsg/shared';
import { genTraceId } from './base';
import {
  FEISHU_BASE_SCOPES,
  FEISHU_USER_RECEIVE_SCOPES as FEISHU_USER_RECEIVE_SCOPES_CORE,
} from '../config/runtime';

/** 飞书开放平台错误：message 直接给用户看（中文 + 修复下一步） */
export class FeishuUserReceiveError extends Error {
  readonly code?: number;
  readonly kind: 'permission' | 'auth' | 'network' | 'http' | 'parse';
  readonly status?: number;

  constructor(
    message: string,
    details: { code?: number; kind?: 'permission' | 'auth' | 'network' | 'http' | 'parse'; status?: number } = {},
  ) {
    super(message);
    this.name = 'FeishuUserReceiveError';
    this.kind = details.kind ?? 'http';
    this.code = details.code;
    this.status = details.status;
  }
}

/**
 * 用户身份读消息所需权限（文档 + hint 共用）。
 * 单一事实来源在 config/runtime.ts（授权 scope 也由它生成，避免两处漂移）。
 */
export const FEISHU_USER_RECEIVE_SCOPES = [
  ...FEISHU_BASE_SCOPES,
  ...FEISHU_USER_RECEIVE_SCOPES_CORE,
] as const;

/** 权限类错误码：飞书不同接口/版本返回不同码，这里统一识别 */
export const FEISHU_PERMISSION_CODES = [99991672, 99991679, 20027, 230027] as const;
/** 用户令牌失效类错误码（需要重新授权，而不是加权限） */
export const FEISHU_AUTH_CODES = [99991663, 99991661, 99991668, 20005, 20026] as const;

/**
 * 把飞书错误码翻译成「缺权限」或「重新授权」两类可操作中文提示。
 * 契约 §3.2 要求轮询错误提示能区分这两种，避免用户白折腾。
 */
export function describeFeishuError(code: number | undefined, message?: string): {
  kind: 'permission' | 'auth' | 'http';
  hint: string;
} {
  const text = message ?? '';
  if (code !== undefined && (FEISHU_PERMISSION_CODES as readonly number[]).includes(code)) {
    return {
      kind: 'permission',
      hint: `飞书用户身份缺少「读消息」权限（错误码 ${code}）：请在飞书开放平台「权限管理 → 用户身份权限」开通 `
        + `${FEISHU_USER_RECEIVE_SCOPES.join('、')}，发布应用版本后到 LinkHub「平台账号」页点「重新授权」。`,
    };
  }
  if (code !== undefined && (FEISHU_AUTH_CODES as readonly number[]).includes(code)) {
    return {
      kind: 'auth',
      hint: `飞书用户授权已失效（错误码 ${code}）：请在 LinkHub「平台账号」页点「重新连接」重新连接飞书本人身份。`,
    };
  }
  if (/permission|权限|forbidden|no permission/i.test(text)) {
    return {
      kind: 'permission',
      hint: '飞书用户身份大概率缺少「读消息」权限：请在开放平台「权限管理 → 用户身份权限」开通 '
        + `${FEISHU_USER_RECEIVE_SCOPES.join('、')}，发布版本后重新授权。`,
    };
  }
  if (/invalid.*token|token.*invalid|expired|过期|未授权|unauthorized/i.test(text)) {
    return {
      kind: 'auth',
      hint: '飞书用户授权已失效或过期：请在 LinkHub「平台账号」页点「重新连接」。',
    };
  }
  return {
    kind: 'http',
    hint: `飞书接口调用失败${code !== undefined ? `（错误码 ${code}）` : ''}：可稍后重试；持续失败请检查网络/代理与开放平台应用状态。`,
  };
}

// ---------------------------------------------------------------------------
// HTTP（注入 fetch）
// ---------------------------------------------------------------------------

export interface FeishuUserReceiveOptions {
  /** 开放平台基址，默认取 config.platforms.feishu.baseUrl */
  baseUrl?: string;
  /** 单测注入 fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const FEISHU_USER_API_TIMEOUT_MS = 10_000;

interface FeishuEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

/** GET 飞书开放平台接口，返回 data；非 0 code 抛中文错误 */
export async function feishuUserGet<T>(
  path: string,
  token: string,
  opts: FeishuUserReceiveOptions = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = (opts.baseUrl ?? 'https://open.feishu.cn').replace(/\/+$/, '');
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? FEISHU_USER_API_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new FeishuUserReceiveError('飞书接口超时（10s）：请检查网络/代理是否可达 open.feishu.cn', { kind: 'network' });
    }
    throw new FeishuUserReceiveError(`连接飞书接口失败：${e instanceof Error ? e.message : String(e)}`, { kind: 'network' });
  }

  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new FeishuUserReceiveError(`飞书接口返回的不是 JSON（HTTP ${res.status}）`, { kind: 'parse', status: res.status });
  }
  const code = typeof json?.code === 'number' ? json.code : undefined;
  const payload = (json?.data ?? json) as FenvelopeShape;
  if (!res.ok || (code !== undefined && code !== 0)) {
    const info = describeFeishuError(code ?? res.status, json?.msg);
    throw new FeishuUserReceiveError(
      `${info.hint}${json?.msg ? `（飞书返回：${String(json.msg).slice(0, 160)}）` : ''}`,
      { ...(code !== undefined ? { code } : {}), kind: info.kind === 'http' ? 'http' : info.kind, status: res.status },
    );
  }
  return payload as unknown as T;
}

type FenvelopeShape = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 会话 / 消息拉取
// ---------------------------------------------------------------------------

export interface FeishuChat {
  chatId: string;
  name?: string;
  /** group = 群聊；p2p = 单聊；topic = 话题群 */
  chatMode?: string;
  chatType?: string;
}

export interface FeishuSelfUserInfo {
  openId: string;
  name?: string;
}

export interface FetchUserChatsResult {
  chats: FeishuChat[];
  pages: number;
  truncated: boolean;
}

/**
 * 列出用户本人所在会话（分页）。契约：page_size=100，最多 maxChats 个。
 * 用户身份下 user_id_type 必须是 open_id。
 */
export async function fetchUserChats(
  token: string,
  opts: FeishuUserReceiveOptions & { pageSize?: number; maxChats?: number } = {},
): Promise<FetchUserChatsResult> {
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 100));
  const maxChats = Math.max(1, opts.maxChats ?? 200);
  const chats: FeishuChat[] = [];
  let pageToken = '';
  let pages = 0;
  // 会话数上限保护：分页最多 20 页（2000 个会话），避免异常数据导致死循环
  for (let i = 0; i < 20; i += 1) {
    const query = new URLSearchParams({
      user_id_type: 'open_id',
      page_size: String(pageSize),
    });
    if (pageToken) query.set('page_token', pageToken);
    const data = await feishuUserGet<{ items?: any[]; has_more?: boolean; page_token?: string }>(
      `/open-apis/im/v1/chats?${query.toString()}`,
      token,
      opts,
    );
    pages += 1;
    for (const item of data?.items ?? []) {
      const chatId = typeof item?.chat_id === 'string' ? item.chat_id : '';
      if (!chatId) continue;
      chats.push({
        chatId,
        ...(typeof item?.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}),
        ...(typeof item?.chat_mode === 'string' ? { chatMode: item.chat_mode } : {}),
        ...(typeof item?.chat_type === 'string' ? { chatType: item.chat_type } : {}),
      });
      if (chats.length >= maxChats) {
        return { chats, pages, truncated: true };
      }
    }
    if (!data?.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return { chats, pages, truncated: false };
}

/** 取当前用户信息（open_id + 展示名）；用于过滤自己发的消息、账号页显示名 */
export async function getSelfUserInfo(
  token: string,
  opts: FeishuUserReceiveOptions = {},
): Promise<FeishuSelfUserInfo> {
  const data = await feishuUserGet<Record<string, unknown>>('/open-apis/authen/v1/user_info', token, opts);
  const openId = typeof data?.open_id === 'string' ? data.open_id : '';
  if (!openId) {
    throw new FeishuUserReceiveError('飞书 user_info 未返回 open_id：用户授权可能不完整，请重新授权', { kind: 'auth' });
  }
  return {
    openId,
    ...(typeof data?.name === 'string' && data.name.trim() ? { name: data.name.trim() } : {}),
  };
}

/** 飞书原始消息（只列用到的字段，其余保留在 raw 里） */
export interface FeishuUserMessageRaw {
  message_id?: string;
  create_time?: string;
  msg_type?: string;
  body?: { content?: string };
  sender?: { id?: string; id_type?: string; sender_type?: string };
  chat_id?: string;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface FetchChatMessagesResult {
  messages: FeishuUserMessageRaw[];
  pages: number;
  /** 本批最大 create_time（毫秒）；无消息时 undefined */
  maxCreateTimeMs?: number;
}

/**
 * 拉取单个会话的增量消息（按创建时间升序，start_time 为秒）。
 * 契约默认 pageSize=50、最多 maxPages=3（150 条/会话/轮）；多页继续用 page_token。
 */
export async function fetchChatMessages(
  token: string,
  chatId: string,
  opts: FeishuUserReceiveOptions & { startTimeSec?: number; pageSize?: number; maxPages?: number } = {},
): Promise<FetchChatMessagesResult> {
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 50));
  const maxPages = Math.max(1, opts.maxPages ?? 3);
  const messages: FeishuUserMessageRaw[] = [];
  let pageToken = '';
  let pages = 0;
  for (let i = 0; i < maxPages; i += 1) {
    const query = new URLSearchParams({
      container_id_type: 'chat',
      container_id: chatId,
      sort_type: 'ByCreateTimeAsc',
      page_size: String(pageSize),
    });
    if (opts.startTimeSec !== undefined && opts.startTimeSec > 0) {
      query.set('start_time', String(Math.floor(opts.startTimeSec)));
    }
    if (pageToken) query.set('page_token', pageToken);
    const data = await feishuUserGet<{ items?: any[]; has_more?: boolean; page_token?: string }>(
      `/open-apis/im/v1/messages?${query.toString()}`,
      token,
      opts,
    );
    pages += 1;
    for (const item of data?.items ?? []) {
      if (item && typeof item === 'object') messages.push(item as FeishuUserMessageRaw);
    }
    if (!data?.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  const maxCreateTimeMs = messages.reduce<number | undefined>((max, m) => {
    const t = Number(m.create_time);
    if (!Number.isFinite(t) || t <= 0) return max;
    return max === undefined || t > max ? t : max;
  }, undefined);
  return { messages, pages, ...(maxCreateTimeMs !== undefined ? { maxCreateTimeMs } : {}) };
}

// ---------------------------------------------------------------------------
// 映射（纯函数）
// ---------------------------------------------------------------------------

function safeJson(text: unknown): any {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** post（富文本）正文提取：标题 + 所有 text 节点的文本 */
function postText(content: any): string {
  const parts: string[] = [];
  if (typeof content?.title === 'string' && content.title.trim()) parts.push(content.title.trim());
  const paragraphs = content?.content;
  if (Array.isArray(paragraphs)) {
    for (const para of paragraphs) {
      if (!Array.isArray(para)) continue;
      const line = para
        .map((el: any) => {
          if (!el || typeof el !== 'object') return '';
          if (el.tag === 'text' || el.tag === 'md') return String(el.text ?? '');
          if (el.tag === 'a') return `${el.text ?? ''}${el.href ? `(${el.href})` : ''}`;
          if (el.tag === 'at') return `@${el.user_name ?? el.user_id ?? ''}`;
          return '';
        })
        .join('');
      if (line.trim()) parts.push(line.trim());
    }
  }
  return parts.join('\n');
}

export interface MapFeishuUserMessageOptions {
  /** 本人 open_id：过滤自己发出的消息（避免自环） */
  selfOpenId?: string;
  /** 单测注入时钟（毫秒） */
  now?: () => number;
}

/**
 * 飞书原始消息 → 统一消息。
 * 返回 null 表示「应跳过」：自己发的 / 已撤回 / 系统消息 / 未知消息类型（调用方计数）。
 */
export function mapFeishuUserMessage(
  raw: FeishuUserMessageRaw,
  chat: FeishuChat,
  selfOpenId?: string,
  opts: MapFeishuUserMessageOptions = {},
): UnifiedMessage | null {
  const messageId = typeof raw.message_id === 'string' ? raw.message_id.trim() : '';
  if (!messageId) return null;
  if (raw.deleted === true) return null;

  const sender = raw.sender ?? {};
  if (sender.sender_type === 'system') return null;
  // 自己发的消息：只在 ID 类型明确是 open_id（或未标注）时才按字符串比较，避免跨 ID 空间误判
  if (selfOpenId && typeof sender.id === 'string' && sender.id) {
    const idType = typeof sender.id_type === 'string' ? sender.id_type : '';
    if ((idType === '' || idType === 'open_id') && sender.id === selfOpenId) return null;
  }

  const msgType = typeof raw.msg_type === 'string' ? raw.msg_type : 'text';
  const content = safeJson(raw.body?.content);
  const now = (opts.now ?? Date.now)();
  const createMs = Number(raw.create_time);
  const createdAt = Number.isFinite(createMs) && createMs > 0 ? new Date(createMs).toISOString() : new Date(now).toISOString();

  let type: UnifiedMessage['type'] = 'text';
  let body = '';
  const attachments: AttachmentInfo[] = [];

  if (msgType === 'text') {
    body = typeof content?.text === 'string' ? content.text : String(content ?? '');
  } else if (msgType === 'post') {
    body = postText(content);
  } else if (msgType === 'file') {
    const name = typeof content?.file_name === 'string' ? content.file_name : '';
    type = 'file';
    body = name ? `[文件] ${name}` : '[文件]';
    attachments.push({ name: name || '飞书文件', mimeType: 'application/octet-stream', size: 0 });
  } else if (msgType === 'image') {
    type = 'image';
    body = '[图片]';
  } else if (msgType === 'audio') {
    type = 'file';
    body = '[语音]';
  } else if (msgType === 'media') {
    type = 'file';
    body = typeof content?.file_name === 'string' ? `[视频] ${content.file_name}` : '[视频]';
  } else if (msgType === 'sticker') {
    type = 'image';
    body = '[表情]';
  } else if (msgType === 'interactive' || msgType === 'share_chat' || msgType === 'share_user') {
    // 卡片/名片类消息：可展示，但没有纯文本正文（不臆造内容）
    type = 'text';
    body = raw.msg_type === 'interactive' ? '[卡片消息]' : '[分享消息]';
  } else {
    // 未知类型：跳过并计数（契约 §3.2）
    return null;
  }
  if (!body.trim()) return null;

  const senderId = typeof sender.id === 'string' && sender.id ? sender.id : 'unknown';
  const conversationType = chat.chatMode === 'p2p' ? 'p2p' : 'group';
  return {
    traceId: genTraceId(),
    platform: Platform.FEISHU,
    // 裸 message_id：与机器人事件的 open_message_id 同空间，双通道幂等去重（契约 §5）
    externalId: messageId,
    sender: { id: senderId, name: senderId },
    conversation: { id: chat.chatId, type: conversationType, ...(chat.name ? { title: chat.name } : {}) },
    type,
    body,
    ...(attachments.length > 0 ? { attachments } : {}),
    receivedAs: 'user',
    status: MsgStatus.RECEIVED,
    createdAt,
    updatedAt: createdAt,
  };
}

// ---------------------------------------------------------------------------
// 当前用户信息缓存（账号页显示的本人名称；避免每轮轮询都多打一次接口）
// ---------------------------------------------------------------------------

let selfInfoCache: { openId: string; name?: string; at: number } | undefined;
const SELF_INFO_TTL_MS = 30 * 60_000;

/** 同步读取缓存的本人信息（identity 视图用，不阻塞） */
export function peekSelfUserInfo(): { openId: string; name?: string } | undefined {
  return selfInfoCache;
}

/** 拉取并缓存本人信息（轮询器每轮尝试一次；失败静默，不阻断收消息） */
export async function refreshSelfUserInfo(
  token: string,
  opts: FeishuUserReceiveOptions = {},
): Promise<{ openId: string; name?: string } | undefined> {
  if (selfInfoCache && Date.now() - selfInfoCache.at < SELF_INFO_TTL_MS) {
    return { openId: selfInfoCache.openId, ...(selfInfoCache.name ? { name: selfInfoCache.name } : {}) };
  }
  try {
    const info = await getSelfUserInfo(token, opts);
    selfInfoCache = { ...info, at: Date.now() };
    return info;
  } catch {
    return undefined;
  }
}

/** 单测用：清空本人信息缓存 */
export function resetSelfUserInfoCache(): void {
  selfInfoCache = undefined;
}