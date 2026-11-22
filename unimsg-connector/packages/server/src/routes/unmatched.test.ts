/**
 * 未匹配 `/api` 路径的 404 契约测试（回归问题①）：
 *
 * 以前机器主人守卫（ownerOnly）挂在 `app.use('/api')` 这一层，任意未匹配的
 * POST / PUT / DELETE 都会先撞上守卫，普通成员收到「只有主人账号能改…」的 403，
 * 把「接口不存在」伪装成「你没权限」。现在守卫只挂在具体路由上，
 * 未匹配的 `/api` 写路径必须统一回 **404 JSON** `{ ok:false, error:… }`。
 *
 * 覆盖：普通成员令牌 / 机器主人令牌 / 部署令牌 × POST、PUT、PATCH、DELETE；
 * 另外确认未知 GET 也走同一份 JSON 404（不是 Express 默认 HTML 报错页）。
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
const UNMATCHED = '/api/no-such-endpoint';

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

async function register(base: string, username: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 201, `注册 ${username} 应成功`);
  return ((await res.json()) as any).data.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Res {
  status: number;
  contentType: string;
  json: any;
}

async function call(base: string, method: string, path: string, token: string): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...auth(token),
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify({}) }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', json };
}

beforeEach(() => {
  setUserStore(new UserStore({ persist: false }));
  resetAuthRateLimit();
});

/** 注册两个账号：第一个是机器主人，第二个是普通成员 */
async function withOwnerAndMember(base: string): Promise<{ owner: string; member: string }> {
  const owner = await register(base, 'unmatched-owner');
  const member = await register(base, 'unmatched-member');
  return { owner, member };
}

function assertNotFoundJson(res: Res, label: string): void {
  assert.equal(res.status, 404, label);
  assert.match(res.contentType, /application\/json/, `${label}：404 必须是 JSON 而不是 HTML 报错页`);
  assert.equal(res.json.ok, false);
  assert.equal(typeof res.json.error, 'string');
  assert.ok(res.json.error.length > 0, `${label}：要给出可读原因`);
  assert.doesNotMatch(
    res.json.error,
    /主人|只有.*能改/,
    `${label}：不能把「接口不存在」伪装成「只有主人能改」的权限错误`,
  );
  assert.match(res.json.error, /不存在|没有/, `${label}：提示应说明功能/接口不存在`);
}

test('普通成员写未匹配路径 → 404 JSON（不再被误判成 403「只有主人…」）', async () => {
  await withApp(async (base) => {
    const { member } = await withOwnerAndMember(base);
    const res = await call(base, 'POST', UNMATCHED, member);
    assertNotFoundJson(res, '普通成员 POST 未匹配路径');
  });
});

test('普通成员的 PUT / PATCH / DELETE 未匹配路径同样 404 JSON', async () => {
  await withApp(async (base) => {
    const { member } = await withOwnerAndMember(base);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await call(base, method, UNMATCHED, member);
      assertNotFoundJson(res, `普通成员 ${method} 未匹配路径`);
    }
  });
});

test('机器主人写未匹配路径也是 404（不是 403，也不是 200）', async () => {
  await withApp(async (base) => {
    const { owner } = await withOwnerAndMember(base);
    const res = await call(base, 'POST', UNMATCHED, owner);
    assertNotFoundJson(res, '机器主人 POST 未匹配路径');
  });
});

test('部署令牌写未匹配路径 → 404 JSON', async () => {
  await withApp(async (base) => {
    const res = await call(base, 'POST', UNMATCHED, DEV_TOKEN);
    assertNotFoundJson(res, '部署令牌 POST 未匹配路径');
  });
});

test('未带凭证写未匹配路径 → 401（先鉴权，不会泄露「接口是否存在」）', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}${UNMATCHED}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as any).error, 'unauthorized');
  });
});

test('未知 GET /api 路径也回统一 JSON 404（不是 Express 默认 HTML 报错页）', async () => {
  await withApp(async (base) => {
    const { member } = await withOwnerAndMember(base);
    const res = await call(base, 'GET', '/api/no-such-page', member);
    assert.equal(res.status, 404);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /不存在|没有/);
  });
});

test('已挂载路由的未知子路径也回 JSON 404（不会误命中原路由）', async () => {
  await withApp(async (base) => {
    const { member } = await withOwnerAndMember(base);
    const res = await call(base, 'POST', '/api/messages/no-such-write', member);
    assertNotFoundJson(res, 'POST /api/messages/no-such-write');
  });
});
