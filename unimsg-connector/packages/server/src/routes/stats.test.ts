/**
 * /api/stats/overview 路由契约测试：
 *  - 200 + { ok: true, data } 风格（与 messages 路由一致）；
 *  - data 是注入数据源算出的 StatsOverview（字段齐全、口径正确）；
 *  - 每次请求都重新计算（新消息进来后数字变化，generatedAt 前移）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { MsgStatus, Platform, type StatsOverview, type TraceEntry, type UnifiedMessage } from '@unimsg/shared';
import { statsRouter } from './stats';
import type { StatsSource } from '../services/stats';

function msg(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  const now = new Date().toISOString();
  return {
    traceId: `trace-${Math.random().toString(36).slice(2)}`,
    platform: Platform.FEISHU,
    externalId: `ext-${Math.random().toString(36).slice(2)}`,
    sender: { id: 'u1', name: '用户' },
    type: 'text',
    body: '正文',
    status: MsgStatus.RECEIVED,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

async function withServer(
  src: StatsSource,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api', statsRouter(src));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /api/stats/overview → 200 {ok:true,data}，data 按注入数据计算', async () => {
  const messages: UnifiedMessage[] = [
    msg({ status: MsgStatus.SENT, delivery: { mode: 'real', at: new Date().toISOString() } }),
    msg({ platform: Platform.DINGTALK, direction: 'out', status: MsgStatus.FAILED }),
    msg({ platform: Platform.WECHAT, type: 'todo', done: true }),
  ];
  const logs: TraceEntry[] = [
    { traceId: messages[0].traceId, platform: Platform.FEISHU, status: MsgStatus.RECEIVED, event: 'received', at: new Date().toISOString() },
  ];
  const dlqCount = () => 2;
  const rules = () => ({ total: 4, hits: 11 });

  await withServer(
    { listMessages: () => messages, getLoopLog: (t) => logs.filter((e) => e.traceId === t), dlqCount, rules },
    async (base) => {
      const res = await fetch(`${base}/api/stats/overview`);
      assert.equal(res.status, 200);
      const body: any = await res.json();
      assert.equal(body.ok, true);
      const data = body.data as StatsOverview;

      assert.deepEqual(data.totals, {
        messages: 3, inbound: 2, outbound: 1, replied: 1, pending: 1, failed: 1, todos: 1, done: 1,
      });
      assert.deepEqual(data.delivery, { real: 1, mock: 0 });
      assert.equal(data.dlq, 2);
      assert.deepEqual(data.rules, { total: 4, hits: 11 });
      assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));
      // 四平台补齐
      assert.deepEqual(
        data.byPlatform.map((r) => r.platform),
        [Platform.FEISHU, Platform.DINGTALK, Platform.MAIL, Platform.WECHAT],
      );
      const feishu = data.byPlatform.find((r) => r.platform === Platform.FEISHU)!;
      assert.equal(feishu.total, 1);
      assert.equal(feishu.replied, 1);
      assert.equal(data.byPlatform.find((r) => r.platform === Platform.MAIL)!.total, 0);
      // StatsOverview 顶层字段齐全
      for (const key of ['totals', 'byPlatform', 'byStatus', 'delivery', 'dlq', 'avgHandleSeconds', 'rules', 'generatedAt']) {
        assert.ok(Object.hasOwn(data, key), `data.${key} 存在`);
      }
    },
  );
});

test('stats/overview 每次请求重新计算（数据变化后数字与 generatedAt 前移）', async () => {
  const bag: UnifiedMessage[] = [msg()];
  const src: StatsSource = {
    listMessages: () => bag,
    getLoopLog: () => [],
    dlqCount: () => 0,
  };
  await withServer(src, async (base) => {
    const first: any = await (await fetch(`${base}/api/stats/overview`)).json();
    assert.equal(first.data.totals.messages, 1);

    bag.push(msg({ platform: Platform.MAIL, status: MsgStatus.SYNCED }));
    await new Promise((r) => setTimeout(r, 5)); // 保证 generatedAt 至少差 1ms
    const second: any = await (await fetch(`${base}/api/stats/overview`)).json();
    assert.equal(second.data.totals.messages, 2);
    assert.equal(second.data.totals.replied, 1);
    assert.ok(Date.parse(second.data.generatedAt) >= Date.parse(first.data.generatedAt));
  });
});
