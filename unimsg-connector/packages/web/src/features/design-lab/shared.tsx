import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import {
  ApiOutlined, ArrowRightOutlined, CheckCircleFilled, CheckOutlined, ClockCircleOutlined,
  CloseOutlined, HistoryOutlined, MailOutlined, PaperClipOutlined, SendOutlined,
  SyncOutlined, TeamOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { PLATFORM_META } from './model';
import type { DesignMessage, DesignPlatform, DesignWorkspace } from './model';

export function PlatformMark({ platform, size = 'normal' }: { platform: DesignPlatform; size?: 'small' | 'normal' | 'large' }) {
  const icons: Record<DesignPlatform, ReactNode> = {
    feishu: <SendOutlined />, dingtalk: <ThunderboltOutlined />, wecom: <TeamOutlined />, mail: <MailOutlined />,
  };
  return (
    <span
      className={`dl-platform dl-platform--${size}`}
      style={{ '--platform-color': PLATFORM_META[platform].color } as CSSProperties}
      aria-label={PLATFORM_META[platform].name}
    >{icons[platform]}</span>
  );
}

export function PersonAvatar({ message, large = false }: { message: DesignMessage; large?: boolean }) {
  return <span className={`dl-avatar${large ? ' dl-avatar--large' : ''}`} data-platform={message.platform}>{message.sender.slice(0, 1)}</span>;
}

export function StatusPill({ message }: { message: DesignMessage }) {
  return <span className={`dl-status dl-status--${message.status === '已同步' ? 'done' : message.status === '待处理' ? 'pending' : 'working'}`}><i />{message.status}</span>;
}

/** 消息处理状态：未读 → 已读未处理 → 已处理（待办完成或已回复均视为已处理） */
export function processStateOf(message: DesignMessage): { label: '未读' | '已读未处理' | '已处理'; tone: 'unread' | 'pending' | 'done' } {
  if (message.unread) return { label: '未读', tone: 'unread' };
  if (message.kind === 'todo') return message.done ? { label: '已处理', tone: 'done' } : { label: '已读未处理', tone: 'pending' };
  return message.reply ? { label: '已处理', tone: 'done' } : { label: '已读未处理', tone: 'pending' };
}

export function ProcessStateBadge({ message }: { message: DesignMessage }) {
  const state = processStateOf(message);
  return <span className={`fl-state fl-state--${state.tone}`}><i />{state.label}</span>;
}

export function EmptyResults({ onReset }: { onReset: () => void }) {
  return <div className="dl-empty"><SearchGlyph /><strong>没有找到相关消息</strong><span>换个关键词，或查看全部渠道。</span><button type="button" onClick={onReset}>清空筛选</button></div>;
}

function SearchGlyph() {
  return <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="21" cy="21" r="12" /><path d="m30 30 9 9" /></svg>;
}

const TRACE_STEPS = [
  { title: '消息接收', detail: '签名校验通过，消息已标准化入库', time: '10:42:01', icon: <ApiOutlined /> },
  { title: '智能理解', detail: '意图识别完成，生成摘要与回复建议', time: '10:42:02', icon: <ClockCircleOutlined /> },
  { title: '人工处理', detail: '用户确认回复内容与目标会话', time: '10:45:18', icon: <CheckOutlined /> },
  { title: '平台回写', detail: '回复已通过原平台身份发送', time: '10:45:19', icon: <SendOutlined /> },
  { title: '状态回流', detail: '平台回执已接收，全链路同步完成', time: '10:45:21', icon: <SyncOutlined /> },
];

export function SecondaryView({ workspace }: { workspace: DesignWorkspace }) {
  const { section, messages, selected, selectMessage, toggleDone } = workspace;
  if (section === 'todos') {
    const todos = messages.filter((message) => message.kind === 'todo');
    return (
      <section className="dl-secondary dl-todos-view">
        <header className="dl-secondary__head"><span className="dl-kicker">FOCUS & FINISH</span><h2>待办清单</h2><p>把散落在各个平台的小事，变成今天可以完成的事。</p></header>
        <div className="dl-todo-list">
          {todos.map((message) => (
            <article className={`dl-todo-row${message.done ? ' is-done' : ''}`} key={message.id}>
              <button className="dl-check" type="button" onClick={() => toggleDone(message.id)} aria-label={message.done ? '标记未完成' : '标记完成'}>{message.done && <CheckOutlined />}</button>
              <PlatformMark platform={message.platform} />
              <button className="dl-todo-row__content" type="button" onClick={() => selectMessage(message.id)}><strong>{message.summary}</strong><span>{message.sender} · {message.conversation}</span></button>
              <span className="dl-todo-row__time">{message.priority ?? '普通'}优先级</span>
              <ArrowRightOutlined />
            </article>
          ))}
        </div>
      </section>
    );
  }
  if (section === 'trace') {
    return (
      <section className="dl-secondary dl-trace-view">
        <header className="dl-secondary__head"><span className="dl-kicker">EVERY STEP, VISIBLE</span><h2>全链路回放</h2><p>从接收、理解到回写，每一步都有据可查。</p></header>
        <div className="dl-trace-layout">
          <div className="dl-trace-messages">{messages.slice(0, 4).map((message) => <button type="button" className={message.id === selected.id ? 'is-active' : ''} key={message.id} onClick={() => selectMessage(message.id, true)}><PlatformMark platform={message.platform} size="small" /><span><strong>{message.sender}</strong><small>{message.id}</small></span></button>)}</div>
          <div className="dl-timeline">
            <div className="dl-timeline__meta"><HistoryOutlined /><span>{selected.trace}</span><StatusPill message={selected} /></div>
            {TRACE_STEPS.map((step, index) => <div className="dl-timeline__step" key={step.title}><span className="dl-timeline__icon">{step.icon}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div><time>{step.time}</time><i>{String(index + 1).padStart(2, '0')}</i></div>)}
          </div>
        </div>
      </section>
    );
  }
  if (section === 'accounts') {
    const accounts = workspace.accounts;
    return (
      <section className="dl-secondary dl-accounts-view">
        <header className="dl-secondary__head"><span className="dl-kicker">YOUR CONNECTED WORLD</span><h2>平台连接</h2><p>一个入口，连接你每天使用的所有沟通工具。</p></header>
        <div className="dl-account-grid">{accounts.map((account) => <article className="dl-account-card" key={account.platform}><div className="dl-account-card__top"><PlatformMark platform={account.platform} size="large" /><span className={account.connected ? '' : 'is-warning'}><CheckCircleFilled />{account.status}</span></div><h3>{PLATFORM_META[account.platform].name}</h3><strong>{account.account}</strong><p>{account.note}</p><button type="button" onClick={() => workspace.manageAccount()}>管理连接 <ArrowRightOutlined /></button></article>)}</div>
      </section>
    );
  }
  return null;
}

export function ComposeDialog({ workspace }: { workspace: DesignWorkspace }) {
  const [platform, setPlatform] = useState<DesignPlatform>('feishu');
  const [recipient, setRecipient] = useState('');
  const [body, setBody] = useState('');
  useEffect(() => {
    if (workspace.composeOpen) { setRecipient(''); setBody(''); }
  }, [workspace.composeOpen]);
  if (!workspace.composeOpen) return null;
  const submit = (event: FormEvent) => { event.preventDefault(); workspace.compose({ platform, recipient, body }); };
  return (
    <div className="dl-modal-scrim" role="presentation" onMouseDown={() => workspace.setComposeOpen(false)}>
      <form className="dl-compose-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()} aria-label="新建发送">
        <header><div><span className="dl-kicker">NEW MESSAGE</span><h2>新建发送</h2></div><button type="button" onClick={() => workspace.setComposeOpen(false)} aria-label="关闭"><CloseOutlined /></button></header>
        <label>发送到</label>
        <div className="dl-compose-platforms">{(Object.keys(PLATFORM_META) as DesignPlatform[]).map((key) => <button type="button" key={key} className={platform === key ? 'is-active' : ''} onClick={() => setPlatform(key)}><PlatformMark platform={key} size="small" />{PLATFORM_META[key].name}</button>)}</div>
        <label htmlFor="dl-recipient">联系人或会话</label><input id="dl-recipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="输入联系人或群聊名称" autoFocus />
        <label htmlFor="dl-body">消息内容</label><textarea id="dl-body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="写下要发送的内容…" rows={5} />
        <footer><span><PaperClipOutlined /> 支持文本与附件</span><button type="submit" disabled={!recipient.trim() || !body.trim()}><SendOutlined /> 确认发送</button></footer>
      </form>
    </div>
  );
}

export function DesignToast({ text }: { text: string }) {
  if (!text) return null;
  return <div className="dl-toast" role="status"><CheckCircleFilled />{text}</div>;
}
