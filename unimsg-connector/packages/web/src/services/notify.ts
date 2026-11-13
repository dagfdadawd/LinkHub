/**
 * 新消息提醒：应用内 toast + 系统通知（Windows 通知中心 / macOS 通知中心）。
 *
 * 为什么两套都要：浏览器与桌面壳（Electron）都实现了 Web Notification API，
 * 它在这两处都会落到操作系统的通知中心；但用户可能拒绝授权，或系统专注助手会拦截，
 * 所以应用内 toast 是兜底——保证「有消息进来」这件事在应用里一定看得见。
 *
 * 通知策略：同一会话在一个批次里合并成一条（避免连发 5 条弹窗），
 * 且只对「入站」消息提醒；自己发出的消息与钉钉回声永不提醒。
 */

const PERMISSION_KEY = 'linkhub.notify.permission-asked';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export function notificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

/** 首次使用时申请一次系统通知权限；用户拒绝后不再骚扰 */
export async function ensureNotificationPermission(): Promise<NotificationPermissionState> {
  const current = notificationPermission();
  if (current !== 'default') return current;
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  try {
    if (window.localStorage.getItem(PERMISSION_KEY) === '1') return notificationPermission();
    window.localStorage.setItem(PERMISSION_KEY, '1');
    return (await Notification.requestPermission()) as NotificationPermissionState;
  } catch {
    return current;
  }
}

export interface IncomingNotice {
  /** 会话名（对方 / 群名 / 邮件主题） */
  title: string;
  /** 该会话本批有多少条新消息 */
  count: number;
  /** 最后一条的摘要 */
  body: string;
  /** 会话标识：同一会话的连续通知会互相替换，而不是堆一屏 */
  tag: string;
}

/** 弹一条系统通知；未授权 / 不支持时静默返回 false（由调用方走应用内 toast） */
export function showSystemNotification(notice: IncomingNotice): boolean {
  if (notificationPermission() !== 'granted') return false;
  try {
    const n = new Notification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      // 同一 tag 的消息替换上一条，避免刷屏；图标用站点默认
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}