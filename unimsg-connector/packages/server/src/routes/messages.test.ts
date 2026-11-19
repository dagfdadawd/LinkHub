/**
 * POST /api/messages/:id/reanalyze 的 HTTP 契约测试（127.0.0.1 回环，绝不触网）。
 * 覆盖：返回完整消息 + 当前 LLM 通道结论（不含密钥）、消息不存在 404。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Platform, MsgStatus } from '@unimsg/shared';
import { createApp } from '../app';
import { config, forceMode } from '../config';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from '../services/llm';
import { OcrService } from '../services/ocr';
import { RateLimiter } from '../services/rateLimiter';
import { MessageService } from '../services/message';
import { feishuSample } from '../connectors/samples';

interface Ctx {
  repo: InMemoryRepository;
  svc: MessageService;
  base: string;
}

async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ repo, svc, base });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// 用当前生效的令牌而不是写死 dev-token：开发机上 .env 配了 API_TOKEN 时也能跑
const headers = { 'content-type': 'application/json', Authorization: `Bearer ${config.apiToken}` };

test('重新生成：返回完整消息 + LLM 通道结论，且不泄露密钥', async () => {
  await withApp(async ({ svc, base }) => {
    const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
    const res = await fetch(`${base}/api/messages/${encodeURIComponent(message.traceId)}/reanalyze`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.traceId, message.traceId);
    assert.ok(body.data.intent, '重新分析必须给出意图');
    assert.ok(['mock', 'real'].includes(body.llm.mode));
    assert.equal(typeof body.llm.reason, 'string');
    assert.equal(typeof body.llm.providerLabel, 'string');
    assert.equal(JSON.stringify(body).includes('apiKey'), false);
    assert.equal(JSON.stringify(body).includes('sk-'), false);

    const missing = await fetch(`${base}/api/messages/not-exist/reanalyze`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(missing.status, 404);
  });
});

test('新建发送：todo 随同一次请求落地（type/todoTitle/dueAt），非法 todo 回 400', async () => {
  forceMode(Platform.WECHAT, 'mock'); // 本用例只走 HTTP + 模拟通道，绝不真实发到平台
  try {
    await withApp(async ({ base }) => {
      const res = await fetch(`${base}/api/messages/compose`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          platform: 'wechat',
          text: '明天把周报发我',
          todo: { title: '跟进周报', dueAt: '2026-11-20T10:00:00+08:00' },
        }),
      });
      assert.equal(res.status, 202);
      const body: any = await res.json();
      assert.equal(body.ok, true);
      // 待办就是这条消息本身：HTTP 回执里直接能看到 type / todoTitle / dueAt
      assert.equal(body.message.type, 'todo');
      assert.equal(body.message.done, false);
      assert.equal(body.message.todoTitle, '跟进周报');
      assert.equal(body.message.dueAt, '2026-11-20T02:00:00.000Z', '截止时间统一成 ISO');
      assert.equal(body.message.body, '明天把周报发我');

      // 回放里能查到「手动加入待办」事件（前端全链路页据此展示）
      const traceRes = await fetch(`${base}/api/messages/trace/${encodeURIComponent(body.taskId)}`, { headers });
      const trace: any = await traceRes.json();
      assert.ok(trace.log.some((e: any) => e.event === 'todo_added' && /手动加入待办/.test(e.detail ?? '')));

      const bad = await fetch(`${base}/api/messages/compose`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ platform: 'wechat', text: 'hi', todo: { dueAt: '明天下午三点' } }),
      });
      assert.equal(bad.status, 400);
      const badBody: any = await bad.json();
      assert.match(badBody.error, /todo\.dueAt 不是合法时间/);
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

test('新建发送：不传 todo 时消息类型仍是 text（加待办是可选行为）', async () => {
  forceMode(Platform.WECHAT, 'mock');
  try {
    await withApp(async ({ base }) => {
      const res = await fetch(`${base}/api/messages/compose`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ platform: 'wechat', text: '普通消息' }),
      });
      assert.equal(res.status, 202);
      const body: any = await res.json();
      assert.equal(body.message.type, 'text');
      assert.equal(body.message.todoTitle, undefined);
      assert.equal(body.message.status, MsgStatus.REPLIED);
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});
