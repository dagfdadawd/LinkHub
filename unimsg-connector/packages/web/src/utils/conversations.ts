/**
 * 会话（thread）聚合：把「一条条消息」折叠成「一个个人 / 一个个群」。
 *
 * 为什么在前端做：消息里已经有 `conversation.id`（钉钉单聊 / 群聊、飞书 chat_id），
 * 同一个会话的所有消息这个 ID 完全一致，所以聚合不需要新的后端接口，
 * 也不影响「待办 / 全链路回放 / 失败重试」这些按条记录的能力——会话只是视图。
 *
 * 规则：
 *  - 会话键 = 平台 + 会话 ID；没有会话 ID 的退化为「平台 + 对方 ID」；再没有才按单条独立。
 *  - 邮件单独按「主题」聚合（去掉 Re:/Fwd: 前缀），因为邮件没有"好友"概念，
 *    按发件人合并会把不同事情的邮件糊成一条。
 *  - 未读只统计 `direction !== 'out'`：自己发出的消息（含钉钉回声）不产生未读。
 */
import { Platform } from '../types';
import type { UnifiedMessage } from '../types';

export type ConversationKind = 'im' | 'mail';

export interface Conversation {
  key: string;
  kind: ConversationKind;
  platform: Platform;
  /** 展示名：单聊=对方，群聊=群名，邮件=主题 */
  title: string;
  /** 会话类型（p2p / group），邮件为空 */
  conversationType?: 'p2p' | 'group';
  /** 时间升序 */
  messages: UnifiedMessage[];
  lastMessage: UnifiedMessage;
  lastAt: string;
  /** 入站未读条数 */
  unread: number;
  /** 需要动作的条数（待人工确认 / 发送失败） */
  needsAction: number;
}

const SUBJECT_PREFIX = /^\s*(?:(?:re|fw|fwd|回复|转发)\s*[:：]\s*)+/i;

/** 邮件主题归一：去 Re:/Fwd: 前缀与首尾空白，用于按主题聚合 */
export function normalizeSubject(subject: string): string {
  return subject.replace(SUBJECT_PREFIX, '').trim();
}

function mailSubject(m: UnifiedMessage): string {
  const raw = m.mailMeta?.subject ?? '';
  return normalizeSubject(raw);
}

/** 平台原始 ID（没有昵称时的标题）：飞书 ou_/oc_、钉钉 cid… 这类 */
const RAW_ID_RE = /^(ou_|oc_|on_|open_|cid|user_)[A-Za-z0-9_+/=-]{6,}$/;

/**
 * 会话标题的可读化兜底。
 *
 * 飞书「本人身份」轮询回来的单聊没有昵称（sender.name 直接是 open_id），
 * 直接把 ou_43c4… 摆给用户看等于没说「发给谁」。这里把纯 ID 标题降级成
 * 「未命名会话（…2084）」，原始 ID 仍保留在 title 属性里可查。
 */
export function formatConversationTitle(title: string, platform: Platform): string {
  const text = (title ?? '').trim();
  if (!text) return '未命名会话';
  if (!RAW_ID_RE.test(text)) return text;
  const tail = text.slice(-4);
  return platform === Platform.MAIL ? `未命名邮件（…${tail}）` : `未命名会话（…${tail}）`;
}

/** 标题是否只是平台 ID（用于给 title 属性补原文、以及决定是否显示「未命名」暗示） */
export function isRawIdTitle(title: string): boolean {
  return RAW_ID_RE.test((title ?? '').trim());
}

/** 会话键：同一条链路的消息必须落到同一个键上 */
export function conversationKey(m: UnifiedMessage): string {
  const convId = m.conversation?.id?.trim();
  if (m.platform === Platform.MAIL) {
    const subject = mailSubject(m);
    // 邮件：账号 + 主题；没有主题时退回「账号 + 对方」，绝不把所有邮件并成一条
    const account = m.mailMeta?.account ?? 'mail';
    const fallback = convId || m.sender.id || m.sender.name || m.traceId;
    return `${m.platform}:mail:${account}:${subject || fallback}`;
  }
  if (convId) return `${m.platform}:${convId}`;
  const peer = m.direction === 'out' ? '' : m.sender.id;
  return `${m.platform}:peer:${peer || m.traceId}`;
}

function isOut(m: UnifiedMessage): boolean {
  return m.direction === 'out';
}

/** 会话展示名：群用群名，单聊用对方名字，邮件用主题 */
function conversationTitle(messages: UnifiedMessage[], platform: Platform): string {
  const last = messages[messages.length - 1];
  if (platform === Platform.MAIL) {
    const subject = mailSubject(last);
    if (subject) return subject;
    return last.sender.name || last.sender.id || '邮件';
  }
  const conv = last.conversation;
  if (conv?.type === 'group' && conv.title) return conv.title;
  // 单聊：取最后一条「入站」消息的发送者作为对方；全是出站时退回会话里出现过的非本人名字
  const inbound = [...messages].reverse().find((m) => !isOut(m));
  if (inbound) return inbound.sender.name || inbound.sender.id;
  // 整段都是「我发出的」（老数据里的回声 / 我只发过没收到过）：不拿自己的名字当会话名
  if (conv?.title) return conv.title;
  return '（我发出的会话）';
}

/** 按会话聚合，返回排序后的列表：IM 在前、邮件在后，各自最近消息优先 */
export function buildConversations(messages: UnifiedMessage[]): Conversation[] {
  const map = new Map<string, UnifiedMessage[]>();
  for (const m of messages) {
    const key = conversationKey(m);
    const list = map.get(key);
    if (list) list.push(m);
    else map.set(key, [m]);
  }

  const conversations: Conversation[] = [];
  for (const [key, list] of map) {
    // 时间升序：线程按时间读，最后一条决定排序与摘要
    const ordered = [...list].sort((a, b) => {
      const ta = Date.parse(a.createdAt || a.updatedAt);
      const tb = Date.parse(b.createdAt || b.updatedAt);
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    });
    const last = ordered[ordered.length - 1];
    const platform = last.platform;
    const kind: ConversationKind = platform === Platform.MAIL ? 'mail' : 'im';
    const unread = ordered.filter((m) => !isOut(m) && !m.readAt).length;
    const needsAction = ordered.filter((m) => m.needsReview || m.status === 'failed').length;
    conversations.push({
      key,
      kind,
      platform,
      title: conversationTitle(ordered, platform),
      conversationType: last.conversation?.type,
      messages: ordered,
      lastMessage: last,
      lastAt: last.updatedAt || last.createdAt,
      unread,
      needsAction,
    });
  }

  const byRecency = (a: Conversation, b: Conversation) =>
    (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0);

  return conversations.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'im' ? -1 : 1;
    return byRecency(a, b);
  });
}

/** 取某条消息所属的会话（详情页用 URL 里的 traceId 反查） */
export function findConversation(
  conversations: Conversation[],
  traceId: string | undefined,
): Conversation | undefined {
  if (!traceId) return undefined;
  return conversations.find((c) => c.messages.some((m) => m.traceId === traceId));
}

/** 会话里的「当前分析对象」：最后一条入站消息（没有入站时退回最后一条） */
export function analyzeTarget(conversation: Conversation): UnifiedMessage {
  const inbound = [...conversation.messages].reverse().find((m) => !isOut(m));
  return inbound ?? conversation.lastMessage;
}

/** 会话里待回复的目标消息（回复要挂在入站消息上） */
export function replyTarget(conversation: Conversation): UnifiedMessage | undefined {
  return [...conversation.messages].reverse().find((m) => !isOut(m));
}

/** 列表摘要文案：最后一句话 + 方向前缀 */
export function conversationSnippet(conversation: Conversation): string {
  const m = conversation.lastMessage;
  const text = (m.body ?? '').trim();
  return m.direction === 'out' ? `我：${text}` : text;
}