/**
 * /api/accounts 视图：飞书发送身份只下发状态与过期时间，绝不下发令牌。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from '@unimsg/shared';
import { config } from '../config';
import { resetFeishuUserAuthCache } from '../connectors/feishuUserAuth';
import { listAccounts } from './account';

const dirs: string[] = [];
const original = {
  sendAs: config.feishuAuth.sendAs,
  tokenFile: config.feishuAuth.tokenFile,
  appId: config.platforms.feishu.appId,
};

function tempTokenFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-account-'));
  dirs.push(dir);
  return join(dir, 'token.json');
}

function writeRecord(file: string, overrides: Record<string, unknown> = {}): void {
  const now = Date.now();
  writeFileSync(file, JSON.stringify({
    appId: 'cli_test',
    accessToken: 'u-view-token',
    refreshToken: 'ur-view-refresh',
    accessExpiresAt: now + 7200_000,
    refreshExpiresAt: now + 604800_000,
    authorizedAt: new Date(now).toISOString(),
    ...overrides,
  }), 'utf8');
}

function setConfig(patch: { sendAs: typeof config.feishuAuth.sendAs; tokenFile: string; appId?: string }): void {
  config.feishuAuth.sendAs = patch.sendAs;
  config.feishuAuth.tokenFile = patch.tokenFile;
  if (patch.appId !== undefined) config.platforms.feishu.appId = patch.appId;
  resetFeishuUserAuthCache();
}

after(() => {
  config.feishuAuth.sendAs = original.sendAs;
  config.feishuAuth.tokenFile = original.tokenFile;
  config.platforms.feishu.appId = original.appId;
  resetFeishuUserAuthCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('飞书账号视图：已授权时下发 effective=user 与过期时间，不含令牌', () => {
  const tokenFile = tempTokenFile();
  setConfig({ sendAs: 'auto', tokenFile, appId: 'cli_test' });
  writeRecord(tokenFile);

  const feishu = listAccounts().find((a) => a.platform === Platform.FEISHU)!;
  assert.equal(feishu.feishuIdentity?.sendAs, 'auto');
  assert.equal(feishu.feishuIdentity?.effective, 'user');
  assert.equal(feishu.feishuIdentity?.tokenState, 'active');
  assert.ok(feishu.feishuIdentity?.accessExpiresAt);
  assert.ok(feishu.feishuIdentity?.refreshExpiresAt);
  assert.match(feishu.feishuIdentity?.hint ?? '', /本人/);

  const serialized = JSON.stringify(feishu);
  assert.ok(!serialized.includes('u-view-token'), '不得下发 access_token');
  assert.ok(!serialized.includes('ur-view-refresh'), '不得下发 refresh_token');
});

test('飞书账号视图：未连接且 auto → 机器人，并提示可连接', () => {
  const tokenFile = tempTokenFile();
  setConfig({ sendAs: 'auto', tokenFile, appId: 'cli_test' });

  const feishu = listAccounts().find((a) => a.platform === Platform.FEISHU)!;
  assert.equal(feishu.feishuIdentity?.tokenState, 'none');
  assert.equal(feishu.feishuIdentity?.effective, 'bot');
  assert.match(feishu.feishuIdentity?.hint ?? '', /机器人/);
});

test('飞书账号视图：user 模式未连接时明确提示发送会失败', () => {
  const tokenFile = tempTokenFile();
  setConfig({ sendAs: 'user', tokenFile, appId: 'cli_test' });

  const feishu = listAccounts().find((a) => a.platform === Platform.FEISHU)!;
  assert.equal(feishu.feishuIdentity?.effective, 'user');
  assert.match(feishu.feishuIdentity?.hint ?? '', /发送会失败/);
});