/**
 * 飞书发送身份集成单测：bot/user 选择、refresh 后发送、附件同身份、自环识别。
 * 不触网：fetch 全部打桩；令牌文件落到临时目录。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Platform, MsgStatus, type OutboundAttachment } from '@unimsg/shared';
import { config, forceAllModes } from '../config';
import { feishuConnector, resetFeishuEchoRegistry } from './feishu';
import { resetFeishuUserAuthCache } from './feishuUserAuth';
import { resetTokenCache } from './real';

const origFetch = globalThis.fetch;
const dirs: string[] = [];
const original = {
  sendAs: config.feishuAuth.sendAs,
  tokenFile: config.feishuAuth.tokenFile,
  accountsBaseUrl: config.feishuAuth.accountsBaseUrl,
  appId: config.platforms.feishu.appId,
  appSecret: config.platforms.feishu.appSecret,
};

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(replies: unknown[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(reply ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

function tempTokenFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-feishu-send-'));
  dirs.push(dir);
  return join(dir, 'token.json');
}

function writeToken(file: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record), 'utf8');
}

function validRecord(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    appId: 'cli_test',
    accessToken: 'u-user',
    refreshToken: 'ur-user',
    tokenType: 'Bearer',
    accessExpiresAt: now + 7200_000,
    refreshExpiresAt: now + 604800_000,
    authorizedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    traceId: 't-user-send',
    platform: Platform.FEISHU,
    externalId: 'om_in_1',
    sender: { id: 'ou_sender', name: 'ou_sender' },
    conversation: { id: 'oc_group', type: 'group' as const },
    type: 'text' as const,
    body: '原文',
    reply: '回写内容',
    status: MsgStatus.REPLIED,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function jsonBody(call: Call): any {
  return JSON.parse(String(call.init.body));
}

before(() => {
  forceAllModes('real');
  config.platforms.feishu.appId = 'cli_test';
  config.platforms.feishu.appSecret = 'secret_test';
});

beforeEach(() => {
  resetTokenCache();
  resetFeishuUserAuthCache();
  resetFeishuEchoRegistry();
  config.feishuAuth.sendAs = 'auto';
  config.feishuAuth.tokenFile = tempTokenFile();
  config.feishuAuth.accountsBaseUrl = 'https://accounts.example';
});

after(() => {
  globalThis.fetch = origFetch;
  forceAllModes('mock');
  config.feishuAuth.sendAs = original.sendAs;
  config.feishuAuth.tokenFile = original.tokenFile;
  config.feishuAuth.accountsBaseUrl = original.accountsBaseUrl;
  config.platforms.feishu.appId = original.appId;
  config.platforms.feishu.appSecret = original.appSecret;
  resetFeishuUserAuthCache();
  resetTokenCache();
  resetFeishuEchoRegistry();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('user 身份：直接使用 user_access_token，不换 tenant token', async () => {
  config.feishuAuth.sendAs = 'user';
  writeToken(config.feishuAuth.tokenFile, validRecord());
  const calls = stubFetch([{ code: 0, data: { message_id: 'om_user_1' } }]);

  const r = await feishuConnector.send(message());
  assert.equal(r.mode, 'real');
  assert.equal(r.identity, 'user');
  assert.equal(r.platformReply, 'om_user_1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/im\/v1\/messages\?receive_id_type=chat_id$/);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer u-user');
  assert.equal(jsonBody(calls[0]).receive_id, 'oc_group');
  assert.deepEqual(JSON.parse(jsonBody(calls[0]).content), { text: '回写内容' });
});

test('bot 身份：即使已授权用户身份也固定用 tenant token', async () => {
  config.feishuAuth.sendAs = 'bot';
  writeToken(config.feishuAuth.tokenFile, validRecord());
  const calls = stubFetch([
    { code: 0, tenant_access_token: 't-123', expire: 7200 },
    { code: 0, data: { message_id: 'om_bot_1' } },
  ]);

  const r = await feishuConnector.send(message());
  assert.equal(r.identity, 'bot');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /tenant_access_token\/internal$/);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, 'Bearer t-123');
});

test('auto：有有效用户令牌时自动用本人；没有时保持机器人', async () => {
  const withToken = stubFetch([{ code: 0, data: { message_id: 'om_auto_1' } }]);
  writeToken(config.feishuAuth.tokenFile, validRecord());
  const userResult = await feishuConnector.send(message());
  assert.equal(userResult.identity, 'user');
  assert.equal(withToken.length, 1);

  resetFeishuUserAuthCache();
  config.feishuAuth.tokenFile = tempTokenFile();
  const withoutToken = stubFetch([
    { code: 0, tenant_access_token: 't-123', expire: 7200 },
    { code: 0, data: { message_id: 'om_auto_2' } },
  ]);
  const botResult = await feishuConnector.send(message());
  assert.equal(botResult.identity, 'bot');
  assert.match(withoutToken[0].url, /tenant_access_token\/internal$/);
});

test('user 身份：附件上传与文件消息同样使用 user_access_token', async () => {
  config.feishuAuth.sendAs = 'user';
  writeToken(config.feishuAuth.tokenFile, validRecord());
  const calls = stubFetch([
    { code: 0, data: { message_id: 'om_text' } },
    { code: 0, data: { file_key: 'fk_1' } },
    { code: 0, data: { message_id: 'om_file' } },
  ]);
  const attachment: OutboundAttachment = {
    name: 'a.txt',
    mimeType: 'text/plain',
    size: 5,
    contentBase64: Buffer.from('hello').toString('base64'),
  };

  const r = await feishuConnector.send(message(), [attachment]);
  assert.equal(r.platformReply, 'om_text,om_file');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer u-user');
  }
  assert.match(calls[1].url, /\/im\/v1\/files$/);
  const fileMessage = jsonBody(calls[2]);
  assert.equal(fileMessage.msg_type, 'file');
  assert.deepEqual(JSON.parse(fileMessage.content), { file_key: 'fk_1' });
});

test('发送前 access 过期但 refresh 有效：先续期再用新 token 发送', async () => {
  config.feishuAuth.sendAs = 'user';
  writeToken(config.feishuAuth.tokenFile, validRecord({
    accessExpiresAt: Date.now() - 1_000,
    refreshExpiresAt: Date.now() + 3_600_000,
  }));
  const calls = stubFetch([
    { access_token: 'u-refreshed', refresh_token: 'ur-refreshed', expires_in: 7200, refresh_token_expires_in: 604800 },
    { code: 0, data: { message_id: 'om_refreshed' } },
  ]);

  const r = await feishuConnector.send(message());
  assert.equal(r.ok, true);
  assert.equal(r.platformReply, 'om_refreshed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://accounts.example/oauth/v3/token');
  assert.match(String(calls[0].init.body), /grant_type=refresh_token/);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, 'Bearer u-refreshed');
});

test('user 身份未授权：发送显式失败且不发起任何网络请求', async () => {
  config.feishuAuth.sendAs = 'user';
  const calls = stubFetch([]);
  await assert.rejects(() => feishuConnector.send(message()), /未授权/);
  assert.equal(calls.length, 0);
});

test('auto 且用户授权已过期：严格失败，不悄悄回退机器人', async () => {
  writeToken(config.feishuAuth.tokenFile, validRecord({
    accessExpiresAt: Date.now() - 1_000,
    refreshExpiresAt: Date.now() - 1_000,
  }));
  const calls = stubFetch([]);
  await assert.rejects(() => feishuConnector.send(message()), /重新授权|过期/);
  assert.equal(calls.length, 0);
});

test('自环识别：本进程发出的 message_id 在窗口内重复投递都命中', async () => {
  config.feishuAuth.sendAs = 'user';
  writeToken(config.feishuAuth.tokenFile, validRecord());
  stubFetch([{ code: 0, data: { message_id: 'om_echo_1' } }]);

  await feishuConnector.send(message());
  const event = { event: { message: { message_id: 'om_echo_1' } } };
  assert.equal(feishuConnector.isSelfEcho?.(event), true);
  assert.equal(feishuConnector.isSelfEcho?.(event), true, '平台重投同一事件必须继续命中');
  // 飞书用户轮询拿到的裸 message 对象（message_id 在顶层）也要能识别
  assert.equal(feishuConnector.isSelfEcho?.({ message_id: 'om_echo_1' }), true);
  assert.equal(feishuConnector.isSelfEcho?.({ message_id: 'om_other' }), false);
  assert.equal(feishuConnector.isSelfEcho?.({ event: { message: { message_id: 'om_other' } } }), false);
  assert.equal(feishuConnector.isSelfEcho?.({}), false);
});