import { useEffect, useState } from 'react';
import {
  ApiOutlined, ArrowRightOutlined, CheckOutlined, CheckSquareOutlined, ClockCircleOutlined,
  InboxOutlined, HistoryOutlined, MoreOutlined, PaperClipOutlined, PlusOutlined,
  SearchOutlined, SendOutlined, SettingOutlined, StarOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { PLATFORM_META } from './model';
import type { DesignSection, DesignWorkspace } from './model';
import { ComposeDialog, EmptyResults, PersonAvatar, PlatformMark, SecondaryView, StatusPill } from './shared';

const NAV: Array<{ id: DesignSection; label: string; icon: React.ReactNode }> = [
  { id: 'inbox', label: '统一收件箱', icon: <InboxOutlined /> },
  { id: 'todos', label: '我的待办', icon: <CheckSquareOutlined /> },
  { id: 'trace', label: '全链路回放', icon: <HistoryOutlined /> },
  { id: 'accounts', label: '平台连接', icon: <ApiOutlined /> },
];

export function ClarityDesign({ workspace }: { workspace: DesignWorkspace }) {
  const { selected } = workspace;
  const [draft, setDraft] = useState(selected.draft);
  useEffect(() => setDraft(selected.draft), [selected.id, selected.draft]);
  const send = () => { if (workspace.reply(selected.id, draft)) setDraft(''); };

  return (
    <div className="dl-design dl-clarity">
      <aside className="cl-side">
        <div className="cl-brand"><span className="cl-brand__mark"><i /><i /><i /></span><strong>LinkHub</strong></div>
        <button className="cl-workspace-switch" type="button"><span>LK</span><div><strong>我的工作空间</strong><small>Personal workspace</small></div><MoreOutlined /></button>
        <nav className="cl-nav" aria-label="方案一导航">
          <span className="cl-nav__label">工作空间</span>
          {NAV.map((item) => <button type="button" key={item.id} className={workspace.section === item.id ? 'is-active' : ''} onClick={() => workspace.setSection(item.id)}>{item.icon}<span>{item.label}</span>{item.id === 'inbox' && <b>{workspace.messages.filter((message) => message.unread).length}</b>}{item.id === 'todos' && <b>{workspace.messages.filter((message) => message.kind === 'todo' && !message.done).length}</b>}</button>)}
        </nav>
        <div className="cl-side__spacer" />
        <div className="cl-connect-card"><span><i />3 / 4 平台已就绪</span><p>把所有对话，带进同一个工作流。</p><button type="button" onClick={() => workspace.setSection('accounts')}>管理连接 <ArrowRightOutlined /></button></div>
        <button className="cl-profile" type="button" onClick={() => workspace.notify('个人设置（概念预览）')}><span>A</span><div><strong>Alex Chen</strong><small>alex@linkhub.cn</small></div><SettingOutlined /></button>
      </aside>

      <main className="cl-main">
        <header className="cl-topbar">
          <div className="cl-breadcrumb"><span>LinkHub</span><i>/</i><strong>{NAV.find((item) => item.id === workspace.section)?.label}</strong></div>
          <label className="cl-search"><SearchOutlined /><input value={workspace.query} onChange={(event) => { workspace.setQuery(event.target.value); workspace.setSection('inbox'); }} placeholder="搜索消息、联系人或群组…" /><kbd>⌘ K</kbd></label>
          <button className="cl-icon-button" type="button" onClick={() => workspace.notify('没有新的系统通知')} aria-label="通知"><ClockCircleOutlined /><i /></button>
          <button className="cl-new-button" type="button" onClick={() => workspace.setComposeOpen(true)}><PlusOutlined /> 新建发送</button>
        </header>

        {workspace.section !== 'inbox' ? <div className="cl-secondary-wrap"><SecondaryView workspace={workspace} /></div> : <>
          <section className="cl-welcome">
            <div><span className="cl-eyebrow">THURSDAY · 12 NOVEMBER</span><h1>上午好，Alex。</h1><p>今天有 <strong>{workspace.messages.filter((message) => message.unread).length} 条新消息</strong>，从最重要的一件事开始。</p></div>
            <div className="cl-day-stats"><div><strong>{workspace.messages.length}</strong><span>全部消息</span></div><i /><div><strong>{workspace.messages.filter((message) => message.kind === 'todo' && !message.done).length}</strong><span>待处理事项</span></div><i /><div><strong>96<small>%</small></strong><span>同步成功率</span></div></div>
          </section>

          <div className="cl-inbox">
            <section className="cl-list">
              <header className="cl-list__head"><div><h2>收件箱</h2><span>{workspace.visibleMessages.length}</span></div><button type="button" onClick={() => { workspace.setPlatform('all'); workspace.setQuery(''); }}>全部已读</button></header>
              <div className="cl-channels">
                <button type="button" className={workspace.platform === 'all' ? 'is-active' : ''} onClick={() => workspace.setPlatform('all')}>全部</button>
                {(Object.keys(PLATFORM_META) as Array<keyof typeof PLATFORM_META>).map((key) => <button type="button" key={key} className={workspace.platform === key ? 'is-active' : ''} onClick={() => workspace.setPlatform(key)} title={PLATFORM_META[key].name}><PlatformMark platform={key} size="small" /><span>{PLATFORM_META[key].name}</span></button>)}
              </div>
              <div className="cl-list__scroll">
                {workspace.visibleMessages.length === 0 ? <EmptyResults onReset={() => { workspace.setPlatform('all'); workspace.setQuery(''); }} /> : workspace.visibleMessages.map((message) => <button type="button" key={message.id} className={`cl-message${message.id === selected.id ? ' is-active' : ''}${message.unread ? ' is-unread' : ''}`} onClick={() => workspace.selectMessage(message.id)}>
                  <div className="cl-message__top"><PersonAvatar message={message} /><div><strong>{message.sender}</strong><span>{PLATFORM_META[message.platform].name} · {message.conversation}</span></div><time>{message.time}</time></div>
                  <p>{message.body}</p>
                  <div className="cl-message__foot"><span className={message.priority === '高' ? 'is-priority' : ''}>{message.kind === 'todo' ? <CheckSquareOutlined /> : <PlatformMark platform={message.platform} size="small" />}{message.kind === 'todo' ? `${message.priority}优先级` : PLATFORM_META[message.platform].name}</span>{message.unread && <i />}<StatusPill message={message} /></div>
                </button>)}
              </div>
            </section>

            <section className="cl-detail">
              <header className="cl-detail__head"><div className="cl-detail__person"><PersonAvatar message={selected} large /><div><h2>{selected.sender}<PlatformMark platform={selected.platform} size="small" /></h2><p>{selected.role} · {selected.conversation}</p></div></div><div className="cl-detail__actions"><StatusPill message={selected} />{selected.kind === 'todo' && <button type="button" className={selected.done ? 'is-done' : ''} onClick={() => workspace.toggleDone(selected.id)}><CheckOutlined />{selected.done ? '已完成' : '完成待办'}</button>}<button type="button" onClick={() => workspace.setSection('trace')}><HistoryOutlined /> 回放</button></div></header>
              <div className="cl-detail__scroll">
                <div className="cl-message-meta"><span>{selected.date}</span><i /> <span>{selected.id}</span></div>
                <article className="cl-original"><p>{selected.body}</p>{selected.attachment && <button type="button" onClick={() => workspace.notify('附件预览已打开（概念预览）')}><PaperClipOutlined /><span>{selected.attachment}</span><ArrowRightOutlined /></button>}</article>
                {selected.reply && <article className="cl-sent-reply"><span><CheckOutlined /> 已通过{PLATFORM_META[selected.platform].name}回复</span><p>{selected.reply}</p></article>}
                <section className="cl-ai-card"><header><span><StarOutlined /> LinkHub AI</span><small>摘要与建议</small></header><p>{selected.summary}</p><button type="button" onClick={() => { setDraft(selected.draft); workspace.notify('AI 建议已填入回复框'); }} disabled={!selected.draft}><ThunderboltOutlined /> 使用建议回复</button></section>
              </div>
              <footer className="cl-reply"><div className="cl-reply__box"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`回复 ${selected.sender}…`} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') send(); }} /><div><span><button type="button" aria-label="添加附件" onClick={() => workspace.notify('可添加附件（概念预览）')}><PaperClipOutlined /></button><small>⌘ + Enter 发送</small></span><button type="button" className="cl-send" disabled={!draft.trim()} onClick={send}><SendOutlined /> 发送回复</button></div></div><p>将以 <strong>本人账号</strong> 通过{PLATFORM_META[selected.platform].name}发送 · 演示数据</p></footer>
            </section>
          </div>
        </>}
      </main>
      <ComposeDialog workspace={workspace} />
    </div>
  );
}
