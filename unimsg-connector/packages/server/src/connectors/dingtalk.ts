/**
 * 钉钉连接器（企业内部机器人 + 本人身份）。
 *
 * receive：解析钉钉回调（conversationId / senderStaffId / msgId）→ 统一消息。
 * convert：统一消息 → 机器人发送参数。
 * send   ：按身份分流——
 *           · 本人身份（effectiveSend/sendIdentity = user）→ 走官方 dws CLI 以当前登录用户发送；
 *           · 机器人身份 → 现有企业内部机器人接口；
 *           · Mock 模式（显式 mock 或 auto 无凭据且未固定本人）→ 本地模拟，绝不外呼。
 * verify ：Mock 模式宽松验签；否则校验 timestamp + HMAC 签名。
 * decrypt：AES 解密 encrypt 字段。
 */
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  Platform, MsgStatus, UnifiedMessage, PlatformConnector,
  type SendResult, type OutboundAttachment,
} from '@unimsg/shared';
import { config } from '../config';
import { genTraceId, mockSend, verifyMock, inferType, inferDueAt, isMock, assertRealSendable } from './base';
import { dingtalkDecrypt, dingtalkSign, safeEqual } from './crypto';
import { dingtalkAccessToken, postJson, postMultipart } from './real';
import { DingtalkPersonalError, dingtalkPersonalClient, type DwsSendTarget } from './dingtalkPersonal';
import { identityChannelsReal, resolveIdentity } from '../services/identity';
import { decodeAttachment, describeAttachments, isOutboundComposed } from '../services/outbound';

/** 媒体上传固定在 oapi 老域名（新域名只有机器人发消息/下载，没有 upload） */
const DINGTALK_MEDIA_UPLOAD_URL = 'https://oapi.dingtalk.com/media/upload';

function header(headers: Record<string, string | string[] | undefined> | undefined, name: string): string {
  const v = headers?.[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * 会话映射：钉钉回调里群聊是 conversationType='2'（文档为字符串），
 * 但不同入口/版本偶尔给数字 2 或 'group'，这里统一兼容，
 * 避免群消息被误判成单聊——单聊分支会把回复私聊给发送人，而不是发回群里。
 */
export function parseConversation(r: any): UnifiedMessage['conversation'] {
  const id = r?.conversationId;
  if (id === undefined || id === null || String(id).trim() === '') return undefined;

  const rawType = r?.conversationType;
  const typeText = String(rawType ?? '').trim().toLowerCase();
  const isGroup = rawType === 2 || typeText === '2' || typeText === 'group';

  const title = isGroup && r?.conversationTitle ? String(r.conversationTitle).trim() : '';
  return { id: String(id), type: isGroup ? 'group' : 'p2p', ...(title ? { title } : {}) };
}

/**
 * 入站事件的一行摘要（Stream 日志用）：
 * 钉钉 Stream 只推「单聊」和「群聊里 @机器人」的消息，普通群消息平台根本不会推送。
 * 所以这条日志是排查「群里 @ 了机器人却没反应」最直接的判据：
 * 有这行 = 平台确实推到了；没有 = 平台没推（机器人没进群 / 不是同一个应用机器人 / 连接断开）。
 */
export function describeInbound(raw: unknown): string {
  const r = raw as any;
  const conversation = parseConversation(r);
  const where = !conversation
    ? '无会话'
    : conversation.type === 'group'
      ? `群聊${conversation.title ? `「${conversation.title}」` : ''}`
      : '单聊';
  const sender = r?.senderNick ?? r?.senderStaffId ?? r?.senderId ?? '未知发送者';
  return `收到钉钉消息：${where} · 发送者=${sender} · 类型=${r?.msgtype ?? 'unknown'} · msgId=${r?.msgId ?? '?'}`;
}

export function receive(raw: unknown): UnifiedMessage {
  const r = raw as any;
  const text = r?.text?.content ?? r?.content ?? '';
  const senderId = r?.senderStaffId ?? r?.senderId ?? 'unknown';
  const now = new Date().toISOString();
  const type = r?.msgtype === 'image' ? 'image'
    : r?.msgtype === 'file' ? 'file' : inferType(text);

  return {
    traceId: genTraceId(),
    platform: Platform.DINGTALK,
    externalId: r?.msgId ?? 'unknown',
    sender: { id: senderId, name: r?.senderNick ?? senderId },
    conversation: parseConversation(r),
    type,
    body: String(text),
    dueAt: type === 'todo' ? inferDueAt(String(text)) : undefined,
    // 机器人 Stream / 回调收到的消息：如实标注来源（Mock 演示不写）
    ...(isMock(Platform.DINGTALK) ? {} : { receivedAs: 'bot' as const }),
    status: MsgStatus.RECEIVED,
    createdAt: now,
    updatedAt: now,
  };
}

export function convert(msg: UnifiedMessage): unknown {
  return {
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: msg.reply ?? msg.body }),
  };
}

export function decrypt(payload: unknown): unknown {
  const p = payload as any;
  if (!p?.encrypt) return payload;
  const key = config.platforms.dingtalk.aesKey;
  if (!key) throw new Error('收到加密回调，但未配置 DINGTALK_AES_KEY');
  return JSON.parse(dingtalkDecrypt(key, String(p.encrypt)));
}

export function verify(
  _payload: unknown,
  _sig: string,
  headers?: Record<string, string | string[] | undefined>,
): boolean {
  if (isMock(Platform.DINGTALK)) return verifyMock(_sig);

  const { aesToken, aesKey } = config.platforms.dingtalk;
  if (!aesToken || !aesKey) return false;

  const timestamp = header(headers, 'timestamp');
  const sign = header(headers, 'sign');
  if (!timestamp || !sign) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 60 * 60 * 1000) return false;

  return safeEqual(dingtalkSign(aesToken, timestamp, aesKey), sign);
}

/**
 * 发送：按「本次身份」分流（契约 §4）。
 *
 * 优先级（顺序不可调换）：
 *  1) 显式 `*_MODE=mock`（或 auto 无机器人凭据且未固定本人）→ 本地模拟，绝不外呼 dws；
 *  2) 显式 `msg.sendIdentity` 优先，否则用平台 effectiveSend；
 *  3) 本人身份 → dws CLI（真实接口，返回 identity='user'）；
 *  4) 机器人身份 → 既有企业内部机器人接口（identity='bot'）。
 *
 * 本人身份附件：dws 只接受本地文件路径，因此把 base64 写临时文件 → 发送 → 立即删除；
 * 发送失败也要清理，绝不残留明文附件。
 */
export async function send(msg: UnifiedMessage, attachments: OutboundAttachment[] = []): Promise<SendResult> {
  const text = msg.reply ?? msg.body;
  const payload = convert(msg) as any;
  const personalReal = identityChannelsReal(Platform.DINGTALK);

  // 1) 不真实：本地模拟（显式 mock 绝不触发 dws 外呼）
  if (!personalReal) {
    return mockSend(
      Platform.DINGTALK,
      attachments.length > 0 ? { ...payload, attachments: describeAttachments(attachments) } : payload,
    );
  }

  const view = resolveIdentity(Platform.DINGTALK);
  const wanted: 'bot' | 'user' = msg.sendIdentity ?? (view.effectiveSend === 'user' ? 'user' : 'bot');

  // 3) 本人身份：dws 子进程
  if (wanted === 'user') {
    // 明确防护：身份策略=user 但 dws 尚未登录时，给可操作的中文原因（进 failureReason/DLQ 也能看懂），
    // 不落到「缺少会话」/底层英文错误；这是用户操作问题，不重试（避免无谓等待）。
    if (!view.user.linked) {
      const err = new DingtalkPersonalError(
        '钉钉本人身份未登录：请先完成钉钉本人登录（连接账号 → 用钉钉本人账号登录）。',
        'not-logged-in',
      );
      (err as unknown as { noRetry?: boolean }).noRetry = true;
      throw err;
    }
    return sendViaPersonal(msg, text, attachments);
  }

  // 4) 机器人身份：保持既有行为
  return sendViaBot(msg, text, payload, attachments);
}

/** 解析本人身份发送目标：有会话 ID 用 --conversation-id；只有单聊对方时退回 --user */
function personalSendTarget(msg: UnifiedMessage): DwsSendTarget {
  const convId = msg.conversation?.id;
  if (convId) return { conversationId: convId };
  const peer = msg.sender.id;
  if (msg.conversation?.type === 'p2p' && peer && peer !== 'linkhub' && peer !== 'unknown') {
    return { userId: peer };
  }
  throw new Error(
    '钉钉本人身份发送缺少目标会话：请先收到该会话的一条消息，或在「新建发送」里填写 conversationId（openConversationId）。',
  );
}

/** 以本人身份发送（dws CLI）。文本先发、再逐个发文件；任一失败整笔抛错（由中枢置 failed + 死信） */
async function sendViaPersonal(
  msg: UnifiedMessage,
  text: string,
  attachments: OutboundAttachment[],
): Promise<SendResult> {
  const client = dingtalkPersonalClient();
  // 幂等键：同一 traceId 重试时 dws 侧 24h 内不会重复发送
  const idempotencyKey = `linkhub-${msg.traceId}`;
  const receipts: string[] = [];
  const target = personalSendTarget(msg);

  // 引用回复语义：个人事件带 openMessageId（externalId 去掉前缀）+ 发送者 openDingTalkId 时用 reply
  const refMessageId = /^dingtalk:(.+)$/.exec(msg.externalId)?.[1];
  const canReply = msg.receivedAs === 'user'
    && Boolean(refMessageId)
    && Boolean(msg.conversation?.id)
    && msg.sender.id !== 'unknown'
    && msg.sender.id !== 'linkhub';

  if (text) {
    const outcome = canReply && refMessageId && msg.conversation?.id
      ? await client.reply({
        conversationId: msg.conversation.id,
        refMessageId,
        refSenderOpenDingtalkId: msg.sender.id,
        text,
        idempotencyKey,
      })
      : await client.sendText({ target, text, idempotencyKey });
    if (outcome.platformReply) receipts.push(outcome.platformReply);
  }

  for (const a of attachments) {
    const ext = extname(a.name) || '.bin';
    const filePath = join(tmpdir(), `linkhub-dws-${randomUUID()}${ext}`);
    try {
      writeFileSync(filePath, decodeAttachment(a));
      const outcome = await client.sendFile({ target, filePath, idempotencyKey: `${idempotencyKey}-${ext}` });
      if (outcome.platformReply) receipts.push(outcome.platformReply);
    } finally {
      try {
        unlinkSync(filePath);
      } catch {
        // 临时文件清理失败不影响已发送结果
      }
    }
  }

  return {
    ok: true,
    mode: 'real',
    platformReply: receipts.join(',') || undefined,
    identity: 'user',
  };
}

/** 机器人身份发送：文本沿用 sampleText；文件走「oapi media/upload → sampleFile(mediaId)」 */
async function sendViaBot(
  msg: UnifiedMessage,
  text: string,
  payload: any,
  attachments: OutboundAttachment[],
): Promise<SendResult> {
  assertRealSendable(Platform.DINGTALK);

  const { robotCode } = config.platforms.dingtalk;
  if (!robotCode) throw new Error('未配置 DINGTALK_ROBOT_CODE');

  const token = await dingtalkAccessToken();
  const headers = { 'x-acs-dingtalk-access-token': token };
  const base = config.platforms.dingtalk.baseUrl;
  const isP2p = msg.conversation?.type === 'p2p';
  if (!isP2p && !msg.conversation?.id) throw new Error('钉钉群消息缺少 conversation.id');

  const targetUser = isOutboundComposed(msg)
    ? (msg.conversation?.id ?? msg.sender.id)
    : msg.sender.id;
  const sendOne = async (body: Record<string, unknown>): Promise<any> => {
    if (isP2p) {
      return postJson(
        `${base}/v1.0/robot/oToMessages/batchSend`,
        { robotCode, userIds: [targetUser], ...body },
        headers,
      );
    }
    return postJson(
      `${base}/v1.0/robot/groupMessages/send`,
      { robotCode, openConversationId: msg.conversation!.id, ...body },
      headers,
    );
  };

  const receipts: string[] = [];
  if (text) {
    const data = await sendOne(payload);
    if (data?.processQueryKey) receipts.push(String(data.processQueryKey));
  }

  for (const a of attachments) {
    // 媒体上传在 oapi 老域名；api.dingtalk.com 没有 /v1.0/robot/media/upload（会 404 InvalidAction.NotFound）
    const uploaded = await postMultipart(
      `${DINGTALK_MEDIA_UPLOAD_URL}?access_token=${encodeURIComponent(token)}`,
      [{ name: 'type', value: 'file' }],
      { field: 'media', filename: a.name, contentType: a.mimeType, content: decodeAttachment(a) },
    );
    if (uploaded?.errcode !== 0 || !uploaded?.media_id) {
      throw new Error(
        `钉钉媒体上传失败（文件 ${a.name}）：${uploaded?.errcode ?? 'no-errcode'} ${uploaded?.errmsg ?? '未返回 media_id'}`,
      );
    }
    const mediaId = String(uploaded.media_id);
    const ext = a.name.includes('.') ? a.name.split('.').pop()!.toLowerCase() : '';
    const data = await sendOne({
      msgKey: 'sampleFile',
      msgParam: JSON.stringify({ mediaId, fileName: a.name, ...(ext ? { fileType: ext } : {}) }),
    });
    if (data?.processQueryKey) receipts.push(String(data.processQueryKey));
  }

  return { ok: true, mode: 'real', platformReply: receipts.join(',') || undefined, identity: 'bot' };
}

export const dingtalkConnector: PlatformConnector = { verify, decrypt, receive, send, convert };
