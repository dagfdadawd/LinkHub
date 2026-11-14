import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, MsgStatus, PlatformConnector } from '@unimsg/shared';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from './llm';
import { OcrService } from './ocr';
import { RateLimiter } from './rateLimiter';
import { MessageService } from './message';
import { feishuSample } from '../connectors/samples';

const wait = (ms = 160) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function feishuRaw(content: string, messageType = 'text') {
  return {
    ...feishuSample,
    event: {
      message: {
        ...feishuSample.event.message,
        message_type: messageType,
        content: JSON.stringify({ text: content }),
      },
    },
  };
}

test('LLM 失败 → 回退「未分类」，不伪造意图', async () => {
  const repo = new InMemoryRepository();
  const svc = new MessageService(repo, connectors, new LlmService(), new OcrService(), new RateLimiter(1, 5), () => {});
  const { message } = await svc.ingest(Platform.FEISHU, feishuRaw('[[FAIL_LLM]] 帮我看看这个'));
  await waitFor(() => repo.get(message.traceId)!.intent !== undefined);
  assert.equal(repo.get(message.traceId)!.intent, '未分类');
  assert.equal(repo.get(message.traceId)!.intentSource, 'rules', '规则结果必须标注为 rules');
});

test('OCR 低置信 → 标记待人工确认（标记落到 needsReview，不污染正文）', async () => {
  const repo = new InMemoryRepository();
  const svc = new MessageService(repo, connectors, new LlmService(), new OcrService(), new RateLimiter(1, 5), () => {});
  const { message } = await svc.ingest(Platform.FEISHU, feishuRaw('[[LOW_CONF]]', 'image'));
  await waitFor(() => repo.get(message.traceId)!.needsReview === true);
  const m = repo.get(message.traceId)!;
  assert.equal(m.needsReview, true);
  // OCR 文本不再拼进正文：正文只留用户看到的内容，识别结果只进闭环日志
  assert.equal(m.body.includes('待人工确认'), false);
  assert.equal(m.body.includes('图片识别文字'), false);
  assert.ok(repo.getLoopLog(message.traceId).some((e) => e.event === 'ocr_low_confidence'));
});

test('发送重试耗尽 → failed + DLQ', async () => {
  const repo = new InMemoryRepository();
  const failing = { ...connectors } as Record<Platform, PlatformConnector>;
  failing[Platform.FEISHU] = {
    ...connectors[Platform.FEISHU],
    send: async () => { throw new Error('platform 500'); },
  };
  const svc = new MessageService(repo, failing, new LlmService(), new OcrService(), new RateLimiter(2, 5), () => {});
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.reply(message.traceId, 'hi');
  await wait(200);
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.FAILED);
  assert.equal(repo.listDlq().length, 1);
});
