import { useEffect, useState } from 'react';
import {
  ArrowRightOutlined, CheckOutlined, EditOutlined, HistoryOutlined, PaperClipOutlined,
  SearchOutlined, SendOutlined,
} from '@ant-design/icons';
import { PLATFORM_META } from './model';
import type { DesignSection, DesignWorkspace } from './model';
import { ComposeDialog, EmptyResults, PlatformMark, SecondaryView, StatusPill } from './shared';

const NAV: Array<{ id: DesignSection; label: string; en: string }> = [
  { id: 'inbox', label: '来信', en: 'Inbox' }, { id: 'todos', label: '事项', en: 'Agenda' },
  { id: 'trace', label: '轨迹', en: 'Journal' }, { id: 'accounts', label: '连接', en: 'Connections' },
];

export function EditorialDesign({ workspace }: { workspace: DesignWorkspace }) {
  const { selected } = workspace;
  const [draft, setDraft] = useState(selected.draft);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => setDraft(selected.draft), [selected.id, selected.draft]);
  const send = () => { if (workspace.reply(selected.id, draft)) setDraft(''); };

  return (
    <div className="dl-design dl-editorial">
      <header className="ed-header"><button type="button" className="ed-brand" onClick={() => workspace.setSection('inbox')}>LinkHub<span>®</span></button><span className="ed-header__descriptor">THE UNIFIED MESSAGE JOURNAL</span><div className="ed-header__right"><span>SHANGHAI · 22:23</span><button type="button" aria-label="搜索" className={searchOpen ? 'is-active' : ''} onClick={() => setSearchOpen((open) => !open)}><SearchOutlined /></button><button type="button" className="ed-compose" onClick={() => workspace.setComposeOpen(true)}><EditOutlined />写一封信</button></div></header>
      <nav className="ed-nav" aria-label="方案三导航">{NAV.map((item) => <button type="button" key={item.id} className={workspace.section === item.id ? 'is-active' : ''} onClick={() => workspace.setSection(item.id)}><span>{item.label}</span><small>{item.en}</small>{item.id === 'inbox' && <b>{workspace.messages.filter((message) => message.unread).length}</b>}</button>)}<span className="ed-nav__note">Less noise. More meaning.</span></nav>
      {searchOpen && <div className="ed-search"><SearchOutlined /><input autoFocus value={workspace.query} onChange={(event) => { workspace.setQuery(event.target.value); workspace.setSection('inbox'); }} placeholder="搜索来信、寄件人或主题…" /><button type="button" onClick={() => { setSearchOpen(false); workspace.setQuery(''); }}>关闭</button></div>}

      {workspace.section !== 'inbox' ? <main className="ed-secondary"><div className="ed-secondary__issue">LINKHUB JOURNAL / SECTION {String(NAV.findIndex((item) => item.id === workspace.section) + 1).padStart(2, '0')}</div><SecondaryView workspace={workspace} /></main> : <main className="ed-main">
        <section className="ed-masthead"><div><span className="ed-kicker">THURSDAY EDITION — NO. 048</span><h1>Your daily<br /><em>correspondence.</em></h1></div><div className="ed-masthead__aside"><p>把每一次沟通，<br />还原成值得阅读的内容。</p><div><span><strong>{String(workspace.messages.length).padStart(2, '0')}</strong>封来信</span><span><strong>{String(workspace.messages.filter((message) => message.kind === 'todo' && !message.done).length).padStart(2, '0')}</strong>件待办</span></div></div><div className="ed-date"><strong>12</strong><span>NOVEMBER<br />2026</span></div></section>

        <div className="ed-content">
          <section className="ed-list"><header><div><span>IN TODAY'S EDITION</span><h2>今日来信</h2></div><small>{workspace.visibleMessages.length} STORIES</small></header><div className="ed-filters"><button type="button" className={workspace.platform === 'all' ? 'is-active' : ''} onClick={() => workspace.setPlatform('all')}>全部</button>{(Object.keys(PLATFORM_META) as Array<keyof typeof PLATFORM_META>).map((key) => <button type="button" className={workspace.platform === key ? 'is-active' : ''} key={key} onClick={() => workspace.setPlatform(key)}>{PLATFORM_META[key].name}</button>)}</div><div className="ed-list__scroll">{workspace.visibleMessages.length === 0 ? <EmptyResults onReset={() => { workspace.setPlatform('all'); workspace.setQuery(''); }} /> : workspace.visibleMessages.map((message, index) => <button type="button" key={message.id} onClick={() => workspace.selectMessage(message.id)} className={`ed-letter${message.id === selected.id ? ' is-active' : ''}${message.unread ? ' is-unread' : ''}`}><span className="ed-letter__number">{String(index + 1).padStart(2, '0')}</span><div className="ed-letter__body"><div><span>{PLATFORM_META[message.platform].name} / {message.conversation}</span><time>{message.time}</time></div><h3>{message.sender}</h3><p>{message.body}</p><footer><span>{message.kind === 'todo' ? '待办事项' : '来信'} {message.priority && `· ${message.priority}优先`}</span>{message.unread && <i>NEW</i>}</footer></div><ArrowRightOutlined /></button>)}</div></section>

          <article className="ed-article"><header><div className="ed-article__label"><PlatformMark platform={selected.platform} size="small" /><span>A LETTER FROM {selected.conversation.toUpperCase()}</span></div><div><StatusPill message={selected} /><button type="button" onClick={() => workspace.setSection('trace')}><HistoryOutlined />查看轨迹</button></div></header><div className="ed-article__scroll"><div className="ed-article__title"><span>{selected.date}</span><h2>{selected.sender}</h2><p>{selected.role}</p></div><div className="ed-article__body"><p>{selected.body}</p>{selected.attachment && <button className="ed-attachment" type="button"><PaperClipOutlined />{selected.attachment}<ArrowRightOutlined /></button>}</div>{selected.reply && <blockquote className="ed-sent"><span>YOUR RESPONSE · 已回复</span><p>{selected.reply}</p></blockquote>}<aside className="ed-editor-note"><span>EDITOR'S NOTE · AI 摘要</span><p>{selected.summary}</p>{selected.draft && <button type="button" onClick={() => { setDraft(selected.draft); workspace.notify('建议回复已填入信纸'); }}>采用建议回复 <ArrowRightOutlined /></button>}</aside></div><footer className="ed-reply"><div className="ed-reply__heading"><span>WRITE YOUR RESPONSE</span>{selected.kind === 'todo' && <button type="button" className={selected.done ? 'is-done' : ''} onClick={() => workspace.toggleDone(selected.id)}><CheckOutlined />{selected.done ? '事项已完成' : '完成此事项'}</button>}</div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`亲爱的 ${selected.sender}…`} /><div><span><PaperClipOutlined /> 添加附件</span><button type="button" disabled={!draft.trim()} onClick={send}>发送回复 <SendOutlined /></button></div></footer></article>
        </div>
      </main>}
      <ComposeDialog workspace={workspace} />
    </div>
  );
}
