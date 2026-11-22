/**
 * /api/ingest 路由测试（通用接入通道）：
 *  - 真实 MessageService + InMemoryRepository（与 services/message.test.ts 同一构造），
 *    幂等完全交给 ingestUnified，路由层不自己查重；
 *  - 202 受理 + { message, duplicate }；同 platform+externalId 重推 duplicate=true；
 *  - 校验失败回 400 中文错误（platform / externalId / body / conversation.id / createdAt / type）。
 * 127.0.0.1 回环，不触网；LLM 富化异步进行且可降级，不影响断言。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Platform } from '@unimsg/shared';
import { ingestRouter } from './ingest';
import { MessageService } from '../services/message';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from '../services/llm';
import { OcrService } from '../services/ocr';
import { RateLimiter } from '../services/rateLimiter';

interface Res {
  status: number;
  json: any;
}

async function withServer(fn: (base: string, ctx: { svc: MessageService; repo: InMemoryRepository }) => Promise<void>): Promise<void> {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService({ mode: 'mock' }), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', ingestRouter(svc));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, { svc, repo });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function call(base: string, body: unknown): Promise<Res> {
  const res = await fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** 一条最小合法请求；字段可覆盖 */
function validReq(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: Platform.FEISHU,
    externalId: 'ext-001',
    body: '你好，请帮我处理这张发票',
    ...extra,
  };
}

test('POST /api/ingest：202 受理，首次 duplicate=false，消息按统一格式组装', async () => {
  await withServer(async (base, { repo }) => {
    const res = await call(base, validReq());
    assert.equal(res.status, 202);
    assert.equal(res.json.ok, true);

    const { message, duplicate } = res.json.data;
    assert.equal(duplicate, false);
    assert.equal(message.platform, Platform.FEISHU);
    assert.equal(message.externalId, 'ext-001');
    assert.equal(message.body, '你好，请帮我处理这张发票');
    // 缺省 sender / type / direction / status
    assert.deepEqual(message.sender, { id: 'ingest', name: '外部采集器' });
    assert.equal(message.type, 'text');
    assert.equal(message.direction, 'in');
    assert.equal(message.status, 'received');
    assert.equal(message.conversation, undefined);
    // 未传 createdAt = 服务端当前时间（允许秒级误差）
    assert.ok(Math.abs(Date.parse(message.createdAt) - Date.now()) < 5000, `createdAt=${message.createdAt}`);
    assert.ok(!Number.isNaN(Date.parse(message.updatedAt)));
    // traceId 未传 = 服务端生成 UUID
    assert.match(message.traceId, /^[0-9a-f-]{36}$/i);
    // 确实入了库
    assert.equal(repo.list().length, 1);
    assert.equal(repo.list()[0].traceId, message.traceId);
  });
});

test('POST /api/ingest：traceId / createdAt / sender / conversation 透传', async () => {
  await withServer(async (base) => {
    const res = await call(base, validReq({
      traceId: 'my-trace-42',
      createdAt: '2026-01-15T08:30:00.000Z',
      sender: { id: 'u9', name: '外部工单系统' },
      conversation: { id: 'conv-abc', type: 'p2p', title: '客服会话' },
    }));
    assert.equal(res.status, 202);
    const message = res.json.data.message;
    assert.equal(message.traceId, 'my-trace-42');
    assert.equal(message.createdAt, '2026-01-15T08:30:00.000Z');
    assert.deepEqual(message.sender, { id: 'u9', name: '外部工单系统' });
    assert.deepEqual(message.conversation, { id: 'conv-abc', type: 'p2p', title: '客服会话' });
  });
});

test('POST /api/ingest：conversation 只传 id 时按对象入库；conversation 不传则不加该字段', async () => {
  await withServer(async (base) => {
    const withConv = await call(base, validReq({ externalId: 'ext-conv', conversation: { id: 'group-1' } }));
    assert.equal(withConv.status, 202);
    assert.equal(withConv.json.data.message.conversation.id, 'group-1');
    assert.equal(withConv.json.data.message.conversation.type, 'group');

    const noConv = await call(base, validReq({ externalId: 'ext-noconv' }));
    assert.equal(noConv.status, 202);
    assert.equal(noConv.json.data.message.conversation, undefined);
  });
});

test('POST /api/ingest：同 platform+externalId 重推 duplicate=true，不重复入库', async () => {
  await withServer(async (base, { repo }) => {
    const first = await call(base, validReq());
    assert.equal(first.status, 202);
    assert.equal(first.json.data.duplicate, false);

    const second = await call(base, validReq({ body: '内容不同的重推' }));
    assert.equal(second.status, 202);
    assert.equal(second.json.data.duplicate, true);
    // 返回的是首次入库的那条消息
    assert.equal(second.json.data.message.traceId, first.json.data.message.traceId);
    assert.equal(second.json.data.message.body, '你好，请帮我处理这张发票');
    assert.equal(repo.list().length, 1, '重复投递不得重复入库');

    // 换 externalId = 新消息
    const third = await call(base, validReq({ externalId: 'ext-002' }));
    assert.equal(third.json.data.duplicate, false);
    assert.equal(repo.list().length, 2);
  });
});

test('POST /api/ingest：platform 非法 / 缺失 → 400 中文错误', async () => {
  await withServer(async (base) => {
    const bad = await call(base, validReq({ platform: 'slack' }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.error, /platform 必须是/);

    const missing = await call(base, { externalId: 'e1', body: 'hi' });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /platform 必须是/);
  });
});

test('POST /api/ingest：externalId 空 / 超长 / 兜底 unknown → 400', async () => {
  await withServer(async (base, { repo }) => {
    const empty = await call(base, validReq({ externalId: '' }));
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /externalId 不能为空/);

    const blank = await call(base, validReq({ externalId: '   ' }));
    assert.equal(blank.status, 400);

    const tooLong = await call(base, validReq({ externalId: 'x'.repeat(257) }));
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /externalId 不能超过 256/);

    // 'unknown' 通过路由校验但被 ingestUnified 拒收（防占死去重键），同样 400
    const unknown = await call(base, validReq({ externalId: 'unknown' }));
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /externalId|唯一 ID/);
    assert.equal(repo.list().length, 0, '全部非法请求都不应入库');
  });
});

test('POST /api/ingest：body 缺失 / 空白 / 超 100000 → 400', async () => {
  await withServer(async (base) => {
    const missing = await call(base, { platform: Platform.MAIL, externalId: 'm1' });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /body 不能为空/);

    const blank = await call(base, validReq({ body: '  \n ' }));
    assert.equal(blank.status, 400);

    const tooLong = await call(base, validReq({ body: 'a'.repeat(100001) }));
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /body 不能超过 100000/);
  });
});

test('POST /api/ingest：conversation.id 超长 → 400；createdAt 畸形 → 400；type 非法 → 400', async () => {
  await withServer(async (base) => {
    const conv = await call(base, validReq({ conversation: { id: 'c'.repeat(257) } }));
    assert.equal(conv.status, 400);
    assert.match(conv.json.error, /conversation\.id 不能超过 256/);

    const badTime = await call(base, validReq({ createdAt: '明天下午' }));
    assert.equal(badTime.status, 400);
    assert.match(badTime.json.error, /createdAt 必须是/);

    const badType = await call(base, validReq({ type: 'voice' }));
    assert.equal(badType.status, 400);
    assert.match(badType.json.error, /type 必须是/);
  });
});

test('POST /api/ingest：合法 createdAt 原样保留；type=image 走图片类型入库', async () => {
  await withServer(async (base, { repo }) => {
    const res = await call(base, validReq({
      externalId: 'img-1',
      type: 'image',
      createdAt: '2026-06-01T10:00:00.000Z',
    }));
    assert.equal(res.status, 202);
    assert.equal(res.json.data.message.type, 'image');
    assert.equal(res.json.data.message.createdAt, '2026-06-01T10:00:00.000Z');
    assert.equal(repo.list().length, 1);
  });
});
