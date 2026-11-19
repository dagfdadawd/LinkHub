/**
 * 引用回复语义：默认普通发送；只有显式传 quoteTraceId 才带引用信息。
 *
 * 背景：旧实现只要目标是「收到的钉钉消息」就一定走 `chat message reply`（引用），
 * 结果每次发送在手机上都是"引用上一条"。这里锁住新契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '@unimsg/shared';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from './llm';
import { OcrService } from './ocr';
import { RateLimiter } from './rateLimiter';
import { MessageService } from './message';
import { wecomSample } from '../connectors/samples';

function makeSvc() {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(5, 5), () => {},
  );
  return { repo, svc };
}
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

test('不传 quoteTraceId：普通发送，消息上不残留 quoteRef', async () => {
  const { svc } = makeSvc();
  const a = await svc.ingest(Platform.WECOM, wecomSample);
  const b = await svc.ingest(Platform.WECOM, wecomSample);

  await svc.reply(a.message.traceId, '好的');
  await wait();

  const after = svc.get(a.message.traceId)!;
  assert.equal(after.quoteRef, undefined, '普通发送不能带引用信息');
  assert.equal(after.reply, '好的');
  assert.ok(b.message.traceId, '另一条消息不受影响');
});

test('传了 quoteTraceId：带回引用目标 + 历史里记下引用摘要', async () => {
  const { svc } = makeSvc();
  const quoted = await svc.ingest(Platform.WECOM, wecomSample);
  const target = await svc.ingest(Platform.WECOM, wecomSample);

  await svc.reply(target.message.traceId, '周六下午', [], undefined, undefined, quoted.message.traceId);
  await wait();

  const after = svc.get(target.message.traceId)!;
  assert.ok(after.quoteRef, '显式引用时必须带 quoteRef');
  assert.equal(after.quoteRef?.messageId, quoted.message.externalId.replace(/^[a-z]+:/i, ''));
  assert.equal(after.quoteRef?.senderName, quoted.message.sender.name);

  const entry = after.replies?.at(-1);
  assert.equal(entry?.text, '周六下午');
  assert.equal(entry?.quote?.senderName, quoted.message.sender.name);
  assert.ok(entry?.quote?.text?.length, '引用摘要不能为空');
});

test('引用目标不存在时回中文错误，不静默发出去', async () => {
  const { svc } = makeSvc();
  const a = await svc.ingest(Platform.WECOM, wecomSample);
  await assert.rejects(
    () => svc.reply(a.message.traceId, 'x', [], undefined, undefined, 'no-such-trace'),
    /要引用的消息不存在|已被删除/,
  );
});