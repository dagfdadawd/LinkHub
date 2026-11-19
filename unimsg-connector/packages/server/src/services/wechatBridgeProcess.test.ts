import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import {
  createWechatBridgeManager,
  isLoopbackHost,
  type WechatBridgeManagerDeps,
} from './wechatBridgeProcess';
import type { WechatBridgeStatus } from './wechatBridge';

function bridge(patch: Partial<WechatBridgeStatus> = {}): WechatBridgeStatus {
  return {
    state: 'rpa',
    url: 'http://127.0.0.1:8787',
    reachable: true,
    mode: 'rpa',
    canSend: true,
    canReceive: true,
    receiveMode: 'auto',
    receiveReason: 'ok',
    reportedReceive: true,
    checkedAt: new Date().toISOString(),
    ...patch,
  };
}

class FakeChild extends EventEmitter {
  pid = 4321;
  exitCode: number | null = null;
  killed = false;
  unrefCalled = false;

  unref(): void {
    this.unrefCalled = true;
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
}

function makeManager(overrides: Partial<WechatBridgeManagerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-bridge-manager-'));
  const scriptPath = join(dir, 'rpa_bridge.py');
  writeFileSync(scriptPath, '# fake\n');
  const logPath = join(dir, 'bridge.log');
  const pidPath = join(dir, 'bridge.pid');
  const child = new FakeChild();
  const calls: { command?: string; args?: string[]; options?: unknown } = {};
  let probes = 0;
  const deps: WechatBridgeManagerDeps = {
    probe: async () => {
      probes += 1;
      return probes === 1 ? bridge({ reachable: false, state: 'unreachable', canSend: false, receiveMode: 'none' }) : bridge();
    },
    spawn: (command, args, options) => {
      calls.command = command;
      calls.args = args;
      calls.options = options;
      return child as unknown as ChildProcess;
    },
    wait: async () => {},
    scriptPath,
    python: 'python',
    host: '127.0.0.1',
    port: 8787,
    linkhubBase: 'http://127.0.0.1:3001',
    logPath,
    pidPath,
    platform: 'win32',
    ...overrides,
  };
  return { manager: createWechatBridgeManager(deps), calls, child, scriptPath };
}

test('isLoopbackHost：只认本机，局域网/公网 false', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('192.168.1.4'), false);
  assert.equal(isLoopbackHost('10.0.0.2'), false);
});

test('start：自动拉起固定参数的桥，并等到 /health 可达', async () => {
  const { manager, calls, child, scriptPath } = makeManager();
  const result = await manager.start();
  assert.equal(result.started, true);
  assert.equal(result.managed, true);
  assert.equal(result.pid, 4321);
  assert.equal(calls.command, 'python');
  assert.deepEqual(calls.args, [
    scriptPath,
    '--mode', 'rpa',
    '--port', '8787',
    '--linkhub', 'http://127.0.0.1:3001',
  ]);
  assert.equal(child.unrefCalled, true);
});

test('start：桥已可达时返回 alreadyRunning，不再 spawn', async () => {
  const { manager, calls } = makeManager({
    probe: async () => bridge(),
  });
  const result = await manager.start();
  assert.equal(result.started, false);
  assert.equal(result.alreadyRunning, true);
  assert.equal(calls.command, undefined);
});

test('start：非本机桥地址直接拒绝（A 形态不启动远程桥）', async () => {
  const { manager } = makeManager({ host: '192.168.1.9' });
  const result = await manager.start();
  assert.equal(result.started, false);
  assert.match(result.error ?? '', /只允许启动本机/);
});

test('start：脚本不存在时给出可读错误，不 spawn', async () => {
  const { manager, calls } = makeManager({ scriptPath: join(tmpdir(), 'missing-rpa_bridge.py') });
  const result = await manager.start();
  assert.equal(result.started, false);
  assert.match(result.error ?? '', /找不到桥脚本/);
  assert.equal(calls.command, undefined);
});

test('stop：只停止本进程启动的桥', async () => {
  const { manager, child } = makeManager();
  const started = await manager.start();
  assert.equal(started.started, true);
  const stopped = await manager.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(child.killed, true);
});

test('stop：手动启动的桥不冒充可停止', async () => {
  const { manager } = makeManager({ probe: async () => bridge() });
  const stopped = await manager.stop();
  assert.equal(stopped.stopped, false);
  assert.match(stopped.error ?? '', /不是由 LinkHub 启动/);
});
