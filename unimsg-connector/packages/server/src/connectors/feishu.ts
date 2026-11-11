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
import { feishuTenantToken, postJson, postMultipart } from './real';
import { decodeAttachment, describeAttachments } from '../services/outbound';

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
  const senderId = m.sender?.sender_id?.user_id ?? m.sender?.sender_id?.open_id ?? 'unknown';
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

  const token = await feishuTenantToken();
  const auth = { Authorization: `Bearer ${token}` };
  const base = config.platforms.feishu.baseUrl;
  const receiveIdType = msg.conversation?.type === 'p2p' ? 'open_id' : 'chat_id';
  const sendUrl = `${base}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
  const receipts: string[] = [];

  if (text) {
    const data = await postJson(sendUrl, payload, auth);
    if (data.code !== 0) throw new Error(`飞书文本发送失败: ${data.code} ${data.msg ?? ''}`);
    if (data.data?.message_id) receipts.push(String(data.data.message_id));
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
    if (data.data?.message_id) receipts.push(String(data.data.message_id));
  }

  return { ok: true, mode: 'real', platformReply: receipts.join(',') || undefined };
}

export const feishuConnector: PlatformConnector = { verify, decrypt, challenge, receive, send, convert };
