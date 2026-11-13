import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, App as AntApp, Button, Dropdown, Tag, Tooltip } from 'antd';
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
import type { OutboundAttachment, UnifiedMessage } from '../../types';
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
  /** 发送成功后短暂冷却：清空输入框 + 禁用按钮，避免手滑把同一内容再发一次（P2-2） */
  const [cooldown, setCooldown] = useState(false);
  const cooldownTimer = useRef<number>();
  /** 聊天区滚到底：会话里最新一条永远在视野内（与 IM 一致） */
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const messages = thread && thread.length > 0 ? thread : [message];
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
    setText(replyTarget.replyDraft ?? '');
    setSending(false);
    setCooldown(false);
    window.clearTimeout(cooldownTimer.current);
    return () => window.clearTimeout(cooldownTimer.current);
  }, [replyTarget.traceId, replyTarget.replyDraft]);

  // 换会话 / 新消息进来后，把聊天记录定位到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.traceId, selectedStatusKey(messages)]);

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
    try {
      await store.reply(replyTarget.traceId, content, attachments);
      // P1-2：「已提交」不等于「已发出」；演示模式必须显式写「模拟发送」（P2-6）
      toast.success(
        replyIdentity === 'mock'
          ? '已模拟发送（不会真的发到平台）…状态会在消息里实时更新'
          : attachments.length > 0
            ? `已提交，正在发送（含 ${attachments.length} 个附件）…状态会在消息里实时更新`
            : '已提交，正在发送…状态会在消息里实时更新',
      );
      // P2-2：清空输入框 + 2 秒防重复，避免手滑再点一次重复打扰对方
      setText('');
      setCooldown(true);
      window.clearTimeout(cooldownTimer.current);
      cooldownTimer.current = window.setTimeout(() => setCooldown(false), 2000);
    } catch (e) {
      toast.error(
        formatSendError(e instanceof Error ? e.message : '发送失败，请重试', account?.identity),
      );
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

  /** 单条消息的气泡（入站左 / 出站右），含附件、告警、回写内容 */
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
                <ul className="file-list" aria-label="附件">
                  {m.attachments.map((a, i) => (
                    <li className="file-list__item" key={`${a.name}-${i}`}>
                      <span className="file-list__icon" aria-hidden="true">
                        <PaperClipOutlined />
                      </span>
                      <span className="file-list__main">
                        <span className="file-list__name">{a.name}</span>
                        <span className="file-list__meta">
                          {a.mimeType || '未知类型'} · {formatBytes(a.size)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bubble__meta bubble__meta--out">
              <span className="bubble__label">
                <SendOutlined aria-hidden="true" /> 我发出的
              </span>
              {m.delivery?.mode === 'mock' ? (
                <span className="chip chip--warn">模拟发送</span>
              ) : m.delivery?.identity ? (
                <IdentityTag role={m.delivery.identity} action="send" short />
              ) : null}
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

        <div className="bubble-row bubble-row--in">
          <AvatarBadge name={m.sender.name} platform={m.platform} size={30} />
          <div className="bubble-wrap">
            <div className="bubble" aria-label="原始消息内容">
              <div className="message-body">{m.body}</div>

              {m.attachments && m.attachments.length > 0 && (
                <ul className="file-list" aria-label="附件">
                  {m.attachments.map((a, i) => (
                    <li className="file-list__item" key={`${a.name}-${i}`}>
                      <span className="file-list__icon" aria-hidden="true">
                        <PaperClipOutlined />
                      </span>
                      <span className="file-list__main">
                        <span className="file-list__name">{a.name}</span>
                        <span className="file-list__meta">
                          {a.mimeType || '未知类型'} · {formatBytes(a.size)}
                        </span>
                      </span>
                      <Tooltip title="附件内容只用于投递，不落库，因此这里只展示元信息">
                        <span className="file-list__hint">仅元信息</span>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bubble__meta">
              <span>{formatDateTime(m.createdAt)}</span>
              {m.type !== 'text' && (
                <span className="chip chip--type">{TYPE_LABEL[m.type]}</span>
              )}
              {m.dueAt && <span className="chip chip--type">截止 {formatDateTime(m.dueAt)}</span>}
              {m.receivedAs && <IdentityTag role={m.receivedAs} action="receive" short />}
            </div>
          </div>
        </div>

        {/* 这条消息的回写内容：紧跟在它下面，作为右侧气泡 */}
        {m.reply && (
          <div className="bubble-row bubble-row--out">
            <div className="bubble-wrap bubble-wrap--out">
              <div className="bubble bubble--out">
                <div className="message-body">{m.reply}</div>
              </div>
              <div className="bubble__meta bubble__meta--out">
                <span className="bubble__label">
                  <SendOutlined aria-hidden="true" />{' '}
                  {m.status === MsgStatus.FAILED ? '待重试的回复' : '已回写'}
                </span>
                {m.status === MsgStatus.FAILED && delivery.kind !== 'none' && (
                  <span className="chip chip--type">{delivery.text}</span>
                )}
                <span>{formatDateTime(m.updatedAt)}</span>
              </div>
            </div>
          </div>
        )}
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
              <AvatarBadge name={headerName} platform={message.platform} size={34} />
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

          <div className="chat-scroll" ref={scrollRef}>
            <div className="thread">
              {visibleMessages.map((m) => renderMessage(m))}

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
                <IdentityTag role={replyIdentity} action="send" />
                <span className="composer__identity-hint">{replyIdentityHint}</span>
              </div>
            )}
            <ReplyComposer
              message={replyTarget}
              value={text}
              sending={sending}
              sendDisabled={cooldown}
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

/** 滚动依赖键：最后一条的状态变化（回写成功）也要把视图带到底部 */
function selectedStatusKey(messages: UnifiedMessage[]): string {
  const last = messages[messages.length - 1];
  return last ? `${last.traceId}:${last.status}:${last.reply ?? ''}` : '';
}