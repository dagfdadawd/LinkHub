/**
 * 本人身份接收通道协调器单测：
 *  - start/stop 决策、幂等（重复 reconcile 不重复起）、串行化；
 *  - 「运行中完成登录」场景：fake-dws 状态文件 未登录→已登录，无需重启后端即启动接收；
 *  - 注销后停止接收。
 * 真实子进程启动器全部注入，测试不依赖本机 dws、不启长驻子进程。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform, type PlatformIdentityView } from '@unimsg/shared';
import { config } from '../config';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from '../services/llm';
import { OcrService } from '../services/ocr';
import { RateLimiter } from '../services/rateLimiter';
import { MessageService } from '../services/message';
import { resetDingtalkPersonalClientCache } from '../connectors/dingtalkPersonal';
import { resetIdentityCaches } from '../services/identity';
import { IdentityChannelsCoordinator } from './identityChannels';
import { makeTempDir } from '../utils/tempDir';

const FAKE_DWS = fileURLToPath(new URL('../../../../scripts/fake-dws.mjs', import.meta.url));
const dirs: string[] = [];
const original = {
  bin: config.identity.dingtalk.bin,
  policy: config.identity.dingtalk.policy,
  runtime: Object.fromEntries(Object.values(Platform).map((p) => [p, { ...config.runtime[p] }])) as Record<string, any>,
  state: process.env.FAKE_DWS_STATE_FILE,
  auth: process.env.FAKE_DWS_AUTHENTICATED,
  delay: process.env.FAKE_DWS_LOGIN_DELAY_MS,
};

function tempDir(): string {
  const dir = makeTempDir('linkhub-identity-channels-');
  dirs.push(dir);
  return dir;
}

function makeSvc(): MessageService {
  return new MessageService(
    new InMemoryRepository(), connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
}

function viewStub(platform: Platform, effectiveReceive: 'user' | 'bot' | 'mock'): PlatformIdentityView {
  return { effectiveReceive } as unknown as PlatformIdentityView;
}

beforeEach(() => {
  config.identity.dingtalk.bin = original.bin;
  config.identity.dingtalk.policy = original.policy;
  for (const [platform, snapshot] of Object.entries(original.runtime)) Object.assign(config.runtime[platform as Platform], snapshot);
  for (const [key, value] of Object.entries({
    FAKE_DWS_STATE_FILE: original.state,
    FAKE_DWS_AUTHENTICATED: original.auth,
    FAKE_DWS_LOGIN_DELAY_MS: original.delay,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
});

after(() => {
  config.identity.dingtalk.bin = original.bin;
  config.identity.dingtalk.policy = original.policy;
  for (const [platform, snapshot] of Object.entries(original.runtime)) Object.assign(config.runtime[platform as Platform], snapshot);
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('reconcile：按 identity.effectiveReceive start/stop，幂等且串行（重复触发不重复起通道）', async () => {
  let feishuState: 'user' | 'bot' | 'mock' = 'bot';
  let dingtalkState: 'user' | 'bot' | 'mock' = 'mock';
  let feishuStarts = 0;
  let feishuStops = 0;
  let dingtalkStarts = 0;
  let dingtalkStops = 0;
  let refreshes = 0;
  const logs: string[] = [];

  const coordinator = new IdentityChannelsCoordinator(makeSvc(), {
    log: (line) => logs.push(line),
    resolveView: ((platform: Platform) => (platform === Platform.FEISHU
      ? viewStub(platform, feishuState)
      : viewStub(platform, dingtalkState))) as typeof import('./identity').resolveIdentity,
    refreshDingtalkStatus: async () => { refreshes += 1; },
    startFeishuPoller: () => {
      feishuStarts += 1;
      return { stop: () => { feishuStops += 1; } };
    },
    startDingtalkStream: () => {
      dingtalkStarts += 1;
      return { stop: async () => { dingtalkStops += 1; } } as any;
    },
  });

  await coordinator.reconcile();
  assert.deepEqual(coordinator.snapshot(), { feishuUserPoller: false, dingtalkPersonalStream: false });
  assert.equal(feishuStarts + dingtalkStarts, 0);
  assert.equal(refreshes, 1, '每次 reconcile 都应刷新钉钉登录态');

  feishuState = 'user';
  dingtalkState = 'user';
  await coordinator.reconcile();
  assert.deepEqual(coordinator.snapshot(), { feishuUserPoller: true, dingtalkPersonalStream: true });
  assert.equal(feishuStarts, 1);
  assert.equal(dingtalkStarts, 1);
  assert.ok(logs.some((l) => l.includes('飞书本人身份可用')), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('钉钉本人身份已连接')), logs.join('\n'));

  // 重复 reconcile 不重复起子进程/轮询
  await coordinator.reconcile();
  await coordinator.reconcile();
  assert.equal(feishuStarts, 1);
  assert.equal(dingtalkStarts, 1);

  // 并发触发：串行化后仍不重复
  await Promise.all([coordinator.reconcile(), coordinator.reconcile(), coordinator.reconcile()]);
  assert.equal(feishuStarts, 1);
  assert.equal(dingtalkStarts, 1);

  // 身份不可用 → stop
  feishuState = 'bot';
  dingtalkState = 'mock';
  await coordinator.reconcile();
  assert.deepEqual(coordinator.snapshot(), { feishuUserPoller: false, dingtalkPersonalStream: false });
  assert.equal(feishuStops, 1);
  assert.equal(dingtalkStops, 1);
  assert.ok(logs.some((l) => l.includes('停止个人事件接收')), logs.join('\n'));

  // stopAll 幂等
  await coordinator.stopAll();
  assert.deepEqual(coordinator.snapshot(), { feishuUserPoller: false, dingtalkPersonalStream: false });
});

test('运行中完成钉钉登录：fake-dws 状态 false→true 后 reconcile 自动启动接收；再变 false 停止（无需重启后端）', async () => {
  const dir = tempDir();
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ authenticated: false }), 'utf8');
  process.env.FAKE_DWS_STATE_FILE = stateFile;
  delete process.env.FAKE_DWS_AUTHENTICATED;
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.policy = 'auto';
  // 真实模式：identityChannelsReal 为真，才会探测 dws/启动事件流
  Object.assign(config.runtime[Platform.DINGTALK], {
    mode: 'real', policy: 'real', canSend: true, canReceive: true,
  });
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();

  const logs: string[] = [];
  let dingtalkStarts = 0;
  let dingtalkStops = 0;
  const coordinator = new IdentityChannelsCoordinator(makeSvc(), {
    log: (line) => logs.push(line),
    startFeishuPoller: () => null,
    startDingtalkStream: () => {
      dingtalkStarts += 1;
      return { stop: async () => { dingtalkStops += 1; } } as any;
    },
  });

  // 未登录：不应启动接收
  await coordinator.reconcile();
  assert.equal(coordinator.snapshot().dingtalkPersonalStream, false);
  assert.equal(dingtalkStarts, 0);

  // 模拟用户在运行中完成登录（浏览器授权成功会写 token / fake-dws 写状态文件）
  writeFileSync(stateFile, JSON.stringify({ authenticated: true }), 'utf8');
  resetIdentityCaches();
  await coordinator.reconcile();
  assert.equal(coordinator.snapshot().dingtalkPersonalStream, true, '运行中登录后应自动启动接收');
  assert.equal(dingtalkStarts, 1);
  assert.ok(logs.some((l) => l.includes('检测到钉钉本人身份已连接，启动个人事件接收')), logs.join('\n'));

  // 再 reconcile 不重复起
  await coordinator.reconcile();
  assert.equal(dingtalkStarts, 1);

  // 注销 / 登录失效 → 停止接收
  writeFileSync(stateFile, JSON.stringify({ authenticated: false }), 'utf8');
  resetIdentityCaches();
  await coordinator.reconcile();
  assert.equal(coordinator.snapshot().dingtalkPersonalStream, false);
  assert.equal(dingtalkStops, 1);
  assert.ok(logs.some((l) => l.includes('停止个人事件接收')), logs.join('\n'));
});