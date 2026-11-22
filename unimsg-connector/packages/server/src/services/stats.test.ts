/**
 * 统计口径单测（纯函数，不起服务、不读库）：
 *  - 各计数口径：方向 / 已回 / 待处理 / 失败 / 待办 / 投递通道；
 *  - byPlatform 四平台补齐 + 未知平台保留；
 *  - 平均处理时长：received→sent、composed→sent、 earliest 取样、负差值剔除、无样本为 null；
 *  - rules 缺省与注入；dlq 透传。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MsgStatus, Platform, type StatsOverview, type TraceEntry, type UnifiedMessage } from '@unimsg/shared';
import { computeStats, type StatsSource } from './stats';

let seq = 0;

function msg(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  seq += 1;
  const now = new Date().toISOString();
  return {
    traceId: `trace-${seq}`,
    platform: Platform.FEISHU,
    externalId: `ext-${seq}`,
    sender: { id: 'u1', name: '用户' },
    type: 'text',
    body: '正文',
    status: MsgStatus.RECEIVED,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function entry(traceId: string, event: string, at: string, status: MsgStatus = MsgStatus.RECEIVED): TraceEntry {
  return { traceId, platform: Platform.FEISHU, status, event, at };
}

/** 固定时间基准：2026-03-01T00:00:00Z 起，用秒数偏移表达，避免时区/可读性问题 */
const T0 = Date.parse('2026-03-01T00:00:00Z');
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

function source(
  messages: UnifiedMessage[],
  logs: TraceEntry[] = [],
  over: Partial<StatsSource> = {},
): StatsSource {
  return {
    listMessages: () => messages,
    getLoopLog: (traceId: string) => logs.filter((e) => e.traceId === traceId),
    dlqCount: () => 0,
    ...over,
  };
}

function byPlatform(stats: StatsOverview, platform: string): StatsOverview['byPlatform'][number] | undefined {
  return stats.byPlatform.find((r) => r.platform === platform);
}

test('空数据：各项为 0、四平台补齐、avgHandleSeconds 为 null、rules 缺省 0/0', () => {
  const s = computeStats(source([]));
  assert.deepEqual(s.totals, {
    messages: 0, inbound: 0, outbound: 0, replied: 0, pending: 0, failed: 0, todos: 0, done: 0,
  });
  assert.equal(s.byPlatform.length, 4);
  for (const p of Object.values(Platform)) {
    const row = byPlatform(s, p);
    assert.ok(row, `平台 ${p} 应出现在 byPlatform`);
    assert.deepEqual(
      { ...row, platform: row.platform },
      { platform: p, total: 0, inbound: 0, outbound: 0, replied: 0, pending: 0, failed: 0 },
    );
  }
  assert.deepEqual(s.byStatus, {});
  assert.deepEqual(s.delivery, { real: 0, mock: 0 });
  assert.equal(s.dlq, 0);
  assert.equal(s.avgHandleSeconds, null);
  assert.deepEqual(s.rules, { total: 0, hits: 0 });
  assert.ok(!Number.isNaN(Date.parse(s.generatedAt)), 'generatedAt 是 ISO 时间');
});

test('方向与状态口径：inbound 缺省、outbound 显式、replied/pending/failed 各自成立', () => {
  const s = computeStats(
    source([
      msg({ status: MsgStatus.RECEIVED }), // 缺省 direction → inbound，pending
      msg({ status: MsgStatus.PROCESSING, direction: 'in' }), // pending
      msg({ status: MsgStatus.REPLIED }), // replied（状态）
      msg({ status: MsgStatus.SENT }), // replied（状态）
      msg({ status: MsgStatus.SYNCED }), // replied（状态）
      msg({ status: MsgStatus.FAILED, replies: [{ text: '试过一次', at: at(10) }] }), // failed 且 replied（有回复历史）
      msg({ status: MsgStatus.FAILED }), // 仅 failed
      msg({ direction: 'out', status: MsgStatus.SENT }), // outbound（且状态 sent → 也计 replied）
    ]),
  );
  assert.equal(s.totals.messages, 8);
  assert.equal(s.totals.inbound, 7, '缺省 direction 按 inbound 计');
  assert.equal(s.totals.outbound, 1);
  assert.equal(s.totals.replied, 5, 'replied/sent/synced 各 1 + 失败但有回复 1 + 出站 sent 1');
  assert.equal(s.totals.pending, 2, 'received + processing');
  assert.equal(s.totals.failed, 2);
  assert.equal(s.byStatus[MsgStatus.RECEIVED], 1);
  assert.equal(s.byStatus[MsgStatus.PROCESSING], 1);
  assert.equal(s.byStatus[MsgStatus.REPLIED], 1);
  assert.equal(s.byStatus[MsgStatus.SENT], 2);
  assert.equal(s.byStatus[MsgStatus.SYNCED], 1);
  assert.equal(s.byStatus[MsgStatus.FAILED], 2);
});

test('待办口径：todos 按 type 计，done 只数 done===true', () => {
  const s = computeStats(
    source([
      msg({ type: 'todo' }), // 待办未完成
      msg({ type: 'todo', done: true }), // 待办已完成
      msg({ type: 'todo', done: true, status: MsgStatus.SYNCED }),
      msg({ done: true }), // 非待办也被标完成：done 计数独立于 todos
    ]),
  );
  assert.equal(s.totals.todos, 3);
  assert.equal(s.totals.done, 3);
});

test('delivery 口径：real / mock 分别计数，未投递不计', () => {
  const s = computeStats(
    source([
      msg({ delivery: { mode: 'real', at: at(5) } }),
      msg({ delivery: { mode: 'real', at: at(5) } }),
      msg({ delivery: { mode: 'mock', at: at(5) } }),
      msg(), // 没投递过
    ]),
  );
  assert.deepEqual(s.delivery, { real: 2, mock: 1 });
});

test('byPlatform：按平台分组计数，枚举之外的平台也保留', () => {
  const s = computeStats(
    source([
      msg({ platform: Platform.FEISHU, status: MsgStatus.SENT }),
      msg({ platform: Platform.FEISHU, direction: 'out', status: MsgStatus.FAILED }),
      msg({ platform: Platform.DINGTALK, status: MsgStatus.PROCESSING }),
      msg({ platform: 'unknown-platform' as Platform, status: MsgStatus.RECEIVED }),
    ]),
  );
  const feishu = byPlatform(s, Platform.FEISHU);
  assert.deepEqual(feishu, {
    platform: Platform.FEISHU, total: 2, inbound: 1, outbound: 1, replied: 1, pending: 0, failed: 1,
  });
  const dingtalk = byPlatform(s, Platform.DINGTALK);
  assert.deepEqual(dingtalk, {
    platform: Platform.DINGTALK, total: 1, inbound: 1, outbound: 0, replied: 0, pending: 1, failed: 0,
  });
  assert.ok(byPlatform(s, Platform.WECHAT), 'wechat 无数据也补齐');
  assert.ok(byPlatform(s, Platform.MAIL), 'mail 无数据也补齐');
  assert.equal(s.byPlatform.length, 5, '四平台 + 未知平台');
  const unknown = byPlatform(s, 'unknown-platform');
  assert.deepEqual(unknown, {
    platform: 'unknown-platform', total: 1, inbound: 1, outbound: 0, replied: 0, pending: 1, failed: 0,
  });
});

test('avgHandleSeconds：received→sent 与 composed→sent 混合样本取平均', () => {
  const m1 = msg({ traceId: 't-1' });
  const m2 = msg({ traceId: 't-2', platform: Platform.DINGTALK });
  const logs: TraceEntry[] = [
    entry('t-1', 'received', at(0)),
    entry('t-1', 'intent', at(1)),
    entry('t-1', 'sent', at(3)), // 3s
    entry('t-2', 'composed', at(0)), // 主动发送：起点是 composed
    entry('t-2', 'processing', at(0.5)),
    entry('t-2', 'sent', at(1)), // 1s
  ];
  const s = computeStats(source([m1, m2], logs));
  assert.equal(s.avgHandleSeconds, 2, '(3 + 1) / 2');
});

test('avgHandleSeconds：多个 received/sent 取各自最早的一条', () => {
  const m = msg({ traceId: 't-3' });
  const logs: TraceEntry[] = [
    entry('t-3', 'received', at(10)), // 较晚的 received（重推场景）不应作为起点
    entry('t-3', 'received', at(2)), // 最早的 received
    entry('t-3', 'sent', at(7)), // 最早的 sent
    entry('t-3', 'sent', at(9)),
  ];
  const s = computeStats(source([m], logs));
  assert.equal(s.avgHandleSeconds, 5, '最早 sent(7) - 最早 received(2)');
});

test('avgHandleSeconds：缺一端、负差值、日志为空都不计入样本', () => {
  const noSent = msg({ traceId: 't-4' });
  const noStart = msg({ traceId: 't-5' });
  const negative = msg({ traceId: 't-6' });
  const badTime = msg({ traceId: 't-7' });
  const logs: TraceEntry[] = [
    entry('t-4', 'received', at(0)), // 没有 sent
    entry('t-5', 'sent', at(4)), // 没有起点
    entry('t-6', 'received', at(6)),
    entry('t-6', 'sent', at(3)), // sent 早于 received：脏数据剔除
    entry('t-7', 'received', 'not-a-date'),
    entry('t-7', 'sent', at(4)),
  ];
  const s = computeStats(source([noSent, noStart, negative, badTime], logs));
  assert.equal(s.avgHandleSeconds, null, '没有任何合格样本');
});

test('rules：来源有值则透传，无 rules() 按 0/0', () => {
  const withRules = computeStats(source([msg()], [], { rules: () => ({ total: 3, hits: 9 }) }));
  assert.deepEqual(withRules.rules, { total: 3, hits: 9 });
  const withoutRules = computeStats(source([msg()]));
  assert.deepEqual(withoutRules.rules, { total: 0, hits: 0 });
});

test('dlq：透传 dlqCount()', () => {
  const s = computeStats(source([msg()], [], { dlqCount: () => 7 }));
  assert.equal(s.dlq, 7);
});
