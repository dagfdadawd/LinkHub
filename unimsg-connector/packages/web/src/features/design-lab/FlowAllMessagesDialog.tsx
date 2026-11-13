/**
 * 「查看全部」弹窗：右侧消息卡片只放得下可视区域里的几条，
 * 点卡片底部的「查看全部」时用一个窗口把当前所有消息完整列出来。
 *
 * 数据与写操作全部走 workspace（选中即标已读），弹窗自己不复制一套消息状态。
 */
import { useEffect, useRef, useState } from 'react';
import { CheckSquareOutlined, CloseOutlined, InboxOutlined, SearchOutlined } from '@ant-design/icons';
import { PLATFORM_META } from './model';
import type { DesignMessage, DesignPlatform, DesignWorkspace } from './model';
import { EmptyResults, PersonAvatar, PlatformMark, ProcessStateBadge } from './shared';

const PLATFORMS: DesignPlatform[] = ['feishu', 'dingtalk', 'wecom', 'mail'];

function matchesQuery(message: DesignMessage, term: string): boolean {
  if (!term) return true;
  return `${message.sender}${message.body}${message.conversation}`.toLowerCase().includes(term);
}

export function FlowAllMessagesDialog({
  workspace, open, onClose,
}: { workspace: DesignWorkspace; open: boolean; onClose: () => void }) {
  const [platform, setPlatform] = useState<'all' | DesignPlatform>('all');
  const [query, setQuery] = useState('');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 每次打开都回到「全部渠道 + 空搜索」，避免上次的筛选让人以为消息变少了
  useEffect(() => {
    if (!open) return;
    setPlatform('all');
    setQuery('');
  }, [open]);

  // Esc 关闭；弹窗打开时锁住背景滚动，关闭后恢复
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); };
    const previousOverflow = document.body.style.overflow;
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  const messages = workspace.messages;
  const term = query.trim().toLowerCase();
  const visible = messages.filter((message) => (platform === 'all' || message.platform === platform) && matchesQuery(message, term));
  const unread = messages.filter((message) => message.unread).length;
  const counts: Record<'all' | DesignPlatform, number> = {
    all: messages.length,
    feishu: messages.filter((message) => message.platform === 'feishu').length,
    dingtalk: messages.filter((message) => message.platform === 'dingtalk').length,
    wecom: messages.filter((message) => message.platform === 'wecom').length,
    mail: messages.filter((message) => message.platform === 'mail').length,
  };
  const filtered = platform !== 'all' || Boolean(term);

  return (
    <div className="dl-modal-scrim" role="presentation" onMouseDown={onClose}>
      <section
        className="fl-all-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fl-all-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="fl-all-kicker">ALL MESSAGES</span>
            <h2 id="fl-all-title">全部消息</h2>
            <p>共 {messages.length} 条 · {unread} 条未读 · 四个渠道</p>
          </div>
          <button type="button" className="fl-all-close" onClick={onClose} aria-label="关闭全部消息窗口">
            <CloseOutlined />
          </button>
        </header>

        <div className="fl-all-toolbar">
          <label className="fl-all-search">
            <SearchOutlined />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索发送人、内容或会话…"
              aria-label="搜索全部消息"
              autoFocus
            />
          </label>
          <div className="fl-all-chips" role="group" aria-label="按渠道筛选">
            <button type="button" aria-pressed={platform === 'all'} className={platform === 'all' ? 'is-active' : ''} onClick={() => setPlatform('all')}>
              <InboxOutlined />全部<b>{counts.all}</b>
            </button>
            {PLATFORMS.map((key) => (
              <button
                type="button"
                key={key}
                aria-pressed={platform === key}
                className={platform === key ? 'is-active' : ''}
                onClick={() => setPlatform(key)}
              >
                <PlatformMark platform={key} size="small" />{PLATFORM_META[key].name}<b>{counts[key]}</b>
              </button>
            ))}
          </div>
        </div>

        <div className="fl-all-scroll">
          {visible.length === 0 ? (
            <EmptyResults onReset={() => { setPlatform('all'); setQuery(''); }} />
          ) : visible.map((message) => (
            <button
              type="button"
              key={message.id}
              className={`fl-all-row${message.id === workspace.selectedId ? ' is-active' : ''}${message.unread ? ' is-unread' : ''}`}
              aria-label={`打开消息：${message.sender} · ${PLATFORM_META[message.platform].name}`}
              onClick={() => { workspace.selectMessage(message.id); onClose(); }}
            >
              <PersonAvatar message={message} />
              <span className="fl-all-row__main">
                <span className="fl-all-row__head">
                  <strong>{message.sender}</strong>
                  <span className="fl-all-row__source">{PLATFORM_META[message.platform].name} · {message.conversation}</span>
                  <time>{message.time}</time>
                </span>
                <span className="fl-all-row__body">{message.body}</span>
              </span>
              <span className="fl-all-row__meta">
                {message.kind === 'todo' && <span className="fl-all-tag"><CheckSquareOutlined />待办</span>}
                <ProcessStateBadge message={message} />
              </span>
            </button>
          ))}
        </div>

        <footer className="fl-all-foot">
          <span><i />实时同步中 · 点击任意消息即可查看详情</span>
          <span>{filtered ? `已筛选 ${visible.length} / ${messages.length} 条` : `共 ${visible.length} 条`}</span>
          <button type="button" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}