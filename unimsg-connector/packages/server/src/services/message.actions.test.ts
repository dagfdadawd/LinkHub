/**
 * 人工处理动作的回归测试：状态流转（含可选回执）/ 跨平台转发 / 优先级 / 自动回复。
 *
 * 这些动作全部复用既有出站链路，所以断言重点不是「有没有调接口」，
 * 而是**状态机、闭环日志、消息历史三者一致**——评审回放时不能出现断层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, MsgStatus, type AutoRule } from '@unimsg/shared';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { sentBox } from '../connectors/base';
import { LlmService } from './llm';
import { OcrService } from './ocr';
import { RateLimiter } from './rateLimiter';
import { MessageService, type AutoReplyPort } from './message';
import { feishuSample, dingtalkSample } from '../connectors/samples';
import { inferPriority } from './priority';

function makeSvc(extra?: { autoReply?: AutoReplyPort; connectors?: typeof connectors }) {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo,
    extra?.connectors ?? connectors,
    new LlmService(),
    new OcrService(),
    new RateLimiter(3, 5),
    () => {},
    extra?.autoReply,
  );
  return { repo, svc };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('changeStatus：人工流转走前进方向并写 trace', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);

  const result = await svc.changeStatus(message.traceId, { status: MsgStatus.PROCESSING });
  assert.equal(result.message.status, MsgStatus.PROCESSING);
  assert.equal(result.notified, false);
  const events = repo.getLoopLog(message.traceId).map((e) => e.event);
  assert.ok(events.includes('status'), '人工流转必须留痕');
  const detail = repo.getLoopLog(message.traceId).find((e) => e.event === 'status')?.detail ?? '';
  assert.match(detail, /received→processing/);
});

test('changeStatus：状态倒退被拒绝，且不改状态', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.syncStatus(message.traceId, 'synced');
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.SYNCED);

  await assert.rejects(
    () => svc.changeStatus(message.traceId, { status: MsgStatus.PROCESSING }),
    /倒退|不允许/,
  );
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.SYNCED);
});

test('changeStatus：notify=true 时回执真的发出（Mock），且不改状态、不进 replies', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  const before = sentBox[Platform.FEISHU].length;

  const result = await svc.changeStatus(message.traceId, {
    status: MsgStatus.PROCESSING,
    notify: true,
  });
  assert.equal(result.notified, true);
  assert.equal(result.notifyMode, 'mock');
  assert.equal(sentBox[Platform.FEISHU].length, before + 1);

  const m = repo.get(message.traceId)!;
  assert.equal(m.status, MsgStatus.PROCESSING, '回执不应把状态推进到 replied');
  assert.equal(m.replies, undefined, '回执不是对用户的回复，不能进回复历史');
  const events = repo.getLoopLog(message.traceId).map((e) => e.event);
  assert.ok(events.includes('status_notified'));
});

test('changeStatus：回执失败时如实返回原因，状态不回滚', async () => {
  const failing = {
    ...connectors,
    [Platform.FEISHU]: {
      ...connectors[Platform.FEISHU],
      send: async () => {
        throw new Error('飞书网关返回 500：proxy error');
      },
    },
  };
  const { svc, repo } = makeSvc({ connectors: failing });
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);

  const result = await svc.changeStatus(message.traceId, {
    status: MsgStatus.PROCESSING,
    notify: true,
  });
  assert.equal(result.notified, false);
  assert.match(result.notifyReason ?? '', /500/);
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.PROCESSING);
  const events = repo.getLoopLog(message.traceId).map((e) => e.event);
  assert.ok(events.includes('status_notify_failed'));
});

test('forward：跨平台转发创建出站消息，并在源消息留 forwarded 追溯', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);

  const ack = await svc.forward(message.traceId, {
    platform: Platform.DINGTALK,
    note: '请钉钉同事跟进',
  });
  const forwarded = repo.get(ack.message.traceId)!;
  assert.equal(forwarded.platform, Platform.DINGTALK);
  assert.equal(forwarded.direction, 'out');
  assert.match(forwarded.body, /请钉钉同事跟进/);
  assert.match(forwarded.body, /\[转发自 feishu\]/);
  assert.match(forwarded.body, /周五前交周报/);

  const events = repo.getLoopLog(message.traceId).map((e) => e.event);
  assert.ok(events.includes('forwarded'), '源消息必须能追溯到被转发');
});

test('forward：目标平台非法时拒绝', async () => {
  const { svc } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await assert.rejects(
    () => svc.forward(message.traceId, { platform: 'telegram' as Platform }),
    /未知平台/,
  );
});

test('setPriority：人工修改写 old→new，并标记 source=manual', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);

  const result = await svc.setPriority(message.traceId, 'urgent');
  assert.equal(result.old, 'normal');
  assert.equal(result.message.priority, 'urgent');
  assert.equal(result.message.prioritySource, 'manual');

  // 富化可能先写过一条「规则推断」，这里只找人工那一条
  const manual = repo
    .getLoopLog(message.traceId)
    .filter((e) => e.event === 'priority')
    .find((e) => /人工纠正/.test(e.detail ?? ''));
  assert.ok(manual, '必须留下一条人工纠正的闭环事件');
  assert.match(manual.detail ?? '', /urgent/);
});

test('setPriority：人工优先级不会被重新分析覆盖', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.setPriority(message.traceId, 'low');

  await svc.reanalyze(message.traceId);
  const m = repo.get(message.traceId)!;
  assert.equal(m.priority, 'low');
  assert.equal(m.prioritySource, 'manual');
});

test('ingest：规则推断出优先级并标注来源 rules', async () => {
  const { svc, repo } = makeSvc();
  // 「周五前」不含紧急词，样例默认不判定；换成明确紧急的正文
  const { message } = await svc.ingestUnified(Platform.FEISHU, {
    ...connectors[Platform.FEISHU].receive(feishuSample),
    externalId: 'om_urgent_demo',
    body: '今天下班前必须给我',
  });
  await waitFor(() => repo.get(message.traceId)?.intentSource !== undefined);
  const m = repo.get(message.traceId)!;
  assert.equal(m.priority, 'urgent');
  assert.equal(m.prioritySource, 'rules');
});

test('autoReply：命中规则后自动回复一次，并记 hit 与 trace', async () => {
  const hits: string[] = [];
  const rule: AutoRule = {
    id: 'r-1',
    replyText: '在的，请说',
    priority: 100,
    enabled: true,
    hitCount: 0,
    createdAt: new Date().toISOString(),
  };
  const port: AutoReplyPort = {
    match: () => rule,
    recordHit: (id) => {
      hits.push(id);
      return rule;
    },
  };
  const { svc, repo } = makeSvc({ autoReply: port });
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);

  await waitFor(() => repo.get(message.traceId)!.status === MsgStatus.SYNCED);
  const m = repo.get(message.traceId)!;
  assert.equal(m.replies?.length, 1);
  assert.equal(m.replies?.[0].text, '在的，请说');
  assert.deepEqual(hits, ['r-1']);
  const events = repo.getLoopLog(message.traceId).map((e) => e.event);
  assert.ok(events.includes('auto_reply'));
});

test('autoReply：同一条消息重复投递不会回第二次', async () => {
  const rule: AutoRule = {
    id: 'r-1',
    replyText: '在的，请说',
    priority: 100,
    enabled: true,
    hitCount: 0,
    createdAt: new Date().toISOString(),
  };
  const port: AutoReplyPort = { match: () => rule, recordHit: () => rule };
  const { svc, repo } = makeSvc({ autoReply: port });

  await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.ingest(Platform.FEISHU, feishuSample);
  await waitFor(() => repo.list()[0].status === MsgStatus.SYNCED);
  assert.equal(repo.list()[0].replies?.length, 1);
});

test('autoReply：自己发出的消息不触发自动回复', async () => {
  const rule: AutoRule = {
    id: 'r-1',
    replyText: '在的，请说',
    priority: 100,
    enabled: true,
    hitCount: 0,
    createdAt: new Date().toISOString(),
  };
  const port: AutoReplyPort = { match: () => rule, recordHit: () => rule };
  const { svc, repo } = makeSvc({ autoReply: port });

  const base = connectors[Platform.DINGTALK].receive(dingtalkSample);
  await svc.ingestUnified(Platform.DINGTALK, {
    ...base,
    externalId: 'msg_out_demo',
    direction: 'out',
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(repo.list()[0].replies, undefined);
});

test('inferPriority：截止 24h 内 > 紧急词 > 低优先级词 > 未判定', () => {
  const now = new Date('2026-11-22T10:00:00Z');
  assert.equal(
    inferPriority('这份文件看一下', { dueAt: '2026-11-22T12:00:00Z', now })?.priority,
    'urgent',
  );
  assert.equal(inferPriority('今天必须给我', { now })?.priority, 'urgent');
  assert.equal(inferPriority('不急，有空再看', { now })?.priority, 'low');
  assert.equal(inferPriority('周末聚餐照片', { now }), undefined);
});
