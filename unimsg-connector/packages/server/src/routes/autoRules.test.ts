/**
 * /api/auto-rules 路由 HTTP 契约测试：
 *  - CRUD（201/200/404）与 { ok, data } / { ok, error } 响应形状；
 *  - 校验失败回 400 中文错误（platform 枚举 / replyText / priority / keyword）；
 *  - PATCH 不存在的规则回 404「规则不存在」。
 * 直接构造 express + 内存 AutoRuleStore，127.0.0.1 回环，不触网、不落盘。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Platform } from '@unimsg/shared';
import { autoRulesRouter } from './autoRules';
import { AutoRuleStore } from '../services/autoReply';

interface Res {
  status: number;
  json: any;
}

async function withServer(fn: (base: string, store: AutoRuleStore) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  const store = new AutoRuleStore();
  app.use('/api', autoRulesRouter(store));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

test('GET /api/auto-rules：初态空列表 { ok:true, data:[] }', async () => {
  await withServer(async (base) => {
    const res = await call(base, 'GET', '/api/auto-rules');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.data, []);
  });
});

test('POST /api/auto-rules：201 创建并返回完整规则（含默认值）', async () => {
  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/auto-rules', {
      platform: Platform.FEISHU,
      keyword: '发票',
      replyText: '开票流程见文档',
      priority: 10,
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.ok, true);
    const rule = res.json.data;
    assert.match(rule.id, /^[0-9a-f-]{36}$/i);
    assert.equal(rule.platform, Platform.FEISHU);
    assert.equal(rule.keyword, '发票');
    assert.equal(rule.replyText, '开票流程见文档');
    assert.equal(rule.priority, 10);
    assert.equal(rule.enabled, true);
    assert.equal(rule.hitCount, 0);
    assert.ok(!Number.isNaN(Date.parse(rule.createdAt)));

    // GET 能看到刚创建的规则
    const list = await call(base, 'GET', '/api/auto-rules');
    assert.equal(list.json.data.length, 1);
    assert.equal(list.json.data[0].id, rule.id);
  });
});

test('POST /api/auto-rules：非法 platform / 缺 replyText / priority 超范围 → 400 中文错误', async () => {
  await withServer(async (base) => {
    const badPlatform = await call(base, 'POST', '/api/auto-rules', {
      platform: 'slack', replyText: 'ok',
    });
    assert.equal(badPlatform.status, 400);
    assert.equal(badPlatform.json.ok, false);
    assert.match(badPlatform.json.error, /platform 必须是/);

    const noReply = await call(base, 'POST', '/api/auto-rules', { keyword: 'k' });
    assert.equal(noReply.status, 400);
    assert.match(noReply.json.error, /replyText 不能为空/);

    const badPriority = await call(base, 'POST', '/api/auto-rules', { replyText: 'ok', priority: 1001 });
    assert.equal(badPriority.status, 400);
    assert.match(badPriority.json.error, /priority/);

    // 失败后列表仍为空（没有半成品入库）
    const list = await call(base, 'GET', '/api/auto-rules');
    assert.equal(list.json.data.length, 0);
  });
});

test('PATCH /api/auto-rules/:id：部分更新返回 200；不存在的 id 回 404「规则不存在」', async () => {
  await withServer(async (base) => {
    const created = await call(base, 'POST', '/api/auto-rules', { replyText: '原文案', keyword: '退款' });
    const id = created.json.data.id as string;

    const patched = await call(base, 'PATCH', `/api/auto-rules/${id}`, { priority: 3, enabled: false });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.ok, true);
    assert.equal(patched.json.data.priority, 3);
    assert.equal(patched.json.data.enabled, false);
    assert.equal(patched.json.data.keyword, '退款', '未传字段保持原值');

    const missing = await call(base, 'PATCH', '/api/auto-rules/no-such-id', { priority: 1 });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.error, '规则不存在');

    const invalid = await call(base, 'PATCH', `/api/auto-rules/${id}`, { priority: -5 });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.error, /priority/);
  });
});

test('DELETE /api/auto-rules/:id：删除成功 200 {ok:true}；再删同 id 回 404', async () => {
  await withServer(async (base) => {
    const created = await call(base, 'POST', '/api/auto-rules', { replyText: '待删' });
    const id = created.json.data.id as string;

    const del = await call(base, 'DELETE', `/api/auto-rules/${id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { ok: true });

    const list = await call(base, 'GET', '/api/auto-rules');
    assert.equal(list.json.data.length, 0);

    const again = await call(base, 'DELETE', `/api/auto-rules/${id}`);
    assert.equal(again.status, 404);
    assert.equal(again.json.error, '规则不存在');
  });
});

test('规则数据经路由写入后可直接被仓库 match 命中（路由与仓库同一份数据）', async () => {
  await withServer(async (base, store) => {
    await call(base, 'POST', '/api/auto-rules', {
      platform: Platform.DINGTALK, keyword: '日历', replyText: '日程同步中', priority: 5,
    });
    const hit = store.match(Platform.DINGTALK, '帮我同步日历');
    assert.ok(hit);
    assert.equal(hit.replyText, '日程同步中');
    assert.equal(store.match(Platform.FEISHU, '帮我同步日历'), undefined);
  });
});
