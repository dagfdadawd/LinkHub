/**
 * 飞书用户身份授权单测：令牌存取 / 过期判定 / refresh / 身份选择。
 * 不触网：fetch 全部打桩；令牌文件落到临时目录，结束后清理。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FeishuUserAuth, type FeishuUserAuthOptions } from './feishuUserAuth';
import { makeTempDir } from '../utils/tempDir';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  body: string;
}

function stubFetch(replies: Array<{ body: unknown; status?: number }>, calls: Call[]): typeof fetch {
  let i = 0;
  return (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(url),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function makeAuth(overrides: Partial<FeishuUserAuthOptions> = {}): FeishuUserAuth {
  const dir = makeTempDir('linkhub-feishu-auth-');
  dirs.push(dir);
  return new FeishuUserAuth({
    appId: 'cli_test',
    appSecret: 'secret_test',
    accountsBaseUrl: 'https://accounts.example',
    tokenFile: join(dir, 'token.json'),
    redirectUri: 'http://localhost:3001/api/feishu/oauth/callback',
    scopes: ['im:message', 'im:message.send_as_user', 'im:resource', 'offline_access'],
    sendAs: 'auto',
    ...overrides,
  });
}

function tokenPayload(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'u-test',
    refresh_token: 'ur-test',
    expires_in: 7200,
    refresh_token_expires_in: 604800,
    token_type: 'Bearer',
    scope: 'im:message im:message.send_as_user',
    ...overrides,
  };
}

function writeRecord(auth: FeishuUserAuth, record: Record<string, unknown>): void {
  mkdirSync(dirname(auth.tokenFile), { recursive: true });
  writeFileSync(auth.tokenFile, JSON.stringify(record), 'utf8');
}

function validRecord(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    appId: 'cli_test',
    accessToken: 'u-test',
    refreshToken: 'ur-test',
    tokenType: 'Bearer',
    accessExpiresAt: now + 7200_000,
    refreshExpiresAt: now + 604800_000,
    authorizedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

test('authorizeUrl 拼接 client_id / redirect_uri / scope / state', () => {
  const auth = makeAuth();
  const url = new URL(auth.authorizeUrl('state-1'));
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.example/open-apis/authen/v1/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cli_test');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3001/api/feishu/oauth/callback');
  assert.equal(url.searchParams.get('scope'), 'im:message im:message.send_as_user im:resource offline_access');
  assert.equal(url.searchParams.get('state'), 'state-1');
});

test('exchange：换 token 后落盘，status=active，发送取 token 不再刷新', async () => {
  const calls: Call[] = [];
  const auth = makeAuth({ fetchImpl: stubFetch([{ body: tokenPayload() }], calls) });

  const status = await auth.exchange('code-1');
  assert.equal(status.state, 'active');
  assert.equal(status.configured, true);
  assert.equal(existsSync(auth.tokenFile), true);

  const saved = JSON.parse(readFileSync(auth.tokenFile, 'utf8'));
  assert.equal(saved.appId, 'cli_test');
  assert.equal(saved.accessToken, 'u-test');
  assert.equal(saved.refreshToken, 'ur-test');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://accounts.example/oauth/v3/token');
  const sent = new URLSearchParams(calls[0].body);
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('client_id'), 'cli_test');
  assert.equal(sent.get('client_secret'), 'secret_test');
  assert.equal(sent.get('code'), 'code-1');
  assert.equal(sent.get('redirect_uri'), 'http://localhost:3001/api/feishu/oauth/callback');

  assert.equal(await auth.accessToken(), 'u-test');
  assert.equal(calls.length, 1, 'access_token 仍有效时不应触发 refresh');
});

test('auto：未连接走机器人，授权后走本人；bot/user 强制身份', async () => {
  const calls: Call[] = [];
  const auto = makeAuth({ fetchImpl: stubFetch([{ body: tokenPayload() }], calls) });
  assert.equal(auto.effectiveIdentity(), 'bot');
  assert.match(auto.identityView().hint, /机器人/);

  await auto.exchange('code-1');
  assert.equal(auto.effectiveIdentity(), 'user');
  assert.equal(auto.identityView().effective, 'user');

  assert.equal(makeAuth({ sendAs: 'bot' }).effectiveIdentity(), 'bot');
  assert.equal(makeAuth({ sendAs: 'user' }).effectiveIdentity(), 'user');
});

test('refresh：access 过期后用 refresh_token 续期并原子更新文件', async () => {
  let now = 1_700_000_000_000;
  const calls: Call[] = [];
  const auth = makeAuth({
    now: () => now,
    fetchImpl: stubFetch([
      { body: tokenPayload() },
      { body: tokenPayload({ access_token: 'u-new', refresh_token: 'ur-new' }) },
    ], calls),
  });

  await auth.exchange('code-1');
  now += 7200_000 + 5_000;
  assert.equal(auth.status().state, 'refreshable');

  assert.equal(await auth.accessToken(), 'u-new');
  assert.equal(calls.length, 2);
  const refreshBody = new URLSearchParams(calls[1].body);
  assert.equal(refreshBody.get('grant_type'), 'refresh_token');
  assert.equal(refreshBody.get('refresh_token'), 'ur-test');
  assert.equal(refreshBody.get('client_secret'), 'secret_test');

  const saved = JSON.parse(readFileSync(auth.tokenFile, 'utf8'));
  assert.equal(saved.accessToken, 'u-new');
  assert.equal(saved.refreshToken, 'ur-new');
});

test('refresh 并发：两次发送共享同一次刷新，只消费一次 refresh_token', async () => {
  let now = 1_700_000_000_000;
  const calls: Call[] = [];
  const auth = makeAuth({
    now: () => now,
    fetchImpl: stubFetch([
      { body: tokenPayload() },
      { body: tokenPayload({ access_token: 'u-new', refresh_token: 'ur-new' }) },
    ], calls),
  });

  await auth.exchange('code-1');
  now += 7200_000 + 5_000;
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.equal(a, 'u-new');
  assert.equal(b, 'u-new');
  assert.equal(calls.length, 2, '并发发送只应触发一次 refresh');
});

test('refresh 未返回 refresh_token_expires_in：不提前判定过期，先允许继续使用', async () => {
  let now = 1_700_000_000_000;
  const auth = makeAuth({
    now: () => now,
    fetchImpl: stubFetch([{ body: tokenPayload({ refresh_token_expires_in: undefined }) }], []),
  });

  await auth.exchange('code-1');
  assert.equal(auth.status().state, 'active');
  assert.equal(auth.status().refreshExpiresAt, undefined, '未知有效期不应伪装成具体时间');

  now += 7200_000 + 5_000;
  assert.equal(auth.status().state, 'refreshable', '未知有效期时不能提前判定 refresh 失效');
});

test('刷新成功但落盘失败：内存令牌继续可用，不阻断本次发送', async () => {
  let now = 1_700_000_000_000;
  const auth = makeAuth({
    now: () => now,
    fetchImpl: stubFetch([
      { body: tokenPayload() },
      { body: tokenPayload({ access_token: 'u-memory', refresh_token: 'ur-memory' }) },
    ], []),
  });

  await auth.exchange('code-1');
  // 把令牌文件路径替换成目录，令下一次 save 必然失败（模拟磁盘满/权限被改）
  rmSync(auth.tokenFile);
  mkdirSync(auth.tokenFile);

  now += 7200_000 + 5_000;
  assert.equal(await auth.accessToken(), 'u-memory');
  const status = auth.status();
  assert.equal(status.state, 'active', '落盘失败后应读内存令牌，不能回到 expired');
  assert.ok(status.accessExpiresAt);
});

test('refresh 失败：提示重新授权、错误不含令牌，并立刻标记失效', async () => {
  let now = 1_700_000_000_000;
  const auth = makeAuth({
    now: () => now,
    // 只有数字错误码、文案里不含 refresh_token：验证按 HTTP 400 也能映射成重新授权
    fetchImpl: stubFetch([
      { body: tokenPayload() },
      { body: { code: 20037, msg: 'invalid' }, status: 400 },
    ], []),
  });

  await auth.exchange('code-1');
  now += 7200_000 + 5_000;
  await assert.rejects(
    () => auth.accessToken(),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /重新授权/);
      assert.ok(!message.includes('ur-test'), '错误信息不得包含 refresh_token');
      return true;
    },
  );
  assert.equal(auth.status().state, 'expired', '刷新失败后状态必须立即失效，不能一直显示可续期');
  const saved = JSON.parse(readFileSync(auth.tokenFile, 'utf8'));
  assert.equal(saved.refreshToken, undefined, '失效后应移除已消费的 refresh_token');
});

test('未返回 refresh_token：access 过期后必须重新授权', async () => {
  let now = 1_700_000_000_000;
  const auth = makeAuth({
    now: () => now,
    fetchImpl: stubFetch([{ body: tokenPayload({ refresh_token: undefined, refresh_token_expires_in: undefined }) }], []),
  });

  await auth.exchange('code-1');
  assert.equal(auth.status().state, 'active');
  now += 7200_000 + 5_000;
  assert.equal(auth.status().state, 'expired');
  await assert.rejects(() => auth.accessToken(), /重新授权/);
});

test('App ID 不匹配：auto 也按本人严格失败，不悄悄回退机器人', async () => {
  const auth = makeAuth();
  writeRecord(auth, validRecord({ appId: 'cli_other' }));

  const status = auth.status();
  assert.equal(status.state, 'invalid');
  assert.equal(status.configured, false);
  assert.equal(status.appIdMatches, false);

  assert.equal(auth.effectiveIdentity(), 'user');
  assert.match(auth.identityView().hint, /发送会失败|重新授权/);
  await assert.rejects(() => auth.accessToken(), /不可用|其他飞书应用/);

  const forced = makeAuth({ sendAs: 'user' });
  writeRecord(forced, validRecord({ appId: 'cli_other' }));
  assert.equal(forced.effectiveIdentity(), 'user');
  await assert.rejects(() => forced.accessToken(), /重新授权|其他飞书应用/);
});

test('令牌文件损坏：已连接过 → auto 严格失败，不把异常吞成机器人', async () => {
  const auth = makeAuth();
  writeFileSync(auth.tokenFile, 'not-json', 'utf8');
  const status = auth.status();
  assert.equal(status.state, 'invalid');
  assert.equal(status.configured, false);
  assert.equal(auth.effectiveIdentity(), 'user');
  assert.match(auth.identityView().hint, /发送会失败|重新授权/);
  await assert.rejects(() => auth.accessToken(), /不可用/);
});

test('user 模式未连接：发送前明确报未授权；identityView 提示会失败', async () => {
  const auth = makeAuth({ sendAs: 'user' });
  assert.equal(auth.effectiveIdentity(), 'user');
  assert.match(auth.identityView().hint, /发送会失败/);
  await assert.rejects(() => auth.accessToken(), /未授权/);
});

test('auto 模式已过期：按本人严格报错，不悄悄回退机器人', async () => {
  const now = 1_700_000_000_000;
  const auth = makeAuth({ now: () => now });
  writeRecord(auth, validRecord({
    accessExpiresAt: now - 1000,
    refreshExpiresAt: now - 1000,
  }));
  assert.equal(auth.status().state, 'expired');
  assert.equal(auth.effectiveIdentity(), 'user');
  assert.match(auth.identityView().hint, /重新授权/);
  await assert.rejects(() => auth.accessToken(), /过期/);
});

test('authorizeUrl：完整身份 scope（含本人接收的读消息权限）用空格分隔', () => {
  const scopes = [
    'im:message', 'im:message.send_as_user', 'im:resource',
    'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user', 'offline_access',
  ];
  const auth = makeAuth({ scopes });
  const url = new URL(auth.authorizeUrl('state-x'));
  assert.equal(url.searchParams.get('scope'), scopes.join(' '));
});
