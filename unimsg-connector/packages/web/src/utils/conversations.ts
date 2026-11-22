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
 *  - 排序只认「最后一条消息的创建时间」，不认 `updatedAt`：改优先级 / 标已读 / 标完成
 *    都是元数据操作，不是新消息，不能让会话在列表里凭空跳到最前面。
 */
import { PRIORITY_RANK, Platform } from '../types';
import type { Priority, UnifiedMessage } from '../types';

export type ConversationKind = 'im' | 'mail';

export interface Conversation {
  key: string;
  kind: ConversationKind;
  platform: Platform;
  /** 展示名：单聊=对方，群聊=群名，邮件=主题 */
  title: string;
  /** 会话 ID（平台侧），用于按名录反查可读名字 */
  conversationId?: string;
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
  /**
   * 会话优先级：取未完成入站消息里**最紧急**的一条（见 `conversationPriorityOf`）。
   * 未判定 = undefined —— 列表不编造「普通」，只在有明确判定时给徽标。
   */
  priority?: Priority;
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
  // 平台给了会话名就用它（飞书的单聊名就是对方昵称，比 sender 的 open_id 可读）
  if (conv?.title) return conv.title;
  if (conv?.type === 'group') return '群聊';
  // 单聊：取最后一条「入站」消息的发送者作为对方；全是出站时退回会话里出现过的非本人名字
  const inbound = [...messages].reverse().find((m) => !isOut(m));
  if (inbound) return inbound.sender.name || inbound.sender.id;
  // 整段都是「我发出的」（老数据里的回声 / 我只发过没收到过）：不拿自己的名字当会话名
  if (conv?.title) return conv.title;
  return '（我发出的会话）';
}

/** 优先级排序号；未判定的消息排最后（不参与「最紧急」的竞争） */
function priorityRankOf(m: UnifiedMessage): number {
  return m.priority ? PRIORITY_RANK[m.priority] : Number.POSITIVE_INFINITY;
}

/** 一组消息里最紧急的一条（同档取最近一条）；全是未判定时返回最后一条 */
function mostUrgent(messages: UnifiedMessage[]): UnifiedMessage | undefined {
  if (messages.length === 0) return undefined;
  // 从末尾往前扫：只有「更紧急」才替换，所以同档自然保留最近的一条
  let best = messages[messages.length - 1]!;
  let bestRank = priorityRankOf(best);
  for (let i = messages.length - 2; i >= 0; i -= 1) {
    const candidate = messages[i]!;
    const rank = priorityRankOf(candidate);
    if (rank < bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * 会话优先级：未完成入站消息里最紧急的一条的优先级；没有未完成入站 = undefined。
 * 已完成的消息不再把会话标红，也就能从列表里「摘掉」。
 */
export function conversationPriorityOf(messages: UnifiedMessage[]): Priority | undefined {
  const pendingInbound = messages.filter((m) => !isOut(m) && !m.done);
  return mostUrgent(pendingInbound)?.priority;
}

/**
 * 优先级操作的目标消息：未完成入站消息里**最紧急**的一条（同档取最近一条）。
 *
 * 为什么不是「最后一条」：右键任意一条消息都能标紧急，标完必须能被列表看见；
 * 只认最后一条会让标在中间消息上的紧急永远不生效。
 * 没有未完成入站时退回最后一条入站，再退回最后一条消息（全是我发出的会话也能标记）。
 */
export function priorityTargetOf(messages: UnifiedMessage[]): UnifiedMessage {
  const inbound = messages.filter((m) => !isOut(m));
  const pending = inbound.filter((m) => !m.done);
  return mostUrgent(pending) ?? inbound[inbound.length - 1] ?? messages[messages.length - 1]!;
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
      conversationId: last.conversation?.id,
      messages: ordered,
      lastMessage: last,
      // 「最近消息」= 最后一条消息的创建时间。updatedAt 会被改优先级/标已读刷新，
      // 用它排序会让元数据操作把会话顶到第一位（线上实测过），所以缺 createdAt 才退回。
      lastAt: last.createdAt || last.updatedAt,
      unread,
      needsAction,
      priority: conversationPriorityOf(ordered),
    });
  }

  const byRecency = (a: Conversation, b: Conversation) =>
    (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0);

  /**
   * 紧急会话置顶。
   *
   * 排在最前面的是「先处理哪条」的判断，不是伪造新消息：同一个会话组里
   * 紧急的排在前面，其余仍按最近消息排序；没有置顶的不会因为改优先级而移动。
   */
  const isUrgent = (c: Conversation): number => (c.priority === 'urgent' ? 0 : 1);

  return conversations.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'im' ? -1 : 1;
    const pinned = isUrgent(a) - isUrgent(b);
    if (pinned !== 0) return pinned;
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