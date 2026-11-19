/**
 * 数据隔离的 HTTP 契约测试：
 *  - 登录用户只看到归属自己的消息；
 *  - 认领把「无主」消息收进当前账号，且不会抢别人的；
 *  - 部署令牌（无人登录）仍能看到全部（单机演示零改动）。
 */
import { test, beforeEach } from 'node:test';
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
import { MessageService, type Broadcast } from '../services/message';
import { dingtalkSample, feishuSample, wecomSample } from '../connectors/samples';
import { UserStore } from '../services/users';
import { resetAuthRateLimit, setUserStore } from './auth';
import { resolveApiToken } from '../middlewares/auth';
import { config } from '../config';

const DEV_TOKEN = resolveApiToken(config.apiToken);

async function withApp(fn: (ctx: { base: string; svc: MessageService }) => Promise<void>): Promise<void> {
  const repo = new InMemoryRepository();
  const broadcast: Broadcast = () => {};
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), broadcast,
  );
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ base, svc });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function register(base: string, username: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, json({ username, password: 'secret123' }));
  const body: any = await res.json();
  return body.data.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 等到条件成立（发送是异步投递的，回复历史/状态要靠 push 推进） */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('等待状态超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  setUserStore(new UserStore({ persist: false }));
  resetAuthRateLimit();
});

test('首个账号自动接管无主历史消息；其余账号只看到自己的；部署令牌仍看到全部', async () => {
  await withApp(async ({ base, svc }) => {
    // 两条「无主」消息（模拟历史数据 / 平台推送）
    await svc.ingest(Platform.FEISHU, feishuSample);
    await svc.ingest(Platform.DINGTALK, dingtalkSample);

    const tokenA = await register(base, 'isolation-a');

    const asDeploy = await (await fetch(`${base}/api/messages`, { headers: auth(DEV_TOKEN) })).json();
    assert.equal(asDeploy.data.length, 2, '部署令牌能看到全部（演示模式）');

    const asA = await (await fetch(`${base}/api/messages`, { headers: auth(tokenA) })).json();
    assert.equal(asA.data.length, 2, '首个账号注册时自动接管无主历史消息（否则新用户看到空收件箱）');

    // 再认领：已经没有无主消息了
    const claim = await fetch(`${base}/api/messages/claim`, { method: 'POST', headers: auth(tokenA) });
    const claimBody: any = await claim.json();
    assert.equal(claimBody.data.claimed, 0);

    const tokenB = await register(base, 'isolation-b');
    const bAfter = await (await fetch(`${base}/api/messages`, { headers: auth(tokenB) })).json();
    assert.equal(bAfter.data.length, 0, 'B 看不到 A 名下的消息');

    // B 再认领：无主消息已没了，不会抢
    const claimB = await fetch(`${base}/api/messages/claim`, { method: 'POST', headers: auth(tokenB) });
    const claimBBody: any = await claimB.json();
    assert.equal(claimBBody.data.claimed, 0);
  });
});

test('未登录（部署令牌）调认领接口被拒绝，并给出可操作提示', async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/messages/claim`, { method: 'POST', headers: auth(DEV_TOKEN) });
    assert.equal(res.status, 400);
    const body: any = await res.json();
    assert.match(body.error, /需要先登录/);
  });
});

test('主动发送带着会话名：收件箱里不会多出一个「没有名字」的会话', async () => {
  await withApp(async ({ base }) => {
    const token = await register(base, 'title-user');
    const res = await fetch(`${base}/api/messages/compose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(token) },
      body: JSON.stringify({
        platform: Platform.MAIL,
        conversationId: 'friend@example.com',
        conversationType: 'p2p',
        conversationTitle: '老王',
        text: '带名字发送',
      }),
    });
    assert.equal(res.status, 202);
    const list = await (await fetch(`${base}/api/messages`, { headers: auth(token) })).json();
    assert.equal(list.data[0].conversation.title, '老王');
  });
});

test('同一会话连发两条回复：每次回复都进 replies 历史，不会互相覆盖', async () => {
  await withApp(async ({ base, svc }) => {
    const { message } = await svc.ingest(Platform.WECOM, wecomSample);
    const token = await register(base, 'reply-history');
    // 直接 ingest 的消息是无主的，登录用户看不到 → 先认领（生产里启动时已由机器主人认领）
    await fetch(`${base}/api/messages/claim`, { method: 'POST', headers: auth(token) });

    const sendReply = (text: string) => fetch(`${base}/api/messages/${message.traceId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(token) },
      body: JSON.stringify({ text }),
    });

    assert.equal((await sendReply('第一条')).status, 202);
    // 回复是异步投递的：真的发出去之后才追加历史（不会出现"假已发出"的气泡）
    await waitFor(async () => (svc.get(message.traceId)?.replies?.length ?? 0) >= 1);
    assert.equal((await sendReply('第二条')).status, 202);
    await waitFor(async () => (svc.get(message.traceId)?.replies?.length ?? 0) >= 2);

    const detail = await (await fetch(`${base}/api/messages/${message.traceId}`, { headers: auth(token) })).json();
    assert.equal(detail.data.reply, '第二条', 'reply 只保留最新一条（兼容旧逻辑）');
    assert.deepEqual(
      detail.data.replies.map((r: any) => r.text),
      ['第一条', '第二条'],
      '两次回复都要留在历史里',
    );
  });
});

test('登录用户主动发送后，消息归属自己（隔离视图里可见）', async () => {
  await withApp(async ({ base }) => {
    const token = await register(base, 'owner-send');
    const res = await fetch(`${base}/api/messages/compose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(token) },
      body: JSON.stringify({
        platform: Platform.MAIL,
        conversationId: 'someone@example.com',
        conversationType: 'p2p',
        text: '隔离验证：这条属于我',
      }),
    });
    assert.equal(res.status, 202);

    const list = await (await fetch(`${base}/api/messages`, { headers: auth(token) })).json();
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].text ?? list.data[0].body, '隔离验证：这条属于我');
  });
});

/** 造一条「属于 alice」的消息，返回 { aliceToken, bobToken, traceId } */
async function twoUsersOneMessage(base: string) {
  const aliceToken = await register(base, 'alice');
  const res = await fetch(`${base}/api/messages/compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(aliceToken) },
    body: JSON.stringify({
      platform: Platform.FEISHU,
      conversationId: 'oc_alice_private',
      text: 'Alice 的私密消息',
    }),
  });
  assert.equal(res.status, 202);
  const { taskId } = (await res.json()) as { taskId: string };
  const bobToken = await register(base, 'bob');
  return { aliceToken, bobToken, traceId: taskId };
}

test('别人的消息：按 id 读、改状态、一键已读、看回放，全部 404/无效（不能靠 id 越权）', async () => {
  await withApp(async ({ base }) => {
    const { bobToken, traceId } = await twoUsersOneMessage(base);

    // ① 详情
    const detail = await fetch(`${base}/api/messages/${traceId}`, { headers: auth(bobToken) });
    assert.equal(detail.status, 404, '别的账号不能按 traceId 读到消息正文');

    // ② 改状态
    for (const path of ['done', 'todo', 'read', 'unread']) {
      const r = await fetch(`${base}/api/messages/${traceId}/${path}`, { method: 'POST', headers: auth(bobToken) });
      assert.equal(r.status, 404, `${path} 必须拒绝别人的消息`);
    }

    // ③ 一键已读：传别人的 id 也不能动
    const readAll = await (await fetch(`${base}/api/messages/read-all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(bobToken) },
      body: JSON.stringify({ ids: [traceId] }),
    })).json();
    assert.equal(readAll.changed, 0, 'read-all 传入别人的 id 不能生效');

    // ④ 全链路回放
    const trace = await (await fetch(`${base}/api/messages/trace/${traceId}`, { headers: auth(bobToken) })).json();
    assert.equal(trace.data.length, 0);
    assert.equal(trace.log.length, 0);
  });
});

test('B 回复 A 的消息会被拒绝，且不会把消息从 A 名下"搬走"', async () => {
  await withApp(async ({ base }) => {
    const { aliceToken, bobToken, traceId } = await twoUsersOneMessage(base);

    const before = await (await fetch(`${base}/api/messages`, { headers: auth(aliceToken) })).json();
    assert.equal(before.data.length, 1);

    const reply = await fetch(`${base}/api/messages/${traceId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(bobToken) },
      body: JSON.stringify({ text: 'bob 偷偷回复' }),
    });
    assert.equal(reply.status, 404, '不能回复别人的消息');

    const aliceAfter = await (await fetch(`${base}/api/messages`, { headers: auth(aliceToken) })).json();
    const bobAfter = await (await fetch(`${base}/api/messages`, { headers: auth(bobToken) })).json();
    assert.equal(aliceAfter.data.length, 1, '消息仍属于 alice');
    assert.equal(bobAfter.data.length, 0, '不能被 bob 抢走');
  });
});

test('未登录（部署令牌）仍能读全部：单机演示不被隔离逻辑挡住', async () => {
  await withApp(async ({ base }) => {
    const { traceId } = await twoUsersOneMessage(base);
    const detail = await fetch(`${base}/api/messages/${traceId}`, { headers: auth(DEV_TOKEN) });
    assert.equal(detail.status, 200);
  });
});