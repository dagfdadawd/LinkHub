/**
 * /api/accounts 视图：飞书/钉钉下发统一身份视图（本人/机器人/模拟 + 连接状态），
 * 且绝不下发任何令牌/密钥。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from '@unimsg/shared';
import { config } from '../config';
import { resetFeishuUserAuthCache } from '../connectors/feishuUserAuth';
import { resetDingtalkPersonalClientCache } from '../connectors/dingtalkPersonal';
import { resetIdentityCaches } from './identity';
import { listAccounts } from './account';

const dirs: string[] = [];
const original = {
  sendAs: config.feishuAuth.sendAs,
  tokenFile: config.feishuAuth.tokenFile,
  appId: config.platforms.feishu.appId,
  // appSecret 也要快照/注入：canAuthorize() 依赖 appId + appSecret 同时存在，
  // 只注入 appId 会让测试在「无 .env 的干净 checkout / CI」下靠环境碰巧通过。
  appSecret: config.platforms.feishu.appSecret,
  policy: config.identity.feishu.policy,
  runtime: Object.values(Platform).map((p) => [p, { ...config.runtime[p] }] as const),
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

function setConfig(patch: {
  policy: typeof config.identity.feishu.policy;
  tokenFile: string;
  appId?: string;
  appSecret?: string;
  mode?: 'real' | 'mock';
}): void {
  config.identity.feishu.policy = patch.policy;
  config.feishuAuth.sendAs = patch.policy;
  config.feishuAuth.tokenFile = patch.tokenFile;
  // 测试自洽：不依赖本机 .env 恰好配了飞书应用凭据（干净 checkout / CI 下无 .env）
  config.platforms.feishu.appId = patch.appId ?? 'cli_test';
  config.platforms.feishu.appSecret = patch.appSecret ?? 'cli_test_secret';
  const mode = patch.mode ?? 'real';
  config.runtime[Platform.FEISHU].mode = mode;
  config.runtime[Platform.FEISHU].policy = mode;
  config.runtime[Platform.FEISHU].canSend = true;
  config.runtime[Platform.FEISHU].canReceive = true;
  resetFeishuUserAuthCache();
  resetIdentityCaches();
}

function feishuView() {
  const feishu = listAccounts().find((a) => a.platform === Platform.FEISHU)!;
  assert.ok(feishu.identity, '飞书必须下发 identity 视图');
  return feishu.identity!;
}

after(() => {
  config.feishuAuth.sendAs = original.sendAs;
  config.feishuAuth.tokenFile = original.tokenFile;
  config.platforms.feishu.appId = original.appId;
  config.platforms.feishu.appSecret = original.appSecret;
  config.identity.feishu.policy = original.policy;
  for (const [platform, snapshot] of original.runtime) Object.assign(config.runtime[platform], snapshot);
  resetFeishuUserAuthCache();
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('飞书身份视图：已授权 + auto → 收发都是本人，含过期时间，不含令牌', () => {
  const tokenFile = tempTokenFile();
  setConfig({ policy: 'auto', tokenFile, appId: 'cli_test' });
  writeRecord(tokenFile);

  const identity = feishuView();
  assert.equal(identity.policy, 'auto');
  assert.equal(identity.effectiveSend, 'user');
  assert.equal(identity.effectiveReceive, 'user');
  assert.equal(identity.user.state, 'linked');
  assert.equal(identity.user.linked, true);
  assert.ok(identity.user.expiresAt);
  assert.match(identity.user.hint, /本人/);
  assert.match(identity.sendHint, /本人身份发送/);
  assert.match(identity.receiveHint, /用户轮询/);
  assert.equal(identity.user.linkMethod, 'oauth');
  assert.equal(identity.user.canLink, true);

  const serialized = JSON.stringify(identity);
  assert.ok(!serialized.includes('u-view-token'), '不得下发 access_token');
  assert.ok(!serialized.includes('ur-view-refresh'), '不得下发 refresh_token');
});

test('飞书身份视图：未连接 + auto → 回退机器人，并提示可连接（推荐）', () => {
  const tokenFile = tempTokenFile();
  setConfig({ policy: 'auto', tokenFile, appId: 'cli_test' });

  const identity = feishuView();
  assert.equal(identity.user.state, 'not_linked');
  assert.equal(identity.user.linked, false);
  assert.equal(identity.effectiveSend, 'bot');
  assert.equal(identity.effectiveReceive, 'bot');
  assert.match(identity.user.hint, /机器人/);
  assert.match(identity.user.hint, /本人/);
});

test('飞书身份视图：FEISHU_IDENTITY=user 未连接 → 仍标本人，明确提示发送会失败（绝不悄悄回退）', () => {
  const tokenFile = tempTokenFile();
  setConfig({ policy: 'user', tokenFile, appId: 'cli_test' });

  const identity = feishuView();
  assert.equal(identity.policy, 'user');
  assert.equal(identity.effectiveSend, 'user');
  assert.match(identity.sendHint, /发送会显式失败/);
  assert.match(identity.user.hint, /发送会显式失败/);
});

test('飞书身份视图：平台 Mock 时收发都标「模拟」，不冒充本人/机器人', () => {
  const tokenFile = tempTokenFile();
  setConfig({ policy: 'auto', tokenFile, appId: 'cli_test', mode: 'mock' });

  const identity = feishuView();
  assert.equal(identity.effectiveSend, 'mock');
  assert.equal(identity.effectiveReceive, 'mock');
  assert.match(identity.sendHint, /模拟发送/);
  assert.match(identity.receiveHint, /模拟/);
});

test('钉钉身份视图：全 Mock 时不探测 dws、不启动个人身份，如实标模拟/不可用', () => {
  const dingtalk = listAccounts().find((a) => a.platform === Platform.DINGTALK)!;
  assert.ok(dingtalk.identity, '钉钉必须下发 identity 视图');
  const identity = dingtalk.identity!;
  assert.equal(identity.policy, 'auto');
  assert.equal(identity.effectiveSend, 'mock');
  assert.equal(identity.effectiveReceive, 'mock');
  assert.equal(identity.user.linkMethod, 'cli');
  assert.match(identity.user.hint, /模拟模式/);
  assert.equal(dingtalk === undefined, false);
});

test('企业微信 / 邮箱不下发 identity（不适用本人身份）', () => {
  const accounts = listAccounts();
  for (const p of [Platform.WECOM, Platform.MAIL]) {
    const view = accounts.find((a) => a.platform === p)!;
    assert.equal(view.identity, undefined);
  }
});