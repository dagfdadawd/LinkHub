/**
 * useUrgentAlerts 接线单测：只提醒新到的紧急入站消息，历史不补提醒、自己标的不提醒、
 * 同一条只提醒一次；页面隐藏时才弹桌面通知。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useUrgentAlerts } from './useUrgentAlerts';
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

/** 只 mock 副作用（声音 / 通知 / 音频解锁），inQuietHours 等纯逻辑用真实实现 */
vi.mock('../utils/urgentAlert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/urgentAlert')>();
  return { ...actual, ...mocks };
});

let seq = 0;
function msg(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  seq += 1;
  return {
    traceId: `urgent-${seq}`,
    platform: Platform.FEISHU,
    externalId: `e-${seq}`,
    sender: { id: 'u1', name: '郑友佳' },
    type: 'text',
    body: '这份合同今天必须确认',
    direction: 'in',
    priority: 'urgent',
    prioritySource: 'rules',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function renderAlerts(initial: UnifiedMessage[], ready = true) {
  return renderHook(
    ({ messages, ready: isReady }: { messages: UnifiedMessage[]; ready: boolean }) =>
      useUrgentAlerts(messages, isReady),
    {
      initialProps: { messages: initial, ready },
      wrapper,
    },
  );
}

beforeEach(() => {
  mocks.playUrgentChime.mockClear();
  mocks.showSystemNotification.mockClear();
  mocks.primeUrgentAudio.mockClear();
  resetPreferences();
  patchPreferences({ urgentSound: true, urgentDesktop: true });
});

afterEach(() => {
  resetPreferences();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('useUrgentAlerts', () => {
  it('首轮加载的历史紧急消息不补提醒', () => {
    renderAlerts([msg()]);
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
  });

  it('首屏数据加载完成前不建基线：登录后历史紧急消息不会响一串', () => {
    const history = msg();
    const { rerender } = renderAlerts([], false);
    // 加载中：历史消息已进 state，但 ready=false → 不提醒也不登记
    rerender({ messages: [history], ready: false });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    // 首屏数据到位：这一批算历史基线，仍不提醒
    rerender({ messages: [history], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    // 之后真正新到的一条才提醒
    rerender({ messages: [history, msg()], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);
  });

  it('新到的紧急入站消息提醒一次；重复渲染 / 同一条更新不重复响', () => {
    const first = msg();
    const { rerender } = renderAlerts([]);

    rerender({ messages: [first], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);

    rerender({ messages: [{ ...first, body: '富化后正文' }], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);

    rerender({ messages: [first, msg()], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(2);
  });

  it('自己手动标的紧急不提醒（刚点的按钮不需要再被告知）', () => {
    const { rerender } = renderAlerts([]);
    rerender({ messages: [msg({ prioritySource: 'manual' })], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
  });

  it('页面隐藏时才弹桌面通知，点击可跳到那条会话', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const urgent = msg();
    const { rerender } = renderAlerts([]);

    rerender({ messages: [urgent], ready: true });
    expect(mocks.showSystemNotification).toHaveBeenCalledTimes(1);
    const [title, body, onClick] = mocks.showSystemNotification.mock.calls[0] as unknown as [
      string,
      string,
      () => void,
    ];
    expect(title).toContain('紧急消息');
    expect(title).toContain('飞书');
    expect(body).toContain('郑友佳');
    expect(body).toContain('合同');

    expect(typeof onClick).toBe('function');
  });

  it('关掉提示音 / 通知后不再打扰', () => {
    patchPreferences({ urgentSound: false, urgentDesktop: false });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const { rerender } = renderAlerts([]);

    rerender({ messages: [msg()], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
    expect(mocks.showSystemNotification).not.toHaveBeenCalled();
  });

  it('级别 all：非紧急的新消息也提醒，标题用「新消息」而非「紧急消息」', () => {
    patchPreferences({ alertLevel: 'all' });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const { rerender } = renderAlerts([]);
    rerender({ messages: [msg({ priority: 'normal' })], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);
    const [title] = mocks.showSystemNotification.mock.calls[0] as unknown as [string];
    expect(title).toContain('新消息');
    expect(title).not.toContain('紧急消息');
  });

  it('级别 off：全部静默，连紧急也不响', () => {
    patchPreferences({ alertLevel: 'off' });
    const { rerender } = renderAlerts([]);
    rerender({ messages: [msg()], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
    expect(mocks.showSystemNotification).not.toHaveBeenCalled();
  });

  it('平台静音：静音平台不响，其他平台照常', () => {
    patchPreferences({ alertLevel: 'all', alertMutedPlatforms: [Platform.MAIL] });
    const { rerender } = renderAlerts([]);
    rerender({ messages: [msg({ platform: Platform.MAIL })], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
    rerender({ messages: [msg({ platform: Platform.MAIL }), msg()], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1); // 只有飞书那条响了
  });

  it('免打扰时段内静默；时段结束后不补响被挡掉的消息，只影响之后的新消息', () => {
    patchPreferences({ alertLevel: 'all', dndEnabled: true, dndFrom: '00:00', dndTo: '23:59' });
    const { rerender } = renderAlerts([]);
    const suppressed = msg();
    rerender({ messages: [suppressed], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();

    // 关闭免打扰：刚那条不会补响（登记为已见），之后真正新到的才响
    patchPreferences({ dndEnabled: false });
    rerender({ messages: [suppressed], ready: true });
    expect(mocks.playUrgentChime).not.toHaveBeenCalled();
    rerender({ messages: [suppressed, msg()], ready: true });
    expect(mocks.playUrgentChime).toHaveBeenCalledTimes(1);
  });

  it('默认偏好：提示音开、桌面通知关、级别仅紧急（与旧行为一致）', () => {
    expect(DEFAULT_PREFERENCES.urgentSound).toBe(true);
    expect(DEFAULT_PREFERENCES.urgentDesktop).toBe(false);
    expect(DEFAULT_PREFERENCES.alertLevel).toBe('urgent');
    expect(DEFAULT_PREFERENCES.alertMutedPlatforms).toEqual([]);
    expect(DEFAULT_PREFERENCES.dndEnabled).toBe(false);
  });
});
