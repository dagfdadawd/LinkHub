import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, MsgStatus } from '@unimsg/shared';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService, type LlmResult } from './llm';
import { OcrService } from './ocr';
import { RateLimiter } from './rateLimiter';
import {
  InvalidPlatformEvent, MessageService, checkStatusTransition, isEmptyPlatformEvent,
} from './message';
import { feishuSample, dingtalkSample } from '../connectors/samples';
import { sentBox } from '../connectors/base';

function makeSvc() {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  return { repo, svc };
}
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 可手动放行的 LLM：验证「入库/广播」不等富化完成。
 *  兜底 250ms 自动放行——旧实现若阻塞等待，测试会失败而不是永久挂住。 */
class GatedLlm extends LlmService {
  private release!: () => void;
  private gate: Promise<void>;
  constructor() {
    super({ mode: 'mock' });
    this.gate = new Promise<void>((r) => { this.release = r; });
  }
  async analyze(): Promise<LlmResult> {
    await Promise.race([this.gate, new Promise<void>((r) => setTimeout(r, 250))]);
    return { ok: true, intent: '待办', confidence: 0.9, summary: '摘要', replyDraft: '收到。', source: 'llm' };
  }
  open(): void { this.release(); }
}

test('ingest：同 externalId 重推幂等，不重复入库', async () => {
  const { svc, repo } = makeSvc();
  const a = await svc.ingest(Platform.FEISHU, feishuSample);
  const b = await svc.ingest(Platform.FEISHU, feishuSample);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(repo.list().length, 1);
  assert.equal(a.message.traceId, b.message.traceId);
});

test('reply：走完状态机并真实回写（Mock）', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  const before = sentBox[Platform.FEISHU].length;
  const ack = await svc.reply(message.traceId, '收到，周五前交周报');
  assert.equal(ack.message.status, MsgStatus.REPLIED);
  await wait();
  const m = repo.get(message.traceId)!;
  assert.equal(m.status, MsgStatus.SYNCED);
  assert.equal(sentBox[Platform.FEISHU].length, before + 1);
  const events = repo.getLoopLog(message.traceId).map((e) => e.event);
  for (const ev of ['received', 'processing', 'replied', 'sent', 'synced']) {
    assert.ok(events.includes(ev), `missing trace: ${ev}`);
  }
});

test('用户身份自环：平台把刚发出的消息推回来时不入库', async () => {
  const repo = new InMemoryRepository();
  const echoConnectors = {
    ...connectors,
    [Platform.FEISHU]: { ...connectors[Platform.FEISHU], isSelfEcho: () => true },
  };
  const svc = new MessageService(
    repo, echoConnectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );

  const r = await svc.onPlatformEvent(Platform.FEISHU, feishuSample);
  assert.equal(r.applied, false);
  assert.equal(repo.list().length, 0, '自环事件不应占用收件箱或幂等键');
});

test('sent trace 标注真实发送身份', async () => {
  const repo = new InMemoryRepository();
  const userConnectors = {
    ...connectors,
    [Platform.FEISHU]: {
      ...connectors[Platform.FEISHU],
      send: async () => ({
        ok: true as const,
        mode: 'real' as const,
        identity: 'user' as const,
        platformReply: 'om_user_trace',
      }),
    },
  };
  const svc = new MessageService(
    repo, userConnectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );

  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.reply(message.traceId, '收到');
  await waitFor(() => repo.get(message.traceId)!.status === MsgStatus.SYNCED);
  const sent = repo.getLoopLog(message.traceId).find((e) => e.event === 'sent');
  assert.match(sent?.detail ?? '', /用户身份/);
});

test('syncStatus：平台回流更新本地状态', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.DINGTALK, dingtalkSample);
  await svc.syncStatus(message.traceId, 'synced');
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.SYNCED);
});

test('markDone：待办标记完成', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  await svc.markDone(message.traceId);
  assert.equal(repo.get(message.traceId)!.done, true);
});

// ---------------------------------------------------------------------------
// P0：空/畸形事件守卫（不能写 trace、不能占幂等键）
// ---------------------------------------------------------------------------

test('ingest：空对象事件抛 InvalidPlatformEvent，不写消息也不占 unknown 幂等键', async () => {
  const { svc, repo } = makeSvc();
  await assert.rejects(
    () => svc.ingest(Platform.FEISHU, {}),
    (e: unknown) => e instanceof InvalidPlatformEvent
      && e.platform === Platform.FEISHU
      && /空/.test(e.reason),
  );
  assert.equal(repo.list().length, 0, '空事件不得入库');
  assert.equal(repo.findByExternal(Platform.FEISHU, 'unknown'), undefined, 'unknown 去重键必须保持空闲');
});

test('ingest：解析后缺 externalId（三平台均兜底 unknown）→ 400 类错误，后续真实消息仍能入库', async () => {
  const { svc, repo } = makeSvc();
  const feishuNoId = {
    schema: '2.0',
    event: { message: { message_type: 'text', content: JSON.stringify({ text: '没有消息 ID' }) } },
  };
  await assert.rejects(() => svc.ingest(Platform.FEISHU, feishuNoId), /externalId/);
  await assert.rejects(() => svc.ingest(Platform.DINGTALK, { msgtype: 'text', text: { content: '没有消息 ID' } }), /externalId/);
  await assert.rejects(() => svc.ingest(Platform.WECOM, { MsgType: 'text', Content: '没有消息 ID' }), /externalId/);
  assert.equal(repo.list().length, 0, '畸形事件不得写入任何记录');

  const ok = await svc.ingest(Platform.FEISHU, feishuSample);
  assert.equal(ok.duplicate, false);
  assert.equal(repo.list().length, 1, '同平台后续真实消息不受污染');
});

test('ingest：空白字符串 / 空数组同样按无效事件拒绝', async () => {
  const { svc, repo } = makeSvc();
  await assert.rejects(() => svc.ingest(Platform.FEISHU, '   '), InvalidPlatformEvent);
  await assert.rejects(() => svc.ingest(Platform.FEISHU, []), InvalidPlatformEvent);
  assert.equal(repo.list().length, 0);
  assert.equal(isEmptyPlatformEvent({}), true);
  assert.equal(isEmptyPlatformEvent({ xml: '' }), true, '空 XML 壳解析出的 {xml:""} 也视为空事件');
  assert.equal(isEmptyPlatformEvent({ MsgId: 'x' }), false);
});

test('ingest：邮箱轮询事件（source=imap）不受空事件守卫影响', async () => {
  const { svc, repo } = makeSvc();
  const raw = {
    source: 'imap',
    account: 'qq',
    folder: 'INBOX',
    uid: 42,
    messageId: '<m42@qq.com>',
    inReplyTo: '',
    subject: '周报',
    date: new Date().toISOString(),
    from: { name: '小王', address: 'wang@qq.com' },
    to: 'me@qq.com',
    text: '周五前交周报',
  };
  const r = await svc.ingest(Platform.MAIL, raw);
  assert.equal(r.duplicate, false);
  assert.equal(r.message.externalId, 'qq:INBOX:42');
  assert.equal(repo.list({ platform: Platform.MAIL }).length, 1);
});

// ---------------------------------------------------------------------------
// P1：状态回流防倒退
// ---------------------------------------------------------------------------

test('syncStatus：received→synced 正常前进', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.DINGTALK, dingtalkSample);
  const r = await svc.syncStatus(message.traceId, 'synced');
  assert.equal(r.applied, true);
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.SYNCED);
});

test('syncStatus：synced 收到 received 被忽略，写 sync_ignored 且保持原状态', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.DINGTALK, dingtalkSample);
  await svc.syncStatus(message.traceId, 'synced');

  const r = await svc.syncStatus(message.traceId, 'received');
  assert.equal(r.applied, false);
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.SYNCED, '已同步的消息不得被打回 received');
  const ignored = repo.getLoopLog(message.traceId).filter((e) => e.event === 'sync_ignored');
  assert.equal(ignored.length, 1);
  assert.match(ignored[0].detail ?? '', /倒退/);
});

test('syncStatus：failed→sent 允许（失败后重试前进）', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.DINGTALK, dingtalkSample);
  repo.update(message.traceId, { status: MsgStatus.FAILED });

  const r = await svc.syncStatus(message.traceId, 'sent');
  assert.equal(r.applied, true);
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.SENT);
});

test('syncStatus：同状态重复回流忽略，不重复改写', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.DINGTALK, dingtalkSample);
  repo.update(message.traceId, { status: MsgStatus.PROCESSING });

  const r = await svc.syncStatus(message.traceId, 'processing');
  assert.equal(r.applied, false);
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.PROCESSING);
});

test('syncStatus：未知平台状态沿用 synced 兜底（不算畸形事件）', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.DINGTALK, dingtalkSample);
  const r = await svc.syncStatus(message.traceId, 'delivered');
  assert.equal(r.applied, true);
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.SYNCED);
});

test('checkStatusTransition：状态序矩阵（前进/倒退/failed 重试）', () => {
  assert.equal(checkStatusTransition(MsgStatus.RECEIVED, MsgStatus.SYNCED).allowed, true);
  assert.equal(checkStatusTransition(MsgStatus.PROCESSING, MsgStatus.RECEIVED).allowed, false);
  assert.equal(checkStatusTransition(MsgStatus.SYNCED, MsgStatus.RECEIVED).allowed, false);
  assert.equal(checkStatusTransition(MsgStatus.SYNCED, MsgStatus.SYNCED).allowed, false);
  assert.equal(checkStatusTransition(MsgStatus.FAILED, MsgStatus.SENT).allowed, true);
  assert.equal(checkStatusTransition(MsgStatus.FAILED, MsgStatus.PROCESSING).allowed, true, '失败后允许重试回前序');
  assert.equal(checkStatusTransition(MsgStatus.SENT, MsgStatus.FAILED).allowed, false, '正常状态不能被回流打成 failed');
});

test('onPlatformEvent：状态回流事件按 externalId 命中，且不会新入库消息', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  const r = await svc.onPlatformEvent(Platform.FEISHU, {
    event: 'status', externalId: 'om_demo_001', status: 'processing',
  });
  assert.equal(r.applied, true);
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.PROCESSING);
  assert.equal(repo.list().length, 1, 'status 事件不能被当成新消息再入库');
});

// ---------- 富化不阻塞入库（真实 LLM 平均 5s+，不能卡住 Webhook 与收件箱） ----------

test('ingest：先广播 received 立即返回，富化在后台完成后补广播 updated', async () => {
  const repo = new InMemoryRepository();
  const llm = new GatedLlm();
  const events: Array<{ type: string; data?: unknown }> = [];
  const svc = new MessageService(
    repo, connectors, llm, new OcrService(), new RateLimiter(3, 5), (e) => events.push(e),
  );

  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);

  assert.equal(events.filter((e) => e.type === 'message.received').length, 1, '入库后应立即广播');
  assert.equal(events.some((e) => e.type === 'message.updated'), false, 'LLM 未返回前不应有 updated');
  assert.equal(repo.get(message.traceId)!.intent, undefined, 'ingest 不应等待意图识别');

  llm.open();
  await waitFor(() => repo.get(message.traceId)!.intent === '待办');
  assert.ok(events.some((e) => e.type === 'message.updated'), '富化完成后应广播 updated');
  assert.equal(repo.get(message.traceId)!.intentSource, 'llm', '真实模型结果要如实标注来源');
});

test('ingest：富化抛异常时不崩溃、不回滚入库，并写 enrich_failed 日志', async () => {
  class BoomLlm extends LlmService {
    constructor() { super({ mode: 'mock' }); }
    async analyze(): Promise<LlmResult> { throw new Error('boom'); }
  }
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new BoomLlm(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);

  await waitFor(() => repo.getLoopLog(message.traceId).some((e) => e.event === 'enrich_failed'));
  assert.equal(repo.get(message.traceId)!.status, MsgStatus.RECEIVED, '消息照常保留');
  assert.equal(repo.list().length, 1);
});
