import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, App as AntApp, Button, Tag, Tooltip } from 'antd';
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CopyOutlined,
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PaperClipOutlined,
  ReloadOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { MsgStatus } from '../../types';
import type { OutboundAttachment, UnifiedMessage } from '../../types';
import { formatBytes } from '../../utils/attachments';
import { store } from '../../store';
import { useAppState } from '../../hooks/useAppState';
import { TYPE_LABEL, PLATFORM_META, deliveryLabel, conversationLabel, formatDateTime, formatRelative, shortTrace } from '../../utils/format';
import { AvatarBadge } from '../../components/AvatarBadge';
import { IdentityTag } from '../../components/IdentityTag';
import { PlatformTag } from '../../components/PlatformTag';
import { StatusBadge } from '../../components/StatusBadge';
import { AiSuggestion } from './AiSuggestion';
import { ReplyComposer } from './ReplyComposer';
import { StatusFlow } from './StatusFlow';
import { usePreferences } from '../settings/preferences';

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
  // 投递方式：Mock 必须如实标注，不能显示成真实平台已收到；真实回写带身份时一并展示
  const delivery = deliveryLabel(message.delivery);
  // 回复将以哪种身份发出（来自账号页身份视图；Mock 平台整体显示模拟）
  const account = state.accounts.find((a) => a.platform === message.platform);
  const replyIdentity = account?.mode === 'mock'
    ? 'mock'
    : account?.identity?.effectiveSend;
  const replyIdentityHint = replyIdentity === 'user'
    ? '以你本人账号发出'
    : replyIdentity === 'bot'
      ? '以机器人身份发出（本人账号未连接时自动兜底）'
      : replyIdentity === 'mock'
        ? 'Mock 模拟，不会真的发到平台'
        : '';

  async function handleSend(attachments: OutboundAttachment[] = []) {
    const content = text.trim();
    if (!content && attachments.length === 0) return;
    setSending(true);
    try {
      await store.reply(message.traceId, content, attachments);
      // P1-2：「已提交」不等于「已发出」——异步发送结果会经 WS 回流，文案不要写成成功口吻
      toast.success(
        attachments.length > 0
          ? `已提交，正在发送（含 ${attachments.length} 个附件）…状态会在消息里实时更新`
          : '已提交，正在发送…状态会在消息里实时更新',
      );
      // P2-2：清空输入框 + 2 秒防重复，避免手滑再点一次重复打扰对方
      setText('');
      setCooldown(true);
      window.clearTimeout(cooldownTimer.current);
      cooldownTimer.current = window.setTimeout(() => setCooldown(false), 2000);
    } catch (e) {
      toast.error(e instanceof Error ? `发送失败：${e.message}` : '发送失败，请重试');
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
      toast.error(e instanceof Error ? `重试失败：${e.message}` : '重试失败，请稍后再试');
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

  async function copyTrace() {
    try {
      await navigator.clipboard.writeText(message.traceId);
      toast.success('traceId 已复制');
    } catch {
      toast.info(message.traceId);
    }
  }

  return (
    <div className="detail" data-testid="detail-panel">
      <header className="detail__head">
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
        />
        <AvatarBadge name={message.sender.name} platform={message.platform} size={42} />
        <div className="detail__title">
          <div className="detail__name">
            {message.sender.name}
            <PlatformTag platform={message.platform} small />
          </div>
          <div className="detail__meta" title={formatDateTime(message.createdAt)}>
            {formatRelative(message.createdAt)} · {TYPE_LABEL[message.type]} · trace {shortTrace(message.traceId)}
          </div>
        </div>
        <div className="detail__head-actions">
          <StatusBadge status={message.status} />
          {message.type === 'todo' && (
            <Button
              size="small"
              icon={<CheckOutlined />}
              disabled={!canMarkDone}
              onClick={handleDone}
            >
              {message.done ? '已完成' : '标记完成'}
            </Button>
          )}
          <Tooltip title="复制 traceId">
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyTrace} />
          </Tooltip>
          <Button
            size="small"
            type="text"
            icon={<HistoryOutlined />}
            onClick={() => navigate(`/trace/${message.traceId}`)}
          >
            回放
          </Button>
        </div>
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

        <section className="detail__section">
          <div className="section-label">消息内容</div>
          <div className="message-body">{message.body}</div>
          {message.attachments && message.attachments.length > 0 && (
            <div className="message-attachments" aria-label="附件">
              {message.attachments.map((a, i) => (
                <Tag key={`${a.name}-${i}`} icon={<PaperClipOutlined />}>
                  {a.name} · {formatBytes(a.size)}
                </Tag>
              ))}
            </div>
          )}
          {message.reply && (
            <div className="message-reply">
              <span className="message-reply__label">
                <SendOutlined /> {message.status === MsgStatus.FAILED ? '待重试的回复' : '已回写内容'}
              </span>
              <span className="message-reply__text">{message.reply}</span>
            </div>
          )}
        </section>

        {prefs.showAiDraft && (
          <AiSuggestion
            message={message}
            onUseDraft={(draft) => setText(draft)}
            onRegenerate={() => toast.info('草稿由关键词规则生成，可手动编辑')}
          />
        )}

        <section className="detail__section">
          <div className="section-label">状态流转</div>
          <StatusFlow status={message.status} />
        </section>

        <section className="detail__section">
          <div className="section-label">消息信息</div>
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
                {message.conversation?.type === 'group' && (
                  <span className="detail__conv-hint">回复会发回该群</span>
                )}
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
              <dd className="mono">{message.traceId}</dd>
            </div>
          </dl>
        </section>
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