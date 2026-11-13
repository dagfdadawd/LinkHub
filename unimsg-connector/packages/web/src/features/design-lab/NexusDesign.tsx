import { useEffect, useState } from 'react';
import {
  ApiOutlined, ArrowRightOutlined, CheckOutlined, CheckSquareOutlined, CodeOutlined,
  HistoryOutlined, InboxOutlined, PaperClipOutlined, PlusOutlined, RadarChartOutlined,
  SearchOutlined, SendOutlined, SettingOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { PLATFORM_META } from './model';
import type { DesignSection, DesignWorkspace } from './model';
import { ComposeDialog, EmptyResults, PlatformMark, SecondaryView, StatusPill } from './shared';

const NAV: Array<{ id: DesignSection; label: string; icon: React.ReactNode }> = [
  { id: 'inbox', label: '消息流', icon: <InboxOutlined /> }, { id: 'todos', label: '任务队列', icon: <CheckSquareOutlined /> },
  { id: 'trace', label: '链路追踪', icon: <HistoryOutlined /> }, { id: 'accounts', label: '节点连接', icon: <ApiOutlined /> },
];

export function NexusDesign({ workspace }: { workspace: DesignWorkspace }) {
  const { selected } = workspace;
  const [draft, setDraft] = useState(selected.draft);
  useEffect(() => setDraft(selected.draft), [selected.id, selected.draft]);
  const send = () => { if (workspace.reply(selected.id, draft)) setDraft(''); };

  return (
    <div className="dl-design dl-nexus">
      <div className="nx-grid-bg" />
      <aside className="nx-rail">
        <button className="nx-logo" type="button" onClick={() => workspace.setSection('inbox')} aria-label="LinkHub 首页"><span /><span /></button>
        <nav>{NAV.map((item, index) => <button type="button" key={item.id} className={workspace.section === item.id ? 'is-active' : ''} onClick={() => workspace.setSection(item.id)} title={item.label}>{item.icon}<small>0{index + 1}</small></button>)}</nav>
        <div className="nx-rail__bottom"><button type="button" onClick={() => workspace.notify('系统偏好（概念预览）')}><SettingOutlined /></button><span className="nx-avatar">AC<i /></span></div>
      </aside>
      <main className="nx-main">
        <header className="nx-header"><div className="nx-title"><span className="nx-wordmark">LINKHUB</span><i>/</i><strong>{NAV.find((item) => item.id === workspace.section)?.label}</strong></div><label className="nx-search"><SearchOutlined /><input value={workspace.query} onChange={(event) => { workspace.setQuery(event.target.value); workspace.setSection('inbox'); }} placeholder="SEARCH ALL SIGNALS" /><kbd>CTRL K</kbd></label><span className="nx-live"><i />SYSTEM ONLINE</span><button className="nx-compose" type="button" onClick={() => workspace.setComposeOpen(true)}><PlusOutlined />NEW MESSAGE</button></header>

        {workspace.section !== 'inbox' ? <div className="nx-secondary"><div className="nx-section-code">MODULE / {workspace.section.toUpperCase()}</div><SecondaryView workspace={workspace} /></div> : <div className="nx-dashboard">
          <section className="nx-hero"><div><span className="nx-kicker"><i />UNIFIED MESSAGE OS · V2.6</span><h1>Signal, not noise<span>.</span></h1><p>所有消息已汇入。现在，专注于真正重要的回应。</p></div><div className="nx-hero__time"><span>LOCAL TIME</span><strong>22:23<small>:07</small></strong><time>2026.11.12 / THU</time></div></section>
          <section className="nx-metrics"><article><span>INBOUND / TODAY</span><strong>{String(workspace.messages.length).padStart(2, '0')}</strong><small><i className="up" />+12.5% vs yesterday</small></article><article><span>PENDING TASKS</span><strong>{String(workspace.messages.filter((message) => message.kind === 'todo' && !message.done).length).padStart(2, '0')}</strong><small><i />2 high priority</small></article><article><span>SYNC SUCCESS</span><strong>96<em>%</em></strong><small><i className="up" />within normal range</small></article><article><span>ACTIVE NODES</span><strong>03<em>/04</em></strong><small><i />1 needs attention</small></article></section>
          <div className="nx-workspace">
            <section className="nx-stream">
              <header><div><RadarChartOutlined /><strong>MESSAGE STREAM</strong></div><span>{workspace.visibleMessages.length} OBJECTS</span></header>
              <div className="nx-channels"><button type="button" className={workspace.platform === 'all' ? 'is-active' : ''} onClick={() => workspace.setPlatform('all')}>ALL</button>{(Object.keys(PLATFORM_META) as Array<keyof typeof PLATFORM_META>).map((key) => <button type="button" key={key} className={workspace.platform === key ? 'is-active' : ''} onClick={() => workspace.setPlatform(key)} title={PLATFORM_META[key].name}><PlatformMark platform={key} size="small" /></button>)}</div>
              <div className="nx-stream__scroll">{workspace.visibleMessages.length === 0 ? <EmptyResults onReset={() => { workspace.setPlatform('all'); workspace.setQuery(''); }} /> : workspace.visibleMessages.map((message) => <button type="button" key={message.id} className={`nx-message${selected.id === message.id ? ' is-active' : ''}`} onClick={() => workspace.selectMessage(message.id)}><div className="nx-message__meta"><PlatformMark platform={message.platform} size="small" /><span>{message.id}</span><time>{message.time}</time>{message.unread && <i />}</div><strong>{message.sender}<small>{message.conversation}</small></strong><p>{message.body}</p><footer><span>{message.kind === 'todo' ? 'ACTION REQUIRED' : 'MESSAGE'}</span><StatusPill message={message} /></footer></button>)}</div>
            </section>

            <section className="nx-detail">
              <header><div><span>ACTIVE OBJECT / {selected.id}</span><h2>{selected.sender}<small>{selected.role}</small></h2></div><button type="button" onClick={() => workspace.setSection('trace')}><CodeOutlined /> TRACE</button></header>
              <div className="nx-detail__scroll"><div className="nx-origin"><PlatformMark platform={selected.platform} /><span>{PLATFORM_META[selected.platform].name} / {selected.conversation}</span><time>{selected.date}</time></div><article className="nx-payload"><span>INCOMING PAYLOAD</span><p>{selected.body}</p>{selected.attachment && <button type="button"><PaperClipOutlined />{selected.attachment}</button>}</article>{selected.reply && <article className="nx-response"><span><CheckOutlined />OUTGOING / SYNCED</span><p>{selected.reply}</p></article>}<div className="nx-route"><span className="is-complete">RECEIVED</span><i /><span className="is-complete">PROCESSED</span><i /><span className={selected.reply ? 'is-complete' : 'is-current'}>{selected.reply ? 'SYNCED' : 'AWAITING REPLY'}</span></div></div>
              <footer className="nx-reply"><div><span>RESPONSE COMPOSER</span><small>IDENTITY: PERSONAL</small></div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type response_" /><footer><button type="button" onClick={() => workspace.notify('附件模块就绪（概念预览）')}><PaperClipOutlined />ATTACH</button><button type="button" className="nx-send" disabled={!draft.trim()} onClick={send}><SendOutlined />TRANSMIT<ArrowRightOutlined /></button></footer></footer>
            </section>

            <aside className="nx-intel"><section className="nx-ai"><div className="nx-ai__orb"><span /><i /></div><span className="nx-kicker">LINKHUB INTELLIGENCE</span><h3>已理解，<br />等待你的判断。</h3><p>{selected.summary}</p><button type="button" disabled={!selected.draft} onClick={() => { setDraft(selected.draft); workspace.notify('建议响应已注入编辑器'); }}><ThunderboltOutlined />APPLY SUGGESTION</button></section><section className="nx-node-health"><header><span>NODE HEALTH</span><small>LIVE</small></header>{(Object.keys(PLATFORM_META) as Array<keyof typeof PLATFORM_META>).map((key, index) => <button type="button" key={key} onClick={() => workspace.setSection('accounts')}><PlatformMark platform={key} size="small" /><span>{PLATFORM_META[key].name}</span><i className={index === 2 ? 'is-warning' : ''} /><small>{index === 2 ? 'SETUP' : `${42 + index * 17}ms`}</small></button>)}</section>{selected.kind === 'todo' && <button className={`nx-complete${selected.done ? ' is-done' : ''}`} type="button" onClick={() => workspace.toggleDone(selected.id)}><CheckOutlined />{selected.done ? 'TASK COMPLETED' : 'MARK AS COMPLETE'}</button>}</aside>
          </div>
        </div>}
      </main>
      <ComposeDialog workspace={workspace} />
    </div>
  );
}
