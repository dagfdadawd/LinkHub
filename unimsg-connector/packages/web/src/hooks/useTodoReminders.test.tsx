/**
 * useTodoReminders 接线单测：到点（或提前量内）提醒一次、历史不补提醒、完成的与
 * 无截止的不提醒、开关关闭时静默但登记；到期瞬间靠 30s 心跳触发（假时钟验证）。
 */
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTodoReminders } from './useTodoReminders';
import { MsgStatus, Platform } from '../types';
import type { UnifiedMessage } from '../types';
import {
  DEFAULT_PREFERENCES,
  patchPreferences,
  resetPreferences,
} from '../features/settings/preferences';

const mocks = vi.hoisted(() => ({
  playUrgentChime: vi.fn(() => true),
  showSystemNotification: vi.fn(() => true),
  primeUrgentAudio: vi.fn(() => true),
}));

/** 只 mock 副作用（声音 / 通知 / 音频解锁），纯逻辑用真实实现 */
vi.mock('../utils/urgentAlert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/urgentAlert')>();
  return { ...actual, ...mocks };
});

let seq = 0;
function todo(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  seq += 1;
  return {
    traceId: `todo-${seq}`,
    platform: Platform.FEISHU,
    externalId: `e-${seq}`,
    sender: { id: 'u1', name: '郑友佳' },
    type: 'todo',
    body: '合同评审会',
    todoTitle: '合同评审会',
    direction: 'in',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const atMin = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function renderReminders(initial: UnifiedMessage[], ready = true) {
  return renderHook(
    ({ todos, ready: isReady }: { todos: UnifiedMessage[]; ready: boolean }) =>
      useTodoReminders(todos, isReady),
    { initialProps: { todos: initial, ready }, wrapper },
  );
}

beforeEach(() => {
  // Date 必须显式纳入 fake：心跳里的 new Date() 要跟随假时钟推进，
  // 否则 interval 触发了、时钟还停在真实时间，永远追不上 fireAt
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  mocks.playUrgentChime.mockClear();
  mocks.showSystemNotification.mockClear();
  mocks.primeUrgentAudio.mockClear();
  resetPreferences();
  patchPreferences({ urgentSound: true, urgentDesktop: true });
});

afterEach(() => {
  resetPreferences();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('useTodoReminders', () => {
  it('首轮加载的已到期 / 临近到期待办不补提醒（开页不响一串）', () => {
    renderReminders([todo({ dueAt: atMin(-30) }), todo({ dueAt: atMin(5) })]);
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
    expect(mocks.showSystemNotification).not.toHaveBeenCalled();
  });

  it('ready 前不建基线：历史待办不会被当成新到期的', () => {
    const history = todo({ dueAt: atMin(-5) });
    const { rerender } = renderReminders([], false);
    rerender({ todos: [history], ready: false });
    rerender({ todos: [history], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
  });

  it('提前量内的新待办提醒一次；同一条更新不重复响', () => {
    const soon = todo({ dueAt: atMin(5) }); // 提前量默认 10 分钟 → 已在提醒窗口
    const { rerender } = renderReminders([]);
    rerender({ todos: [soon], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);

    rerender({ todos: [{ ...soon, body: '更新后的正文' }], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);

    rerender({ todos: [soon, todo({ dueAt: atMin(-1) })], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(2);
  });

  it('未到提前量不提醒；30s 心跳越点到点后自动提醒（无新消息也触发）', () => {
    const later = todo({ dueAt: atMin(20.25) }); // +20分15秒 → fireAt = +10分15秒
    renderReminders([later]);
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(31_000); // +31s：仍未到 fireAt
    });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(11 * 60_000); // 越过 fireAt，心跳触发
    });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5 * 60_000); // 继续心跳：已登记，不重复
    });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);
  });

  it('完成的待办不提醒', () => {
    const { rerender } = renderReminders([]);
    rerender({ todos: [todo({ dueAt: atMin(-10), done: true })], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
  });

  it('没有截止时间的待办不提醒（不伪造时间）', () => {
    const { rerender } = renderReminders([]);
    rerender({ todos: [todo()], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
  });

  it('关闭待办提醒后静默但登记；重新打开不补响积压，只影响之后的待办', () => {
    patchPreferences({ todoReminder: false });
    const { rerender } = renderReminders([]);
    const suppressed = todo({ dueAt: atMin(-5) });
    rerender({ todos: [suppressed], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    patchPreferences({ todoReminder: true });
    rerender({ todos: [suppressed], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    rerender({ todos: [suppressed, todo({ dueAt: atMin(-2) })], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);
  });

  it('页面隐藏时弹桌面通知：标题带「待办到期」，正文带标题与时刻，点击直达待办页', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const { rerender } = renderReminders([]);
    rerender({ todos: [todo({ dueAt: atMin(-5) })], ready: true });
    expect(mocks.showSystemNotification).toHaveBeenCalledTimes(1);
    const [title, body, onClick] = mocks.showSystemNotification.mock.calls[0] as unknown as [
      string,
      string,
      () => void,
    ];
    expect(title).toContain('待办到期');
    expect(body).toContain('合同评审会');
    expect(typeof onClick).toBe('function');
  });

  it('提前量为 0（到点才提醒）：还没到点的待办不提前响', () => {
    patchPreferences({ todoReminderLeadMin: 0 });
    const { rerender } = renderReminders([]);
    rerender({ todos: [todo({ dueAt: atMin(3) })], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
  });

  it('默认偏好：待办提醒开、提前 10 分钟', () => {
    expect(DEFAULT_PREFERENCES.todoReminder).toBe(true);
    expect(DEFAULT_PREFERENCES.todoReminderLeadMin).toBe(10);
  });
});
