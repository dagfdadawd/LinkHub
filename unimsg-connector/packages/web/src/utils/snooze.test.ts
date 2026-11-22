/**
 * Snooze 纯逻辑单测：到期判定（含非法时间）与三档预设的顺延规则
 * （今晚 21:00 已过 → 顺延明天，文案如实跟着变）。
 */
import { describe, expect, it } from 'vitest';
import { MsgStatus, Platform } from '../types';
import type { UnifiedMessage } from '../types';
import { isSnoozed, snoozePresets } from './snooze';

function msg(snoozedUntil?: string): UnifiedMessage {
  return {
    traceId: 't-1',
    platform: Platform.FEISHU,
    externalId: 'e-1',
    sender: { id: 'u', name: '张三' },
    type: 'text',
    body: '正文',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };
}

describe('isSnoozed', () => {
  const now = new Date('2026-11-22T12:00:00+08:00');

  it('到期前为 true，到期后 / 无字段 / 非法时间均为 false', () => {
    expect(isSnoozed(msg('2026-11-22T13:00:00+08:00'), now)).toBe(true);
    expect(isSnoozed(msg('2026-11-22T12:00:00+08:00'), now)).toBe(false); // 到点即回列表
    expect(isSnoozed(msg('2026-11-22T11:59:00+08:00'), now)).toBe(false);
    expect(isSnoozed(msg(), now)).toBe(false);
    expect(isSnoozed(msg('not-a-date'), now)).toBe(false);
  });
});

describe('snoozePresets', () => {
  it('白天：今晚 21:00 / 明早 9:00 / 1 小时后', () => {
    const now = new Date('2026-11-22T12:00:00+08:00');
    const presets = snoozePresets(now);
    expect(presets.map((p) => p.label)).toEqual(['1 小时后', '今晚 21:00', '明早 9:00']);
    // toISOString 恒为 UTC：12:00+08:00 的 1 小时后 = 05:00Z
    expect(presets[0].untilIso).toBe('2026-11-22T05:00:00.000Z');
    expect(presets[1].untilIso).toBe('2026-11-22T13:00:00.000Z');
    expect(presets[2].untilIso).toBe('2026-11-23T01:00:00.000Z');
  });

  it('已过 21:00：今晚档顺延到明天 21:00，文案如实跟着变', () => {
    const now = new Date('2026-11-22T22:30:00+08:00');
    const presets = snoozePresets(now);
    expect(presets[1].label).toBe('明天 21:00');
    expect(presets[1].untilIso).toBe('2026-11-23T13:00:00.000Z');
    expect(presets[2].label).toBe('明早 9:00');
    expect(presets[2].untilIso).toBe('2026-11-23T01:00:00.000Z');
  });
});
