/**
 * Snooze 到期提醒（评审 P1-6）：跨过 snoozedUntil 的消息提示音 +（不在前台时）
 * 桌面通知，点击直达那条会话——「1 小时后叫我」的另一半承诺。
 *
 *  - 每条消息的每次 Snooze 只响一次（traceId 登记；同一条再次 Snooze 会换新时刻，
 *    用 traceId 登记足够：再次到期时 traceId 仍在 seen 里？——不，会漏！所以登记键
 *    用 `traceId@snoozedUntil`，同一条消息的每一次 Snooze 都有独立的提醒资格）；
 *  - 页面关闭期间错过的到期：重新打开时补响一次（「到点叫你」的承诺优先于
 *    「不骚扰」；但只响一次，不会积压成串）；
 *  - 复用新消息提醒的通道开关（urgentSound / urgentDesktop），30s 心跳驱动。
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UnifiedMessage } from '../types';
import { usePreferences } from '../features/settings/preferences';
import { platformMeta } from '../utils/format';
import { useNowTick } from './useNowTick';
import { playUrgentChime, primeUrgentAudio, showSystemNotification } from '../utils/urgentAlert';

/** 登记键：traceId + 该次 Snooze 的到期时刻（同一消息多次 Snooze 各有资格） */
function keyOf(m: UnifiedMessage): string {
  return `${m.traceId}@${m.snoozedUntil ?? ''}`;
}

/** 通知正文摘要：压成单行截断（与新消息提醒同一套口径） */
function snippetOf(text: string, max = 60): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 0 ? (oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine) : '（无正文）';
}

export function useSnoozeAlerts(messages: UnifiedMessage[], ready: boolean): void {
  const prefs = usePreferences();
  const navigate = useNavigate();
  const now = useNowTick(30_000);

  /** 已提醒过的 traceId@snoozedUntil；null = 尚未完成首轮登记 */
  const notified = useRef<Set<string> | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // 浏览器自动播放策略：首个用户手势解锁音频（与消息提醒共用同一个解锁器）
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
    // 首轮只登记「普通消息」；Snooze 中的（无论未到期还是已过期）都不登记——
    // 未来到期的要留给主循环在到点触发（否则加载时就存在的 Snooze 永远不响），
    // 已过期的由主循环补响一次（关页面错过到点的承诺兑现，见下）。
    if (notified.current === null) {
      notified.current = new Set(messages.filter((m) => !m.snoozedUntil).map((m) => keyOf(m)));
      return;
    }

    const seen = notified.current;
    const { urgentSound, urgentDesktop } = prefsRef.current;
    for (const m of messages) {
      if (!m.snoozedUntil) continue;
      const key = keyOf(m);
      if (seen.has(key)) continue;
      const due = Date.parse(m.snoozedUntil);
      if (Number.isNaN(due) || now.getTime() < due) continue; // 未到期：不登记，到点再提醒

      seen.add(key);
      if (urgentSound) playUrgentChime();
      const watching =
        document.visibilityState === 'visible' && document.hasFocus?.() !== false;
      if (urgentDesktop && !watching) {
        showSystemNotification(
          `稍后处理到期 · ${platformMeta(m.platform).name}`,
          `${m.sender?.name ?? '对方'}：${snippetOf(m.body)}`,
          () => navigateRef.current(`/inbox/${m.traceId}`),
        );
      }
    }
  }, [messages, now, ready]);
}
