/**
 * 群消息视图原型（/preview/groups）
 *
 * 目的：让产品决策者**看见**两种展示方案的差别，再决定「群消息全收」怎么展示。
 * 纯前端、静态假数据、不进真实数据、不影响现有页面；确认方案后这份文件可直接删除。
 *
 * 方案 A 折叠：单聊 / @我 / 待办 优先，群消息按会话聚合成一行，点开才逐条看
 * 方案 B 平铺：像微信，群里每条消息都单独占一行
 */
import { useMemo, useState } from 'react';
import { Button, Segmented, Tag } from 'antd';
import {
  BellOutlined,
  MailOutlined,
  MessageOutlined,
  TeamOutlined,
} from '@ant-design/icons';

interface DemoMessage {
  id: string;
  sender: string;
  text: string;
  at: string;
  mentionsMe?: boolean;
  fromMe?: boolean;
}

interface DemoConversation {
  id: string;
  name: string;
  kind: 'p2p' | 'group' | 'mail';
  unread: number;
  mentionsMe: number;
  messages: DemoMessage[];
}

const DEMO: DemoConversation[] = [
  {
    id: 'p2p-zheng',
    name: '郑友佳',
    kind: 'p2p',
    unread: 2,
    mentionsMe: 0,
    messages: [
      { id: 'm1', sender: '郑友佳', text: '明天上午的评审会你参加吗？', at: '今天 09:12' },
      { id: 'm2', sender: '我', text: '参加，我提前十分钟到。', at: '今天 09:15', fromMe: true },
      { id: 'm3', sender: '郑友佳', text: '好，会议室 A301。', at: '今天 09:16' },
    ],
  },
  {
    id: 'p2p-lebin',
    name: '郑乐斌',
    kind: 'p2p',
    unread: 0,
    mentionsMe: 0,
    messages: [
      { id: 'm4', sender: '郑乐斌', text: '接口文档更新了，记得看 v2。', at: '昨天 18:20' },
    ],
  },
  {
    id: 'group-msg',
    name: '消息管理',
    kind: 'group',
    unread: 12,
    mentionsMe: 3,
    messages: [
      { id: 'g1', sender: '陈(陈)', text: '今天的发布窗口推迟到 20:00。', at: '今天 10:02' },
      { id: 'g2', sender: '郑乐斌', text: '@郑友佳 请问你想约什么时间、什么地点呢？', at: '今天 10:05', mentionsMe: true },
      { id: 'g3', sender: '林工', text: '我这边测试环境已经好了。', at: '今天 10:08' },
      { id: 'g4', sender: '陈(陈)', text: '收到。', at: '今天 10:09' },
      { id: 'g5', sender: '郑乐斌', text: '@郑友佳 记得把回归结果贴上来', at: '今天 10:31', mentionsMe: true },
      { id: 'g6', sender: '林工', text: '这个报错有人遇到过吗？', at: '今天 10:44' },
      { id: 'g7', sender: '陈(陈)', text: '@郑友佳 帮忙看下这个报错', at: '今天 10:45', mentionsMe: true },
      { id: 'g8', sender: '林工', text: '已解决，是缓存没清。', at: '今天 10:52' },
      { id: 'g9', sender: '陈(陈)', text: '好，那按计划走。', at: '今天 11:03' },
      { id: 'g10', sender: '郑乐斌', text: '周报模板更新了。', at: '今天 11:20' },
      { id: 'g11', sender: '林工', text: '收到', at: '今天 11:21' },
      { id: 'g12', sender: '陈(陈)', text: '下午三点对齐一下进度。', at: '今天 11:40' },
    ],
  },
  {
    id: 'group-notify',
    name: '工作通知:消息管理',
    kind: 'group',
    unread: 3,
    mentionsMe: 0,
    messages: [
      { id: 'n1', sender: '系统通知', text: '你有一条新的审批待处理。', at: '今天 08:00' },
      { id: 'n2', sender: '系统通知', text: '考勤异常提醒：昨日未打卡。', at: '今天 08:05' },
      { id: 'n3', sender: '系统通知', text: '月度报表已生成。', at: '今天 08:30' },
    ],
  },
  {
    id: 'mail-1',
    name: '验证 Apple 账户电子邮件地址',
    kind: 'mail',
    unread: 1,
    mentionsMe: 0,
    messages: [{ id: 'e1', sender: 'Apple', text: '请验证你的电子邮件地址…', at: '今天 12:27' }],
  },
];

const KIND_ICON = {
  p2p: <MessageOutlined />,
  group: <TeamOutlined />,
  mail: <MailOutlined />,
};

function ChatPane({ conv }: { conv: DemoConversation }) {
  return (
    <div className="pv-chat">
      <header className="pv-chat__head">
        <span className="pv-chat__title">{conv.name}</span>
        <Tag bordered={false}>{conv.kind === 'group' ? '群' : conv.kind === 'mail' ? '邮箱' : '单聊'}</Tag>
      </header>
      <div className="pv-chat__body">
        {conv.messages.map((m) => (
          <div key={m.id} className={`pv-msg${m.fromMe ? ' pv-msg--out' : ''}`}>
            {!m.fromMe && <div className="pv-msg__who">{m.sender}</div>}
            <div className={`pv-msg__bubble${m.mentionsMe ? ' pv-msg__bubble--at' : ''}`}>
              {m.text}
            </div>
            <div className="pv-msg__time">{m.at}{m.fromMe ? ' · 我' : ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GroupViewPreview() {
  /** A = 折叠（群消息聚合），B = 平铺（每条都进列表），C = 顶部切换（推荐） */
  const [mode, setMode] = useState<'A' | 'B' | 'C'>('C');
  /** C 方案里的频道标签：全部 / 单聊 / @我 / 群消息 */
  const [channel, setChannel] = useState<'all' | 'direct' | 'at' | 'group'>('all');
  const [selected, setSelected] = useState('p2p-zheng');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 频道条视觉样式：quiet(纯文本) / underline(下划线) / soft(胶囊) */
  const [tabStyle, setTabStyle] = useState<'quiet' | 'underline' | 'soft'>('quiet');

  const conv = DEMO.find((c) => c.id === selected) ?? DEMO[0];

  const stats = useMemo(() => {
    const total = DEMO.reduce((n, c) => n + c.unread, 0);
    const groupMsgs = DEMO.filter((c) => c.kind === 'group').reduce((n, c) => n + c.messages.length, 0);
    const mentions = DEMO.reduce((n, c) => n + c.mentionsMe, 0);
    return { total, groupMsgs, mentions };
  }, []);

  /** 方案 A 的行：单聊/待办/@我 优先，群折叠成一行 */
  const rowsA = useMemo(() => {
    const direct = DEMO.filter((c) => c.kind !== 'group');
    const groups = DEMO.filter((c) => c.kind === 'group');
    return { direct, groups };
  }, []);

  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="pv">
      <div className="pv__bar">
        <div className="pv__title">
          群消息展示方案预览
          <span className="pv__sub">
            共 {stats.groupMsgs} 条群消息 · 其中 @我 {stats.mentions} 条 · 未读 {stats.total}
          </span>
        </div>
        <Segmented
          size="small"
          value={tabStyle}
          onChange={(v) => setTabStyle(v as 'quiet' | 'underline' | 'soft')}
          options={[
            { label: '标签：纯文本', value: 'quiet' },
            { label: '标签：下划线', value: 'underline' },
            { label: '标签：胶囊', value: 'soft' },
          ]}
        />
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as 'A' | 'B' | 'C')}
          options={[
            { label: '★ C · 顶部切换 + 群折叠（推荐）', value: 'C' },
            { label: 'A · 群消息折叠', value: 'A' },
            { label: 'B · 全部平铺（微信式）', value: 'B' },
          ]}
        />
      </div>

      <div className="pv__body">
        <aside className="pv__list">
          {mode === 'C' ? (
            <>
              <div className="pv__tabs" data-style={tabStyle}>
                {([
                  ['all', '全部', stats.total],
                  ['direct', '单聊', DEMO.filter((x) => x.kind !== 'group').reduce((n, x) => n + x.unread, 0)],
                  ['at', '@我', stats.mentions],
                  ['group', '群消息', stats.groupMsgs],
                ] as const).map(([id, label, count]) => (
                  <button
                    type="button"
                    key={id}
                    className={`pv__tab${channel === id ? ' pv__tab--active' : ''}`}
                    onClick={() => setChannel(id)}
                  >
                    {label}
                    {count > 0 && <span className="pv__tab-count">{count}</span>}
                  </button>
                ))}
              </div>

              {channel === 'at' && DEMO.flatMap((c) =>
                c.messages.filter((m) => m.mentionsMe).map((m) => (
                  <button
                    type="button"
                    key={`${c.id}:${m.id}`}
                    className={`pv-row${c.id === selected ? ' pv-row--active' : ''}`}
                    onClick={() => setSelected(c.id)}
                  >
                    <span className="pv-row__icon">{KIND_ICON.group}</span>
                    <span className="pv-row__main">
                      <span className="pv-row__name">{c.name}</span>
                      <span className="pv-row__preview">{m.sender}：{m.text}</span>
                    </span>
                    <span className="pv-row__time">{m.at}</span>
                  </button>
                )),
              )}

              {channel === 'direct' && DEMO.filter((c) => c.kind !== 'group').map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`pv-row${c.id === selected ? ' pv-row--active' : ''}`}
                  onClick={() => setSelected(c.id)}
                >
                  <span className="pv-row__icon">{KIND_ICON[c.kind]}</span>
                  <span className="pv-row__main">
                    <span className="pv-row__name">{c.name}</span>
                    <span className="pv-row__preview">{c.messages[c.messages.length - 1]?.text}</span>
                  </span>
                  {c.unread > 0 && <span className="pv-row__badge">{c.unread}</span>}
                </button>
              ))}

              {channel === 'group' && DEMO.filter((c) => c.kind === 'group').map((c) => {
                const open = expanded.has(c.id);
                return (
                  <div key={c.id}>
                    <button type="button" className="pv-row pv-row--group" onClick={() => toggleGroup(c.id)}>
                      <span className="pv-row__icon">{KIND_ICON.group}</span>
                      <span className="pv-row__main">
                        <span className="pv-row__name">
                          {c.name}
                          {c.mentionsMe > 0 && (
                            <span className="pv-row__at"><BellOutlined /> @我 {c.mentionsMe}</span>
                          )}
                        </span>
                        <span className="pv-row__preview">{c.messages.length} 条消息 · 未读 {c.unread}</span>
                      </span>
                      <span className="pv-row__time">{open ? '收起' : '展开'}</span>
                    </button>
                    {open && c.messages.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        className={`pv-row pv-row--nested${c.id === selected ? ' pv-row--active' : ''}`}
                        onClick={() => setSelected(c.id)}
                      >
                        <span className="pv-row__main">
                          <span className="pv-row__preview"><b>{m.sender}：</b>{m.text}</span>
                          <span className="pv-row__time">{m.at}</span>
                        </span>
                        {m.mentionsMe && <span className="pv-row__dot" />}
                      </button>
                    ))}
                  </div>
                );
              })}

              {channel === 'all' && (
                <>
                  <div className="pv__section">需要我的</div>
                  {DEMO.flatMap((c) =>
                    c.messages.filter((m) => m.mentionsMe).map((m) => (
                      <button
                        type="button"
                        key={`at:${c.id}:${m.id}`}
                        className="pv-row"
                        onClick={() => setSelected(c.id)}
                      >
                        <span className="pv-row__icon">{KIND_ICON.group}</span>
                        <span className="pv-row__main">
                          <span className="pv-row__name">{c.name} · {m.sender}</span>
                          <span className="pv-row__preview">{m.text}</span>
                        </span>
                        <span className="pv-row__at"><BellOutlined /> @我</span>
                      </button>
                    )),
                  )}
                  <div className="pv__section pv__section--gap">单聊</div>
                  {rowsA.direct.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className={`pv-row${c.id === selected ? ' pv-row--active' : ''}`}
                      onClick={() => setSelected(c.id)}
                    >
                      <span className="pv-row__icon">{KIND_ICON[c.kind]}</span>
                      <span className="pv-row__main">
                        <span className="pv-row__name">{c.name}</span>
                        <span className="pv-row__preview">{c.messages[c.messages.length - 1]?.text}</span>
                      </span>
                      {c.unread > 0 && <span className="pv-row__badge">{c.unread}</span>}
                    </button>
                  ))}
                  <div className="pv__section pv__section--gap">
                    群消息（{rowsA.groups.length} 个群 · {stats.groupMsgs} 条）
                  </div>
                  {rowsA.groups.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className="pv-row pv-row--group"
                      onClick={() => { setChannel('group'); toggleGroup(c.id); }}
                    >
                      <span className="pv-row__icon">{KIND_ICON.group}</span>
                      <span className="pv-row__main">
                        <span className="pv-row__name">
                          {c.name}
                          {c.mentionsMe > 0 && (
                            <span className="pv-row__at"><BellOutlined /> @我 {c.mentionsMe}</span>
                          )}
                        </span>
                        <span className="pv-row__preview">
                          {c.messages[c.messages.length - 1]?.sender}：{c.messages[c.messages.length - 1]?.text}
                        </span>
                      </span>
                      {c.unread > 0 && <span className="pv-row__badge">{c.unread}</span>}
                    </button>
                  ))}
                </>
              )}
            </>
          ) : mode === 'A' ? (
            <>
              <div className="pv__section">单聊 / 待办</div>
              {rowsA.direct.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`pv-row${c.id === selected ? ' pv-row--active' : ''}`}
                  onClick={() => setSelected(c.id)}
                >
                  <span className="pv-row__icon">{KIND_ICON[c.kind]}</span>
                  <span className="pv-row__main">
                    <span className="pv-row__name">{c.name}</span>
                    <span className="pv-row__preview">{c.messages[c.messages.length - 1]?.text}</span>
                  </span>
                  {c.unread > 0 && <span className="pv-row__badge">{c.unread}</span>}
                </button>
              ))}

              <div className="pv__section pv__section--gap">
                群消息（{rowsA.groups.length} 个群 · {stats.groupMsgs} 条）
              </div>
              {rowsA.groups.map((c) => {
                const open = expanded.has(c.id);
                return (
                  <div key={c.id}>
                    <button
                      type="button"
                      className="pv-row pv-row--group"
                      onClick={() => toggleGroup(c.id)}
                    >
                      <span className="pv-row__icon">{KIND_ICON.group}</span>
                      <span className="pv-row__main">
                        <span className="pv-row__name">
                          {c.name}
                          {c.mentionsMe > 0 && (
                            <span className="pv-row__at">
                              <BellOutlined /> @我 {c.mentionsMe}
                            </span>
                          )}
                        </span>
                        <span className="pv-row__preview">
                          {c.messages[c.messages.length - 1]?.sender}：{c.messages[c.messages.length - 1]?.text}
                        </span>
                      </span>
                      {c.unread > 0 && <span className="pv-row__badge">{c.unread}</span>}
                    </button>
                    {open &&
                      c.messages.map((m) => (
                        <button
                          type="button"
                          key={m.id}
                          className={`pv-row pv-row--nested${m.id === selected ? ' pv-row--active' : ''}`}
                          onClick={() => setSelected(c.id)}
                        >
                          <span className="pv-row__main">
                            <span className="pv-row__preview">
                              <b>{m.sender}：</b>
                              {m.text}
                            </span>
                            <span className="pv-row__time">{m.at}</span>
                          </span>
                          {m.mentionsMe && <span className="pv-row__dot" />}
                        </button>
                      ))}
                  </div>
                );
              })}
            </>
          ) : (
            <>
              <div className="pv__section">全部消息（{stats.total} 条未读）</div>
              {DEMO.flatMap((c) =>
                c.messages.map((m) => (
                  <button
                    type="button"
                    key={`${c.id}:${m.id}`}
                    className={`pv-row${c.id === selected ? ' pv-row--active' : ''}`}
                    onClick={() => setSelected(c.id)}
                  >
                    <span className="pv-row__icon">{KIND_ICON[c.kind]}</span>
                    <span className="pv-row__main">
                      <span className="pv-row__name">
                        {c.kind === 'group' ? c.name : m.sender}
                        {m.mentionsMe && (
                          <span className="pv-row__at">
                            <BellOutlined /> @我
                          </span>
                        )}
                      </span>
                      <span className="pv-row__preview">{m.text}</span>
                    </span>
                    <span className="pv-row__time">{m.at}</span>
                  </button>
                )),
              )}
            </>
          )}
        </aside>

        <div className="pv__panes">
          <ChatPane conv={conv} />

          <div className="pv__note">
            <h4>{mode === 'A' ? '方案 A：群消息折叠' : mode === 'B' ? '方案 B：全部平铺' : '★ 推荐：顶部切换 + 群折叠'}</h4>
            <ul>
              {mode === 'C' ? (
                <>
                  <li>顶部四个标签：<b>全部 / 单聊 / @我 / 群消息</b>，按状态随手切换</li>
                  <li>「全部」里 @我 和单聊永远在上，群只占一行，不会被闲聊刷掉</li>
                  <li>想看群聊细节就切「群消息」，默认折叠、点开看逐条</li>
                  <li>兼顾：不漏消息（数据全收），也不被噪音淹没（默认不乱摊）</li>
                </>
              ) : mode === 'A' ? (
                <>
                  <li>单聊、@我、待办永远在最上面，不会被群聊淹没</li>
                  <li>群消息按会话聚合：一行显示「群名 + 未读数 + @我数」，点开才展开逐条</li>
                  <li>适合：群多、消息杂，只想处理"需要我的"</li>
                </>
              ) : (
                <>
                  <li>所有群消息和单聊平铺在一起，按时间倒序（和微信一致）</li>
                  <li>消息一条不漏，但群一活跃，重要消息会被刷下去</li>
                  <li>适合：群少、希望一眼看全所有动态</li>
                </>
              )}
            </ul>
            <div className="pv__actions">
              <Button type="primary" onClick={() => window.history.back()}>
                返回应用
              </Button>
              <span className="pv__hint">
                当前是静态原型：数据是假的，不会写进任何库；你选好方案后我按选中的做真实实现。
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}