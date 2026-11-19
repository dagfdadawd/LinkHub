import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { config } from '../config';
import { wechatPullRouter } from './wechatPull';

/** 起一个只挂 wechatPull 路由的最小应用（不经鉴权，聚焦路由本身的行为） */
async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', wechatPullRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 假桥：按 handler 返回，用于验证「桥怎么回，后端就怎么透传」 */
async function withFakeBridge(
  handler: (body: unknown) => { status: number; json: unknown },
  fn: (bridge: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const { status, json } = handler(raw ? JSON.parse(raw) : {});
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const prev = config.platforms.wechat.bridgeUrl;
  config.platforms.wechat.bridgeUrl = url;
  try {
    await fn(url);
  } finally {
    config.platforms.wechat.bridgeUrl = prev;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(base: string, body: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(`${base}/api/wechat/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

test('缺 conversation：400 且说清「要和微信里显示的一致」', async () => {
  await withApp(async (base) => {
    const { status, json } = await post(base, {});
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.match(json.error, /会话名/);
    assert.match(json.error, /一致/);
  });
});

test('桥没启动：502 并提示用 --mode rpa 启动，不假装成功', async () => {
  const prev = config.platforms.wechat.bridgeUrl;
  // 1 端口必定连不上
  config.platforms.wechat.bridgeUrl = 'http://127.0.0.1:1';
  try {
    await withApp(async (base) => {
      const { status, json } = await post(base, { conversation: '项目群' });
      assert.equal(status, 502);
      assert.equal(json.ok, false);
      assert.match(json.error, /连不上本机 RPA 桥/);
      assert.match(json.error, /--mode rpa/);
    });
  } finally {
    config.platforms.wechat.bridgeUrl = prev;
  }
});

test('桥返回 mock 模式 409：原样透传桥的原因，不包装成 500', async () => {
  await withFakeBridge(
    () => ({
      status: 409,
      json: { ok: false, error: '桥在 mock 模式，不会操作真实微信。请用 --mode rpa 重启桥。' },
    }),
    async () => {
      await withApp(async (base) => {
        const { status, json } = await post(base, { conversation: '项目群' });
        assert.equal(status, 502, '前端只需知道这次没成功');
        assert.match(json.error, /mock 模式/);
      });
    },
  );
});

test('拉取成功：解析/转发/去重数字原样带回，并附能力边界', async () => {
  const seen: any[] = [];
  await withFakeBridge(
    (body) => {
      seen.push(body);
      return {
        status: 200,
        json: {
          ok: true,
          conversation: '项目群',
          parsed: 3,
          forwarded: 2,
          duplicates: 1,
          failed: [],
          scope: ['只覆盖当前打开的会话'],
        },
      };
    },
    async () => {
      await withApp(async (base) => {
        const { status, json } = await post(base, { conversation: '项目群', selfName: '阿彬' });
        assert.equal(status, 200);
        assert.equal(json.parsed, 3);
        assert.equal(json.forwarded, 2);
        assert.equal(json.duplicates, 1);
        assert.deepEqual(json.scope, ['只覆盖当前打开的会话']);
        // 请求体要按桥的约定传过去（含 selfName 过滤自己发的消息）
        assert.deepEqual(seen[0], { conversation: '项目群', conversationType: 'p2p', selfName: '阿彬' });
      });
    },
  );
});

test('桥部分失败（207）：状态码保留 207，failed 明细透出', async () => {
  await withFakeBridge(
    () => ({
      status: 207,
      json: {
        ok: false,
        conversation: '项目群',
        parsed: 2,
        forwarded: 1,
        duplicates: 0,
        failed: [{ sender: '张三', error: 'HTTP 500' }],
      },
    }),
    async () => {
      await withApp(async (base) => {
        const { status, json } = await post(base, { conversation: '项目群' });
        assert.equal(status, 207);
        assert.equal(json.forwarded, 1);
        assert.equal(json.failed[0].sender, '张三');
      });
    },
  );
});
