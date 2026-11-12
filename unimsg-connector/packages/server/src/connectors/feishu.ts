/**
 * 飞书连接器。
 *
 * receive：解析 im.message.receive_v1（也兼容旧版简化结构）→ 统一消息。
 * convert：统一消息 → 飞书 im/v1/messages 请求体。
 * send   ：Mock 模式写入 sentBox 并返回 mode='mock'；否则换取 tenant_access_token 真实发送。
 * verify ：Mock 模式宽松验签；否则校验事件头里的 verification token。
 * decrypt：配置了 Encrypt Key 时解密 encrypt 字段。
 */
import {
  Platform, MsgStatus, UnifiedMessage, PlatformConnector,
  type SendResult, type OutboundAttachment,
} from '@unimsg/shared';
import { config } from '../config';
import { genTraceId, mockSend, verifyMock, inferType, inferDueAt, isMock, assertRealSendable } from './base';
import { feishuDecrypt } from './crypto';
import { feishuUserAuth } from './feishuUserAuth';
import { feishuTenantToken, postJson, postMultipart } from './real';
import { decodeAttachment, describeAttachments } from '../services/outbound';

/**
 * 自环登记：用户身份发出的消息可能再次触发 im.message.receive_v1（单聊必现）。
 * 用 message_id 精确识别本进程刚发出的消息，只保留有限时间窗口，避免无限增长。
 */
const ECHO_TTL_MS = 10 * 60_000;
const ECHO_MAX_ENTRIES = 200;
const recentOutbound = new Map<string, number>();

function pruneEchoRegistry(now = Date.now()): void {
  for (const [id, at] of recentOutbound) {
    if (now - at > ECHO_TTL_MS) recentOutbound.delete(id);
  }
  while (recentOutbound.size > ECHO_MAX_ENTRIES) {
    const oldest = recentOutbound.keys().next().value;
    if (oldest === undefined) break;
    recentOutbound.delete(oldest);
  }
}

function rememberOutboundMessageId(id: string): void {
  const now = Date.now();
  pruneEchoRegistry(now);
  recentOutbound.set(id, now);
}

/** 单测用：清空自环登记，避免不同用例互相影响 */
export function resetFeishuEchoRegistry(): void {
  recentOutbound.clear();
}

/** 入站事件是否为本进程刚以用户身份发出的消息（TTL 窗口内持续命中，平台重投也不会漏） */
export function isSelfEcho(raw: unknown): boolean {
  const r = raw as any;
  const event = r?.event ?? r;
  const id = event?.message?.message_id;
  if (typeof id !== 'string' || !id) return false;
  const at = recentOutbound.get(id);
  if (!at) return false;
  // 不删除：平台可能重投同一事件，重复投递仍必须被识别为自环；
  // 条目由 TTL + 数量上限自动淘汰，不会无限增长。
  return Date.now() - at <= ECHO_TTL_MS;
}

/**
 * 按本次要用的身份选出令牌：
 *  - 显式 `msg.sendIdentity`（统一入口指定）优先级最高：user 强制本人、bot 强制机器人；
 *  - 未指定才按 FEISHU_IDENTITY（旧 FEISHU_SEND_AS）与授权状态解析（auto：连过就用本人）。
 * 显式 user 但未授权/失效时**绝不悄悄回退机器人**，直接中文报错。
 */
async function resolveSendToken(requested?: 'bot' | 'user'): Promise<{ token: string; identity: 'bot' | 'user' }> {
  const auth = feishuUserAuth();
  const identity = requested ?? auth.effectiveIdentity();
  if (identity === 'user') {
    try {
      return { token: await auth.accessToken(), identity };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`飞书用户身份发送失败：${reason}`);
    }
  }
  return { token: await feishuTenantToken(), identity: 'bot' };
}

/** 飞书 im/v1/files 允许的 file_type：按扩展名归类，其余统一走 stream */
function feishuFileType(a: OutboundAttachment): string {
  const ext = a.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'txt', 'md'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'xls';
  if (['ppt', 'pptx'].includes(ext)) return 'ppt';
  if (ext === 'mp4') return 'mp4';
  if (['mp3', 'wav', 'opus'].includes(ext)) return 'opus';
  return 'stream';
}

/**
 * receive_id_type 由 ID 前缀决定，而不是会话类型：
 * 入站消息的 conversation.id 始终是 chat_id（oc_，单聊/群聊通用），
 * 主动发送若显式传 open_id（ou_）/union_id（on_）也能正确投递。
 */
function feishuReceiveIdType(id: string): string {
  if (id.startsWith('ou_')) return 'open_id';
  if (id.startsWith('on_')) return 'union_id';
  return 'chat_id';
}

function safeParse(content: unknown): any {
  if (typeof content !== 'string') return content;
  try { return JSON.parse(content); } catch { return content; }
}

function pickText(content: any): string {
  if (typeof content === 'object' && content) return content.text ?? content.title ?? '';
  return String(content ?? '');
}

export function receive(raw: unknown): UnifiedMessage {
  const r = raw as any;
  // 飞书 v2 事件：{ schema, header, event: { message } }
  const e = r?.event ?? r;
  const m = e?.message ?? {};
  const content = safeParse(m.content);
  const text = pickText(content);
  // 真实飞书事件 sender 与 message 平级（在 event 层）；旧样例把 sender 放在 message 内，两者都兼容
  const sender = e?.sender ?? m?.sender ?? {};
  const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? 'unknown';
  const now = new Date().toISOString();
  const kind = m.message_type;
  const type = kind === 'image' ? 'image' : kind === 'file' ? 'file' : inferType(text);
  const chatId = m.chat_id ?? e?.chat_id;
  const chatType = m.chat_type ?? e?.chat_type;

  return {
    traceId: genTraceId(),
    platform: Platform.FEISHU,
    externalId: m.message_id ?? 'unknown',
    sender: { id: senderId, name: senderId },
    conversation: chatId
      ? { id: String(chatId), type: chatType === 'p2p' ? 'p2p' : 'group' }
      : undefined,
    type,
    body: text,
    dueAt: type === 'todo' ? inferDueAt(text) : undefined,
    // 机器人 webhook / 长连接收到的消息：如实标注来源身份（Mock 演示不写）
    ...(isMock(Platform.FEISHU) ? {} : { receivedAs: 'bot' as const }),
    status: MsgStatus.RECEIVED,
    createdAt: now,
    updatedAt: now,
  };
}

export function convert(msg: UnifiedMessage): unknown {
  return {
    receive_id: msg.conversation?.id ?? msg.sender.id,
    msg_type: 'text',
    content: JSON.stringify({ text: msg.reply ?? msg.body }),
  };
}

export function decrypt(payload: unknown): unknown {
  const p = payload as any;
  if (!p?.encrypt) return payload;
  const key = config.platforms.feishu.encryptKey;
  if (!key) throw new Error('收到加密事件，但未配置 FEISHU_ENCRYPT_KEY');
  return JSON.parse(feishuDecrypt(key, String(p.encrypt)));
}

export function challenge(payload: unknown): unknown | undefined {
  const p = payload as any;
  if (p?.type !== 'url_verification') return undefined;
  return { challenge: p.challenge };
}

export function verify(payload: unknown, sig: string): boolean {
  if (isMock(Platform.FEISHU)) return verifyMock(sig);
  const expected = config.platforms.feishu.verifyToken;
  if (!expected) return false;
  const p = payload as any;
  const token = p?.header?.token ?? p?.token;
  return typeof token === 'string' && token === expected;
}

/**
 * 发送：文本走 im/v1/messages（text），文件走「im/v1/files 上传 → im/v1/messages（file）」。
 * 文本与文件可同一笔发送；任一步失败即整笔抛错，由中枢置 failed 并写死信队列，
 * 绝不出现「文本发出去了、文件悄悄丢了却报成功」的假闭环。
 */
export async function send(msg: UnifiedMessage, attachments: OutboundAttachment[] = []): Promise<SendResult> {
  const text = msg.reply ?? msg.body;
  const payload = convert(msg) as any;
  if (isMock(Platform.FEISHU)) {
    return mockSend(
      Platform.FEISHU,
      attachments.length > 0 ? { ...payload, attachments: describeAttachments(attachments) } : payload,
    );
  }
  assertRealSendable(Platform.FEISHU);

  const chatId = msg.conversation?.id;
  if (!chatId) throw new Error('飞书真实发送缺少 conversation.id（需先收到该会话的消息）');

  const { token, identity } = await resolveSendToken(msg.sendIdentity);
  const auth = { Authorization: `Bearer ${token}` };
  const base = config.platforms.feishu.baseUrl;
  const receiveIdType = feishuReceiveIdType(chatId);
  const sendUrl = `${base}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
  const receipts: string[] = [];

  if (text) {
    const data = await postJson(sendUrl, payload, auth);
    if (data.code !== 0) throw new Error(`飞书文本发送失败: ${data.code} ${data.msg ?? ''}`);
    if (data.data?.message_id) {
      const id = String(data.data.message_id);
      receipts.push(id);
      rememberOutboundMessageId(id);
    }
  }

  for (const a of attachments) {
    const uploaded = await postMultipart(
      `${base}/open-apis/im/v1/files`,
      [
        { name: 'file_type', value: feishuFileType(a) },
        { name: 'file_name', value: a.name },
      ],
      { field: 'file', filename: a.name, contentType: a.mimeType, content: decodeAttachment(a) },
      auth,
    );
    if (uploaded.code !== 0 || !uploaded.data?.file_key) {
      throw new Error(`飞书文件上传失败: ${uploaded.code ?? 'unknown'} ${uploaded.msg ?? ''}`);
    }
    const data = await postJson(
      sendUrl,
      { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: uploaded.data.file_key }) },
      auth,
    );
    if (data.code !== 0) throw new Error(`飞书文件消息发送失败: ${data.code} ${data.msg ?? ''}`);
    if (data.data?.message_id) {
      const id = String(data.data.message_id);
      receipts.push(id);
      rememberOutboundMessageId(id);
    }
  }

  return { ok: true, mode: 'real', platformReply: receipts.join(',') || undefined, identity };
}

export const feishuConnector: PlatformConnector = {
  verify, decrypt, challenge, receive, send, isSelfEcho, convert,
};
