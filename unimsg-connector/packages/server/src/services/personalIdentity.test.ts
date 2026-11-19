/**
 * 钉钉「一登即用」身份自动启用/回退单测（不真实登录、不联网）：
 *  - 登录成功 + 无机器人凭据 + policy=auto → 热应用 user 并持久化（autoApplied 标记）；
 *  - 未登录 / 有机器人凭据 / 显式 bot 策略 → 不改任何配置；
 *  - 注销后仅「自动启用」的 user 回退 auto（显式手写 user 不动）。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Platform } from '@unimsg/shared';
import { config } from '../config';
import { readLocalConfig, sanitizeLocalConfig, writeLocalConfigFile } from './localConfig';
import {
  isDingtalkAutoApplied,
  maybeAutoEnableDingtalkPersonalIdentity,
  maybeRevertDingtalkPersonalIdentity,
} from './personalIdentity';
import { makeTempDir } from '../utils/tempDir';

const dirs: string[] = [];
const original = {
  policy: config.identity.dingtalk.policy,
  runtime: { ...config.runtime[Platform.DINGTALK] },
  dataDir: process.env.DATA_DIR,
  identityEnv: process.env.DINGTALK_IDENTITY,
};

function tempDir(): string {
  const dir = makeTempDir('linkhub-personal-identity-');
  dirs.push(dir);
  return dir;
}

function reset(): string {
  const dir = tempDir();
  process.env.DATA_DIR = dir;
  delete process.env.DINGTALK_IDENTITY;
  config.identity.dingtalk.policy = 'auto';
  Object.assign(config.runtime[Platform.DINGTALK], {
    mode: 'mock', policy: 'auto', configured: false, canSend: false, canReceive: false,
  });
  return dir;
}

beforeEach(() => {
  reset();
});

after(() => {
  config.identity.dingtalk.policy = original.policy;
  Object.assign(config.runtime[Platform.DINGTALK], original.runtime);
  if (original.identityEnv === undefined) delete process.env.DINGTALK_IDENTITY;
  else process.env.DINGTALK_IDENTITY = original.identityEnv;
  if (original.dataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = original.dataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const deps = { authenticated: true, log: () => {}, warn: () => {} };

test('登录成功 + 无机器人凭据 + policy=auto → 自动热应用 user 并持久化（标记 autoApplied）', async () => {
  const dir = reset();
  const result = await maybeAutoEnableDingtalkPersonalIdentity('单测登录成功', deps);
  assert.equal(result.applied, true);
  assert.equal(config.identity.dingtalk.policy, 'user', '运行中 config 立即生效（无需重启）');
  const local = readLocalConfig('/unused', { DATA_DIR: dir }).config;
  assert.equal(local.identity?.dingtalk, 'user', '已持久化，重启后仍 user');
  assert.equal(local.identity?.dingtalkAutoApplied, true, '标记为自动启用（注销时可回退）');
  assert.equal(isDingtalkAutoApplied(), true);
});

test('未登录 / 有机器人凭据 / 显式 bot 策略 → 不改变任何配置', async () => {
  reset();
  const notLogged = await maybeAutoEnableDingtalkPersonalIdentity('未登录', { authenticated: false, log: () => {}, warn: () => {} });
  assert.equal(notLogged.applied, false);
  assert.equal(config.identity.dingtalk.policy, 'auto');

  reset();
  config.runtime[Platform.DINGTALK].configured = true;
  const withBot = await maybeAutoEnableDingtalkPersonalIdentity('有机器人凭据', deps);
  assert.equal(withBot.applied, false, '有机器人凭据时不自动切仅本人身份');
  assert.equal(config.identity.dingtalk.policy, 'auto');

  reset();
  config.identity.dingtalk.policy = 'bot';
  const explicitBot = await maybeAutoEnableDingtalkPersonalIdentity('显式 bot', deps);
  assert.equal(explicitBot.applied, false);
  assert.equal(config.identity.dingtalk.policy, 'bot');
});

test('注销回退：仅「自动启用」的 user 回退 auto 并持久化；显式手写 user 不回退', async () => {
  const dir = reset();
  await maybeAutoEnableDingtalkPersonalIdentity('登录成功', deps);
  assert.equal(config.identity.dingtalk.policy, 'user');

  const reverted = maybeRevertDingtalkPersonalIdentity('用户注销 dws', { log: () => {}, warn: () => {} });
  assert.equal(reverted.reverted, true);
  assert.equal(config.identity.dingtalk.policy, 'auto', '注销后自动回退 auto（避免已启用未登录导致发送失败）');
  const local = readLocalConfig('/unused', { DATA_DIR: dir }).config;
  assert.equal(local.identity?.dingtalk, 'auto');
  assert.equal(local.identity?.dingtalkAutoApplied, undefined, '标记已清除');
  assert.equal(maybeRevertDingtalkPersonalIdentity('再次注销', { log: () => {}, warn: () => {} }).reverted, false, '幂等');

  // 用户显式手写 user（无 autoApplied 标记）→ 注销不回退
  const dir2 = reset();
  writeLocalConfigFile(join(dir2, 'linkhub-config.json'), sanitizeLocalConfig({ identity: { dingtalk: 'user' } }));
  config.identity.dingtalk.policy = 'user';
  const manual = maybeRevertDingtalkPersonalIdentity('用户注销', { log: () => {}, warn: () => {} });
  assert.equal(manual.reverted, false, '手写 user 不自动回退');
  assert.equal(config.identity.dingtalk.policy, 'user');
});

test('显式 .env DINGTALK_IDENTITY=user → 注销不回退（环境变量优先）', async () => {
  const dir = reset();
  await maybeAutoEnableDingtalkPersonalIdentity('登录成功', deps);
  process.env.DINGTALK_IDENTITY = 'user';
  const result = maybeRevertDingtalkPersonalIdentity('注销', { log: () => {}, warn: () => {} });
  assert.equal(result.reverted, false);
  assert.equal(config.identity.dingtalk.policy, 'user');
  const local = readLocalConfig('/unused', { DATA_DIR: dir }).config;
  assert.equal(local.identity?.dingtalk, 'user');
});