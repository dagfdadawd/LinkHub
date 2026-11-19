import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, App as AntApp, Button, Dropdown, Image, Tag, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CopyOutlined,
  HistoryOutlined,
  MailOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  MoreOutlined,
  PaperClipOutlined,
  ReloadOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { MsgStatus } from '../../types';
import type { AttachmentInfo, IdentityRole, OutboundAttachment, UnifiedMessage } from '../../types';
import { formatBytes } from '../../utils/attachments';
import { formatSendError } from '../../utils/sendError';
import { store } from '../../store';
import { useAppState } from '../../hooks/useAppState';
import {
  PLATFORM_META,
  TYPE_LABEL,
  conversationLabel,
  deliveryLabel,
  formatDateTime,
  shortTrace,
} from '../../utils/format';
import { AvatarBadge } from '../../components/AvatarBadge';
import { IdentityTag } from '../../components/IdentityTag';
import { PlatformTag } from '../../components/PlatformTag';
import { StatusBadge } from '../../components/StatusBadge';
import { AiSuggestion } from './AiSuggestion';
import { ReplyComposer } from './ReplyComposer';
import { StatusFlow } from './StatusFlow';
import { usePreferences } from '../settings/preferences';

/** 把焦点交给回复框：工作台的主操作是「回复」，不该让人再找一次输入框 */
function focusComposer() {
  const focus = (): boolean => {
    const el = document.querySelector<HTMLTextAreaElement>('.composer textarea');
    if (!el) return false;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    return true;
  };
  if (!focus()) window.setTimeout(focus, 80);
}

function isOut(m: UnifiedMessage): boolean {
  return m.direction === 'out';
}

/**
 * 附件列表：图片直接给缩略图（点开可放大），其它文件保持文件卡片。
 * 三处气泡共用同一个组件，避免「回复里的图」和「消息里的图」长得不一样。
 */
function AttachmentList({ items, label }: { items: AttachmentInfo[]; label: string }) {
  return (
    <ul className="file-list" aria-label={label}>
      {items.map((a, i) => (
        <li className={`file-list__item${a.preview ? ' has-preview' : ''}`} key={`${a.name}-${i}`}>
          {a.preview ? (
            <Image
              className="file-list__thumb"
              src={a.preview}
              alt={a.name}
              width={128}
              height={128}
              style={{ objectFit: 'cover', borderRadius: 10 }}
            />
          ) : (
            <span className="file-list__icon" aria-hidden="true">
              <PaperClipOutlined />
            </span>
          )}
          <span className="file-list__main">
            <span className="file-list__name">{a.name}</span>
            <span className="file-list__meta">
              {/* 平台没给大小时不写「0 B」：那是误导，不是文件真的空 */}
              {a.size > 0
                ? `${a.mimeType || '未知类型'} · ${formatBytes(a.size)}`
                : a.mimeType === 'image/*'
                  ? '图片'
                  : a.mimeType || '未知类型'}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DetailPanel({
  message,
  thread,
  conversationTitle,
  listCollapsed = false,
  onToggleList,
}: {
  /** 当前锚点消息（URL 里的 traceId 指向的那条）：更多信息 / AI 分析以它为准 */
  message: UnifiedMessage;
  /** 整个会话的消息（时间升序）；不传则退化为单条消息视图 */
  thread?: UnifiedMessage[];
  /** 会话展示名（单聊=对方 / 群聊=群名 / 邮件=主题） */
  conversationTitle?: string;
  /** 左侧列表是否已收起（收起后详情占满） */
  listCollapsed?: boolean;
  /** 收起 / 展开左侧列表；不传则不渲染切换按钮 */
  onToggleList?: () => void;
}) {
  const navigate = useNavigate();
  const { message: toast } = AntApp.useApp();
  const prefs = usePreferences();
  const state = useAppState();
  const [text, setText] = useState(message.replyDraft ?? '');
  const [sending, setSending] = useState(false);
  /** 重新生成 AI 建议：按钮 loading，避免连点重复调用模型 */
  const [regenerating, setRegenerating] = useState(false);
  /** 用户显式选中的「引用回复」目标；为空 = 普通发送（不带引用条） */
  const [quoteTarget, setQuoteTarget] = useState<UnifiedMessage | null>(null);
  /** 发送中的回复：先以气泡上屏，成功由服务端 reply 接管，失败保留并给出原因 */
  const [pendingReply, setPendingReply] = useState<{ text: string; at: number; failed?: string } | null>(null);


  /** 发送成功后短暂冷却：清空输入框 + 禁用按钮，避免手滑把同一内容再发一次（P2-2） */
  const [cooldown, setCooldown] = useState(false);
  const cooldownTimer = useRef<number>();
  /** 聊天区滚到底：会话里最新一条永远在视野内（与 IM 一致） */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 移动端长按识别（引用回复入口） */
  const longPressTimer = useRef<number>();

  const messages = thread && thread.length > 0 ? thread : [message];

  /**
   * 发送中的气泡什么时候撤掉：
   * 一旦服务端消息里已经带上这次回复（replies 最新一条 / reply 字段），就**同一帧**不画它，
   * 否则会先冒出"正式气泡"再撤回"发送中气泡"，用户看到的就是闪一下。
   */
  const pendingVisible = pendingReply
    ? !messages.some((m) => {
      const latest = m.replies && m.replies.length > 0
        ? m.replies[m.replies.length - 1].text
        : (m.reply ?? '');
      return latest.trim() === pendingReply.text.trim();
    })
    : false;
  /** 回复要挂在「最后一条入站消息」上：出站消息没有平台回写目标 */
  const replyTarget = [...messages].reverse().find((m) => !isOut(m)) ?? message;
  const threadInboundCount = messages.filter((m) => !isOut(m)).length;

  /**
   * 回声去重（老数据兜底）：同一条内容既作为入站消息的 `reply` 存在，
   * 又以独立消息（direction=out）入库时，只在「已回写」那里画一次，
   * 否则会话里会出现两条一模一样的右侧气泡。
   * 判定：同文本 + 时间相差 ≤2 分钟。
   */
  const echoDuplicates = new Set<string>();
  for (const m of messages) {
    if (!isOut(m) || !m.body) continue;
    const text = m.body.trim();
    const twin = messages.find(
      (x) =>
        x.traceId !== m.traceId &&
        !isOut(x) &&
        x.reply &&
        x.reply.trim() === text &&
        Math.abs(Date.parse(x.updatedAt) - Date.parse(m.createdAt)) <= 120_000,
    );
    if (twin) echoDuplicates.add(m.traceId);
  }
  const visibleMessages = messages.filter((m) => !echoDuplicates.has(m.traceId));

  useEffect(() => {
    setQuoteTarget(null);
    setText(replyTarget.replyDraft ?? '');
    setSending(false);
    setCooldown(false);
    window.clearTimeout(cooldownTimer.current);
    return () => window.clearTimeout(cooldownTimer.current);
  }, [replyTarget.traceId, replyTarget.replyDraft]);

  /**
   * 回复条数指纹：回复是挂在消息上的 `replies` 数组，**不改变 messages.length**，
   * 旧依赖只看消息条数/最后 traceId，所以"发完一条回复"不会触发滚动，
   * 新气泡落在视口外 —— 用户就会以为"我发的消息没显示"。
   */
  const repliesFingerprint = messages.reduce(
    (n, m) => n + (m.replies?.length ?? (m.reply ? 1 : 0)),
    0,
  );

  /**
   * 贴底跟随：只有「用户本来就在底部」时才自动滚，并且用平滑滚动。
   *
   * 之前让动效发涩的三处：
   *  1. 状态每变一次（processing → replied → sent → synced）就硬跳一次 `scrollTop`，
   *     同一秒内跳 3~4 次，气泡看起来在抖；状态变化并不改变高度，根本不需要滚；
   *  2. 用户正在往上翻历史时也会被强行拽回底部；
   *  3. 挂载时用的是同一个硬跳，和 CSS 的 `scroll-behavior: smooth` 互相打架。
   */
  const stickToBottomRef = useRef(true);
  const handleChatScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    // 96px 容差：贴底时自然跟随，稍微上翻一点就不要抢
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  // 挂载 / 换会话（本组件按会话重新挂载）：立刻到底，不要动画
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
    const raf = window.requestAnimationFrame(() => {
      el.style.scrollBehavior = prev;
    });
    return () => {
      window.cancelAnimationFrame(raf);
      el.style.scrollBehavior = prev;
    };
  }, []);

  // 新增内容（新消息 / 新回复 / 刚上屏的发送中气泡）才平滑跟随
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      // jsdom / 老浏览器没有 Element.scrollTo，退回直接赋值（不影响真实浏览器的平滑滚动）
      if (typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [
    messages.length,
    messages[messages.length - 1]?.traceId,
    repliesFingerprint,
    pendingReply?.text,
  ]);

  const canMarkDone = !message.done;
  // 投递方式：Mock 必须如实标注，不能显示成真实平台已收到；真实回写带身份时一并展示。
  // 发送失败时以失败原因/实际投递为准：不能显示「模拟发送」掩盖未送达（二轮复验收 P1）。
  const rawDeliveryLabel = deliveryLabel(message.delivery);
  const delivery = message.status === MsgStatus.FAILED && rawDeliveryLabel.kind === 'mock'
    ? { text: '发送失败（未送达平台）', kind: 'none' as const }
    : rawDeliveryLabel;
  // 回复将以哪种身份发出：只有「平台整体 Mock」才说模拟发送；
  // identity=user 但未登录时发送会失败，提示去登录，不能假称已模拟发送（UI 二轮复验 P2-4）。
  const account = state.accounts.find((a) => a.platform === replyTarget.platform);
  const platformMock = account?.identity
    ? account.identity.effectiveSend === 'mock' && account.identity.effectiveReceive === 'mock'
    : account?.mode === 'mock';
  const replyIdentity = platformMock ? 'mock' : account?.identity?.effectiveSend;
  const replyUserUnlinked = replyIdentity === 'user' && !account?.identity?.user.linked;
  const replyIdentityHint = replyIdentity === 'user'
    ? replyUserUnlinked
      ? '本人身份未登录：发送会失败，请先到「连接账号」完成钉钉本人登录'
      : '以你本人账号发出'
    : replyIdentity === 'bot'
      ? '以机器人身份发出（本人账号未连接时自动兜底）'
      : replyIdentity === 'mock'
        ? '演示模式：模拟发送，不会真的发到平台'
        : '';

  async function handleSend(attachments: OutboundAttachment[] = []) {
    const content = text.trim();
    if (!content && attachments.length === 0) return;
    setSending(true);
    // 先上屏：发送中的内容立刻作为右侧气泡出现（否则失败时对话框里什么都没有）
    setPendingReply({ text: content || `[附件] ${attachments.map((a) => a.name).join(', ')}`, at: Date.now() });
    try {
      // 回复永远跟随后端平台策略：身份只在「新建发送」里选，避免上一次的选择粘到这—条消息上
      // quoteTarget 为空则普通发送；只有用户点了「回复」才引用
      await store.reply(replyTarget.traceId, content, attachments, undefined, quoteTarget?.traceId);
      setQuoteTarget(null);
      /**
       * 提交成功不再弹 toast：气泡会立刻出现，状态（已同步/待重试）就在消息里实时变，
       * 再盖一层「已提交，正在发送」既挡视线又重复。只有失败才提示。
       */
      setPendingReply(null);
      // P2-2：清空输入框 + 2 秒防重复，避免手滑再点一次重复打扰对方
      setText('');
      setCooldown(true);
      window.clearTimeout(cooldownTimer.current);
      cooldownTimer.current = window.setTimeout(() => setCooldown(false), 2000);
    } catch (e) {
      const reason = formatSendError(
        e instanceof Error ? e.message : '发送失败，请重试',
        account?.identity,
      );
      // 失败也留在对话框里：带上原因，可一键重发（用户不会以为"消息没发出去也没痕迹"）
      setPendingReply((prev) => (prev ? { ...prev, failed: reason } : null));
      toast.error(reason);
    } finally {
      setSending(false);
    }
  }

  /**
   * 「重新生成」真接后端：用当前 LLM 配置重跑分析，store 会就地刷新消息。
   *
   * 成功（含低精度）不弹 toast：草稿、来源标签、低精度说明和回复框都已经就地更新，
   * 再浮一条提示既重复又会挡住底部「发送」按钮。只有结果可能没变化的
   * 规则兜底 / 调用失败才需要浮层把后端原因说出来。
   */
  async function handleRegenerate() {
    if (regenerating) return;
    setRegenerating(true);
    try {
      const result = await store.reanalyze(message.traceId);
      if (result.message.intentSource !== 'llm') {
        const reason = (result.llm.reason || '请检查 AI 模型配置并重启后端').slice(0, 220);
        toast.warning(`本次仍由关键词规则生成：${reason}`);
      }
    } catch (e) {
      toast.error(`重新生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRegenerating(false);
    }
  }

  /** 失败消息重试：用同一条回复内容再走一次回写，不要求用户改文案（P1-2） */
  const retryContent = replyTarget.reply?.trim() ?? '';
  const retryBlockedByAttachments = Boolean(
    replyTarget.attachments && replyTarget.attachments.length > 0,
  );
  const canRetry = retryContent.length > 0 && !retryBlockedByAttachments;

  async function handleRetry(): Promise<void> {
    if (!canRetry || sending) return;
    setSending(true);
    try {
      await store.reply(replyTarget.traceId, retryContent);
      toast.success('已重新提交，正在重试…成功/失败会实时更新');
    } catch (e) {
      toast.error(
        formatSendError(e instanceof Error ? e.message : '重试失败，请稍后再试', account?.identity),
      );
    } finally {
      setSending(false);
    }
  }

  async function handleDone() {
    try {
      await store.markDone(message.traceId);
      toast.success('已标记完成');
    } catch {
      toast.error('操作失败，请重试');
    }
  }

  async function handleMarkUnread() {
    try {
      await store.markRead(message.traceId, false);
      toast.success('已标为未读');
    } catch {
      toast.error('操作失败，请重试');
    }
  }

  async function handleMarkRead() {
    try {
      await store.markRead(message.traceId, true);
      toast.success('已标为已读');
    } catch {
      toast.error('操作失败，请重试');
    }
  }

  async function copyTrace() {
    try {
      await navigator.clipboard.writeText(message.traceId);
      toast.success('traceId 已复制');
    } catch {
      toast.info(message.traceId);
    }
  }

  /** 复制原始消息正文（AI 面板「快捷工具」与更多菜单共用） */
  async function copyBody() {
    try {
      await navigator.clipboard.writeText(message.body);
      toast.success('消息内容已复制');
    } catch {
      toast.info(message.body);
    }
  }

  const moreItems: MenuProps['items'] = [
    {
      key: 'copy-body',
      icon: <CopyOutlined />,
      label: '复制消息内容',
      onClick: () => void copyBody(),
    },
    {
      key: 'trace',
      icon: <CopyOutlined />,
      label: '复制 traceId',
      onClick: () => void copyTrace(),
    },
    {
      key: 'replay',
      icon: <HistoryOutlined />,
      label: '全链路回放',
      onClick: () => navigate(`/trace/${message.traceId}`),
    },
    ...(message.type === 'todo'
      ? [
          {
            key: 'done',
            icon: <CheckOutlined />,
            label: message.done ? '已完成' : '标记完成',
            disabled: !canMarkDone,
            onClick: () => void handleDone(),
          },
        ]
      : []),
  ];

  const headerName = conversationTitle ?? message.sender.name;
  /**
   * 整段都是自己发出的（没有对方）：标题是「（我发出的会话）」这类合成文案，
   * 取首字会得到「）」这种废字符。这时头像改用自己的发送图标，与列表行保持一致。
   */
  const headerOutOnly = threadInboundCount === 0;

  /** 单条消息的气泡（入站左 / 出站右），含附件、告警、回写内容 */
  /**
   * 回复气泡独立渲染：它按「回复发生的时刻」参与整条线程排序，
   * 不再紧贴在原消息下面（否则回复 11-12 的消息会在 11-18 跑到最上面）。
   * 每次回复各占一个气泡（来自 message.replies 历史），不会被下一次回复覆盖。
   */
  const renderReplyBubble = (
    m: UnifiedMessage,
    entry: {
      text: string;
      at: string;
      attachments?: AttachmentInfo[];
      identity?: IdentityRole;
      failed?: boolean;
      failureReason?: string;
      /** 这次回复引用了哪条消息（只有显式引用时才有） */
      quote?: { text: string; senderName: string };
    },
    isLatest: boolean,
  ) => {
    // 纯文件回复没有正文：附件必须算在气泡内容里，否则就是一个空气泡
    const files = entry.attachments
      ?? (isLatest ? m.replyAttachments : undefined)
      ?? [];
    const hasText = Boolean(entry.text?.trim());
    /**
     * 身份按「这一条回复实际用的身份」渲染（entry.identity），不再共用整条消息的
     * delivery.identity —— 同一个会话先后用本人 / 机器人回过时，共用一个标签必然错一半。
     * 老数据没有逐条身份时退回投递身份，再退回默认（本人）。
     */
    const bubbleIdentity = entry.identity ?? m.delivery?.identity ?? 'user';
    return (
      <div
        className="bubble-row bubble-row--out"
        key={`${m.traceId}:reply:${entry.at}:${entry.text}`}
        data-reply-failed={entry.failed ? 'true' : undefined}
      >
        <div className="bubble-wrap bubble-wrap--out">
          <div className={`bubble bubble--out${entry.failed ? ' is-failed' : ''}`}>
            {entry.quote && (
              <div className="bubble__quote" data-testid="quoted-block">
                <div className="bubble__quote-name">{entry.quote.senderName || '对方'}</div>
                <div className="bubble__quote-text">{entry.quote.text || '（原消息为空）'}</div>
              </div>
            )}
            {hasText && <div className="message-body">{entry.text}</div>}
            {files.length > 0 && <AttachmentList items={files} label="回复附件" />}
            {!hasText && files.length === 0 && (
              <div className="message-body bubble__empty">（空内容）</div>
            )}
          </div>
          <div className="bubble__meta bubble__meta--out">
            {entry.failed ? (
              <>
                <span className="bubble__label">发送失败</span>
                <Tooltip
                  title={
                    entry.failureReason
                      ? `原因：${formatSendError(entry.failureReason, account?.identity)}`
                      : '这条没有发出去，可直接重试'
                  }
                >
                  <span className="chip chip--warn">未送达</span>
                </Tooltip>
              </>
            ) : (
              <>
                <IdentityTag role={bubbleIdentity} action="send" short />
                <span>{formatDateTime(entry.at)}</span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  /**
   * 线程渲染顺序：**按事件发生时间升序**。
   * 一条入站消息 + 它的每一次回复都是独立事件，各自排序；
   * 只看 `reply` 单字段会让"后来的回复覆盖前一条"，对话框里永远只剩最后一句。
   */
  const threadItems = useMemo(() => {
    type Item = {
      key: string;
      at: number;
      node: 'msg' | 'reply';
      m: UnifiedMessage;
      entry?: { text: string; at: string };
      isLatest?: boolean;
    };
    const items: Item[] = [];
    for (const m of visibleMessages) {
      items.push({ key: m.traceId, at: Date.parse(m.createdAt) || 0, node: 'msg', m });
      /**
       * 回复历史：有 replies 就用 replies。
       * 没有时的历史兜底**只对入站消息成立**——出站消息（含「新建发送」）的 `reply`
       * 是「这次发出去的文本」，body 也是同一段话；把它当回复再画一遍，
       * 对话框里就会出现两条内容一模一样的气泡（线上真实出现过）。
       */
      const entries = m.replies && m.replies.length > 0
        ? m.replies
        : (!isOut(m) && m.reply ? [{ text: m.reply, at: m.updatedAt || m.createdAt }] : []);
      entries.forEach((entry, index) => {
        items.push({
          key: `${m.traceId}:reply:${index}`,
          at: Date.parse(entry.at) || 0,
          node: 'reply',
          m,
          entry,
          isLatest: index === entries.length - 1,
        });
      });
    }
    return items.sort((a, b) => a.at - b.at);
  }, [visibleMessages]);

  const renderMessage = (m: UnifiedMessage) => {
    const out = isOut(m);
    const isAnchor = m.traceId === message.traceId;

    if (out) {
      return (
        <div className="bubble-row bubble-row--out" key={m.traceId}>
          <div className="bubble-wrap bubble-wrap--out">
            <div className="bubble bubble--out">
              <div className="message-body">{m.body}</div>
              {m.attachments && m.attachments.length > 0 && (
                <AttachmentList items={m.attachments} label="附件" />
              )}
            </div>
            <div className="bubble__meta bubble__meta--out">
              {m.delivery?.mode === 'mock' ? (
                <span className="chip chip--warn">模拟发送</span>
              ) : (
                /* 没有投递记录的出站消息 = 你在手机/桌面客户端上直接发的（钉钉回声识别）。
                   早先这里只认 delivery.identity，导致「手机发的前几条有本人、后几条没有」，
                   统一按本人标注：出站且非机器人投递的，只可能是本人账号。 */
                <IdentityTag role={m.delivery?.identity ?? 'user'} action="send" short />
              )}
              <span>{formatDateTime(m.createdAt)}</span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div key={m.traceId} className={isAnchor ? 'bubble-anchor' : undefined}>
        {m.needsReview && (
          <Alert
            className="chat-alert"
            type="warning"
            showIcon
            message="OCR 置信度不足，已标记待人工确认"
            description="请先人工核对图片 / 文件中的文字，再决定回复内容。"
          />
        )}

        {m.status === MsgStatus.FAILED && (
          <Alert
            className="chat-alert"
            type="error"
            showIcon
            message="发送失败（已写入死信队列）"
            description={
              <div className="detail__fail">
                <div className="detail__fail-reason">
                  {m.failureReason
                    ? `原因：${formatSendError(m.failureReason, account?.identity)}`
                    : '暂未拿到可读原因，点「查看闭环日志」可看到完整错误。'}
                </div>
                <div className="detail__fail-actions">
                  <Button
                    size="small"
                    type="primary"
                    icon={<ReloadOutlined />}
                    loading={sending}
                    disabled={!canRetry}
                    onClick={() => void handleRetry()}
                    data-testid="retry-send"
                  >
                    重试发送
                  </Button>
                  <Button size="small" onClick={() => navigate(`/trace/${m.traceId}`)}>
                    查看闭环日志
                  </Button>
                  {!canRetry && (
                    <span className="detail__fail-hint">
                      {retryBlockedByAttachments
                        ? '含附件的失败消息请在下方回复框重新附加文件后发送'
                        : '这条消息没有可重试的回复内容'}
                    </span>
                  )}
                </div>
              </div>
            }
          />
        )}

        <div
          className="bubble-row bubble-row--in"
          onContextMenu={(e) => {
            // 桌面：右键这条消息 → 回复（引用它）
            e.preventDefault();
            setQuoteTarget(m);
            focusComposer();
          }}
          onTouchStart={() => {
            // 移动端：长按 500ms 触发（短按仍可正常点链接）
            window.clearTimeout(longPressTimer.current);
            longPressTimer.current = window.setTimeout(() => {
              setQuoteTarget(m);
              focusComposer();
            }, 500);
          }}
          onTouchEnd={() => window.clearTimeout(longPressTimer.current)}
          onTouchMove={() => window.clearTimeout(longPressTimer.current)}
          data-quote-trace={m.traceId}
        >
          <AvatarBadge name={m.sender.name} platform={m.platform} size={30} />
          <div className="bubble-wrap">
            <div className="bubble" aria-label="原始消息内容">
              <div className="message-body">{m.body}</div>

              {m.attachments && m.attachments.length > 0 && (
                <AttachmentList items={m.attachments} label="附件" />
              )}
            </div>
            <div className="bubble__meta">
              <span>{formatDateTime(m.createdAt)}</span>
              {m.type !== 'text' && (
                <span className="chip chip--type">{TYPE_LABEL[m.type]}</span>
              )}
              {m.dueAt && <span className="chip chip--type">截止 {formatDateTime(m.dueAt)}</span>}
              {m.receivedAs && <IdentityTag role={m.receivedAs} action="receive" short />}
              <button
                type="button"
                className="bubble__reply-btn"
                aria-label="回复这条消息"
                onClick={() => {
                  setQuoteTarget(m);
                  focusComposer();
                }}
              >
                回复
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="detail detail--workbench" data-testid="detail-panel">
      <div className="wb">
        <div className="wb__chat">
          <header className="chat-head">
            <div className="chat-head__lead">
              {onToggleList && (
                <Tooltip title={listCollapsed ? '展开会话列表' : '收起会话列表'}>
                  <Button
                    className="chat-head__icon"
                    type="text"
                    size="small"
                    icon={listCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                    onClick={onToggleList}
                    aria-label={listCollapsed ? '展开会话列表' : '收起会话列表'}
                  />
                </Tooltip>
              )}
              <Button
                className="chat-head__back"
                type="text"
                size="small"
                icon={<ArrowLeftOutlined />}
                onClick={() => navigate('/inbox')}
                aria-label="返回列表"
              />
              <AvatarBadge
                name={headerName}
                platform={message.platform}
                size={34}
                {...(headerOutOnly ? { icon: <SendOutlined /> } : {})}
              />
              <div className="chat-head__who">
                <div className="chat-head__name">
                  <span className="chat-head__name-text" title={headerName}>
                    {headerName}
                  </span>
                  <PlatformTag platform={message.platform} small />
                  {message.conversation?.type === 'group' && (
                    <span className="conv-row__tag">群</span>
                  )}
                </div>
                <div className="chat-head__meta" title={message.externalId}>
                  <span>{conversationLabel(message)}</span>
                  <span className="chat-head__dot" aria-hidden="true">·</span>
                  <span>{threadInboundCount} 条收到的消息</span>
                  <span className="chat-head__dot" aria-hidden="true">·</span>
                  <span>{formatDateTime(messages[messages.length - 1].createdAt)}</span>
                </div>
              </div>
            </div>

            <div className="chat-head__tags">
              <StatusBadge status={message.status} small />
              {message.needsReview && <span className="chip chip--warn">需人工确认</span>}
              {message.done && <span className="chip chip--done">已完成</span>}
              {message.receivedAs && <IdentityTag role={message.receivedAs} action="receive" />}
            </div>

            <div className="chat-head__actions">
              <Tooltip title="标记为未读，会回到未读筛选">
                <Button
                  size="small"
                  type="text"
                  icon={<MailOutlined />}
                  onClick={handleMarkUnread}
                  aria-label="标为未读"
                />
              </Tooltip>
              <Tooltip title="回复这个会话（R）">
                <Button
                  size="small"
                  type="text"
                  icon={<MessageOutlined />}
                  onClick={focusComposer}
                  aria-label="回复"
                />
              </Tooltip>
              <Dropdown menu={{ items: moreItems }} trigger={['click']} placement="bottomRight">
                <Button size="small" type="text" icon={<MoreOutlined />} aria-label="更多操作" />
              </Dropdown>
            </div>
          </header>

          <div className="chat-scroll" ref={scrollRef} onScroll={handleChatScroll}>
            <div className="thread">
              {threadItems.map((item) => (
                item.node === 'reply' && item.entry
                  ? renderReplyBubble(item.m, item.entry, Boolean(item.isLatest))
                  : renderMessage(item.m)
              ))}

              {/* 发送中的回复：立刻上屏，成功后被服务端 reply 接管，失败保留并给出重试 */}
              {pendingVisible && pendingReply && (
                <div className="bubble-row bubble-row--out bubble-row--pending" data-testid="pending-reply">
                  <div className="bubble-wrap bubble-wrap--out">
                    <div className={`bubble bubble--out${pendingReply.failed ? ' is-failed' : ''}`}>
                      <div className="message-body">{pendingReply.text}</div>
                    </div>
                    <div className="bubble__meta bubble__meta--out">
                      {pendingReply.failed ? (
                        <>
                          <span className="pending-reply__error">{pendingReply.failed}</span>
                          <Button
                            size="small"
                            type="link"
                            loading={sending}
                            onClick={() => void handleSend()}
                          >
                            重发
                          </Button>
                          <Button size="small" type="link" onClick={() => setPendingReply(null)}>
                            丢弃
                          </Button>
                        </>
                      ) : (
                        <span>发送中…</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* 状态流转 + 消息信息：降级成可展开详情，不占阅读空间 */}
              <details className="detail__more">
                <summary>更多信息（状态流转 / 会话 / 外部 ID / traceId / 投递方式）</summary>
                <dl className="meta-grid">
                  <div>
                    <dt>发送人</dt>
                    <dd>
                      {message.sender.name}（{message.sender.id}）
                    </dd>
                  </div>
                  <div>
                    <dt>平台</dt>
                    <dd>{PLATFORM_META[message.platform].name}</dd>
                  </div>
                  <div>
                    <dt>会话</dt>
                    <dd title={message.conversation ? `会话 ID：${message.conversation.id}` : undefined}>
                      {conversationLabel(message)}
                    </dd>
                  </div>
                  <div>
                    <dt>类型</dt>
                    <dd>{TYPE_LABEL[message.type]}</dd>
                  </div>
                  <div>
                    <dt>外部 ID</dt>
                    <dd className="mono">{message.externalId}</dd>
                  </div>
                  <div>
                    <dt>创建时间</dt>
                    <dd>{formatDateTime(message.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>更新时间</dt>
                    <dd>{formatDateTime(message.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt>接收身份</dt>
                    <dd
                      title={
                        message.receivedAs
                          ? '这条消息进入 LinkHub 时实际使用的身份'
                          : '这条消息未记录接收身份（Mock / 演示消息或旧数据），不冒充真实接收'
                      }
                    >
                      {message.receivedAs ? (
                        <IdentityTag role={message.receivedAs} action="receive" />
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div className="meta-grid__wide">
                    <dt>投递方式</dt>
                    <dd title={delivery.kind === 'none' ? undefined : delivery.text}>
                      {delivery.kind === 'none' ? (
                        '—'
                      ) : (
                        <Tag color={delivery.kind === 'mock' ? 'warning' : 'success'}>{delivery.text}</Tag>
                      )}
                    </dd>
                  </div>
                  <div className="meta-grid__wide">
                    <dt>traceId</dt>
                    <dd className="mono">
                      {message.traceId}（{shortTrace(message.traceId)}）
                    </dd>
                  </div>
                </dl>
                <div className="detail__more-flow">
                  <StatusFlow status={message.status} />
                </div>
              </details>
            </div>
          </div>

          <footer className="chat-foot">
            {replyIdentity && (
              <div className="composer__identity" data-testid="reply-identity">
                <span className="composer__identity-label">本次回复</span>
                {/* 回复不提供身份切换：一律跟随后端平台策略（用户要换身份去「新建发送」）。
                    这里只如实显示这次会以哪个身份发出。 */}
                <Tooltip title={replyIdentityHint || undefined}>
                  <span>
                    <IdentityTag role={replyIdentity} action="send" />
                  </span>
                </Tooltip>
              </div>
            )}
            <ReplyComposer
              message={replyTarget}
              value={text}
              sending={sending}
              sendDisabled={cooldown}
              {...(quoteTarget
                ? {
                  quote: {
                    text: String(quoteTarget.body ?? '').slice(0, 120),
                    senderName: quoteTarget.sender?.name ?? '',
                  },
                }
                : {})}
              onClearQuote={() => setQuoteTarget(null)}
              onChange={setText}
              onSend={handleSend}
            />
          </footer>
        </div>

        {prefs.showAiDraft && (
          <AiSuggestion
            message={message}
            onUseDraft={(draft) => {
              setText(draft);
              focusComposer();
            }}
onRegenerate={() => void handleRegenerate()}
            regenerating={regenerating}
            onCopyBody={() => void copyBody()}
            onMarkRead={() => void (message.readAt ? handleMarkUnread() : handleMarkRead())}
            onMarkDone={message.done ? undefined : () => void handleDone()}
            onTrace={() => navigate(`/trace/${message.traceId}`)}
          />
        )}
      </div>
    </div>
  );
}
