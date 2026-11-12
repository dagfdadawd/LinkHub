/**
 * 飞书用户授权路由单测：
 *  - start 必须带 Bearer，返回包含 state/scope/redirect_uri 的授权 URL；
 *  - callback 校验 state、用 code 换 token 并把令牌写入文件；
 *  - 成功页/失败页都不回显任何令牌值。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app';
import { config } from '../config';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { resetFeishuUserAuthCache } from '../connectors/feishuUserAuth';
import { LlmService } from '../services/llm';
import { OcrService } from '../services/ocr';
import { RateLimiter } from '../services/rateLimiter';
import { MessageService } from '../services/message';
import { resetFeishuOAuthStates } from './feishuOAuth';

const realFetch = globalThis.fetch;
const dirs: string[] = [];
const original = {
  appId: config.platforms.feishu.appId,
  appSecret: config.platforms.feishu.appSecret,
  tokenFile: config.feishuAuth.tokenFile,
  accountsBaseUrl: config.feishuAuth.accountsBaseUrl,
  redirectUri: config.feishuAuth.redirectUri,
};

function makeSvc(): MessageService {
  return new MessageService(
    new InMemoryRepository(), connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
}

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createApp(makeSvc(), { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postStart(base: string, token = config.apiToken): Promise<Response> {
  return fetch(`${base}/api/feishu/oauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}',
  });
}

function tempTokenFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-feishu-oauth-'));
  dirs.push(dir);
  return join(dir, 'token.json');
}

before(() => {
  config.platforms.feishu.appId = 'cli_test';
  config.platforms.feishu.appSecret = 'secret_test';
  config.feishuAuth.accountsBaseUrl = 'https://accounts.example';
  config.feishuAuth.redirectUri = 'http://localhost:3001/api/feishu/oauth/callback';
  config.feishuAuth.sendAs = 'auto';
});

beforeEach(() => {
  resetFeishuOAuthStates();
  resetFeishuUserAuthCache();
  config.feishuAuth.tokenFile = tempTokenFile();
  config.platforms.feishu.appId = 'cli_test';
  config.platforms.feishu.appSecret = 'secret_test';
});

after(() => {
  globalThis.fetch = realFetch;
  config.platforms.feishu.appId = original.appId;
  config.platforms.feishu.appSecret = original.appSecret;
  config.feishuAuth.tokenFile = original.tokenFile;
  config.feishuAuth.accountsBaseUrl = original.accountsBaseUrl;
  config.feishuAuth.redirectUri = original.redirectUri;
  resetFeishuUserAuthCache();
  resetFeishuOAuthStates();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('start 未带 Bearer → 401', async () => {
  await withApp(async (base) => {
    const res = await postStart(base, 'wrong-token');
    assert.equal(res.status, 401);
  });
});

test('start 返回飞书授权 URL（scope/redirect_uri/state 齐全）', async () => {
  await withApp(async (base) => {
    const res = await postStart(base);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json() as any;
    const url = new URL(body.data.url);
    assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.example/open-apis/authen/v1/authorize');
    assert.equal(url.searchParams.get('client_id'), 'cli_test');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3001/api/feishu/oauth/callback');
    // scope 由 config.identity 动态生成（本人接收开启时含用户身份读消息权限，避免授权后仍 99991672）
    const scopeParam = url.searchParams.get('scope') ?? '';
    assert.equal(scopeParam, config.feishuAuth.scopes.join(' '));
    assert.ok(scopeParam.includes('im:message.p2p_msg:get_as_user'), '必须申请单聊读消息权限');
    assert.ok(scopeParam.includes('im:message.group_msg:get_as_user'), '必须申请群聊读消息权限');
    assert.ok(url.searchParams.get('state'), '必须带一次性 state');
  });
});

test('start 缺 App 凭证 → 400 并给出可操作提示', async () => {
  config.platforms.feishu.appId = '';
  resetFeishuUserAuthCache();
  await withApp(async (base) => {
    const res = await postStart(base);
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(String(body.error), /FEISHU_APP_ID/);
  });
});

test('callback state 不匹配 → 400，不调用 token 接口', async () => {
  let called = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith('https://accounts.example')) {
      called += 1;
      return new Response('{}', { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  await withApp(async (base) => {
    const res = await fetch(`${base}/api/feishu/oauth/callback?code=code-1&state=bad-state`);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /状态/);
  });
  assert.equal(called, 0);
});

test('callback 成功：换 token、落盘、成功页不回显令牌', async () => {
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith('https://accounts.example')) {
      return new Response(JSON.stringify({
        access_token: 'u-secret-access',
        refresh_token: 'ur-secret-refresh',
        expires_in: 7200,
        refresh_token_expires_in: 604800,
        scope: 'im:message',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  await withApp(async (base) => {
    const started = await postStart(base);
    const body = await started.json() as any;
    const state = new URL(body.data.url).searchParams.get('state')!;

    const res = await fetch(`${base}/api/feishu/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /连接成功|授权成功/);
    assert.ok(!html.includes('u-secret-access'), '成功页不得回显 access_token');
    assert.ok(!html.includes('ur-secret-refresh'), '成功页不得回显 refresh_token');

    assert.equal(existsSync(config.feishuAuth.tokenFile), true);
    const saved = JSON.parse(readFileSync(config.feishuAuth.tokenFile, 'utf8'));
    assert.equal(saved.accessToken, 'u-secret-access');
    assert.equal(saved.refreshToken, 'ur-secret-refresh');
    assert.equal(saved.appId, 'cli_test');

    // state 一次性：同一回调重放必须拒绝
    const replay = await fetch(`${base}/api/feishu/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400);
  });
});

test('callback 换 token 失败 → 失败页包含重新授权提示', async () => {
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith('https://accounts.example')) {
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'code expired',
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  await withApp(async (base) => {
    const started = await postStart(base);
    const body = await started.json() as any;
    const state = new URL(body.data.url).searchParams.get('state')!;

    const res = await fetch(`${base}/api/feishu/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /授权失败|重新/);
  });
});