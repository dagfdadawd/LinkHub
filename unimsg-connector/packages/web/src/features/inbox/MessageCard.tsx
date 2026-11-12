import type { MouseEvent } from 'react';
import { CheckOutlined, HistoryOutlined, MessageOutlined, RightOutlined } from '@ant-design/icons';
import { MsgStatus } from '../../types';
import type { UnifiedMessage } from '../../types';
import { clamp, formatRelative, isSelfComposedMock, PLATFORM_META } from '../../utils/format';
import { AvatarBadge } from '../../components/AvatarBadge';
import { IdentityTag } from '../../components/IdentityTag';
import { PlatformGlyph } from '../../components/PlatformGlyph';
import { PlatformTag } from '../../components/PlatformTag';
import { StatusBadge } from '../../components/StatusBadge';
import { IntentTag } from '../../components/IntentTag';

export function MessageCard({
  message,
  active,
  onSelect,
  variant = 'compact',
  onReply,
  onDone,
  onTrace,
}: {
  message: UnifiedMessage;
  active: boolean;
  onSelect: (traceId: string) => void;
  /** card = 卡片网格（旧）；row = 收件箱纵向列表；compact = 详情打开后的紧凑列表 */
  variant?: 'card' | 'row' | 'compact';
  /** 行内快捷操作：回复 / 标记完成 / 全链路回放 */
  onReply?: (traceId: string) => void;
  onDone?: (traceId: string) => void;
  onTrace?: (traceId: string) => void;
}) {
  // 时间轴上的点表示「这条消息还要不要我处理」，而不是来源——
  // 来源已经由头像配色 + 平台标签表达，一个信息不需要说两遍。
  const dotState =
    message.status === MsgStatus.FAILED
      ? 'failed'
      : message.status === MsgStatus.REPLIED ||
          message.status === MsgStatus.SENT ||
          message.status === MsgStatus.SYNCED
        ? 'done'
        : message.needsReview
          ? 'review'
          : 'pending';
  // 行内按钮不能冒泡到整卡，否则点「完成」会同时打开详情
  const isolate = (fn?: (traceId: string) => void) => (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    fn?.(message.traceId);
  };
  // 已读/未读是独立维度，用行态类表达；未读圆点只在列表模式出现在最左列。
  // Mock 下「自己新建发送」的模拟消息不是收到的来信：不算未读，并标「我发出的（模拟）」。
  const isRow = variant === 'row';
  const selfMock = isSelfComposedMock(message);
  const unread = !message.readAt && !selfMock;
  const classes = [
    'msg-card',
    variant === 'card' ? 'msg-card--card' : '',
    isRow ? 'msg-card--row' : '',
    isRow && unread ? 'is-unread' : '',
    isRow && !unread ? 'is-read' : '',
    active ? 'is-active' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <article
      className={classes}
      onClick={() => onSelect(message.traceId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(message.traceId);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${unread && isRow ? '未读，' : ''}${message.sender.name}：${message.body}`}
      aria-current={active}
      data-trace={message.traceId}
    >
      {isRow && (
        <span className="msg-card__read" aria-hidden="true">
          {unread && <i className="msg-card__read-dot" />}
        </span>
      )}
      {variant === 'compact' && (
        <span className={`msg-card__dot msg-card__dot--${dotState}`} aria-hidden="true" />
      )}
      {isRow ? (
        // 列表行用渠道图形做头像：一屏扫下来「哪条来自哪个渠道」不需要读文字
        <span
          className="msg-card__glyph"
          style={{
            background: PLATFORM_META[message.platform].soft,
            color: PLATFORM_META[message.platform].color,
          }}
          aria-hidden="true"
        >
          <PlatformGlyph platform={message.platform} size={18} />
        </span>
      ) : (
        <AvatarBadge name={message.sender.name} platform={message.platform} size={34} />
      )}
      <div className="msg-card__main">
        <div className="msg-card__row">
          <span className="msg-card__sender">{message.sender.name}</span>
          <span className="msg-card__sep" aria-hidden="true">·</span>
          <PlatformTag platform={message.platform} small />
          <span className="msg-card__spacer" />
          {isRow && (
            <span className={`msg-card__badge msg-card__badge--${unread ? 'unread' : 'read'}`}>
              {unread ? '未读' : '已读'}
            </span>
          )}
          <span className="msg-card__time">{formatRelative(message.createdAt)}</span>
          {isRow && <RightOutlined className="msg-card__chevron" aria-hidden="true" />}
        </div>
        <div className="msg-card__body">{clamp(message.body, 72)}</div>
        <div className="msg-card__row msg-card__row--meta">
          <StatusBadge status={message.status} small />
          <IntentTag intent={message.intent} />
          {/* 身份如实标注：真实接收写「本人账号接收 / 机器人接收」；回写看 delivery.identity / Mock */}
          {message.receivedAs && <IdentityTag role={message.receivedAs} action="receive" />}
          {message.delivery?.mode === 'mock' && (
            <IdentityTag role="mock" action={selfMock ? 'receive' : 'send'} />
          )}
          {selfMock && <span className="chip chip--warn">我发出的（模拟）</span>}
          {message.delivery?.mode === 'real' && message.delivery.identity && (
            <IdentityTag role={message.delivery.identity} action="send" />
          )}
          {message.needsReview && <span className="chip chip--warn">需人工确认</span>}
          {message.done && <span className="chip chip--done">已完成</span>}

          <div className="msg-card__actions">
            <button
              type="button"
              className="msg-action"
              aria-label="回复"
              title="回复（R）"
              onClick={isolate(onReply)}
            >
              <MessageOutlined />
            </button>
            {!message.done && (
              <button
                type="button"
                className="msg-action"
                aria-label="标记完成"
                title="标记完成（E）"
                onClick={isolate(onDone)}
              >
                <CheckOutlined />
              </button>
            )}
            <button
              type="button"
              className="msg-action"
              aria-label="全链路回放"
              title="全链路回放"
              onClick={isolate(onTrace)}
            >
              <HistoryOutlined />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}