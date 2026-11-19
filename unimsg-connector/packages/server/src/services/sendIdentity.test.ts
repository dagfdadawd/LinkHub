/**
 * 本轮回归：发送身份只对「本次发送」有效、回声不再入库、失败回复要留痕。
 *
 * 这三条对应线上真实事故：
 *  1. 用户在对话框里选过一次机器人 → `sendIdentity` 永久写在这条消息上 →
 *     之后每次回复都按机器人发出，群里没机器人就 230002「发不出去」；
 *  2. 飞书没有回声抑制 → 自己发出的消息被轮询/长连接推回来，又存成一条「收到的」；
 *  3. 发送失败时回复直接丢弃 → 界面上的「发送中」气泡永远等不到结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, MsgStatus } from '@unimsg/shared';
import type { UnifiedMessage } from '@unimsg/shared';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from './llm';
import { OcrService } from './ocr';
import { RateLimiter } from './rateLimiter';
import { MessageService } from './message';
import { feishuSample } from '../connectors/samples';

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeSvc(overrides: Partial<Record<Platform, unknown>> = {}) {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo,
    { ...connectors, ...overrides } as typeof connectors,
    new LlmService(),
    new OcrService(),
    new RateLimiter(3, 5),
    () => {},
  );
  return { repo, svc };
}

test('回复成功：这条回复记录自己的身份，且不影响下一次发送', async () => {
  const { repo, svc } = makeSvc({
    [Platform.FEISHU]: {
      ...connectors[Platform.FEISHU],
      send: async () => ({ ok: true as const, mode: 'real' as const, identity: 'user' as const, platformReply: 'om_1' }),
    },
  });
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.reply(message.traceId, '本人发的');
  await waitFor(() => repo.get(message.traceId)!.status === MsgStatus.SYNCED);

  const replies = repo.get(message.traceId)!.replies ?? [];
  assert.equal(replies.length, 1);
  assert.equal(replies[0].identity, 'user', '每条回复要记下自己实际用的身份');
  assert.equal(replies[0].failed, undefined);
});

test('回复失败：仍然写进历史并标记 failed，界面才不会永远停在「发送中」', async () => {
  const { repo, svc } = makeSvc({
    [Platform.FEISHU]: {
      ...connectors[Platform.FEISHU],
      send: async () => {
        throw new Error('飞书拒绝发送：机器人不在这个会话里（code 230002）');
      },
    },
  });
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.reply(message.traceId, '群里发不出去的话');
  await waitFor(() => repo.get(message.traceId)!.status === MsgStatus.FAILED);

  const saved = repo.get(message.traceId)!;
  const replies = saved.replies ?? [];
  assert.equal(replies.length, 1, '失败也要留一条记录');
  assert.equal(replies[0].failed, true);
  assert.equal(replies[0].text, '群里发不出去的话');
  assert.match(replies[0].failureReason ?? '', /230002/);
  assert.equal(saved.reply, '群里发不出去的话', '重试仍要能拿到原文');
});

test('回声抑制：刚发出的消息被平台推回来时不再入库（飞书也走这条）', async () => {
  const { repo, svc } = makeSvc({
    [Platform.FEISHU]: {
      ...connectors[Platform.FEISHU],
      send: async () => ({ ok: true as const, mode: 'real' as const, identity: 'user' as const, platformReply: 'om_echo' }),
    },
  });
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.reply(message.traceId, '自测回声消息');
  await waitFor(() => repo.get(message.traceId)!.status === MsgStatus.SYNCED);
  const before = repo.list().length;

  // 平台把这条推送回来：同会话 + 同正文 + 新 message_id
  const echo: UnifiedMessage = {
    ...feishuSampleMessage(),
    traceId: 'echo-1',
    externalId: 'om_echo_pushback',
    body: '自测回声消息',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const r = await svc.ingestUnified(Platform.FEISHU, echo);
  assert.equal(r.duplicate, true, '回声要按重复处理');
  assert.equal(repo.list().length, before, '不能多出一条「收到的」消息');
});

test('历史回声修复：自己发出去又被推回来的旧记录，启动时归到「我发出的」', async () => {
  const { repo, svc } = makeSvc();
  const base = feishuSampleMessage();
  const sentAt = new Date('2026-11-19T03:00:00.000Z').toISOString();
  const original: UnifiedMessage = {
    ...base, traceId: 'sent-1', externalId: 'compose:1', direction: 'out',
    body: '历史回声内容', createdAt: sentAt, updatedAt: sentAt,
  };
  const echo: UnifiedMessage = {
    ...base, traceId: 'echo-old', externalId: 'om_old_echo', direction: undefined,
    body: '历史回声内容',
    createdAt: new Date('2026-11-19T03:00:20.000Z').toISOString(),
    updatedAt: new Date('2026-11-19T03:00:20.000Z').toISOString(),
  };
  repo.save(original);
  repo.save(echo);

  const fixed = svc.repairEchoDuplicates();
  assert.equal(fixed, 1);
  assert.equal(repo.get('echo-old')!.direction, 'out', '回声记录不能再算成来信');
  assert.equal(repo.get('sent-1')!.direction, 'out', '原始记录不受影响');
});

test('启动清理：历史消息上残留的 sendIdentity 会被抹掉（身份不再写死在消息上）', async () => {
  const { repo, svc } = makeSvc();
  const legacy = { ...feishuSampleMessage(), traceId: 'legacy-1', sendIdentity: 'bot' as const };
  repo.save(legacy);
  assert.equal(svc.cleanupLegacySendIdentity(), 1);
  assert.equal(repo.get('legacy-1')!.sendIdentity, undefined, '残留身份必须清掉');
  assert.equal(svc.cleanupLegacySendIdentity(), 0, '没有残留时是 no-op');
});

/** 一份最小的飞书消息骨架（会话 id 固定，便于保证「同会话」） */
function feishuSampleMessage(): UnifiedMessage {
  const now = new Date().toISOString();
  return {
    traceId: 'base-1',
    platform: Platform.FEISHU,
    externalId: 'om_base',
    sender: { id: 'ou_peer', name: '同事' },
    conversation: { id: 'oc_regression_chat', type: 'p2p' },
    type: 'text',
    body: '原始消息',
    status: MsgStatus.RECEIVED,
    createdAt: now,
    updatedAt: now,
  };
}