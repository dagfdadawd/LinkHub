/**
 * useSnoozeAlerts 接线单测：跨过 snoozedUntil 提醒一次；页面关闭期间错过的到期，
 * 打开时补响一次但绝不积压成串；同一条消息再次 Snooze（新时刻）有独立的提醒资格。
 */
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSnoozeAlerts } from './useSnoozeAlerts';
import { MsgStatus, Platform } from '../types';
import type { UnifiedMessage } from '../types';
import {
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
function msg(snoozedUntil?: string): UnifiedMessage {
  seq += 1;
  return {
    traceId: `snooze-${seq}`,
    platform: Platform.FEISHU,
    externalId: `e-${seq}`,
    sender: { id: 'u1', name: '郑友佳' },
    type: 'text',
    body: '这份合同先放一放',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function renderAlerts(initial: UnifiedMessage[], ready = true) {
  return renderHook(
    ({ messages, ready: isReady }: { messages: UnifiedMessage[]; ready: boolean }) =>
      useSnoozeAlerts(messages, isReady),
    { initialProps: { messages: initial, ready }, wrapper },
  );
}

const atMin = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

beforeEach(() => {
  // Date 必须显式纳入 fake：心跳里的 new Date() 要跟随假时钟推进
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

describe('useSnoozeAlerts', () => {
  it('未到期不响；心跳越过到期点后响一次，同一条不重复', () => {
    const later = msg(atMin(20.25)); // fireAt = +20分15秒
    renderAlerts([later]);
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(21 * 60_000); // 越过到期点，30s 心跳触发
    });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1); // 已登记，不重复
  });

  it('页面关闭期间错过的到期：打开时补响一次，不积压成串', () => {
    // 挂载时 Snooze 已经过期（用户关着页面错过了到点提醒）
    const overdue = msg(atMin(-15));
    const overdue2 = msg(atMin(-10));
    const { rerender } = renderAlerts([overdue, overdue2], false);
    rerender({ messages: [overdue, overdue2], ready: true });
    // 基线轮只登记不响；下一轮效应（新数组引用）才走主循环补响
    rerender({ messages: [overdue, overdue2], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(2);

    rerender({ messages: [overdue, overdue2], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(2); // 不重复
  });

  it('同一条消息再次 Snooze（新时刻）有独立的提醒资格', () => {
    const first = msg(atMin(-5));
    const { rerender } = renderAlerts([first]);
    rerender({ messages: [first], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1); // 首轮补响

    // 用户又 Snooze 到未来时刻，之后到期 → 再次提醒
    const second = { ...first, traceId: first.traceId, snoozedUntil: atMin(10) } as UnifiedMessage;
    rerender({ messages: [second], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1); // 新时刻未到

    act(() => {
      vi.advanceTimersByTime(11 * 60_000);
    });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(2);
  });

  it('没有 snoozedUntil 的普通消息永不提醒', () => {
    const { rerender } = renderAlerts([msg()]);
    rerender({ messages: [msg()], ready: true });
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
  });

  it('关闭提示音通道后静默（登记照常，改设置不补响）', () => {
    patchPreferences({ urgentSound: false, urgentDesktop: false });
    const overdue = msg(atMin(-5));
    const { rerender } = renderAlerts([overdue]);
    // 第一轮主循环：静默登记（通道关着，响与不响都只此一次资格）
    rerender({ messages: [overdue], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
    expect(mocks.showSystemNotification).not.toHaveBeenCalled();

    patchPreferences({ urgentSound: true });
    rerender({ messages: [overdue], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled(); // 已登记，不补响
  });

  it('页面隐藏时弹桌面通知，点击可跳到那条会话', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const overdue = msg(atMin(-5));
    const { rerender } = renderAlerts([overdue]);
    rerender({ messages: [overdue], ready: true });
    expect(mocks.showSystemNotification).toHaveBeenCalledTimes(1);
    const [title] = mocks.showSystemNotification.mock.calls[0] as unknown as [string];
    expect(title).toContain('稍后处理到期');
  });
});
