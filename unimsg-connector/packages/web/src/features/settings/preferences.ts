import { useSyncExternalStore } from 'react';
import { Platform } from '../../types';

/**
 * 应用偏好（外观 / 交互 / 消息展示 / 新消息提醒）。
 *
 * 与个人资料一样只存本机；区别是这些偏好会直接改界面行为：
 *  - density   → <html data-density>，压缩留白
 *  - motion    → <html data-motion>，减弱动效
 *  - sendKey   → 回复框的发送快捷键
 *  - showAiDraft → 是否展示「AI 建议」卡片
 *  - alertLevel    → 新消息提醒级别（off / urgent / all）
 *  - alertMutedPlatforms → 静音的平台：来了消息也不响，收件箱照常显示
 *  - dndEnabled/dndFrom/dndTo → 免打扰时段（HH:mm，支持跨夜），时段内提示音与通知都静默
 *  - urgentSound   → 提醒触发时是否播放提示音（声音通道开关）
 *  - urgentDesktop → 页面不在前台时弹系统通知（通知通道开关，需要浏览器授权）
 */

export type Density = 'comfortable' | 'compact';
export type MotionLevel = 'full' | 'reduced';
export type SendKey = 'mod-enter' | 'enter';
/** 提醒级别：off 不打扰 / urgent 仅紧急（默认，与旧行为一致）/ all 全部入站新消息 */
export type AlertLevel = 'off' | 'urgent' | 'all';

export interface Preferences {
  density: Density;
  motion: MotionLevel;
  sendKey: SendKey;
  showAiDraft: boolean;
  alertLevel: AlertLevel;
  alertMutedPlatforms: Platform[];
  dndEnabled: boolean;
  dndFrom: string;
  dndTo: string;
  urgentSound: boolean;
  urgentDesktop: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  density: 'comfortable',
  motion: 'full',
  sendKey: 'mod-enter',
  showAiDraft: true,
  // 默认仅紧急：保持既有行为，想「一个入口不漏消息」的用户显式切到「全部」
  alertLevel: 'urgent',
  alertMutedPlatforms: [],
  dndEnabled: false,
  dndFrom: '22:00',
  dndTo: '08:00',
  // 提示音默认开（不需要权限）；系统通知涉及浏览器授权，默认关，由设置页显式开启
  urgentSound: true,
  urgentDesktop: false,
};

const STORAGE_KEY = 'linkhub-prefs';

let cache: Preferences | null = null;
const listeners = new Set<() => void>();

const PLATFORM_VALUES = Object.values(Platform) as Platform[];
const HH_MM = /^([01]?\d|2[0-3]):[0-5]\d$/;

function sanitize(input: unknown): Preferences {
  if (!input || typeof input !== 'object') return DEFAULT_PREFERENCES;
  const raw = input as Partial<Preferences>;
  return {
    density: raw.density === 'compact' ? 'compact' : 'comfortable',
    motion: raw.motion === 'reduced' ? 'reduced' : 'full',
    sendKey: raw.sendKey === 'enter' ? 'enter' : 'mod-enter',
    showAiDraft: typeof raw.showAiDraft === 'boolean' ? raw.showAiDraft : true,
    alertLevel: raw.alertLevel === 'off' || raw.alertLevel === 'all' ? raw.alertLevel : 'urgent',
    alertMutedPlatforms: Array.isArray(raw.alertMutedPlatforms)
      ? [...new Set(raw.alertMutedPlatforms.filter((p): p is Platform => PLATFORM_VALUES.includes(p as Platform)))]
      : [],
    dndEnabled: typeof raw.dndEnabled === 'boolean' ? raw.dndEnabled : false,
    dndFrom: typeof raw.dndFrom === 'string' && HH_MM.test(raw.dndFrom) ? raw.dndFrom : '22:00',
    dndTo: typeof raw.dndTo === 'string' && HH_MM.test(raw.dndTo) ? raw.dndTo : '08:00',
    urgentSound: typeof raw.urgentSound === 'boolean' ? raw.urgentSound : true,
    urgentDesktop: typeof raw.urgentDesktop === 'boolean' ? raw.urgentDesktop : false,
  };
}

function read(): Preferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    return sanitize(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function getPreferences(): Preferences {
  if (!cache) cache = read();
  return cache;
}

export function savePreferences(next: Preferences) {
  cache = sanitize(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // 隐私模式下写入失败：本次会话仍然生效
  }
  listeners.forEach((listener) => listener());
}

export function patchPreferences(patch: Partial<Preferences>) {
  savePreferences({ ...getPreferences(), ...patch });
}

export function resetPreferences() {
  savePreferences(DEFAULT_PREFERENCES);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferences, () => DEFAULT_PREFERENCES);
}
