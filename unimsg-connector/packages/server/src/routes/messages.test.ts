/**
 * POST /api/messages/:id/reanalyze 的 HTTP 契约测试（127.0.0.1 回环，绝不触网）。
 * 覆盖：返回完整消息 + 当前 LLM 通道结论（不含密钥）、消息不存在 404。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Platform } from '@unimsg/shared';
import { createApp } from '../app';
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

const headers = { 'content-type': 'application/json', Authorization: 'Bearer dev-token' };

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
