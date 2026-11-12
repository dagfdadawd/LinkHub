import { useState, type ReactNode } from 'react';
import { CheckOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';

/**
 * 可折叠消息分组（未读 / 已读）。
 *
 * 折叠只影响渲染，不影响数据：分组里的消息始终在 store 里，
 * 数量由调用方按当前筛选结果算好传入，因此折叠、搜索、切换渠道都不会让计数失真。
 */
export function MessageGroup({
  title,
  count,
  tone,
  collapsible = false,
  defaultOpen = true,
  action,
  children,
}: {
  title: string;
  count: number;
  /** unread = 蓝色圆点，read = 灰色圆点 */
  tone: 'unread' | 'read';
  collapsible?: boolean;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => {
    if (collapsible) setOpen((v) => !v);
  };

  return (
    <section className={`msg-group msg-group--${tone}`} aria-label={`${title}消息`}>
      <header
        className={`msg-group__head${collapsible ? ' is-collapsible' : ''}`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (!collapsible) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? open : undefined}
      >
        <span className={`msg-group__dot msg-group__dot--${tone}`} aria-hidden="true" />
        <span className="msg-group__title">{title}</span>
        <span className="msg-group__count">{count}</span>
        <span className="msg-group__spacer" />
        {action}
        {collapsible && (
          <span className="msg-group__toggle">
            {open ? <DownOutlined /> : <RightOutlined />}
            <span className="msg-group__toggle-text">{open ? '收起' : '展开'}</span>
          </span>
        )}
      </header>
      {open && <div className="msg-group__body">{children}</div>}
    </section>
  );
}

/** 分组标题右侧的「全部标为已读」：与分组头同一行，避免额外一行工具条 */
export function MarkAllReadAction({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="msg-group__action"
      disabled={disabled}
      onClick={(e) => {
        // 分组头本身可点击折叠，这里必须阻断冒泡
        e.stopPropagation();
        onClick();
      }}
    >
      <CheckOutlined />
      全部标为已读
    </button>
  );
}