/**
 * 微信 RPA 桥「运行态」探针单测。
 *
 * 用本地 http 服务模拟桥的 /health，不碰真实微信、不联网。
 * 这层是 P0 的判定依据：桥在 mock、或接收没实现，都必须落到 canReceive=false。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { probeWechatBridge, resetWechatBridgeCache, wechatBridgeStatus } from './wechatBridge';

async function withHealth(
  handler: (path: string) => { status: number; body: unknown } | undefined,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const out = handler(req.url ?? '/');
    if (!out) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('桥 mock → 发送也不可用；不能只拦接收却让发送卡 7 秒', async () => {
  await withHealth(
    () => ({ status: 200, body: { ok: true, mode: 'mock' } }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal((s as { canSend?: boolean }).canSend, false);
      assert.equal((s as { receiveMode?: string }).receiveMode, 'none');
    },
  );
});

test('桥 rpa + 4.x：发送可用，接收标 pull（不是 none，也不是 auto）', async () => {
  await withHealth(
    () => ({
      status: 200,
      body: {
        ok: true,
        mode: 'rpa',
        receive: { implemented: true, supported: false, reason: '4.x 无控件树' },
        client: { kind: 'weixin4', uiaUsable: false, reason: '4.x 无控件树' },
        pull: { available: true },
      },
    }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal((s as { canSend?: boolean }).canSend, true);
      assert.equal(s.canReceive, false);
      assert.equal((s as { receiveMode?: string }).receiveMode, 'pull');
    },
  );
});

test('桥 rpa + 3.x 自动接收可用 → receiveMode=auto', async () => {
  await withHealth(
    () => ({
      status: 200,
      body: { ok: true, mode: 'rpa', receive: { implemented: true, supported: true } },
    }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal((s as { canSend?: boolean }).canSend, true);
      assert.equal((s as { receiveMode?: string }).receiveMode, 'auto');
    },
  );
});

test('桥 rpa + 接收已实现且可用 → canReceive=true', async () => {
  await withHealth(
    () => ({
      status: 200,
      body: { ok: true, mode: 'rpa', receive: { implemented: true, supported: true } },
    }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal(s.reachable, true);
      assert.equal(s.state, 'rpa');
      assert.equal(s.canReceive, true);
      assert.match(s.receiveReason, /轮询/);
    },
  );
});

test('桥 rpa 但读不到窗口（supported=false）→ canReceive=false，原因透传', async () => {
  await withHealth(
    () => ({
      status: 200,
      body: {
        ok: true,
        mode: 'rpa',
        receive: { implemented: true, supported: false, reason: '未找到微信主窗口' },
      },
    }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal(s.state, 'rpa');
      assert.equal(s.canReceive, false);
      assert.equal(s.receiveReason, '未找到微信主窗口');
    },
  );
});

test('桥在 mock 模式 → canReceive=false（并说明不会操作微信）', async () => {
  await withHealth(
    () => ({ status: 200, body: { ok: true, mode: 'mock' } }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal(s.state, 'mock');
      assert.equal(s.canReceive, false);
      assert.match(s.receiveReason, /mock 模式/);
    },
  );
});

test('旧版桥没上报 receive → 按未实现处理，绝不乐观假设', async () => {
  await withHealth(
    () => ({ status: 200, body: { ok: true, mode: 'rpa' } }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal(s.state, 'rpa');
      assert.equal(s.reportedReceive, false);
      assert.equal(s.canReceive, false);
      assert.match(s.receiveReason, /版本过旧/);
    },
  );
});

test('桥不可达 → state=unreachable，带可读原因（不抛异常）', async () => {
  const s = await probeWechatBridge({ url: 'http://127.0.0.1:1', timeoutMs: 400 });
  assert.equal(s.state, 'unreachable');
  assert.equal(s.reachable, false);
  assert.equal(s.canReceive, false);
  assert.ok(s.receiveReason.includes('连不上本机 RPA 桥'));
});

test('桥返回非 200 → 同样按不可达处理', async () => {
  await withHealth(
    () => ({ status: 500, body: { ok: false } }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal(s.state, 'unreachable');
      assert.match(s.receiveReason, /HTTP 500/);
    },
  );
});

test('缓存：5s 内复用结果，maxAgeMs=0 强制重探', async () => {
  resetWechatBridgeCache();
  let hits = 0;
  await withHealth(
    () => {
      hits += 1;
      return { status: 200, body: { ok: true, mode: 'rpa', receive: { implemented: true, supported: true } } };
    },
    async (url) => {
      await wechatBridgeStatus({ url, timeoutMs: 500 });
      await wechatBridgeStatus({ url, timeoutMs: 500 });
      assert.equal(hits, 1, '第二次应命中缓存，不再请求桥');
      await wechatBridgeStatus({ url, timeoutMs: 500, maxAgeMs: 0 });
      assert.equal(hits, 2, 'doctor 需要现场结论：maxAgeMs=0 必须重探');
    },
  );
  resetWechatBridgeCache();
});

test('微信 4.x：桥上报 client.kind=weixin4 → 结论指向版本不兼容，而不是「没登录/缺依赖」', async () => {
  await withHealth(
    () => ({
      status: 200,
      body: {
        ok: true,
        mode: 'rpa',
        receive: { implemented: true, supported: false, reason: '检测到微信 4.x' },
        client: {
          kind: 'weixin4',
          class: 'Qt51514QWindowIcon',
          uiaUsable: false,
          reason: '检测到微信 4.x（Weixin，Qt 自绘）：不暴露可访问性控件树，请改装微信 3.9.x',
        },
      },
    }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal(s.canReceive, false);
      assert.equal(s.client?.kind, 'weixin4');
      assert.equal(s.client?.uiaUsable, false);
      assert.equal(s.client?.className, 'Qt51514QWindowIcon');
      assert.match(s.receiveReason, /3\.9/, '必须直接给出可行动结论');
      assert.doesNotMatch(s.receiveReason, /未安装 uiautomation|未登录/);
    },
  );
});

test('旧版桥没有 client 字段：不臆造，client 保持 undefined', async () => {
  await withHealth(
    () => ({
      status: 200,
      body: { ok: true, mode: 'rpa', receive: { implemented: true, supported: false, reason: '未找到微信主窗口' } },
    }),
    async (url) => {
      const s = await probeWechatBridge({ url });
      assert.equal(s.client, undefined);
      assert.equal(s.canReceive, false);
      assert.match(s.receiveReason, /未找到微信主窗口/);
    },
  );
});
