/**
 * 统一入口「主动发送 + 文件」的闭环单测。
 * 验证：新建发送与带附件回复都走完整状态机、写 trace、附件元数据可见、
 * 文件内容不进入可持久化消息，Mock 通道如实记录而不伪装真实发送。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, MsgStatus } from '@unimsg/shared';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { sentBox } from '../connectors/base';
import { LlmService } from './llm';
import { OcrService } from './ocr';
import { RateLimiter } from './rateLimiter';
import { MessageService } from './message';
import { feishuSample } from '../connectors/samples';

function makeSvc() {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  return { repo, svc };
}
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function attachment() {
  const buf = Buffer.from('%PDF-1.4 demo', 'utf8');
  return {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: buf.byteLength,
    contentBase64: buf.toString('base64'),
  };
}

test('compose：指定平台/会话主动发送，走完状态机且可回放', async () => {
  const { svc, repo } = makeSvc();
  const ack = await svc.compose({
    platform: Platform.FEISHU,
    conversationId: 'oc_compose_test',
    text: '请查收本周周报',
  });
  assert.equal(ack.message.platform, Platform.FEISHU);
  assert.equal(ack.message.conversation?.id, 'oc_compose_test');
  assert.equal(ack.message.status, MsgStatus.REPLIED);
  assert.equal(ack.message.sender.name, 'LinkHub 统一入口');

  await wait();
  const m = repo.get(ack.taskId)!;
  assert.equal(m.status, MsgStatus.SYNCED);
  assert.equal(m.delivery?.mode, 'mock');
  const events = repo.getLoopLog(ack.taskId).map((e) => e.event);
  for (const ev of ['composed', 'processing', 'replied', 'sent', 'synced']) {
    assert.ok(events.includes(ev), `missing trace: ${ev}`);
  }
});

test('compose：带附件时元数据入库、内容不入库，适配器收到原始附件', async () => {
  const { svc, repo } = makeSvc();
  const a = attachment();
  const before = sentBox[Platform.FEISHU].length;

  const ack = await svc.compose({
    platform: Platform.FEISHU,
    conversationId: 'oc_file_test',
    text: '附上文件',
    attachments: [a],
  });
  assert.deepEqual(ack.message.attachments, [
    { name: 'report.pdf', mimeType: 'application/pdf', size: a.size },
  ]);

  await wait();
  const stored = JSON.stringify(repo.get(ack.taskId));
  assert.equal(stored.includes('contentBase64'), false);
  assert.equal(stored.includes(a.contentBase64), false);

  const sent = sentBox[Platform.FEISHU].slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0] as { payload: { attachments?: unknown[] } }).payload.attachments, [
    { name: 'report.pdf', mimeType: 'application/pdf', size: a.size },
  ]);
});

test('compose：只发文件也合法，正文退化为附件摘要', async () => {
  const { svc } = makeSvc();
  const ack = await svc.compose({
    platform: Platform.FEISHU,
    conversationId: 'oc_only_file',
    text: '',
    attachments: [attachment()],
  });
  assert.equal(ack.message.reply, '');
  assert.match(ack.message.body, /^\[附件\] report\.pdf$/);
  assert.equal(ack.message.attachments?.length, 1);
  await wait();
});

test('compose：既无显式会话也无历史会话时显式报错，不伪造目标', async () => {
  const { svc } = makeSvc();
  await assert.rejects(
    () => svc.compose({ platform: Platform.WECOM, text: 'hi' }),
    /缺少目标会话/,
  );
});

test('reply：带附件回写沿用同一状态机，附件元数据可见', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  const a = attachment();
  const ack = await svc.reply(message.traceId, '收到，附文件', [a]);
  assert.equal(ack.message.status, MsgStatus.REPLIED);
  assert.equal(ack.message.attachments?.length, 1);

  await wait();
  const m = repo.get(message.traceId)!;
  assert.equal(m.status, MsgStatus.SYNCED);
  assert.deepEqual(m.attachments, [{ name: 'report.pdf', mimeType: 'application/pdf', size: a.size }]);
  assert.equal(JSON.stringify(m).includes(a.contentBase64), false);
  assert.ok(repo.getLoopLog(message.traceId).some((e) => /带 1 个附件/.test(e.detail ?? '')));
});
