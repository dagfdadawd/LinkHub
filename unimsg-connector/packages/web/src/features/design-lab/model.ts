import { useMemo, useState } from 'react';

export type DesignPlatform = 'feishu' | 'dingtalk' | 'wecom' | 'mail';
export type DesignSection = 'inbox' | 'todos' | 'trace' | 'accounts';
export type DesignStatus = '待处理' | '处理中' | '已发送' | '已同步' | '发送失败';

export interface DesignMessage {
  id: string;
  platform: DesignPlatform;
  sender: string;
  role: string;
  body: string;
  time: string;
  date: string;
  unread: boolean;
  status: DesignStatus;
  kind: 'message' | 'todo';
  done: boolean;
  priority?: '高' | '中' | '普通';
  summary: string;
  draft: string;
  conversation: string;
  trace: string;
  attachment?: string;
  reply?: string;
}

export const PLATFORM_META: Record<DesignPlatform, { name: string; short: string; color: string }> = {
  feishu: { name: '飞书', short: '飞', color: '#3370ff' },
  dingtalk: { name: '钉钉', short: '钉', color: '#1677ff' },
  wecom: { name: '企业微信', short: '企', color: '#07c160' },
  mail: { name: '邮箱', short: '邮', color: '#f2994a' },
};

export const INITIAL_MESSAGES: DesignMessage[] = [
  {
    id: 'LH-2601', platform: 'feishu', sender: '林晓然', role: '产品设计 · 体验组',
    body: '新版官网的高保真页面已经放到 Figma 了。首页的信息层级我重新梳理了一版，想请你重点看看首屏价值主张和移动端导航。今天下班前给我一些反馈就可以，我们明天一起过最终稿。',
    time: '10:42', date: '今天 10:42', unread: true, status: '待处理', kind: 'todo', done: false, priority: '高',
    summary: '需要你审阅新版官网设计，重点关注首屏价值主张与移动端导航，并在今天下班前反馈。',
    draft: '收到，我会重点看首屏信息层级和移动端导航，今天下班前把反馈整理到 Figma 里。', conversation: '产品设计群', trace: 'tr_8fa2c901',
  },
  {
    id: 'LH-2602', platform: 'dingtalk', sender: '陈墨', role: '前端负责人',
    body: '明早 10 点产品评审，会议室 A301。新的消息闭环演示需要你再过一遍，尤其是异常重试和状态回流，辛苦提前准备一下。',
    time: '10:18', date: '今天 10:18', unread: true, status: '待处理', kind: 'todo', done: false, priority: '中',
    summary: '明早 10:00 在 A301 进行产品评审，需要提前验证消息闭环、异常重试与状态回流。',
    draft: '好的，我今晚会完整跑一遍闭环和异常重试，明早提前十分钟到会议室准备演示。', conversation: '陈墨', trace: 'tr_2bd714e8',
  },
  {
    id: 'LH-2603', platform: 'mail', sender: '周奕', role: '市场合作部',
    body: '附件是 Q4 联合活动方案的最终版本。我们已经根据昨天的讨论调整了渠道预算，烦请确认数据引用和品牌露出部分，如无修改今天会正式发出。',
    time: '09:36', date: '今天 09:36', unread: true, status: '处理中', kind: 'message', done: false,
    summary: 'Q4 联合活动方案已定稿，等待确认数据引用与品牌露出，附件包含最终版本。',
    draft: '附件已收到，我会尽快核对数据引用和品牌露出部分，确认后直接邮件回复你。', conversation: 'Q4 联合活动', trace: 'tr_65c09a42', attachment: 'Q4_联合活动方案_Final.pdf · 4.8 MB',
  },
  {
    id: 'LH-2604', platform: 'wecom', sender: '王梓', role: '客户成功 · 企业服务',
    body: '客户反馈登录偶发失败，主要集中在今天上午。我已经整理了三条问题会话，方便拉个群一起看下日志吗？客户希望下午四点前有初步结论。',
    time: '09:12', date: '今天 09:12', unread: false, status: '待处理', kind: 'todo', done: false, priority: '高',
    summary: '客户出现偶发登录失败，需要联合排查日志，并在 16:00 前提供初步结论。',
    draft: '可以，你把问题会话发到群里，我先检查认证服务和网关日志，下午三点同步初步排查结果。', conversation: '客户服务群', trace: 'tr_9e1b330d',
  },
  {
    id: 'LH-2605', platform: 'feishu', sender: '孙宁', role: '研发效能',
    body: '本周连接器稳定性的周报已生成，四个平台的平均响应时间都有下降。详细数据在报告中，建议你抽空看一下邮箱通道的延迟变化。',
    time: '昨天', date: '昨天 18:26', unread: false, status: '已同步', kind: 'message', done: true,
    summary: '连接器稳定性周报已生成，四平台响应时间均下降，建议关注邮箱通道延迟变化。',
    draft: '周报收到，数据趋势不错。我会重点看邮箱通道的延迟变化。', conversation: '研发效能群', trace: 'tr_4ac8129f', reply: '收到，周报数据很清晰，邮箱通道的部分我会单独看。',
  },
  {
    id: 'LH-2606', platform: 'mail', sender: 'ArchDaily', role: '设计灵感订阅',
    body: 'Your weekly edit of adaptive workspaces, quiet interfaces and the ideas shaping a more thoughtful digital world.',
    time: '昨天', date: '昨天 16:08', unread: false, status: '已同步', kind: 'message', done: true,
    summary: '本周设计灵感精选：自适应工作空间、安静界面与数字体验趋势。',
    draft: '', conversation: '设计订阅', trace: 'tr_71fb0c26',
  },
];

export interface ComposeInput { platform: DesignPlatform; recipient: string; body: string }

export interface DesignAccountView {
  platform: DesignPlatform;
  account: string;
  status: string;
  note: string;
  connected: boolean;
}

const DEMO_ACCOUNTS: DesignAccountView[] = [
  { platform: 'feishu', account: 'linkhub@studio.cn', status: '本人 · 已连接', note: '消息与群聊同步正常', connected: true },
  { platform: 'dingtalk', account: '陈默 · 产品团队', status: '本人 · 已连接', note: 'Stream 长连接运行中', connected: true },
  { platform: 'wecom', account: 'LinkHub 企业应用', status: '需完成配置', note: '待添加企业可信 IP', connected: false },
  { platform: 'mail', account: '2 个邮箱账号', status: '已验证', note: 'IMAP / SMTP 均可用', connected: true },
];

export function useDesignWorkspace() {
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [selectedId, setSelectedId] = useState('LH-2601');
  const [section, setSection] = useState<DesignSection>('inbox');
  const [platform, setPlatform] = useState<DesignPlatform | 'all'>('all');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);

  const visibleMessages = useMemo(() => messages.filter((message) => {
    const inChannel = platform === 'all' || message.platform === platform;
    const term = query.trim().toLowerCase();
    const inSearch = !term || `${message.sender}${message.body}${message.conversation}`.toLowerCase().includes(term);
    return inChannel && inSearch;
  }), [messages, platform, query]);

  const selected = messages.find((message) => message.id === selectedId) ?? messages[0];
  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 2600);
  };
  const selectMessage = (id: string, keepSection = false) => {
    setSelectedId(id);
    if (!keepSection) setSection('inbox');
    setMessages((current) => current.map((message) => message.id === id ? { ...message, unread: false } : message));
  };
  const toggleDone = (id: string) => {
    setMessages((current) => current.map((message) => message.id === id ? { ...message, done: !message.done } : message));
    notify('待办状态已更新');
  };
  const reply = (id: string, body: string) => {
    if (!body.trim()) return false;
    setMessages((current) => current.map((message) => message.id === id ? {
      ...message, reply: body.trim(), status: '已同步', unread: false,
    } : message));
    notify('回复已提交 · 演示环境已模拟同步');
    return true;
  };
  const addTodo = (id: string) => {
    setMessages((current) => current.map((message) => message.id === id ? {
      ...message, kind: 'todo', done: false, status: '待处理',
    } : message));
    notify('已添加到待办清单');
  };
  const compose = ({ platform: target, recipient, body }: ComposeInput) => {
    if (!recipient.trim() || !body.trim()) return false;
    const id = `LH-${Date.now().toString().slice(-4)}`;
    const message: DesignMessage = {
      id, platform: target, sender: recipient.trim(), role: '由 LinkHub 发起',
      body: body.trim(), time: '刚刚', date: '刚刚', unread: false, status: '已同步', kind: 'message', done: false,
      summary: body.trim(), draft: '', conversation: recipient.trim(), trace: `tr_${Date.now().toString(16)}`, reply: body.trim(),
    };
    setMessages((current) => [message, ...current]);
    setSelectedId(id);
    setComposeOpen(false);
    setSection('inbox');
    notify('新消息已创建 · 演示环境已模拟发送');
    return true;
  };

  return {
    messages, visibleMessages, selected, selectedId, section, platform, query, toast, composeOpen,
    setSection, setPlatform, setQuery, setComposeOpen, selectMessage, toggleDone, addTodo, reply, compose, notify,
    accounts: DEMO_ACCOUNTS,
    manageAccount: () => notify('连接管理（概念预览）'),
    openLegacy: () => notify('旧版界面（概念预览）'),
    openTrace: (_id?: string) => { setSection('trace'); },
  };
}

export type DesignWorkspace = ReturnType<typeof useDesignWorkspace>;
