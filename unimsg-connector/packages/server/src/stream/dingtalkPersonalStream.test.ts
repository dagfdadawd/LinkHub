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
  ingestPersonalEvent,
  killChildTree,
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
import { learnSelfId } from '../services/echoRegistry';

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

test('buildListenArgs：不含 --flatten（真实 +listen-im 不支持，task-13 P0）', () => {
  const args = buildListenArgs('all-direct');
  assert.deepEqual(args, [
    'event', '+listen-im', '--kind', 'all-direct', '--events', 'message', '-f', 'ndjson', '-y',
  ]);
  assert.ok(!args.includes('--flatten'), '绝不能传 --flatten（真实 dws exit 3 会重启循环）');
  assert.ok(args.includes('--events') && args.includes('message'));
  assert.ok(args.includes('-y'), '自动确认订阅，避免交互式阻塞');
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

test('监管：拉起真实事件子进程的 spawn 参数不含 --flatten（task-13 回归）', async () => {
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

  const captured: string[][] = [];
  class FakeChild2 extends EventEmitter implements SpawnedProcessLike {
    pid = 1;
    stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
    stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
    exitCode: number | null = null;
    kill(): boolean {
      this.exitCode = 0;
      this.emit('exit', 0, null);
      return true;
    }
  }
  const { svc } = makeSvc();
  const stream = new DingtalkPersonalStream(svc, {
    spawnImpl: (_file, args) => {
      captured.push(args);
      return new FakeChild2();
    },
    log: () => {},
    warn: () => {},
  });
  stream.start();
  assert.equal(captured.length, 1);
  const args = captured[0]!;
  assert.ok(args.includes('+listen-im'));
  assert.ok(args.includes('--kind') && args.includes('all-direct'));
  assert.ok(!args.includes('--flatten'), `spawn 参数不得含 --flatten，实际：${args.join(' ')}`);
  await stream.stop(50);
});

test('killChildTree：优先关 stdin 让真实 dws 优雅退订，无 stdin 时才 SIGTERM', async () => {
  const events: string[] = [];
  const child: any = Object.assign(new EventEmitter(), {
    pid: 987,
    exitCode: null as number | null,
    kill: () => { events.push('kill'); return true; },
    stdin: {
      writableEnded: false,
      end() {
        events.push('stdin-end');
        setTimeout(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }, 5);
      },
    },
  });
  await killChildTree(child, 200);
  // Windows：只关 stdin（SIGTERM 在 Windows 上等于 TerminateProcess，dws 来不及退订）；
  // POSIX：关 stdin 后再补一个真实 SIGTERM（实现如此，dws 能优雅退订）。
  const expected = process.platform === 'win32' ? ['stdin-end'] : ['stdin-end', 'kill'];
  assert.deepEqual(events, expected, '有 stdin 时应先关 stdin；POSIX 额外补 SIGTERM');

  const child2: any = Object.assign(new EventEmitter(), { pid: 988, exitCode: null as number | null });
  child2.kill = () => {
    events.push('kill2');
    child2.exitCode = 0;
    child2.emit('exit', 0, null);
    return true;
  };
  await killChildTree(child2, 200);
  assert.ok(events.includes('kill2'), '没有 stdin 时退回 SIGTERM');
});

test('端到端冒烟：真实 fake-dws 个人事件 → 入库 receivedAs=user（关 stdin 优雅退出）', async () => {
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
test('all-group 订阅只留「我自己发的」群消息，别人的群聊不灌进收件箱', async () => {
  const { svc, repo } = makeSvc();
  const self = `od_self_${Date.now()}`;
  learnSelfId(Platform.DINGTALK, self);

  const evt = (senderId: string, id: string) => ({
    messageId: id,
    conversationId: 'cid_group_1',
    content: '[文件] 演示文稿.pptx fileId: abc',
    eventType: 'user_im_message_receive_group_all',
    senderOpenDingtalkId: senderId,
    senderName: senderId === self ? '我' : '同事',
    raw: {},
  });

  // 别人在群里发的：all-group 不入库（仍由 at-me 负责）
  const counters = { ignored: 0 };
  const other = await ingestPersonalEvent(svc, evt('od_other', 'om_other'), counters, undefined, {
    sourceKind: 'all-group',
  });
  assert.equal(other, null);
  assert.equal(counters.ignored, 1);
  assert.equal(repo.list().length, 0);

  // 我在群里发的（本人 ID 已学到）：必须保留
  const mine = await ingestPersonalEvent(svc, evt(self, 'om_mine'), counters, undefined, {
    sourceKind: 'all-group',
  });
  assert.ok(mine, '自己发的群消息必须入库');
  assert.equal(mine.direction, 'out');

  // at-me 订阅不受该过滤影响：别人 @我 的消息照常进入
  const atMe = await ingestPersonalEvent(svc, evt('od_other', 'om_at'), counters, undefined, {
    sourceKind: 'at-me',
  });
  assert.ok(atMe, '@我 的消息不受 all-group 过滤影响');
});
