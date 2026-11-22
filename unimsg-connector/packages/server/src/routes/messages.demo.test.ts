/**
 * `POST /api/messages/demo` 的 HTTP 契约测试（离线，只走 127.0.0.1 回环）：
 *  - 需要账号会话令牌（Bearer），示例消息归属**发起请求的账号**：
 *    A 注入后 A 的 `GET /api/messages` 有 1 条，B 的列表看不到；
 *  - 成功返回 201 `{ ok:true, data:{ traceId, duplicate } }`；
 *  - 部署令牌（dev-token，无 req.user）在「纯内存账号库」的测试环境里能过 apiAuth，
 *    但路由因为没有用户身份 → 400 中文可操作提示；
 *  - 「本机已建账号」的真实部署里部署令牌通道关闭 → apiAuth 先回 401（用强制登录模式模拟）；
 *  - platform 非法 / 缺失 → 400 中文提示，且不会落任何消息。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from '../services/llm';
import { OcrService } from '../services/ocr';
import { RateLimiter } from '../services/rateLimiter';
import { MessageService } from '../services/message';
import { UserStore } from '../services/users';
import { resetAuthRateLimit, setUserStore } from './auth';
import { resolveApiToken } from '../middlewares/auth';
import { config } from '../config';

const DEV_TOKEN = resolveApiToken(config.apiToken);

async function withApp(fn: (ctx: { base: string; svc: MessageService }) => Promise<void>): Promise<void> {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(base: string, username: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 201, `注册 ${username} 应成功`);
  const body: any = await res.json();
  return body.data.token as string;
}

interface Res {
  status: number;
  contentType: string;
  json: any;
}

async function demo(base: string, platform: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${base}/api/messages/demo`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? auth(token) : {}),
    },
    body: JSON.stringify(platform === undefined ? {} : { platform }),
  });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    json: await res.json(),
  };
}

async function listMessages(base: string, token: string): Promise<any[]> {
  const res = await fetch(`${base}/api/messages`, { headers: auth(token) });
  assert.equal(res.status, 200);
  return (await res.json()).data as any[];
}

beforeEach(() => {
  setUserStore(new UserStore({ persist: false }));
  resetAuthRateLimit();
});

test('A 注入示例（飞书/钉钉/微信）→ 201 且带 traceId/duplicate；消息归属 A，B 看不到', async () => {
  await withApp(async ({ base }) => {
    const tokenA = await register(base, 'demo-a');

    for (const platform of ['feishu', 'dingtalk', 'wechat']) {
      const res = await demo(base, platform, tokenA);
      assert.equal(res.status, 201, `注入 ${platform} 示例应成功`);
      assert.match(res.contentType, /application\/json/);
      assert.equal(res.json.ok, true);
      assert.equal(typeof res.json.data.traceId, 'string', '响应要给出 traceId（前端据此定位消息）');
      assert.ok(res.json.data.traceId.length > 0);
      assert.equal(typeof res.json.data.duplicate, 'boolean', 'duplicate 必须是布尔（是否幂等命中）');
    }

    const listA = await listMessages(base, tokenA);
    assert.equal(listA.length, 3, 'A 注入的 3 条示例都应出现在 A 的收件箱');
    assert.deepEqual(
      listA.map((m) => m.platform).sort(),
      ['dingtalk', 'feishu', 'wechat'],
      '三个平台的示例都按请求里的 platform 入库',
    );

    const tokenB = await register(base, 'demo-b');
    const listB = await listMessages(base, tokenB);
    assert.equal(listB.length, 0, 'B 看不到 A 注入的消息（归属请求者而不是机器主人）');
  });
});

test('部署令牌（无 req.user）调 demo → 400 中文可操作提示，且不落任何消息', async () => {
  await withApp(async ({ base }) => {
    const tokenA = await register(base, 'demo-dev-token');
    // 单测用纯内存账号库（config.usersFile 为空），loginRequired() 为 false，
    // 所以部署令牌能通过 apiAuth、走到路由的「需要先登录」分支 → 400。
    const res = await demo(base, 'feishu', DEV_TOKEN);
    assert.equal(res.status, 400, '没有用户身份时不能把示例消息丢进收件箱');
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /需要先登录/, '要告诉用户先登录，而不是静默失败');
    assert.match(res.json.error, /收件箱/, '要说明登录后消息去了哪里');

    const listA = await listMessages(base, tokenA);
    assert.equal(listA.length, 0, '被拒绝的注入不能落库');
  });
});

test('本机已要求登录（真实部署场景）：部署令牌调 demo 被 apiAuth 拦成 401', async () => {
  const prevMode = config.authRequireLoginMode;
  // 等价于「部署机已经有账号库」：apiAuth 关闭部署令牌通道。
  config.authRequireLoginMode = 'on';
  try {
    await withApp(async ({ base }) => {
      await register(base, 'demo-login-required');
      const res = await demo(base, 'feishu', DEV_TOKEN);
      assert.equal(res.status, 401, '要求登录时部署令牌不再能调业务接口');
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error, 'unauthorized');
    });
  } finally {
    config.authRequireLoginMode = prevMode;
  }
});

test('platform 非法 / 缺失 → 400 中文提示，且不落消息', async () => {
  await withApp(async ({ base }) => {
    const token = await register(base, 'demo-invalid-platform');

    const bad = await demo(base, 'slack', token);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.error, /平台/);
    assert.match(bad.json.error, /飞书|钉钉|微信/, '提示要列出可选平台');

    const missing = await demo(base, undefined, token);
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /平台/);

    const list = await listMessages(base, token);
    assert.equal(list.length, 0, '非法请求不能落任何消息');
  });
});

test('未带任何凭证调 demo → 401（apiAuth 兜底）', async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/messages/demo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'feishu' }),
    });
    assert.equal(res.status, 401);
    const body: any = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unauthorized');
  });
});
