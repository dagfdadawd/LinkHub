/**
 * 邮箱账号运行时导入 HTTP 接口测试（注入 store + 测试连接实现，不连真实 IMAP/SMTP、不写真实文件）。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { config } from '../config';
import type { MailAccount } from '../config/runtime';
import { MailAccountsStore, resetMailAccountsForTests } from '../services/mailAccounts';
import { mailAccountsRouter, type MailAccountsRouterDeps } from './mailAccounts';
import { makeTempDir } from '../utils/tempDir';

const dirs: string[] = [];
const original = { accounts: [...config.mail.accounts], issues: [...config.mail.issues] };

function tempDir(): string {
  const dir = makeTempDir('linkhub-mail-api-');
  dirs.push(dir);
  return dir;
}

function envAccount(): MailAccount {
  return {
    key: 'envmail',
    label: '.env 邮箱',
    address: 'env@qq.com',
    authCode: 'env-secret-code',
    provider: 'qq',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    folders: ['INBOX'],
  };
}

beforeEach(() => {
  config.mail.accounts.splice(0, config.mail.accounts.length);
  config.mail.issues.splice(0, config.mail.issues.length);
  resetMailAccountsForTests();
});

after(() => {
  config.mail.accounts.splice(0, config.mail.accounts.length, ...original.accounts);
  config.mail.issues.splice(0, config.mail.issues.length, ...original.issues);
  resetMailAccountsForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Res {
  status: number;
  json: any;
}

async function withServer(
  deps: MailAccountsRouterDeps,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', mailAccountsRouter(deps));
  const server = http.createServer(app);
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
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

function makeStore(onChanges: string[] = []): MailAccountsStore {
  return new MailAccountsStore({
    file: join(tempDir(), 'mail-accounts.json'),
    onChange: (reason) => onChanges.push(reason),
    log: () => {},
    warn: () => {},
  });
}

test('邮箱接口：GET 脱敏列表（无授权码）、POST test 调注入实现、POST 保存、DELETE 本地账号', async () => {
  const changes: string[] = [];
  const store = makeStore(changes);
  store.init();
  const calls: Array<Record<string, unknown>> = [];
  const deps: MailAccountsRouterDeps = {
    store,
    testAccount: async (input) => {
      calls.push(input as Record<string, unknown>);
      if (input.address === 'bad@qq.com') {
        return {
          result: {
            ok: false,
            address: 'b**@qq.com',
            provider: 'qq',
            imap: { ok: false, detail: 'IMAP 登录失败：授权码错误', hint: '去邮箱网页版重新生成授权码' },
            smtp: { ok: true, detail: 'SMTP 认证成功' },
            checkedAt: new Date().toISOString(),
          },
        };
      }
      if (input.address === 'invalid') return { errors: ['邮箱地址格式不对（示例：you@qq.com）'] };
      return {
        result: {
          ok: true,
          address: 'a**@qq.com',
          provider: 'qq',
          imap: { ok: true, detail: 'IMAP 登录基线 UID=1' },
          smtp: { ok: true, detail: 'SMTP 认证成功' },
          checkedAt: new Date().toISOString(),
        },
      };
    },
  };
  await withServer(deps, async (base) => {
    const empty = await call(base, 'GET', '/api/mail/accounts');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.data.accounts, []);
    assert.ok(empty.json.data.filePath);
    assert.ok(!String(empty.json.data.filePath).includes('\\'), 'P3：只给 basename，不暴露绝对路径');
    assert.match(empty.json.data.filePath, /mail-accounts\.json$/);
    assert.ok(Array.isArray(empty.json.data.providers));

    // 测试连接：输入非法 → 400；失败 → 200 ok:false + 中文原因；成功 → 200
    const invalid = await call(base, 'POST', '/api/mail/accounts/test', { address: 'invalid', authCode: '' });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.error, /邮箱地址格式不对/);

    const failTest = await call(base, 'POST', '/api/mail/accounts/test', { address: 'bad@qq.com', authCode: 'x' });
    assert.equal(failTest.status, 200);
    assert.equal(failTest.json.data.ok, false);
    assert.match(failTest.json.data.imap.detail, /授权码错误/);
    assert.ok(failTest.json.data.imap.hint);

    const okTest = await call(base, 'POST', '/api/mail/accounts/test', { address: 'a@qq.com', authCode: 'x' });
    assert.equal(okTest.status, 200);
    assert.equal(okTest.json.data.ok, true);
    assert.equal(calls.length, 2, '非法输入不触发网络自检');

    // 保存：201 + 脱敏 + 不含授权码
    const saved = await call(base, 'POST', '/api/mail/accounts', {
      address: 'a@qq.com',
      authCode: 'super-secret',
      label: '我的QQ',
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.json.data.account.key, 'a');
    assert.equal(saved.json.data.account.address, 'a**@qq.com');
    assert.equal(saved.json.data.hotReloaded, true);
    assert.ok(!JSON.stringify(saved.json).includes('super-secret'), '响应不得含授权码');
    assert.equal(changes.at(-1), '新增/更新邮箱账号');

    const list = await call(base, 'GET', '/api/mail/accounts');
    assert.equal(list.json.data.accounts.length, 1);
    assert.equal(list.json.data.accounts[0].source, 'file');
    assert.equal(list.json.data.accounts[0].removable, true);
    assert.ok(!JSON.stringify(list.json).includes('super-secret'));

    // 删除本地账号
    const removed = await call(base, 'DELETE', '/api/mail/accounts/a');
    assert.equal(removed.status, 200);
    assert.equal(removed.json.data.removed.key, 'a');
    assert.equal(changes.at(-1), '删除邮箱账号');
    assert.equal((await call(base, 'DELETE', '/api/mail/accounts/a')).status, 404);
  });
});

test('邮箱接口：.env 来源账号 DELETE → 400 中文（提示改 .env）', async () => {
  config.mail.accounts.push(envAccount());
  const store = makeStore();
  store.init();
  await withServer({ store }, async (base) => {
    const list = await call(base, 'GET', '/api/mail/accounts');
    assert.equal(list.json.data.accounts[0].source, 'env');
    assert.equal(list.json.data.accounts[0].removable, false);
    assert.ok(!JSON.stringify(list.json).includes('env-secret-code'));

    const res = await call(base, 'DELETE', '/api/mail/accounts/envmail');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /来自 \.env/);
    assert.match(res.json.error, /MAIL_ENVMAIL/);
  });
});
test('POST /api/mail/accounts/:key/verify：成功写 verifiedAt；失败保持未验证；env 来源 400', async () => {
  const changes: string[] = [];
  const store = makeStore(changes);
  store.init();
  store.addOrUpdate({ key: 'verifyme', address: 'vm@qq.com', authCode: 'code' });
  let mode: 'ok' | 'fail' = 'ok';
  const deps: MailAccountsRouterDeps = {
    store,
    testAccount: async () => (mode === 'ok'
      ? { result: { ok: true, address: 'v**@qq.com', provider: 'qq', imap: { ok: true, detail: 'IMAP ok' }, smtp: { ok: true, detail: 'SMTP ok' }, checkedAt: new Date().toISOString() } }
      : { result: { ok: false, address: 'v**@qq.com', provider: 'qq', imap: { ok: false, detail: 'IMAP 授权码错误', hint: '重新生成授权码' }, smtp: { ok: true, detail: 'SMTP ok' }, checkedAt: new Date().toISOString() } }),
  };
  await withServer(deps, async (base) => {
    mode = 'fail';
    const failed = await call(base, 'POST', '/api/mail/accounts/verifyme/verify');
    assert.equal(failed.status, 200);
    assert.equal(failed.json.ok, false);
    assert.equal(failed.json.verified, false);
    assert.match(failed.json.imap.detail, /授权码错误/);
    assert.equal(store.snapshot().masked.find((m) => m.key === 'verifyme')!.verified, false);

    mode = 'ok';
    const ok = await call(base, 'POST', '/api/mail/accounts/verifyme/verify');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.verified, true);
    assert.ok(ok.json.verifiedAt);
    assert.equal(store.snapshot().masked.find((m) => m.key === 'verifyme')!.verified, true);
    assert.equal(changes.at(-1), '验证邮箱账号');

    const missing = await call(base, 'POST', '/api/mail/accounts/nope/verify');
    assert.equal(missing.status, 404);
  });

  config.mail.accounts.push(envAccount());
  const envStore = makeStore();
  envStore.init();
  await withServer({ store: envStore }, async (base) => {
    const res = await call(base, 'POST', '/api/mail/accounts/envmail/verify');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /\.env/);
  });
});

test('POST /api/mail/accounts body.verify=true：测试通过才保存并标记 verified；失败不落盘', async () => {
  const store = makeStore();
  store.init();
  let pass = false;
  const deps: MailAccountsRouterDeps = {
    store,
    testAccount: async () => (pass
      ? { result: { ok: true, address: 'x**@qq.com', provider: 'qq', imap: { ok: true, detail: 'ok' }, smtp: { ok: true, detail: 'ok' }, checkedAt: new Date().toISOString() } }
      : { result: { ok: false, address: 'x**@qq.com', provider: 'qq', imap: { ok: false, detail: 'IMAP 失败' }, smtp: { ok: true, detail: 'ok' }, checkedAt: new Date().toISOString() } }),
  };
  await withServer(deps, async (base) => {
    const failed = await call(base, 'POST', '/api/mail/accounts', { address: 'x@qq.com', authCode: 'c', verify: true });
    assert.equal(failed.status, 200);
    assert.equal(failed.json.saved, false);
    assert.equal(store.snapshot().masked.length, 0, '测试失败不得保存账号');

    pass = true;
    const ok = await call(base, 'POST', '/api/mail/accounts', { address: 'x@qq.com', authCode: 'c', verify: true });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.data.verified, true);
    assert.ok(ok.json.data.account.verifiedAt);
  });
});
