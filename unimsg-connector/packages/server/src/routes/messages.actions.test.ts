/**
 * 人工处理动作的 HTTP 契约测试（127.0.0.1 回环，绝不触网）：
 * PATCH /messages/:id/status、POST /messages/:id/forward、PATCH /messages/:id/priority。
 *
 * 服务层语义已有单测；这里只验证「路由解析、状态码、错误文案、响应形状」，
 * 避免前端照着错误契约对接。
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

const headers = { 'content-type': 'application/json', Authorization: `Bearer ${config.apiToken}` };

test('PATCH status：前进成功；倒退回 400 中文原因', async () => {
  forceMode(Platform.FEISHU, 'mock');
  await withApp(async ({ svc, base }) => {
    const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
    const url = `${base}/api/messages/${encodeURIComponent(message.traceId)}/status`;

    const ok = await fetch(url, {
      method: 'PATCH', headers, body: JSON.stringify({ status: MsgStatus.PROCESSING }),
    });
    assert.equal(ok.status, 200);
    const body: any = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.message.status, MsgStatus.PROCESSING);
    assert.equal(body.data.notified, false);

    const back = await fetch(url, {
      method: 'PATCH', headers, body: JSON.stringify({ status: MsgStatus.RECEIVED }),
    });
    assert.equal(back.status, 400);
    const err: any = await back.json();
    assert.equal(err.ok, false);
    assert.match(err.error, /倒退|不允许/);
  });
});

test('PATCH status：notify=true 时回执走模拟通道并如实返回 mode', async () => {
  forceMode(Platform.FEISHU, 'mock');
  await withApp(async ({ svc, base }) => {
    const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
    const res = await fetch(`${base}/api/messages/${encodeURIComponent(message.traceId)}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: MsgStatus.PROCESSING, notify: true, note: '已安排同事跟进' }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.data.notified, true);
    assert.equal(body.data.notifyMode, 'mock');
    const events = svc.getLoopLog(message.traceId).map((e) => e.event);
    assert.ok(events.includes('status_notified'));
  });
});

test('PATCH status：非法 notify / 未知状态回 400', async () => {
  forceMode(Platform.FEISHU, 'mock');
  await withApp(async ({ svc, base }) => {
    const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
    const url = `${base}/api/messages/${encodeURIComponent(message.traceId)}/status`;
    const badNotify = await fetch(url, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'processing', notify: 'yes' }),
    });
    assert.equal(badNotify.status, 400);
    const badStatus = await fetch(url, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'teleported' }),
    });
    assert.equal(badStatus.status, 400);
  });
});

test('POST forward：202 返回目标平台消息，正文带来源标记', async () => {
  forceMode(Platform.FEISHU, 'mock');
  forceMode(Platform.DINGTALK, 'mock');
  await withApp(async ({ svc, base }) => {
    const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
    const res = await fetch(`${base}/api/messages/${encodeURIComponent(message.traceId)}/forward`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ platform: Platform.DINGTALK, note: '请钉钉同事跟进' }),
    });
    assert.equal(res.status, 202);
    const body: any = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.message.platform, Platform.DINGTALK);
    assert.match(body.message.body, /\[转发自 feishu\]/);
    assert.match(body.message.body, /请钉钉同事跟进/);
  });
});

test('POST forward：非法平台 / 消息不存在分别回 400 与 404', async () => {
  forceMode(Platform.FEISHU, 'mock');
  await withApp(async ({ svc, base }) => {
    const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
    const bad = await fetch(`${base}/api/messages/${encodeURIComponent(message.traceId)}/forward`, {
      method: 'POST', headers, body: JSON.stringify({ platform: 'telegram' }),
    });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${base}/api/messages/not-exist/forward`, {
      method: 'POST', headers, body: JSON.stringify({ platform: Platform.DINGTALK }),
    });
    assert.equal(missing.status, 404);
  });
});

test('PATCH priority：合法值成功、非法值 400', async () => {
  forceMode(Platform.FEISHU, 'mock');
  await withApp(async ({ svc, base }) => {
    const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
    const url = `${base}/api/messages/${encodeURIComponent(message.traceId)}/priority`;

    const ok = await fetch(url, {
      method: 'PATCH', headers, body: JSON.stringify({ priority: 'urgent' }),
    });
    assert.equal(ok.status, 200);
    const body: any = await ok.json();
    assert.equal(body.data.message.priority, 'urgent');
    assert.equal(body.data.message.prioritySource, 'manual');

    const bad = await fetch(url, {
      method: 'PATCH', headers, body: JSON.stringify({ priority: 'sooner' }),
    });
    assert.equal(bad.status, 400);
  });
});
