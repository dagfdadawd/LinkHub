import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { wechatBridgeRouter } from './wechatBridge';
import type { WechatBridgeManager } from '../services/wechatBridgeProcess';
import type { WechatBridgeStatus } from '../services/wechatBridge';

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

function view(patch: Record<string, unknown> = {}) {
  return { managed: true, pid: 123, url: 'http://127.0.0.1:8787', logPath: 'x', bridge: bridge(), ...patch };
}

async function withApp(
  manager: WechatBridgeManager,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', wechatBridgeRouter(manager));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET bridge/status：返回探针与 managed 状态', async () => {
  const manager: WechatBridgeManager = {
    status: async () => view() as never,
    start: async () => view({ started: true }) as never,
    stop: async () => view({ stopped: true }) as never,
  };
  await withApp(manager, async (base) => {
    const res = await fetch(`${base}/api/wechat/bridge/status`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.data.bridge.mode, 'rpa');
    assert.equal(json.data.managed, true);
  });
});

test('POST start：成功返回 200；失败返回 409 和可读原因', async () => {
  let fail = false;
  const manager: WechatBridgeManager = {
    status: async () => view() as never,
    start: async () => (fail
      ? view({ started: false, error: 'Python 未安装' }) as never
      : view({ started: true }) as never),
    stop: async () => view({ stopped: true }) as never,
  };
  await withApp(manager, async (base) => {
    const ok = await fetch(`${base}/api/wechat/bridge/start`, { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);

    fail = true;
    const bad = await fetch(`${base}/api/wechat/bridge/start`, { method: 'POST' });
    assert.equal(bad.status, 409);
    const json = await bad.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /Python/);
  });
});

test('POST stop：非本进程启动返回 409，不冒充成功', async () => {
  const manager: WechatBridgeManager = {
    status: async () => view({ managed: false }) as never,
    start: async () => view({ started: true }) as never,
    stop: async () => view({ stopped: false, error: '不是由 LinkHub 启动' }) as never,
  };
  await withApp(manager, async (base) => {
    const res = await fetch(`${base}/api/wechat/bridge/stop`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /不是由 LinkHub 启动/);
  });
});
