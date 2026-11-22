/**
 * 稍后处理（Snooze）纯逻辑（评审 P1-6）：
 *  - isSnoozed：到期前为 true——收件箱用它把消息藏起来，到期自然回到列表；
 *  - snoozePresets：三个固定档（1 小时后 / 今晚 21:00 / 明早 9:00），不搞自定义时间——
 *    稍后处理的本质是「我现在不想看」，三个答案足够，多一档就多一次决策。
 */
import type { UnifiedMessage } from '../types';

/** 消息是否处于「稍后处理中」（snoozedUntil 在未来）；字段缺失 / 非法时间 = 未稍后 */
export function isSnoozed(m: UnifiedMessage, now: Date): boolean {
  if (!m.snoozedUntil) return false;
  const t = Date.parse(m.snoozedUntil);
  return !Number.isNaN(t) && t > now.getTime();
}

export interface SnoozePreset {
  key: '1h' | 'tonight' | 'tomorrow';
  label: string;
  untilIso: string;
}

function at(base: Date, dayOffset: number, hours: number, minutes: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** 三个固定档：今晚 21:00 已过就顺延到明天 21:00（文案如实跟着变） */
export function snoozePresets(now: Date): SnoozePreset[] {
  const tonight = at(now, now.getHours() >= 21 ? 1 : 0, 21, 0);
  return [
    { key: '1h', label: '1 小时后', untilIso: new Date(now.getTime() + 60 * 60_000).toISOString() },
    {
      key: 'tonight',
      label: tonight.getDate() === now.getDate() ? '今晚 21:00' : '明天 21:00',
      untilIso: tonight.toISOString(),
    },
    { key: 'tomorrow', label: '明早 9:00', untilIso: at(now, 1, 9, 0).toISOString() },
  ];
}
