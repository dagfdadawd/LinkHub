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
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
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

/**
 * 提取钉钉入站正文。
 *
 * `msgtype=text` 时是 `text.content` 字符串；但 `msgtype=richText` 时 `content` 是一个
 * 对象（`{ richText: [{ text }, ...] }`），直接 String() 会得到 "[object Object]"。
 * 这里把富文本段拼成纯文本；未知结构退回空串，绝不把对象塞进消息正文。
 */
export function extractInboundText(raw: unknown): string {
  const r = raw as any;
  const direct = r?.text?.content ?? r?.content;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') {
    const segments = (direct as any).richText;
    if (Array.isArray(segments)) {
      return segments
        .map((seg: any) => (typeof seg?.text === 'string' ? seg.text : ''))
        .join('')
        .trim();
    }
  }
  return '';
}

export function receive(raw: unknown): UnifiedMessage {
  const r = raw as any;
  const text = extractInboundText(r);
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

/**
 * 本人身份发送的幂等键。
 *
 * 只按 traceId 生成会出事：同一条消息先后发两次（先回文本、再补附件，或改了措辞重发）
 * 拿到同一个 uuid，钉钉会以「Request is repeated with uuid」直接拒绝，第二次永远发不出去。
 * 加入内容指纹后：同一份内容重试 → 同一个键（保留 24h 去重），不同内容 → 不同键。
 */
export function sendIdempotencyKey(
  traceId: string,
  text: string,
  attachments: OutboundAttachment[],
): string {
  const contentTag = createHash('sha1')
    .update(text)
    .update('\u0000')
    .update(attachments.map((a) => `${a.name}:${a.size}`).join('|'))
    .digest('hex')
    .slice(0, 10);
  return `linkhub-${traceId}-${contentTag}`;
}

/** dws 图文混排一次最多上传 3 张本地图片；超出的按文件消息发 */
export const MAX_INLINE_IMAGES = 3;

/** 图片判定：MIME 优先，退化看扩展名（平台给的 mime 经常为空） */
export function isInlineImage(a: OutboundAttachment): boolean {
  return /^image\//i.test(a.mimeType ?? '') || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(a.name);
}

/**
 * 拼「文字 + 内联图片」正文。
 *
 * dws 只有把图片写进 Markdown 正文（`![标题](本地路径)`）才会**内联渲染成照片**；
 * `--msg-type file` 发出去的是「可下载的附件卡片」，手机上看到的是文件名而不是图。
 * 路径统一转成正斜杠，Windows 下 dws 也能识别。
 */
/**
 * 内联图片的落盘文件名：只保留扩展名，其余全部换成序号。
 *
 * 为什么必须是纯 ASCII：dws 走的是 Markdown 内联图（`![alt](本地路径)`），
 * 路径里出现空格或括号（`宫崎骏风格 (3).png`）会让 Markdown 链接在空格处截断，
 * dws 认不出这是图片，就把整串 `![…](…)` 当纯文本发出去——
 * 手机端表现为「图片没发出来，聊天里多了一串乱码」。原名放进 alt，仍然可读。
 */
export function inlineImageFileName(originalName: string, index = 0): string {
  const ext = (extname(basename(originalName)) || '.png').toLowerCase().replace(/[^a-z0-9.]/g, '');
  return `image-${index + 1}${ext || '.png'}`;
}

export function buildInlineContent(
  text: string,
  images: Array<{ name: string; path: string }>,
): string {
  const lines = images.map((img) => {
    // alt 里的 `]` 会提前闭合 `![...]`，换行会截断整段 markdown：换成安全字符
    const alt = img.name.replace(/[[\]\r\n]/g, (ch) => (ch === ']' ? '）' : ch === '[' ? '（' : ' '));
    return `![${alt}](${img.path.replace(/\\/g, '/')})`;
  });
  return [text.trim(), ...lines].filter(Boolean).join('\n\n');
}

/** 以本人身份发送（dws CLI）：文字与内联图片一条发出，其余文件逐条发；任一失败整笔抛错 */
async function sendViaPersonal(
  msg: UnifiedMessage,
  text: string,
  attachments: OutboundAttachment[],
): Promise<SendResult> {
  const client = dingtalkPersonalClient();
  const idempotencyKey = sendIdempotencyKey(msg.traceId, text, attachments);
  const receipts: string[] = [];
  const target = personalSendTarget(msg);

  // 引用回复语义：个人事件带 openMessageId（externalId 去掉前缀）+ 发送者 openDingTalkId 时用 reply
  const refMessageId = /^dingtalk:(.+)$/.exec(msg.externalId)?.[1];
  const canReply = msg.receivedAs === 'user'
    && Boolean(refMessageId)
    && Boolean(msg.conversation?.id)
    && msg.sender.id !== 'unknown'
    && msg.sender.id !== 'linkhub';

  // 图片走内联（≤3 张），其余附件仍按文件消息发
  const inlineImages = attachments.filter(isInlineImage).slice(0, MAX_INLINE_IMAGES);
  const plainFiles = attachments.filter((a) => !inlineImages.includes(a));

  /**
   * 临时目录按「一次发送」隔离，文件名保持用户原名。
   *
   * 原先是 `<tmp>/linkhub-dws-<uuid>.docx`：钉钉回推文件消息时会把本地文件名
   * 原样写进正文（`[文件] linkhub-dws-…docx fileId: …`），用户看到的就是一串 uuid。
   * 目录唯一已经足够，文件名不必再带随机串——回推里就是真实文件名。
   */
  const tempDir = join(tmpdir(), `linkhub-dws-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  const usedNames = new Set<string>();
  /**
   * 落盘文件名分两种：
   *  - **内联图片**必须纯 ASCII（`image-1.png`），否则 Markdown 链接会被路径里的
   *    空格/括号截断，dws 会把 `![…](…)` 当纯文本发出去（见 inlineImageFileName）。
   *  - **文件消息**保留原名：平台回推会把本地文件名写进正文，用原名才不至于显示 uuid。
   */
  const writeTemp = (a: OutboundAttachment, index: number, inline = false): string => {
    let safe: string;
    if (inline) {
      safe = inlineImageFileName(a.name, index);
    } else {
      safe = basename(a.name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';
      if (usedNames.has(safe)) safe = `${usedNames.size + 1}-${safe}`;
      usedNames.add(safe);
    }
    const p = join(tempDir, safe);
    writeFileSync(p, decodeAttachment(a));
    return p;
  };

  try {
    const content = buildInlineContent(
      text,
      inlineImages.map((a, i) => ({ name: a.name, path: writeTemp(a, i, true) })),
    );

    if (content) {
      /**
       * 带图时改走普通 send：`reply --content` 没有确认支持 Markdown 内联图，
       * 若把 `![..](..)` 当纯文本原样回显，手机上会看到一串路径，比丢引用条更糟。
       * 纯文字回复仍用 reply，保留引用关系。
       */
      const useReply = inlineImages.length === 0
        && canReply
        && Boolean(refMessageId)
        && Boolean(msg.conversation?.id);
      const outcome = useReply && refMessageId && msg.conversation?.id
        ? await client.reply({
          conversationId: msg.conversation.id,
          refMessageId,
          refSenderOpenDingtalkId: msg.sender.id,
          text: content,
          idempotencyKey,
        })
        : await client.sendText({ target, text: content, idempotencyKey });
      if (outcome.platformReply) receipts.push(outcome.platformReply);
    }

    for (const [index, a] of plainFiles.entries()) {
      const outcome = await client.sendFile({
        target,
        filePath: writeTemp(a, index),
        idempotencyKey: `${idempotencyKey}-f${index}`,
      });
      if (outcome.platformReply) receipts.push(outcome.platformReply);
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响已发送结果
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
