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

export function DetailPanel({
  message,
  listCollapsed = false,
  onToggleList,
}: {
  message: UnifiedMessage;
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
  /** 发送成功后短暂冷却：清空输入框 + 禁用按钮，避免手滑把同一内容再发一次（P2-2） */
  const [cooldown, setCooldown] = useState(false);
  const cooldownTimer = useRef<number>();

  useEffect(() => {
    setText(message.replyDraft ?? '');
    setSending(false);
    setCooldown(false);
    window.clearTimeout(cooldownTimer.current);
    return () => window.clearTimeout(cooldownTimer.current);
  }, [message.traceId, message.replyDraft]);

  const canMarkDone = !message.done;
  // 投递方式：Mock 必须如实标注，不能显示成真实平台已收到；真实回写带身份时一并展示。
  // 发送失败时以失败原因/实际投递为准：不能显示「模拟发送」掩盖未送达（二轮复验收 P1）。
  const rawDeliveryLabel = deliveryLabel(message.delivery);
  const delivery = message.status === MsgStatus.FAILED && rawDeliveryLabel.kind === 'mock'
    ? { text: '发送失败（未送达平台）', kind: 'none' as const }
    : rawDeliveryLabel;
  // 回复将以哪种身份发出：只有「平台整体 Mock」才说模拟发送；
  // identity=user 但未登录时发送会失败，提示去登录，不能假称已模拟发送（UI 二轮复验 P2-4）。
  const account = state.accounts.find((a) => a.platform === message.platform);
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
      await store.reply(message.traceId, content, attachments);
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

  /** 失败消息重试：用同一条回复内容再走一次回写，不要求用户改文案（P1-2） */
  const retryContent = message.reply?.trim() ?? '';
  const retryBlockedByAttachments = Boolean(message.attachments && message.attachments.length > 0);
  const canRetry = retryContent.length > 0 && !retryBlockedByAttachments;

  async function handleRetry(): Promise<void> {
    if (!canRetry || sending) return;
    setSending(true);
    try {
      await store.reply(message.traceId, retryContent);
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

  async function copyTrace() {
    try {
      await navigator.clipboard.writeText(message.traceId);
      toast.success('traceId 已复制');
    } catch {
      toast.info(message.traceId);
    }
  }

  const moreItems: MenuProps['items'] = [
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

  return (
    <div className="detail detail--workbench" data-testid="detail-panel">
      <header className="detail__bar">
        {onToggleList && (
          <Tooltip title={listCollapsed ? '展开消息列表' : '收起消息列表'}>
            <Button
              className="detail__list-toggle"
              type="text"
              icon={listCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={onToggleList}
              aria-label={listCollapsed ? '展开消息列表' : '收起消息列表'}
            />
          </Tooltip>
        )}
        <Button
          className="detail__back"
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate('/inbox')}
          aria-label="返回列表"
        >
          返回
        </Button>

        <span className="detail__bar-spacer" />

        <Tooltip title="标记为未读，会回到左侧未读分组">
          <Button size="small" type="text" icon={<MailOutlined />} onClick={handleMarkUnread}>
            标为未读
          </Button>
        </Tooltip>
        <Button size="small" type="text" icon={<MessageOutlined />} onClick={focusComposer}>
          回复
        </Button>
        <Dropdown menu={{ items: moreItems }} trigger={['click']} placement="bottomRight">
          <Button size="small" type="text" icon={<MoreOutlined />} aria-label="更多操作" />
        </Dropdown>
      </header>

      <div className="detail__scroll">
        {message.needsReview && (
          <Alert
            className="detail__alert"
            type="warning"
            showIcon
            message="OCR 置信度不足，已标记待人工确认"
            description="请先人工核对图片 / 文件中的文字，再决定回复内容。"
          />
        )}

        {message.status === MsgStatus.FAILED && (
          <Alert
            className="detail__alert"
            type="error"
            showIcon
            message="发送失败（已写入死信队列）"
            description={
              <div className="detail__fail">
                <div className="detail__fail-reason">
                  {message.failureReason
                    ? `原因：${message.failureReason}`
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
                  <Button
                    size="small"
                    onClick={() => navigate(`/trace/${message.traceId}`)}
                  >
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

        {/* 发送人：一行读完「谁 · 哪个渠道 · 什么时候 · 当前状态」 */}
        <section className="detail__sender" aria-label="发送人信息">
          <AvatarBadge name={message.sender.name} platform={message.platform} size={44} />
          <div className="detail__sender-main">
            <div className="detail__sender-name">
              <span className="detail__sender-name-text" title={message.sender.name}>
                {message.sender.name}
              </span>
              <PlatformTag platform={message.platform} small />
            </div>
            <div className="detail__sender-meta" title={formatDateTime(message.createdAt)}>
              {formatDateTime(message.createdAt)} · {TYPE_LABEL[message.type]} ·{' '}
              {conversationLabel(message)}
              {message.conversation?.type === 'group' && (
                <span className="detail__conv-hint">回复会发回该群</span>
              )}
            </div>
          </div>
          <div className="detail__sender-tags">
            <StatusBadge status={message.status} small />
            {message.needsReview && <span className="chip chip--warn">需人工确认</span>}
            {message.done && <span className="chip chip--done">已完成</span>}
            {message.receivedAs && <IdentityTag role={message.receivedAs} action="receive" />}
          </div>
        </section>

        {/* 原始消息：白底大字排版，是这一页的主要阅读区 */}
        <article className="detail__message" aria-label="原始消息内容">
          <div className="message-body">{message.body}</div>

          {message.attachments && message.attachments.length > 0 && (
            <ul className="file-list" aria-label="附件">
              {message.attachments.map((a, i) => (
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

          {message.reply && (
            <div className="message-reply">
              <span className="message-reply__label">
                <SendOutlined />{' '}
                {message.status === MsgStatus.FAILED ? '待重试的回复' : '已回写内容'}
              </span>
              <span className="message-reply__text">{message.reply}</span>
            </div>
          )}
        </article>

        {prefs.showAiDraft && (
          <AiSuggestion
            message={message}
            onUseDraft={(draft) => {
              setText(draft);
              focusComposer();
            }}
            onRegenerate={() => toast.info('当前草稿由关键词规则生成，可直接编辑或重新撰写')}
          />
        )}

        {/* 原来的「状态流转 + 消息信息」大面板降级成可展开的详情，不占阅读空间 */}
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

      <footer className="detail__footer">
        {replyIdentity && (
          <div className="composer__identity" data-testid="reply-identity">
            <span className="composer__identity-label">本次回复</span>
            <IdentityTag role={replyIdentity} action="send" />
            <span className="composer__identity-hint">{replyIdentityHint}</span>
          </div>
        )}
        <ReplyComposer
          message={message}
          value={text}
          sending={sending}
          sendDisabled={cooldown}
          onChange={setText}
          onSend={handleSend}
        />
      </footer>
    </div>
  );
}