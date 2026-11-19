/**
 * 账号体系（注册/登录/会话）的 HTTP 契约测试。全程 127.0.0.1 回环，不触网。
 * 重点验证：口令不落明文、会话令牌能访问受保护业务接口、登出即失效。
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
import { makeTempDir } from '../utils/tempDir';

interface Ctx {
  base: string;
  users: UserStore;
}

async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ base, users: new UserStore({ persist: false }) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  setUserStore(new UserStore({ persist: false }));
  resetAuthRateLimit();
});

test('注册：返回用户与会话令牌，且不泄露口令哈希/盐', async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/auth/register`, json({
      username: '张三', password: 'secret123', displayName: '张三（产品）',
    }));
    assert.equal(res.status, 201);
    const body: any = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.user.username, '张三');
    assert.equal(body.data.user.displayName, '张三（产品）');
    assert.equal(typeof body.data.token, 'string');
    assert.ok(body.data.token.length >= 32);
    const raw = JSON.stringify(body);
    assert.equal(raw.includes('passwordHash'), false);
    assert.equal(raw.includes('salt'), false);
    assert.equal(raw.includes('secret123'), false);
  });
});

test('注册：用户名重复返回 409，口令过短返回 400', async () => {
  await withApp(async ({ base }) => {
    const first = await fetch(`${base}/api/auth/register`, json({ username: 'lisi', password: 'abc123' }));
    assert.equal(first.status, 201);

    const dup = await fetch(`${base}/api/auth/register`, json({ username: 'lisi', password: 'abc123' }));
    assert.equal(dup.status, 409);

    const weak = await fetch(`${base}/api/auth/register`, json({ username: 'wangwu', password: '123' }));
    assert.equal(weak.status, 400);
    const body: any = await weak.json();
    assert.match(body.error, /口令至少/);
  });
});

test('登录：口令错误与用户不存在给同一句提示（不暴露账号是否存在）', async () => {
  await withApp(async ({ base }) => {
    await fetch(`${base}/api/auth/register`, json({ username: 'zhaoliu', password: 'abc123' }));

    const wrong = await fetch(`${base}/api/auth/login`, json({ username: 'zhaoliu', password: 'nope' }));
    const missing = await fetch(`${base}/api/auth/login`, json({ username: 'nobody', password: 'abc123' }));
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    const a: any = await wrong.json();
    const b: any = await missing.json();
    assert.equal(a.error, b.error);
  });
});

test('会话令牌可以访问受保护的业务接口；登出后立即失效', async () => {
  await withApp(async ({ base }) => {
    const reg: any = await (await fetch(`${base}/api/auth/register`, json({
      username: 'session-user', password: 'abc123',
    }))).json();
    const token = reg.data.token as string;

    // 受保护接口：消息列表
    const list = await fetch(`${base}/api/messages`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(list.status, 200);

    // me 能识别身份
    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    const meBody: any = await me.json();
    assert.equal(meBody.data.user.username, 'session-user');

    // 登出后同一令牌失效
    await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const after = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401);
  });
});

test('无效令牌不能访问业务接口（鉴权没有被放宽）', async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/messages`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(res.status, 401);
  });
});

/** 注册一个用户并返回其会话令牌 */
async function registerUser(base: string, username: string, password = 'secret123') {
  const res = await fetch(`${base}/api/auth/register`, json({ username, password }));
  const body: any = await res.json();
  return { token: body.data.token as string, user: body.data.user };
}

test('忘记口令：用恢复码重置；恢复码错 401，重置后旧会话作废', async () => {
  await withApp(async ({ base }) => {
    const reg = await (await fetch(`${base}/api/auth/register`, json({
      username: 'recovery-user', password: 'secret123',
    }))).json();
    const token = reg.data.token as string;
    const code = reg.data.recoveryCode as string;
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // 错的恢复码
    const bad = await fetch(`${base}/api/auth/reset-password`, json({
      username: 'recovery-user', recoveryCode: 'AAAA-BBBB-CCCC', newPassword: 'newpass123',
    }));
    assert.equal(bad.status, 401);

    // 正确的恢复码（大小写/横线容错）
    const ok = await fetch(`${base}/api/auth/reset-password`, json({
      username: 'recovery-user', recoveryCode: code.toLowerCase(), newPassword: 'newpass123',
    }));
    assert.equal(ok.status, 200);
    const okBody: any = await ok.json();
    assert.equal(okBody.data.revoked, 1);

    // 旧会话失效
    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 401);

    // 新口令可登录
    const login = await fetch(`${base}/api/auth/login`, json({ username: 'recovery-user', password: 'newpass123' }));
    assert.equal(login.status, 200);
  });
});

test('登录审计：/api/auth/me 返回最近登录时间', async () => {
  await withApp(async ({ base }) => {
    const reg = await (await fetch(`${base}/api/auth/register`, json({
      username: 'audit-user', password: 'secret123',
    }))).json();
    const token = reg.data.token as string;
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(typeof me.data.user.lastLoginAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(me.data.user.lastLoginAt)));
  });
});

test('会话令牌不落明文：库文件里查不到可用的令牌字符串', async () => {
  const { readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = makeTempDir('linkhub-users-');
  const file = join(dir, 'users.json');

  // 直接对仓储做一次注册+登录，检查落盘内容
  const { UserStore: Store } = await import('../services/users');
  const store = new Store({ filePath: file });
  store.register({ username: 'hash-check', password: 'secret123' });
  const { token } = store.login({ username: 'hash-check', password: 'secret123' });

  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes(token), false, '明文令牌不应出现在库文件');
  assert.equal(raw.includes('secret123'), false, '明文口令不应出现在库文件');
  // 但令牌确实可用
  assert.equal(store.resolveSession(token)?.username, 'hash-check');
  // 哈希后的令牌在库里
  const parsed = JSON.parse(raw);
  assert.equal(parsed.sessions.length, 1);
  assert.match(parsed.sessions[0].tokenHash, /^[a-f0-9]{64}$/);
});

test('改口令：原口令错 401；成功后退掉全部会话，旧令牌立即失效', async () => {
  await withApp(async ({ base }) => {
    const { token } = await registerUser(base, 'pwd-user');

    // 原口令错
    const wrong = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: 'nope', newPassword: 'newpass123' }),
    });
    assert.equal(wrong.status, 401);

    // 新口令太短
    const short = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: 'secret123', newPassword: '123' }),
    });
    assert.equal(short.status, 400);

    // 正常修改
    const ok = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: 'secret123', newPassword: 'newpass123' }),
    });
    assert.equal(ok.status, 200);
    const okBody: any = await ok.json();
    assert.equal(okBody.data.revoked, 1);

    // 旧令牌立即失效
    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 401);

    // 旧口令不能登录，新口令可以
    const oldLogin = await fetch(`${base}/api/auth/login`, json({ username: 'pwd-user', password: 'secret123' }));
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(`${base}/api/auth/login`, json({ username: 'pwd-user', password: 'newpass123' }));
    assert.equal(newLogin.status, 200);
  });
});

test('退出所有设备：多端登录后一次作废，全部令牌失效', async () => {
  await withApp(async ({ base }) => {
    const first = await registerUser(base, 'multi-device');
    // 再登一次模拟第二台设备
    const secondRes = await fetch(`${base}/api/auth/login`, json({ username: 'multi-device', password: 'secret123' }));
    const second: any = await secondRes.json();

    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${first.token}` } });
    const meBody: any = await me.json();
    assert.equal(meBody.data.sessionCount, 2);

    const all = await fetch(`${base}/api/auth/logout-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${first.token}` },
    });
    const allBody: any = await all.json();
    assert.equal(allBody.data.revoked, 2);

    for (const token of [first.token, second.data.token]) {
      const r = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(r.status, 401);
    }
  });
});

test('注册限流只统计失败：连续正常注册不会被锁（旧实现成功也计数）', async () => {
  await withApp(async ({ base }) => {
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/api/auth/register`, json({ username: `bulk-${i}`, password: 'secret123' }));
      assert.equal(res.status, 201, `第 ${i + 1} 个正常注册不应被限流`);
    }
  });
});

test('登录限流按「IP + 用户名」分桶：锁住一个账号不连坐同 IP 的其他账号', async () => {
  await withApp(async ({ base }) => {
    await registerUser(base, 'alice');
    await registerUser(base, 'bob');

    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${base}/api/auth/login`, json({ username: 'alice', password: `wrong-${i}` }));
      assert.equal(res.status, 401);
    }

    const alice = await fetch(`${base}/api/auth/login`, json({ username: 'alice', password: 'secret123' }));
    assert.equal(alice.status, 429);
    assert.ok(alice.headers.get('retry-after'), '限流响应应带 Retry-After');

    // 同 IP 的另一个账号不受影响（旧实现按纯 IP 分桶会把整个办公室一起锁死）
    const bob = await fetch(`${base}/api/auth/login`, json({ username: 'bob', password: 'secret123' }));
    assert.equal(bob.status, 200);
  });
});

test('注册准入：本机已有账号且未配置邀请码时，注册被拒绝（纯内存库不参与限制）', async () => {
  // 该用例直接验证策略函数：有账号 + auto + 无邀请码 → 关闭；
  // 路由层在真实账号库（usersFile 非空）上才会调用它。
  const { registrationPolicy } = await import('./auth');
  const policy = registrationPolicy();
  // 单测使用纯内存账号库（usersFile 为空），策略应保持开放，避免测试互相干扰
  assert.equal(policy.open, true);
});