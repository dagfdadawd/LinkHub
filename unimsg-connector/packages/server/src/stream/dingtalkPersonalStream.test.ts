/**
 * 钉钉个人事件子进程监管单测：
 *  - 纯函数（重启退避 / listen 参数 / NDJSON 容错 / 退出原因分类）；
 *  - 注入 spawn 的监管逻辑（退出重启、优雅关闭）；
 *  - 真实 fake-dws 子进程端到端冒烟（NDJSON → UnifiedMessage(receivedAs=user) → 入库）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from '@unimsg/shared';
import {
  DingtalkPersonalStream,
  buildListenArgs,
  classifyStreamExit,
  parseStreamLine,
  restartDelay,
  type SpawnedProcessLike,
} from './dingtalkPersonalStream';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from '../services/llm';
import { OcrService } from '../services/ocr';
import { RateLimiter } from '../services/rateLimiter';
import { MessageService } from '../services/message';
import { config } from '../config';
import {
  dingtalkPersonalClient,
  resetDingtalkPersonalClientCache,
} from '../connectors/dingtalkPersonal';
import { resetIdentityCaches } from '../services/identity';

const FAKE_DWS = fileURLToPath(new URL('../../../../scripts/fake-dws.mjs', import.meta.url));
const dirs: string[] = [];
const original = {
  mode: { ...config.runtime[Platform.DINGTALK] },
  bin: config.identity.dingtalk.bin,
  kinds: config.identity.dingtalk.eventKinds,
  policy: config.identity.dingtalk.policy,
  state: process.env.FAKE_DWS_STATE_FILE,
  interval: process.env.FAKE_DWS_EVENT_INTERVAL_MS,
};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-dws-stream-'));
  dirs.push(dir);
  return dir;
}

function makeSvc(): { svc: MessageService; repo: InMemoryRepository } {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  return { svc, repo };
}

async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

after(() => {
  Object.assign(config.runtime[Platform.DINGTALK], original.mode);
  config.identity.dingtalk.bin = original.bin;
  config.identity.dingtalk.eventKinds = original.kinds;
  config.identity.dingtalk.policy = original.policy;
  if (original.state === undefined) delete process.env.FAKE_DWS_STATE_FILE;
  else process.env.FAKE_DWS_STATE_FILE = original.state;
  if (original.interval === undefined) delete process.env.FAKE_DWS_EVENT_INTERVAL_MS;
  else process.env.FAKE_DWS_EVENT_INTERVAL_MS = original.interval;
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('restartDelay：1s→2s→4s…上限 60s', () => {
  assert.deepEqual([1, 2, 3, 4, 7, 10, 99].map(restartDelay), [1000, 2000, 4000, 8000, 64000 > 60000 ? 60000 : 64000, 60000, 60000]);
  assert.equal(restartDelay(7), 60000);
  assert.equal(restartDelay(2 ** 20), 60000);
});

test('buildListenArgs：--kind / --events message / --flatten / ndjson', () => {
  const args = buildListenArgs('all-direct');
  assert.deepEqual(args, [
    'event', '+listen-im', '--kind', 'all-direct', '--events', 'message', '--flatten', '-f', 'ndjson', '-y',
  ]);
});

test('parseStreamLine / classifyStreamExit：NDJSON 容错与未登录中文提示', () => {
  const line = JSON.stringify({ payload: { message_id: 'om_1', content: 'hi', conversation_id: 'cid_1' } });
  const parsed = parseStreamLine(line);
  assert.equal(parsed.event?.messageId, 'om_1');
  assert.equal(parseStreamLine('WARN: 诊断').event, undefined);

  const notLogged = classifyStreamExit(5, 'load access token: reading secure data file');
  assert.equal(notLogged.kind, 'not-logged-in');
  assert.match(notLogged.message, /dws auth login/);
  assert.equal(classifyStreamExit(1, 'permission denied').kind, 'permission');
  assert.equal(classifyStreamExit(1, "spawn dws ENOENT").kind, 'not-installed');
  assert.equal(classifyStreamExit(0, '').kind, 'exited');
});

test('监管：子进程退出后按退避重启，日志说明第 N 次重启；stop 后不再重启', async () => {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const timers: (() => void)[] = [];

  class FakeChild extends EventEmitter implements SpawnedProcessLike {
    pid = 1000 + children.length;
    stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
    stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
    exitCode: number | null = null;
    killed = false;
    kill(): boolean {
      this.killed = true;
      this.exitCode = 0;
      this.emit('exit', 0, null);
      return true;
    }
  }

  // 构造：强制真实模式 + 已登录（注入 fake-dws 状态探测由 client 真实执行，很快）
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.eventKinds = ['all-direct'];
  config.runtime[Platform.DINGTALK].mode = 'real';
  config.runtime[Platform.DINGTALK].policy = 'real';
  config.runtime[Platform.DINGTALK].canSend = true;
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  await dingtalkPersonalClient().authStatus({ force: true });

  const { svc } = makeSvc();
  const stream = new DingtalkPersonalStream(svc, {
    spawnImpl: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimeoutImpl: (fn) => {
      timers.push(fn);
      return 0 as any;
    },
    clearTimeoutImpl: () => {},
    log: (l) => logs.push(l),
    warn: (l) => warns.push(l),
  });
  stream.start();
  assert.equal(children.length, 1, '启动一个事件范围一个子进程');

  // 模拟崩溃退出
  children[0]!.exitCode = 1;
  children[0]!.emit('exit', 1, null);
  assert.ok(warns.some((w) => /第 1 次重启将在 1s 后执行/.test(w)), `应说明重启：${warns.join('|')}`);
  assert.equal(timers.length, 1);
  timers.shift()!();
  assert.equal(children.length, 2, '退避到点后重新拉起');

  // 稳定运行 >30s 后退避计数归零的逻辑由单测覆盖 restartDelay，这里只验证 stop 不再重启
  await stream.stop(50);
  assert.ok(logs.some((l) => /已停止/.test(l)));
  assert.equal(children[1]!.killed, true, 'stop 必须终止子进程');
});

test('端到端冒烟：真实 fake-dws 个人事件 → 入库 receivedAs=user（SIGTERM 优雅退出）', async () => {
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  process.env.FAKE_DWS_EVENT_INTERVAL_MS = '100';
  config.identity.dingtalk.bin = `node ${FAKE_DWS}`;
  config.identity.dingtalk.eventKinds = ['all-direct'];
  config.runtime[Platform.DINGTALK].mode = 'real';
  config.runtime[Platform.DINGTALK].policy = 'real';
  config.runtime[Platform.DINGTALK].canSend = true;
  resetDingtalkPersonalClientCache();
  resetIdentityCaches();
  await dingtalkPersonalClient().authStatus({ force: true });

  const { svc, repo } = makeSvc();
  const logs: string[] = [];
  const stream = new DingtalkPersonalStream(svc, { log: (l) => logs.push(l), warn: (l) => logs.push(l) });
  stream.start();
  try {
    await waitFor(() => repo.list({ platform: Platform.DINGTALK }).length > 0, 10_000);
    const msg = repo.list({ platform: Platform.DINGTALK })[0]!;
    assert.match(msg.externalId, /^dingtalk:fake-open-message-/);
    assert.equal(msg.receivedAs, 'user');
    assert.equal(msg.conversation?.type, 'p2p');
    assert.match(msg.body, /fake-dws 模拟消息|季度复盘|待办/);
    assert.ok(logs.some((l) => /dws 个人事件订阅就绪|已启动 dws 个人事件订阅/.test(l)), logs.join('\n'));
  } finally {
    const started = Date.now();
    await stream.stop(5_000);
    assert.ok(Date.now() - started < 5_000, '优雅关闭应在超时前完成（SIGTERM）');
  }
  // 重复事件不会重复入库（fake-dws 每 100ms 一条，关停前可能已进多条，但 externalId 唯一）
  const ids = repo.list({ platform: Platform.DINGTALK }).map((m) => m.externalId);
  assert.equal(new Set(ids).size, ids.length, '幂等键唯一');
});