import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import {
  ApiOutlined, ArrowRightOutlined, CheckOutlined, CheckSquareOutlined, ExportOutlined,
  HistoryOutlined, InboxOutlined, MoreOutlined, PaperClipOutlined, PlusOutlined,
  SearchOutlined, SendOutlined, SettingOutlined, StarOutlined,
} from '@ant-design/icons';
import { PLATFORM_META } from './model';
import type { DesignSection, DesignWorkspace } from './model';
import { useProfile } from '../settings/profile';
import { ComposeDialog, EmptyResults, PersonAvatar, PlatformMark, ProcessStateBadge, SecondaryView } from './shared';
import { FlowAllMessagesDialog } from './FlowAllMessagesDialog';

function timeGreeting(hour: number, name: string): string {
  if (hour >= 0 && hour < 6) return `夜深了，${name}。`;
  if (hour < 12) return `上午好，${name}。`;
  if (hour < 18) return `下午好，${name}。`;
  return `晚上好，${name}。`;
}

function greetingHint(hour: number, unread: number, todos: number): string {
  if (hour >= 0 && hour < 6) return '消息都已妥善同步。先去休息，明天再处理也不迟。';
  if (hour < 12) return `今天有 ${unread} 条新消息，从最重要的一件事开始。`;
  if (hour < 18) return `今天还有 ${todos} 项待办，把时间留给真正重要的事。`;
  return `今天还有 ${todos} 项待办。别忘了好好休息，重要的事情明天再处理。`;
}

const NAV: Array<{ id: DesignSection; label: string; icon: React.ReactNode }> = [
  { id: 'inbox', label: '消息', icon: <InboxOutlined /> }, { id: 'todos', label: '待办', icon: <CheckSquareOutlined /> },
  { id: 'trace', label: '回放', icon: <HistoryOutlined /> }, { id: 'accounts', label: '连接', icon: <ApiOutlined /> },
];

export function FlowDesign({ workspace }: { workspace: DesignWorkspace }) {
  const { selected } = workspace;
  const [draft, setDraft] = useState(selected.draft);
  const [focusMode, setFocusMode] = useState(false);
  const [allMessagesOpen, setAllMessagesOpen] = useState(false);
  useEffect(() => setDraft(selected.draft), [selected.id, selected.draft]);
  const send = () => { if (workspace.reply(selected.id, draft)) setDraft(''); };
  const todoCount = workspace.messages.filter((message) => message.kind === 'todo' && !message.done).length;
  const unreadCount = workspace.messages.filter((message) => message.unread).length;
  const currentHour = dayjs().hour();
  const dayLabel = dayjs().locale('en').format('dddd, D MMMM').toUpperCase();
  const profile = useProfile();
  const greetingName = profile.name.trim() && profile.name !== '我' ? profile.name.trim() : 'Alex';
  const avatarInitial = Array.from(greetingName)[0]?.toUpperCase() ?? 'A';
  const syncRate = workspace.messages.length
    ? Math.round((1 - workspace.messages.filter((message) => message.status === '发送失败').length / workspace.messages.length) * 100)
    : 100;
  const processedCount = workspace.messages.filter((message) => !message.unread && (message.reply || message.done)).length;
  const senders = Array.from(new Set(workspace.messages.map((message) => message.sender)));

  return (
    <div className={`dl-design dl-flow${focusMode ? ' is-focus' : ''}`}>
      <div className="fl-blob fl-blob--one" /><div className="fl-blob fl-blob--two" />
      <header className="fl-header"><button type="button" className="fl-brand" onClick={() => workspace.setSection('inbox')}><span><i /><i /></span><strong>linkhub</strong><small>beta</small></button><nav>{NAV.map((item) => <button type="button" key={item.id} className={workspace.section === item.id ? 'is-active' : ''} onClick={() => item.id === 'trace' ? workspace.openTrace(selected.id) : workspace.setSection(item.id)}>{item.icon}{item.label}{item.id === 'inbox' && <b>{workspace.messages.filter((message) => message.unread).length}</b>}</button>)}</nav><div className="fl-header__actions"><button type="button" className="fl-search-button" aria-label="搜索" onClick={() => document.getElementById('fl-search')?.focus()}><SearchOutlined /></button><button type="button" className="fl-legacy" title="返回旧版界面" aria-label="返回旧版界面" onClick={() => workspace.openLegacy()}><ExportOutlined /></button><button type="button" className="fl-settings" onClick={() => workspace.notify('偏好设置（概念预览）')}><SettingOutlined /></button><button type="button" className="fl-compose" onClick={() => workspace.setComposeOpen(true)}><PlusOutlined />新消息</button><span className={`fl-avatar${profile.avatarUrl ? ' has-image' : ''}`} style={profile.avatarUrl ? { backgroundImage: `url(${profile.avatarUrl})` } : undefined}>{!profile.avatarUrl && avatarInitial}<i /></span></div></header>

      {workspace.section !== 'inbox' ? <main className="fl-secondary"><SecondaryView workspace={workspace} /></main> : <main className="fl-main">
        <section className="fl-greeting"><div><span className="fl-eyebrow"><i />{dayLabel}</span><h1>{timeGreeting(currentHour, greetingName)}<span>✦</span></h1><p>{greetingHint(currentHour, unreadCount, todoCount)}</p></div><div className="fl-greeting__actions"><button type="button" className={focusMode ? 'is-active' : ''} title="只看待办：隐藏普通消息，只显示需要处理的事项" onClick={() => { const next = !focusMode; setFocusMode(next); if (next && selected.kind !== 'todo') { const firstTodo = workspace.messages.find((message) => message.kind === 'todo' && !message.done); if (firstTodo) workspace.selectMessage(firstTodo.id); } workspace.notify(next ? '已只看待办：普通消息暂时隐藏' : '已恢复显示全部消息'); }}><CheckSquareOutlined />{focusMode ? '显示全部消息' : '只看待办'}</button><span>{focusMode ? '已切换：仅显示待办' : '最后同步：刚刚'}</span></div></section>
        <section className="fl-stats"><article className="fl-stat fl-stat--ink"><div><span>全部消息</span><InboxOutlined /></div><strong>{workspace.messages.length}<small>条</small></strong><p><i>{unreadCount} 条未读</i> · 实时同步中</p><span className="fl-stat__deco">✦</span></article><article className="fl-stat"><div><span>待处理事项</span><CheckSquareOutlined /></div><strong>{todoCount}<small>项</small></strong><p>{todoCount === 0 ? '今天的事项都已处理' : '从最重要的一件事开始'}</p><div className="fl-mini-progress"><i style={{ width: `${Math.max(12, 100 - todoCount * 18)}%` }} /></div></article><article className="fl-stat"><div><span>沟通状态</span><StarOutlined /></div><strong>{syncRate}<small>%</small></strong><p>{processedCount} 条已处理 · {Math.max(0, workspace.messages.length - processedCount)} 条待跟进</p><div className="fl-avatars">{senders.slice(0, 4).map((sender) => <span key={sender}>{sender.slice(0, 1)}</span>)}{senders.length > 4 && <small>+{senders.length - 4}</small>}</div></article></section>

        <div className="fl-workspace">
          <aside className="fl-channels-card"><header><span>我的渠道</span><button type="button" onClick={() => workspace.setSection('accounts')}><MoreOutlined /></button></header><button type="button" className={workspace.platform === 'all' ? 'is-active' : ''} onClick={() => workspace.setPlatform('all')}><span className="fl-all-icon"><InboxOutlined /></span><div><strong>全部消息</strong><small>所有沟通，一处可见</small></div><b>{workspace.messages.length}</b></button>{(Object.keys(PLATFORM_META) as Array<keyof typeof PLATFORM_META>).map((key) => { const account = workspace.accounts.find((item) => item.platform === key); return <button type="button" key={key} className={workspace.platform === key ? 'is-active' : ''} onClick={() => workspace.setPlatform(key)}><PlatformMark platform={key} /><div><strong>{PLATFORM_META[key].name}</strong><small>{account?.status ?? '未连接'}</small></div><b>{workspace.messages.filter((message) => message.platform === key).length}</b><i className={account?.connected ? '' : 'is-warning'} /></button>; })}<div className="fl-focus-card"><span><StarOutlined /></span><strong>今日处理目标</strong><p>完成所有高优先级回复，<br />留一点时间给自己。</p><div><i /><i /><i /><i /><i /></div></div></aside>

          <section className="fl-inbox-card"><header><div><h2>{focusMode ? '待办消息' : '最新消息'}</h2><span>{workspace.visibleMessages.length}</span></div><label><SearchOutlined /><input id="fl-search" value={workspace.query} onChange={(event) => workspace.setQuery(event.target.value)} placeholder="搜索消息…" /></label></header><div className="fl-inbox-scroll">{workspace.visibleMessages.length === 0 ? <EmptyResults onReset={() => { workspace.setPlatform('all'); workspace.setQuery(''); }} /> : workspace.visibleMessages.filter((message) => !focusMode || message.kind === 'todo').map((message) => <button type="button" key={message.id} className={`fl-message${message.id === selected.id ? ' is-active' : ''}${message.unread ? ' is-unread' : ''}`} onClick={() => workspace.selectMessage(message.id)}><PersonAvatar message={message} /><div className="fl-message__content"><div><strong>{message.sender}</strong><span className="fl-message__source">{PLATFORM_META[message.platform].name}-{message.conversation}</span><time>{message.time}</time></div><p>{message.body}</p><footer><span className={message.kind === 'todo' ? 'is-task' : ''}>{message.kind === 'todo' ? <CheckSquareOutlined /> : <PlatformMark platform={message.platform} size="small" />}{message.kind === 'todo' ? '待办事项' : '消息'}</span><ProcessStateBadge message={message} /></footer></div></button>)}</div><footer className="fl-inbox-footer"><span><i />实时同步中</span><button type="button" onClick={() => setAllMessagesOpen(true)}>查看全部 <ArrowRightOutlined /></button></footer></section>

          <section className="fl-detail-card"><header><div><PersonAvatar message={selected} large /><span><strong>{selected.sender}</strong><small>{selected.role}</small></span></div><div className="fl-detail-actions"><button type="button" className={`fl-detail-todo${selected.kind === 'todo' ? ' is-done' : ''}`} disabled={selected.kind === 'todo'} title={selected.kind === 'todo' ? '这条消息已在待办清单中' : '把这条消息加入待办清单，稍后处理'} onClick={() => workspace.addTodo(selected.id)}><CheckSquareOutlined />{selected.kind === 'todo' ? '已加待办' : '加待办'}</button><button type="button" title="查看全链路回放" onClick={() => workspace.openTrace(selected.id)}><HistoryOutlined /></button></div></header><div className="fl-detail-scroll"><div className="fl-conversation-label"><span>{PLATFORM_META[selected.platform].name}-{selected.conversation}</span><ProcessStateBadge message={selected} /></div><article className="fl-bubble"><p>{selected.body}</p><span>{selected.date}</span></article>{selected.attachment && <button className="fl-attachment" type="button"><PaperClipOutlined />{selected.attachment}<ArrowRightOutlined /></button>}{selected.reply && <article className="fl-bubble fl-bubble--mine"><p>{selected.reply}</p><span><CheckOutlined /> 已同步</span></article>}<aside className="fl-ai-note"><header><span><StarOutlined />AI 小助手</span><small>刚刚</small></header><p>{selected.summary}</p>{selected.draft && <button type="button" onClick={() => { setDraft(selected.draft); workspace.notify('已为你准备好建议回复'); }}>帮我回复 <ArrowRightOutlined /></button>}</aside></div><footer className="fl-reply"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`回复 ${selected.sender}…`} /><div><span><button type="button" aria-label="添加附件" onClick={() => workspace.notify('可添加附件（概念预览）')}><PaperClipOutlined /></button>{selected.kind === 'todo' && <button type="button" className={selected.done ? 'is-done' : ''} onClick={() => workspace.toggleDone(selected.id)}><CheckOutlined />{selected.done ? '已完成' : '完成待办'}</button>}</span><button type="button" className="fl-send" disabled={!draft.trim()} onClick={send}><SendOutlined />发送</button></div></footer></section>
        </div>
      </main>}
      <ComposeDialog workspace={workspace} />
      <FlowAllMessagesDialog workspace={workspace} open={allMessagesOpen} onClose={() => setAllMessagesOpen(false)} />
    </div>
  );
}
