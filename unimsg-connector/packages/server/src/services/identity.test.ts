/**
 * 统一身份解析单测：本人 / 机器人 / 模拟 三态 + 「仅本人身份」部署边界 + 发送校验。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from '@unimsg/shared';
import { config } from '../config';
import { resetFeishuUserAuthCache } from '../connectors/feishuUserAuth';
import {
  dingtalkPersonalClient,
  resetDingtalkPersonalClientCache,
} from '../connectors/dingtalkPersonal';
import {
  IdentityUnavailableError,
  assertIdentityUsable,
  canSendAsUser,
  identityChannelsReal,
  identityStartupLines,
  identitySummary,
  receiveEnabled,
  resetIdentityCaches,
  resolveIdentity,
  setFeishuReceiveError,
  warmIdentityProbes,
} from './identity';

const FAKE_DWS = fileURLToPath(new URL('../../../../scripts/fake-dws.mjs', import.meta.url));
const dirs: string[] = [];
const original = {
  feishu: { ...config.identity.feishu },
  dingtalk: { ...config.identity.dingtalk },
  feishuAuth: { ...config.feishuAuth },
  feishuAppId: config.platforms.feishu.appId,
  runtime: Object.fromEntries(Object.values(Platform).map((p) => [p, { ...config.runtime[p] }])) as Record<string, any>,
  fakeState: process.env.FAKE_DWS_STATE_FILE,
  fakeAuth: process.env.FAKE_DWS_AUTHENTICATED,
};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-identity-'));
  dirs.push(dir);
  return dir;
}

function writeFeishuToken(file: string, accessExpiresAt = Date.now() + 3600_000): void {
  writeFileSync(file, JSON.stringify({
    appId: 'cli_test',
    accessToken: 'u-secret-token',
    refreshToken: 'ur-secret-refresh',
    accessExpiresAt,
    refreshExpiresAt: Date.now() + 86_400_000,
    authorizedAt: new Date().toISOString(),
  }), 'utf8');
}

function setRuntime(platform: Platform, patch: Partial<typeof config.runtime[Platform]>): void {
  Object.assign(config.runtime[platform], patch);
}

function resetAll(): void {
  config.identity.feishu = { ...original.feishu };
  config.identity.dingtalk = { ...original.dingtalk };
  config.feishuAuth = { ...original.feishuAuth };
  config.platforms.feishu.appId = original.feishuAppId;
  for (const [platform, snapshot] of Object.entries(original.runtime)) Object.assign(config.runtime[platform as Platform], snapshot);
  resetFeishuUserAuthCache();
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
}

beforeEach(() => {
  resetAll();
  if (original.fakeState === undefined) delete process.env.FAKE_DWS_STATE_FILE;
  else process.env.FAKE_DWS_STATE_FILE = original.fakeState;
  if (original.fakeAuth === undefined) delete process.env.FAKE_DWS_AUTHENTICATED;
  else process.env.FAKE_DWS_AUTHENTICATED = original.fakeAuth;
});

after(() => {
  resetAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('receiveEnabled：auto 跟随策略，true/false 强制', () => {
  assert.equal(receiveEnabled('auto', 'auto'), true);
  assert.equal(receiveEnabled('bot', 'auto'), false);
  assert.equal(receiveEnabled('user', 'auto'), true);
  assert.equal(receiveEnabled('user', false), false);
  assert.equal(receiveEnabled('bot', true), true);
});

test('全 Mock：收发都标「模拟」，不探测 dws、不起子进程', async () => {
  for (const p of Object.values(Platform)) setRuntime(p, { mode: 'mock', policy: 'mock' });
  resetDingtalkPersonalClientCache();
  const feishu = resolveIdentity(Platform.FEISHU);
  assert.equal(feishu.effectiveSend, 'mock');
  assert.equal(feishu.effectiveReceive, 'mock');
  assert.match(feishu.sendHint, /模拟发送/);

  const dingtalk = resolveIdentity(Platform.DINGTALK);
  assert.equal(dingtalk.effectiveSend, 'mock');
  assert.match(dingtalk.user.hint, /模拟模式/);
  assert.equal(dingtalkPersonalClient().lastKnownStatus(), undefined, 'Mock 下不得触发 dws 探测');

  const summary = identitySummary();
  assert.equal(summary.feishu!.send, 'mock');
  assert.equal(summary.dingtalk!.receive, 'mock');

  const lines = identityStartupLines();
  assert.match(lines[0]!, /身份:/);
  assert.match(lines[0]!, /企业微信=不适用/);
  assert.match(lines[0]!, /邮箱=不适用/);
});

test('飞书本人已授权 + auto：收发都是本人，且不下发令牌', () => {
  const dir = tempDir();
  const tokenFile = join(dir, 'token.json');
  writeFeishuToken(tokenFile);
  config.identity.feishu.policy = 'auto';
  config.feishuAuth.sendAs = 'auto';
  config.feishuAuth.tokenFile = tokenFile;
  config.platforms.feishu.appId = 'cli_test';
  setRuntime(Platform.FEISHU, { mode: 'real', policy: 'real', canSend: true, canReceive: true });
  resetFeishuUserAuthCache();

  const view = resolveIdentity(Platform.FEISHU);
  assert.equal(view.effectiveSend, 'user');
  assert.equal(view.effectiveReceive, 'user');
  assert.equal(view.user.state, 'linked');
  assert.equal(view.user.linked, true);
  assert.ok(view.user.expiresAt);
  assert.match(view.user.hint, /本人/);
  assert.match(view.receiveHint, /用户轮询/);
  assert.ok(!JSON.stringify(view).includes('u-secret-token'));
});

test('飞书 FEISHU_IDENTITY=user 未连接：绝不悄悄回退，发送校验 400 类错误', () => {
  const dir = tempDir();
  config.identity.feishu.policy = 'user';
  config.feishuAuth.sendAs = 'user';
  config.feishuAuth.tokenFile = join(dir, 'missing.json');
  config.platforms.feishu.appId = 'cli_test';
  setRuntime(Platform.FEISHU, { mode: 'real', policy: 'real', canSend: true, canReceive: true });
  resetFeishuUserAuthCache();

  const view = resolveIdentity(Platform.FEISHU);
  assert.equal(view.effectiveSend, 'user');
  assert.match(view.sendHint, /发送会显式失败/);
  assert.throws(
    () => assertIdentityUsable(Platform.FEISHU, 'user'),
    (e: unknown) => e instanceof IdentityUnavailableError
      && /飞书本人身份未连接/.test(e.message)
      && /连接本人账号/.test(e.message)
      && /identity=bot/.test(e.message),
  );
  assert.equal(canSendAsUser(Platform.FEISHU), false);
});

test('飞书接收轮询错误写进 hint（权限修复提示可见）', () => {
  const dir = tempDir();
  const tokenFile = join(dir, 'token.json');
  writeFeishuToken(tokenFile);
  config.feishuAuth.tokenFile = tokenFile;
  config.feishuAuth.sendAs = 'auto';
  config.identity.feishu.policy = 'auto';
  config.platforms.feishu.appId = 'cli_test';
  setRuntime(Platform.FEISHU, { mode: 'real', policy: 'real', canSend: true, canReceive: true });
  resetFeishuUserAuthCache();
  setFeishuReceiveError('飞书用户身份缺少「读消息」权限（错误码 99991672）：请开通 im:message');
  const hint = resolveIdentity(Platform.FEISHU).user.hint;
  assert.match(hint, /接收轮询失败/);
  assert.match(hint, /99991672/);
});

test('钉钉「仅本人身份」：auto 无机器人凭据 + DINGTALK_IDENTITY=user + dws 已登录 → 收发本人（identityChannelsReal）', async () => {
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.policy = 'user';
  setRuntime(Platform.DINGTALK, {
    mode: 'mock',
    policy: 'auto',
    configured: false,
    canSend: false,
    canReceive: false,
    missing: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'],
  });
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  await dingtalkPersonalClient().authStatus({ force: true });

  assert.equal(identityChannelsReal(Platform.DINGTALK), true);
  const view = resolveIdentity(Platform.DINGTALK);
  assert.equal(view.effectiveSend, 'user');
  assert.equal(view.effectiveReceive, 'user');
  assert.match(view.sendHint, /本人身份通道/);
  assert.match(view.receiveHint, /本人身份通道/);
  assert.match(view.user.detail ?? '', /dws v1\.0\.68-beta\.1/);
  assert.equal((view.user.detail ?? '').split('dws v1.0.68-beta.1').length - 1, 1, '版本只能出现一次');
  assert.doesNotThrow(() => assertIdentityUsable(Platform.DINGTALK, 'user'));
});

test('钉钉显式 mock 时「仅本人身份」例外不触发（绝不外呼）', async () => {
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.policy = 'user';
  setRuntime(Platform.DINGTALK, { mode: 'mock', policy: 'mock', configured: false, canSend: false, canReceive: false });
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();

  assert.equal(identityChannelsReal(Platform.DINGTALK), false);
  const view = resolveIdentity(Platform.DINGTALK);
  assert.equal(view.effectiveSend, 'mock');
  assert.equal(dingtalkPersonalClient().lastKnownStatus(), undefined, '显式 mock 不得探测 dws');
  // 模拟模式下不阻止 identity 指定（不写 delivery.identity，绝不冒充真实身份）
  assert.doesNotThrow(() => assertIdentityUsable(Platform.DINGTALK, 'user'));
});

test('钉钉未登录 + DINGTALK_IDENTITY=user：发送校验中文报错，不产生假成功', async () => {
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  process.env.FAKE_DWS_AUTHENTICATED = 'false';
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.policy = 'user';
  setRuntime(Platform.DINGTALK, { mode: 'real', policy: 'real', canSend: true, canReceive: true });
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  await dingtalkPersonalClient().authStatus({ force: true });

  const view = resolveIdentity(Platform.DINGTALK);
  assert.equal(view.user.state, 'not_linked');
  assert.equal(view.user.linked, false);
  assert.match(view.user.hint, /未登录|dws auth login/);
  assert.throws(
    () => assertIdentityUsable(Platform.DINGTALK, 'user'),
    (e: unknown) => e instanceof IdentityUnavailableError
      && /钉钉本人身份未连接/.test(e.message)
      && /连接本人账号/.test(e.message),
  );
  assert.throws(() => assertIdentityUsable(Platform.WECOM, 'user'), IdentityUnavailableError);
});

test('warmIdentityProbes：钉钉档案名进 displayName，detail 不重复版本', async () => {
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.policy = 'user';
  setRuntime(Platform.DINGTALK, { mode: 'mock', policy: 'auto', configured: false, canSend: false, canReceive: false });
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();

  await warmIdentityProbes();
  const view = resolveIdentity(Platform.DINGTALK);
  assert.equal(view.user.displayName, '张三（模拟）');
  assert.match(view.user.detail ?? '', /档案/);
  assert.match(view.user.detail ?? '', /已脱敏/);
  assert.equal((view.user.detail ?? '').split('dws v1.0.68-beta.1').length - 1, 1);
});

test('assertIdentityUsable：机器人身份不可用时给中文可操作错误', () => {
  config.identity.dingtalk.policy = 'auto';
  setRuntime(Platform.DINGTALK, { mode: 'real', policy: 'real', canSend: false, canReceive: false, missing: ['DINGTALK_CLIENT_ID'] });
  setRuntime(Platform.DINGTALK, { mode: 'real' });
  assert.throws(
    () => assertIdentityUsable(Platform.DINGTALK, 'bot'),
    (e: unknown) => e instanceof IdentityUnavailableError && /机器人通道当前不可用/.test(e.message),
  );
  // 不传 identity 时不校验（由连接器按 policy 解析）
  assert.doesNotThrow(() => assertIdentityUsable(Platform.DINGTALK, undefined));
});

test('NEW-P2-3 机器人不可用提示：本人未连接时引导先连接，已连接时才建议改用 identity=user', async () => {
  // 未连接本人身份：不能建议「改用 identity=user」（用户选不了）
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  process.env.FAKE_DWS_AUTHENTICATED = 'false';
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.policy = 'auto';
  setRuntime(Platform.DINGTALK, {
    mode: 'real', policy: 'real', canSend: false, canReceive: false, missing: ['DINGTALK_CLIENT_ID'],
  });
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  await dingtalkPersonalClient().authStatus({ force: true });
  assert.throws(
    () => assertIdentityUsable(Platform.DINGTALK, 'bot'),
    (e: unknown) => e instanceof IdentityUnavailableError
      && /机器人通道当前不可用/.test(e.message)
      && /先在「平台账号」页连接本人身份/.test(e.message)
      && !/或改用 identity=user 以本人身份发送/.test(e.message),
  );

  // 已连接本人身份：保留「或改用 identity=user」原建议
  delete process.env.FAKE_DWS_AUTHENTICATED;
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  await dingtalkPersonalClient().authStatus({ force: true });
  assert.throws(
    () => assertIdentityUsable(Platform.DINGTALK, 'bot'),
    (e: unknown) => e instanceof IdentityUnavailableError
      && /或改用 identity=user 以本人身份发送/.test(e.message),
  );
});
