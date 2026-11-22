/**
 * 紧急消息提醒的「系统能力」封装：提示音 + 桌面通知。
 *
 * 为什么单独拆出来：
 *  - 浏览器策略相关的坑都在这里（AudioContext 必须由用户手势解锁、Notification 权限只能由
 *    用户点击触发申请），UI 与 hook 不该各自记一遍；
 *  - 全部失败都静默降级（没声音 / 没通知不影响收消息），但返回布尔值，设置页可以如实提示。
 *
 * 声音不用音频文件：WebAudio 现场合成两声短音，省一个静态资源，也不受部署路径影响。
 */

/** 全模块共用一个 AudioContext（浏览器限制同时存在的上下文数量） */
let audioContext: AudioContext | null = null;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * 解锁音频：浏览器要求 AudioContext 在用户手势里创建/恢复，否则一直是 suspended。
 * 在首个 pointerdown / keydown 时调用一次即可。
 */
export function primeUrgentAudio(): boolean {
  const Ctor = audioContextCtor();
  if (!Ctor) return false;
  try {
    audioContext ??= new Ctor();
    if (audioContext.state === 'suspended') void audioContext.resume();
    return true;
  } catch {
    return false;
  }
}

/** 两声短促提示音（880Hz → 1180Hz）；返回是否真的播出去了 */
export function playUrgentChime(): boolean {
  const ctx = (() => {
    if (!primeUrgentAudio()) return null;
    return audioContext;
  })();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    [880, 1180].forEach((frequency, index) => {
      const start = now + index * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      // 指数包络：起音快、收尾干净，避免爆音
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
    return true;
  } catch {
    return false;
  }
}

/** 当前通知权限；环境不支持时返回 'unsupported' */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * 请求桌面通知权限。
 * 必须在用户手势（例如设置里的开关）里调用，否则浏览器会拒绝且之后很难再弹。
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  const current = notificationPermission();
  if (current === 'unsupported' || current !== 'default') return current;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * 弹一条系统通知；权限不足 / 环境不支持时返回 false（绝不假装弹了）。
 * 点击通知时聚焦窗口并执行回调（通常是跳到那条消息）。
 */
export function showSystemNotification(title: string, body: string, onClick?: () => void): boolean {
  if (notificationPermission() !== 'granted') return false;
  try {
    // silent: 声音由 playUrgentChime 统一控制，避免系统提示音和提示音设置打架
    const notification = new Notification(title, { body, silent: true });
    notification.onclick = () => {
      try {
        window.focus();
        onClick?.();
      } finally {
        notification.close();
      }
    };
    return true;
  } catch {
    return false;
  }
}

/** 设置页「试听 / 测试」用：弹一条测试通知（不依赖紧急消息流程） */
export function showUrgentTestNotification(onClick?: () => void): boolean {
  return showSystemNotification('LinkHub 紧急提醒', '这是一条测试通知：收到紧急消息时会这样提醒你。', onClick);
}
