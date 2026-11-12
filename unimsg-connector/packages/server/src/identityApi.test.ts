/**
 * 身份能力 HTTP 集成测试（回环 127.0.0.1，fake-dws，不联网、不真实登录/发送）：
 *  - /api/health 的 modes + identities 摘要；
 *  - /api/accounts 的 identity 字段（飞书 / 钉钉）；
 *  - 钉钉本人身份 login/status/logout 路由；
 *  - reply / compose 的身份校验（400 中文）与 delivery.identity 写入。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MsgStatus, Platform, type UnifiedMessage } from '@unimsg/shared';
import { createApp } from './app';
import { config } from './config';
import { resolveApiToken } from './middlewares/auth';
import { InMemoryRepository } from './db/repository';
import { connectors } from './connectors/registry';
import { LlmService } from './services/llm';
import { OcrService } from './services/ocr';
import { RateLimiter } from './services/rateLimiter';
import { MessageService } from './services/message';
import {
  dingtalkPersonalClient,
  resetDingtalkPersonalClientCache,
} from './connectors/dingtalkPersonal';
import { resetIdentityCaches } from './services/identity';

const FAKE_DWS = fileURLToPath(new URL('../../../scripts/fake-dws.mjs', import.meta.url));
const dirs: string[] = [];
const original = {
  dingtalk: { ...config.identity.dingtalk },
  runtime: Object.fromEntries(Object.values(Platform).map((p) => [p, { ...config.runtime[p] }])) as Record<string, any>,
  env: {
    state: process.env.FAKE_DWS_STATE_FILE,
    sent: process.env.FAKE_DWS_SENT_LOG,
    auth: process.env.FAKE_DWS_AUTHENTICATED,
    interval: process.env.FAKE_DWS_EVENT_INTERVAL_MS,
  },
};
const token = resolveApiToken(config.apiToken);

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-identity-api-'));
  dirs.push(dir);
  return dir;
}

interface Res {
  status: number;
  json: any;
}

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function setRuntime(platform: Platform, patch: Record<string, unknown>): void {
  Object.assign(config.runtime[platform], patch);
}

function setupRealPersonalOnly(): void {
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  process.env.FAKE_DWS_SENT_LOG = join(dir, 'sent.ndjson');
  process.env.FAKE_DWS_EVENT_INTERVAL_MS = '100000';
  delete process.env.FAKE_DWS_AUTHENTICATED;
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.policy = 'auto';
  // 真实模式 + 无机器人凭据：只有本人身份可用
  setRuntime(Platform.DINGTALK, {
    mode: 'real',
    policy: 'real',
    configured: false,
    canSend: false,
    canReceive: false,
    missing: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'],
  });
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
}

function personalMessage(id = 'dingtalk:om-api-1'): UnifiedMessage {
  const now = new Date().toISOString();
  return {
    traceId: `trace-${id}`,
    platform: Platform.DINGTALK,
    externalId: id,
    sender: { id: 'od_peer', name: '张三' },
    conversation: { id: 'cid-api', type: 'p2p' },
    type: 'text',
    body: '明天 18:00 前确认演示环境',
    receivedAs: 'user',
    status: MsgStatus.RECEIVED,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  config.identity.dingtalk = { ...original.dingtalk };
  for (const [platform, snapshot] of Object.entries(original.runtime)) Object.assign(config.runtime[platform as Platform], snapshot);
  for (const [k, v] of Object.entries({
    FAKE_DWS_STATE_FILE: original.env.state,
    FAKE_DWS_SENT_LOG: original.env.sent,
    FAKE_DWS_AUTHENTICATED: original.env.auth,
    FAKE_DWS_EVENT_INTERVAL_MS: original.env.interval,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
});

after(() => {
  config.identity.dingtalk = { ...original.dingtalk };
  for (const [platform, snapshot] of Object.entries(original.runtime)) Object.assign(config.runtime[platform as Platform], snapshot);
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('GET /api/health：modes 语义不变，identities 摘要随身份可用', async () => {
  setupRealPersonalOnly();
  await dingtalkPersonalClient().authStatus({ force: true });
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/health`);
    const json = await res.json() as any;
    assert.equal(res.status, 200);
    assert.equal(json.modes.dingtalk, 'real', 'modes 仍描述机器人/既有通道');
    assert.deepEqual(json.identities.dingtalk, { send: 'user', receive: 'user' });
    // P1-5：前端用 startedAt 与 envFile.mtime 对比提示「.env 已修改需重启」；绝不下发内容
    assert.match(json.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    if (json.envFile) {
      assert.ok(json.envFile.path.endsWith('.env'));
      assert.ok(json.envFile.mtime);
      assert.equal(json.envFile.content, undefined, '不得下发 .env 内容');
    } else {
      assert.equal(json.envFile, null);
    }
    assert.equal(json.identities.feishu.send, 'mock');
    assert.ok(!JSON.stringify(json).includes('secret'));
  });
});

test('GET /api/accounts：飞书/钉钉下发 identity，企业微信/邮箱不适用', async () => {
  setupRealPersonalOnly();
  await dingtalkPersonalClient().authStatus({ force: true });
  await withApp(async (base) => {
    const res = await call(base, 'GET', '/api/accounts');
    assert.equal(res.status, 200);
    const accounts = res.json.data as any[];
    const dingtalk = accounts.find((a) => a.platform === 'dingtalk')!;
    assert.ok(dingtalk.identity);
    assert.equal(dingtalk.identity.effectiveSend, 'user');
    assert.equal(dingtalk.identity.effectiveReceive, 'user');
    assert.equal(dingtalk.identity.user.linked, true);
    assert.equal(dingtalk.identity.user.linkMethod, 'cli');
    assert.match(dingtalk.identity.user.loginCommand ?? '', /scripts[\\/]fake-dws\.mjs auth login$/);
    assert.match(dingtalk.identity.sendHint, /本人身份发送/);
    const wecom = accounts.find((a) => a.platform === 'wecom')!;
    assert.equal(wecom.identity, undefined);
    const mail = accounts.find((a) => a.platform === 'mail')!;
    assert.equal(mail.identity, undefined);
  });
});

test('钉钉本人身份路由：status / login / logout 全链路（fake-dws）', async () => {
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  delete process.env.FAKE_DWS_AUTHENTICATED;
  process.env.FAKE_DWS_LOGIN_DELAY_MS = '0';
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.policy = 'auto';
  setRuntime(Platform.DINGTALK, { mode: 'real', policy: 'real', canSend: true, canReceive: true });
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();

  // 先手动把 fake-dws 置为未登录
  const client = dingtalkPersonalClient();
  await client.logout();

  await withApp(async (base) => {
    const statusBefore = await call(base, 'GET', '/api/dingtalk/personal/status');
    assert.equal(statusBefore.status, 200);
    assert.equal(statusBefore.json.data.available, true);
    assert.equal(statusBefore.json.data.authenticated, false);
    assert.equal(statusBefore.json.data.state, 'not_linked');
    assert.ok(statusBefore.json.data.hint);

    const login = await call(base, 'POST', '/api/dingtalk/personal/login');
    assert.equal(login.status, 200);
    assert.equal(login.json.data.started, true);
    assert.ok(['device', 'browser'].includes(login.json.data.mode));
    assert.ok(login.json.data.instructions);
    assert.ok(!/token/i.test(JSON.stringify(login.json.data)), '不得下发令牌');

    // fake-dws 登录延迟 0 → 立即变为已登录
    const statusAfter = await call(base, 'GET', '/api/dingtalk/personal/status');
    assert.equal(statusAfter.json.data.authenticated, true);
    assert.equal(statusAfter.json.data.state, 'linked');

    const logout = await call(base, 'POST', '/api/dingtalk/personal/logout');
    assert.equal(logout.status, 200);
    assert.equal(logout.json.data.authenticated, false);
    const statusFinal = await call(base, 'GET', '/api/dingtalk/personal/status');
    assert.equal(statusFinal.json.data.authenticated, false);
  });
});

test('钉钉本人身份路由：dws 不存在 → 400 中文安装指引（不假装成功）', async () => {
  config.identity.dingtalk.bin = 'dws-definitely-not-installed-xyz';
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  await withApp(async (base) => {
    const status = await call(base, 'GET', '/api/dingtalk/personal/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.data.available, false);
    assert.match(status.json.data.installHint, /dws|钉钉官方 CLI/);
    const login = await call(base, 'POST', '/api/dingtalk/personal/login');
    assert.equal(login.status, 400);
    assert.match(login.json.error, /未找到 dws|安装/);
  });
});

test('reply 指定 identity=user：走 fake-dws 发送，delivery.identity=user，trace 文案无尾逗号', async () => {
  setupRealPersonalOnly();
  await dingtalkPersonalClient().authStatus({ force: true });
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const cover = await svc.ingestUnified(Platform.DINGTALK, personalMessage());
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const reply = await call(base, 'POST', `/api/messages/${cover.message.traceId}/reply`, {
      text: '收到，我来确认',
      identity: 'user',
    });
    assert.equal(reply.status, 202);
    await waitFor(() => repo.get(cover.message.traceId)!.status === MsgStatus.SYNCED);
    const saved = repo.get(cover.message.traceId)!;
    assert.equal(saved.sendIdentity, 'user');
    assert.equal(saved.delivery?.mode, 'real');
    assert.equal(saved.delivery?.identity, 'user');
    assert.match(saved.delivery?.platformReply ?? '', /fake-open-task-/);
    const log = repo.getLoopLog(cover.message.traceId);
    const processing = log.find((e) => e.event === 'processing');
    assert.match(processing?.detail ?? '', /指定发送身份=本人/);
    assert.ok(!(processing?.detail ?? '').endsWith('，'), 'trace 文案不得有尾逗号');
    assert.match(log.find((e) => e.event === 'sent')?.detail ?? '', /真实接口（用户身份）/);
    // 发送记录确实到了 dws（fake 本地日志）
    const sentLog = readFileSync(process.env.FAKE_DWS_SENT_LOG!, 'utf8');
    assert.match(sentLog, /收到，我来确认/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('reply / compose 身份校验：非法值 400、不可用 400 中文', async () => {
  setupRealPersonalOnly();
  await dingtalkPersonalClient().authStatus({ force: true });
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const cover = await svc.ingestUnified(Platform.DINGTALK, personalMessage('dingtalk:om-api-2'));
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const bad = await call(base, 'POST', `/api/messages/${cover.message.traceId}/reply`, { text: 'x', identity: 'robot' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /identity 只能是 bot/);

    const composeUser = await call(base, 'POST', '/api/messages/compose', {
      platform: 'dingtalk',
      conversationId: 'cid-api',
      text: '统一入口以本人身份发送',
      identity: 'user',
    });
    assert.equal(composeUser.status, 202);
    await waitFor(() => repo.get(composeUser.json.taskId)!.status === MsgStatus.SYNCED);
    assert.equal(repo.get(composeUser.json.taskId)!.delivery?.identity, 'user');

    // 机器人凭据不可用 → 指定 identity=bot 必须 400 中文，绝不假成功
    const composeBot = await call(base, 'POST', '/api/messages/compose', {
      platform: 'dingtalk',
      conversationId: 'cid-api',
      text: 'x',
      identity: 'bot',
    });
    assert.equal(composeBot.status, 400);
    assert.match(composeBot.json.error, /机器人通道当前不可用/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('reply identity=user 但 dws 未登录 → 400 中文（不产生假成功）', async () => {
  setupRealPersonalOnly();
  process.env.FAKE_DWS_AUTHENTICATED = 'false';
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  await dingtalkPersonalClient().authStatus({ force: true });
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const cover = await svc.ingestUnified(Platform.DINGTALK, personalMessage('dingtalk:om-api-3'));
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const reply = await call(base, 'POST', `/api/messages/${cover.message.traceId}/reply`, { text: 'x', identity: 'user' });
    assert.equal(reply.status, 400);
    assert.match(reply.json.error, /钉钉本人身份未连接/);
    assert.equal(repo.get(cover.message.traceId)!.status, MsgStatus.RECEIVED, '校验失败不得推进状态机');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});