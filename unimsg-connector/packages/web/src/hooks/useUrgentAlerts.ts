/**
 * 紧急消息到达提醒：提示音 +（页面不在前台时）桌面通知。
 *
 * 触发条件刻意收窄，避免变成骚扰：
 *  - 只提醒**入站**消息；
 *  - 只提醒优先级被判定为 urgent 的消息；人工自己标的（prioritySource='manual'）不提醒
 *    ——那是你刚点的，不需要再被告知一遍；
 *  - 每条消息只提醒一次；首轮加载的历史紧急消息不补提醒（否则一打开页面就响一串）。
 *
 * 挂在 AppShell 上（而不是收件箱页）是有意的：无论当前停在待办、看板还是设置页，
 * 紧急消息都能提醒到，而不是只有打开收件箱才生效。
 *
 * `ready`（首屏数据加载完成）之前不建基线：否则登录后历史消息一到，会被当成
 * 「刚收到的一串紧急消息」全响一遍。
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UnifiedMessage } from '../types';
import { usePreferences } from '../features/settings/preferences';
import { platformMeta } from '../utils/format';
import {
  playUrgentChime,
  primeUrgentAudio,
  showSystemNotification,
} from '../utils/urgentAlert';

/** 通知正文里的正文摘要：压成单行并截断，避免系统通知被撑爆 */
function snippetOf(text: string, max = 60): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function useUrgentAlerts(messages: UnifiedMessage[], ready: boolean): void {
  const prefs = usePreferences();
  const navigate = useNavigate();

  /** 已提醒过的 traceId；null = 尚未完成首轮登记 */
  const notified = useRef<Set<string> | null>(null);
  /** effect 里读最新值但不作为依赖：偏好/导航变化不该重放提醒逻辑 */
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // 浏览器自动播放策略：首个用户手势时解锁音频，之后才允许出声
  useEffect(() => {
    const unlock = (): void => {
      primeUrgentAudio();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    // 首屏数据到位后的第一轮：只登记页面上已经存在的紧急消息，不补提醒
    if (notified.current === null) {
      notified.current = new Set(
        messages.filter((m) => m.priority === 'urgent').map((m) => m.traceId),
      );
      return;
    }

    const seen = notified.current;
    for (const m of messages) {
      if (seen.has(m.traceId)) continue;
      // 优先级是异步富化出来的：消息先到、priority 后到，所以不能只看「新消息」
      if (m.direction === 'out') continue;
      if (m.priority !== 'urgent') continue;
      if (m.prioritySource === 'manual') continue;

      seen.add(m.traceId);
      const { urgentSound, urgentDesktop } = prefsRef.current;
      if (urgentSound) playUrgentChime();
      // 用户正在看这个页面时不弹系统通知；切到别的标签页/窗口（或最小化）才提醒
      const watching =
        document.visibilityState === 'visible' && document.hasFocus?.() !== false;
      if (urgentDesktop && !watching) {
        showSystemNotification(
          `紧急消息 · ${platformMeta(m.platform).name}`,
          `${m.sender?.name ?? '对方'}：${snippetOf(m.body)}`,
          () => navigateRef.current(`/inbox/${m.traceId}`),
        );
      }
    }
  }, [messages, ready]);
}
