/**
 * 浮光正式主界面的数据适配层。
 *
 * 设计稿只认识轻量的 DesignMessage；这里把真实 UnifiedMessage / 账号状态映射过去，
 * 所有写操作仍走 AppStore（回复、已读、完成待办、加入待办、主动发送），
 * 不复制一套演示数据，也不绕开既有业务状态机。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../../hooks/useAppState';
import { store } from '../../store';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';
import { PLATFORM_META as APP_PLATFORM_META, formatRelative } from '../../utils/format';
import { formatBytes } from '../../utils/attachments';
import type { DesignAccountView, DesignMessage, DesignPlatform, DesignSection, DesignStatus, DesignWorkspace } from './model';

const PLATFORM_ORDER: DesignPlatform[] = ['feishu', 'dingtalk', 'wecom', 'mail'];

const EMPTY_MESSAGE: DesignMessage = {
  id: '__empty__', platform: 'feishu', sender: 'LinkHub', role: '统一消息入口',
  body: '还没有收到消息。你可以先连接账号，或切到旧版界面注入一条示例消息，这里会自动出现。',
  time: '', date: '现在', unread: false, status: '待处理', kind: 'message', done: false,
  summary: '当前收件箱为空。连接账号后，新消息会实时出现在这里。', draft: '', conversation: '收件箱', trace: '',
};

function compactTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()) return '昨天';
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

function statusOf(message: UnifiedMessage): DesignStatus {
  if (message.status === MsgStatus.FAILED) return '发送失败';
  if (message.status === MsgStatus.SYNCED) return '已同步';
  if (message.status === MsgStatus.SENT) return '已发送';
  if (message.status === MsgStatus.REPLIED) return '处理中';
  return '待处理';
}

/** 平台有些账号只回原始 openId / appId；界面上用可读称呼，避免露出一长串内部 ID */
function readableSender(name: string, platform: DesignPlatform): string {
  const value = name.trim();
  const opaque = /^(ou_|on_|cli_|wm_|wo_|uid_)/i.test(value) || /^[a-z0-9_-]{24,}$/i.test(value);
  return opaque ? `${APP_PLATFORM_META[platform as Platform].name}联系人` : (value || '未知发送人');
}

function toDesignMessage(message: UnifiedMessage): DesignMessage {
  const sender = readableSender(message.sender.name, message.platform as DesignPlatform);
  const conversation = message.conversation?.title?.trim() || sender;
  const attachment = message.attachments?.[0];
  const insight = message.intent
    ? `${message.intentSource === 'llm' ? 'AI' : '规则'}识别为「${message.intent}」。`
    : '';
  return {
    id: message.traceId,
    platform: message.platform as DesignPlatform,
    sender,
    role: message.receivedAs === 'user' ? '本人账号接收' : message.receivedAs === 'bot' ? '机器人接收' : '统一入口接收',
    body: message.body || '（无文本内容）',
    time: compactTime(message.createdAt),
    date: formatRelative(message.createdAt),
    unread: !message.readAt,
    status: statusOf(message),
    kind: message.type === 'todo' ? 'todo' : 'message',
    done: Boolean(message.done),
    priority: message.needsReview ? '高' : message.dueAt ? '中' : '普通',
    summary: `${insight}${message.body.replace(/\s+/g, ' ').slice(0, 88)}${message.body.length > 88 ? '…' : ''}`,
    draft: message.replyDraft ?? '',
    conversation,
    trace: message.traceId,
    attachment: attachment ? `${attachment.name} · ${formatBytes(attachment.size)}` : undefined,
    reply: message.reply,
  };
}

function accountsOf(accounts: ReturnType<typeof useAppState>['accounts']): DesignAccountView[] {
  return PLATFORM_ORDER.map((platform) => {
    const account = accounts.find((item) => item.platform === (platform as Platform));
    const name = APP_PLATFORM_META[platform as Platform].name;
    if (!account) {
      return { platform, account: name, status: '未连接', note: '等待配置账号凭据', connected: false };
    }
    const identity = account.identity?.user;
    const label = identity?.displayName || account.label || (account.accounts?.length ? `${account.accounts.length} 个邮箱账号` : name);
    const status = identity?.linked
      ? '本人 · 已连接'
      : account.mode === 'real'
        ? '真实接口'
        : account.mode === 'mock'
          ? '演示模式'
          : account.configured
            ? '已配置'
            : '未连接';
    const note = account.reason || account.warnings?.[0] || account.issues?.[0]?.message || (account.mode === 'mock' ? '本地模拟，不会调用真实平台' : '连接状态正常');
    return { platform, account: label, status, note, connected: Boolean(account.configured && account.mode !== 'mock') };
  });
}

export function useLiveDesignWorkspace(): DesignWorkspace {
  const state = useAppState();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState('');
  const [section, setSection] = useState<DesignSection>('inbox');
  const [platform, setPlatform] = useState<DesignPlatform | 'all'>('all');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const toastTimer = useRef<number>();

  const messages = useMemo(() => state.messages.map(toDesignMessage), [state.messages]);
  const visibleMessages = useMemo(() => messages.filter((message) => {
    const inChannel = platform === 'all' || message.platform === platform;
    const term = query.trim().toLowerCase();
    return inChannel && (!term || `${message.sender}${message.body}${message.conversation}`.toLowerCase().includes(term));
  }), [messages, platform, query]);

  const selected = messages.find((message) => message.id === selectedId) ?? messages[0] ?? EMPTY_MESSAGE;
  const accounts = useMemo(() => accountsOf(state.accounts), [state.accounts]);

  useEffect(() => {
    if (messages.length > 0 && !messages.some((message) => message.id === selectedId)) {
      setSelectedId(messages[0].id);
    }
  }, [messages, selectedId]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const notify = (text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2800);
  };

  const selectMessage = (id: string, keepSection = false) => {
    setSelectedId(id);
    if (!keepSection) setSection('inbox');
    const original = state.messages.find((message) => message.traceId === id);
    if (original && !original.readAt) {
      void store.markRead(id, true).catch(() => notify('已打开消息，但已读状态同步失败'));
    }
  };

  const toggleDone = (id: string) => {
    const original = state.messages.find((message) => message.traceId === id);
    if (!original) return;
    if (original.done) {
      notify('这条待办已经完成');
      return;
    }
    void store.markDone(id).then(() => notify('已标记完成')).catch(() => notify('标记失败，请稍后重试'));
  };

  const addTodo = (id: string) => {
    if (id === EMPTY_MESSAGE.id) return;
    void store.markTodo(id).then(() => notify('已加入待办清单')).catch(() => notify('加入待办失败，请稍后重试'));
  };

  const reply = (id: string, body: string) => {
    if (!body.trim() || id === EMPTY_MESSAGE.id) return false;
    void store.reply(id, body).then(() => notify('回复已提交，正在回写平台')).catch((error) => notify(error instanceof Error ? error.message : '回复失败，请重试'));
    return true;
  };

  const compose = ({ platform: target, recipient, body }: { platform: DesignPlatform; recipient: string; body: string }) => {
    if (!recipient.trim() || !body.trim()) return false;
    setComposeOpen(false);
    void store.compose({ platform: target as Platform, conversationId: recipient.trim(), text: body.trim() })
      .then(() => notify('已提交发送，状态会实时更新'))
      .catch((error) => notify(error instanceof Error ? error.message : '发送失败，请重试'));
    return true;
  };

  return {
    messages, visibleMessages, selected, selectedId, section, platform, query, toast, composeOpen,
    setSection, setPlatform, setQuery, setComposeOpen, selectMessage, toggleDone, addTodo, reply, compose, notify,
    accounts,
    manageAccount: () => navigate('/connect'),
    openLegacy: () => navigate('/inbox'),
    openTrace: (id = '') => navigate(id ? `/trace/${id}` : '/trace'),
  };
}
