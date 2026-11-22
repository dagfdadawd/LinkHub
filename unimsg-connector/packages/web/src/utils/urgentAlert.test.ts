/**
 * 紧急提醒的系统能力单测：声音 / 通知在环境不支持时必须静默降级并返回 false，
 * 权限不足时绝不假装弹了通知（与「不把 Mock 伪装成真实」同一原则）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inQuietHours,
  notificationPermission,
  playUrgentChime,
  requestNotificationPermission,
  showSystemNotification,
  showUrgentTestNotification,
} from './urgentAlert';

const instances: FakeNotification[] = [];

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  static closeOnClick = true;

  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    instances.push(this);
  }
}

function stubNotification(permission: NotificationPermission = 'granted'): void {
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = vi.fn(async () => permission);
  instances.length = 0;
  vi.stubGlobal('Notification', FakeNotification);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  instances.length = 0;
});

describe('提示音', () => {
  it('环境没有 AudioContext 时返回 false（静默降级，不抛错）', () => {
    expect(playUrgentChime()).toBe(false);
  });
});

describe('桌面通知权限', () => {
  it('不支持 Notification 的环境返回 unsupported，不抛错', () => {
    expect(notificationPermission()).toBe('unsupported');
    expect(showSystemNotification('t', 'b')).toBe(false);
  });

  it('未授权时不弹通知，返回 false', () => {
    stubNotification('default');
    expect(showSystemNotification('紧急消息', '正文')).toBe(false);
    expect(instances).toHaveLength(0);
  });

  it('已授权时弹通知：silent 交给自研提示音，点击聚焦并回调', () => {
    stubNotification('granted');
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const onClick = vi.fn();

    expect(showSystemNotification('紧急消息 · 飞书', '张三：今天必须确认', onClick)).toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0].title).toBe('紧急消息 · 飞书');
    expect(instances[0].options?.silent).toBe(true);

    instances[0].onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(instances[0].close).toHaveBeenCalled();
  });

  it('requestNotificationPermission：已是 granted/denied 直接返回，不再打扰用户', async () => {
    stubNotification('granted');
    expect(await requestNotificationPermission()).toBe('granted');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    stubNotification('denied');
    expect(await requestNotificationPermission()).toBe('denied');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('requestNotificationPermission：default 时才真正申请', async () => {
    stubNotification('default');
    expect(await requestNotificationPermission()).toBe('default');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('测试通知走同一套权限判定', () => {
    stubNotification('denied');
    expect(showUrgentTestNotification()).toBe(false);
    stubNotification('granted');
    expect(showUrgentTestNotification()).toBe(true);
    expect(instances[0].title).toContain('紧急提醒');
  });
});

describe('免打扰时段 inQuietHours', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 20, h, m);

  it('同日窗口：只静默区间内的时间（左闭右开）', () => {
    expect(inQuietHours(at(12, 0), '10:00', '14:00')).toBe(true);
    expect(inQuietHours(at(13, 59), '10:00', '14:00')).toBe(true);
    expect(inQuietHours(at(14, 0), '10:00', '14:00')).toBe(false);
    expect(inQuietHours(at(9, 59), '10:00', '14:00')).toBe(false);
  });

  it('跨夜窗口（22:00→08:00）：深夜与凌晨静默，白天正常', () => {
    expect(inQuietHours(at(23, 30), '22:00', '08:00')).toBe(true);
    expect(inQuietHours(at(3, 0), '22:00', '08:00')).toBe(true);
    expect(inQuietHours(at(7, 59), '22:00', '08:00')).toBe(true);
    expect(inQuietHours(at(8, 0), '22:00', '08:00')).toBe(false);
    expect(inQuietHours(at(12, 0), '22:00', '08:00')).toBe(false);
  });

  it('from === to 视为空窗口，永不静默', () => {
    expect(inQuietHours(at(12, 0), '12:00', '12:00')).toBe(false);
  });

  it('时间串非法一律不静默：配置坏了宁可多提醒，不吞消息', () => {
    expect(inQuietHours(at(12, 0), 'bad', '08:00')).toBe(false);
    expect(inQuietHours(at(12, 0), '22:00', '24:00')).toBe(false);
    expect(inQuietHours(at(12, 0), '', '')).toBe(false);
  });
});
