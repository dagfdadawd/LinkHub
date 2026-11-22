/**
 * 机器主人守卫（ownerOnly）的 HTTP 契约测试（回归问题①的另一面）：
 *
 *  - 守卫只挂在**具体写路由**上：普通成员仍被 403 挡住
 *    （`POST /api/wechat/pull`、`POST /api/wechat/bridge/start|stop`、`POST /api/auto-rules`），
 *    且读接口（GET）对成员放行；
 *  - 守卫不能挂在 `app.use('/api')`：未匹配路径应回 404（见 unmatched.test.ts）；
 *  - 机器主人本人的写操作不被守卫挡：`POST /api/auto-rules` → 201、
 *    `POST /api/wechat/bridge/start` → 200（用 mock manager，绝不真的启动桥进程）。
 *
 * 桥 manager 通过替换单例方法为 mock 注入（不落生产代码、不 spawn 任何进程）。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Platform } from '@unimsg/shared';
import { createApp } from '../app';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from '../services/llm';
import { OcrService } from '../services/ocr';
import { RateLimiter } from '../services/rateLimiter';
import { MessageService } from '../services/message';
import { UserStore } from '../services/users';
import { AutoRuleStore } from '../services/autoReply';
import { wechatBridgeManager } from '../services/wechatBridgeProcess';
import type { WechatBridgeStatus } from '../services/wechatBridge';
import { resetAuthRateLimit, setUserStore } from './auth';
import { config } from '../config';

function makeSvc(): MessageService {
  return new MessageService(
    new InMemoryRepository(), connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
}

interface Ctx {
  base: string;
  svc: MessageService;
}

async function withApp(
  fn: (ctx: Ctx) => Promise<void>,
  options: { autoRules?: AutoRuleStore } = {},
): Promise<void> {
  const svc = makeSvc();
  const server = http.createServer(createApp(svc, { corsOrigins: null, ...options }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ base, svc });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(base: string, username: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 201, `注册 ${username} 应成功`);
  return ((await res.json()) as any).data.token as string;
}

interface Res {
  status: number;
  json: any;
}

async function request(base: string, method: string, path: string, token: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...auth(token),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

function bridgeStatus(patch: Partial<WechatBridgeStatus> = {}): WechatBridgeStatus {
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

function bridgeView(patch: Record<string, unknown> = {}) {
  return {
    managed: true,
    pid: 123,
    url: 'http://127.0.0.1:8787',
    logPath: 'unused-in-test',
    bridge: bridgeStatus(),
    ...patch,
  };
}

/**
 * 把 wechatBridgeManager 单例的方法换成 mock：
 * createApp 内部用的是同一个单例，因此能验证「守卫放行后才会执行 manager.start」，
 * 同时保证测试不会真的 spawn Python 桥。
 */
function installMockBridge() {
  const manager = wechatBridgeManager();
  const original = {
    status: manager.status,
    start: manager.start,
    stop: manager.stop,
  };
  const calls = { status: 0, start: 0, stop: 0 };
  manager.status = async () => {
    calls.status += 1;
    return bridgeView() as never;
  };
  manager.start = async () => {
    calls.start += 1;
    return bridgeView({ started: true }) as never;
  };
  manager.stop = async () => {
    calls.stop += 1;
    return bridgeView({ stopped: true }) as never;
  };
  return {
    calls,
    restore: () => {
      manager.status = original.status;
      manager.start = original.start;
      manager.stop = original.stop;
    },
  };
}

beforeEach(() => {
  setUserStore(new UserStore({ persist: false }));
  resetAuthRateLimit();
});

test('普通成员写机器级接口仍 403；读接口放行（wechat/pull、auto-rules）', async () => {
  // 守卫先于路由执行，不应真的去连 RPA 桥；把地址指向必定连不上的端口兜底。
  const prevBridgeUrl = config.platforms.wechat.bridgeUrl;
  config.platforms.wechat.bridgeUrl = 'http://127.0.0.1:1';
  try {
    await withApp(async ({ base }) => {
      await register(base, 'guard-owner'); // 第一个账号 = 机器主人
      const member = await register(base, 'guard-member');

      const pull = await request(base, 'POST', '/api/wechat/pull', member, { conversation: '项目群' });
      assert.equal(pull.status, 403, '成员不能触发本机微信拉取');
      assert.equal(pull.json.ok, false);
      assert.match(pull.json.error, /只有.*主人/, '要给出可操作提示：换主人账号');
      assert.doesNotMatch(pull.json.error, /连不上本机 RPA 桥/, '守卫应在路由逻辑之前就拒绝');

      const createRule = await request(base, 'POST', '/api/auto-rules', member, { replyText: '成员不该建的规则' });
      assert.equal(createRule.status, 403, '成员不能用机器主人的账号外发自动回复');
      assert.equal(createRule.json.ok, false);
      assert.match(createRule.json.error, /只有.*主人/);

      const rulesForMember = await request(base, 'GET', '/api/auto-rules', member);
      assert.equal(rulesForMember.status, 200, '读接口对普通成员放行');
      assert.equal(rulesForMember.json.ok, true);
      assert.deepEqual(rulesForMember.json.data, [], '被 403 的写操作不能落库');
    }, { autoRules: new AutoRuleStore() });
  } finally {
    config.platforms.wechat.bridgeUrl = prevBridgeUrl;
  }
});

test('机器主人本人写操作不被守卫挡：auto-rules 201、bridge/start 用 mock manager 返回 200（不是 403）', async () => {
  const mock = installMockBridge();
  try {
    await withApp(async ({ base }) => {
      const owner = await register(base, 'guard-owner-self');

      const created = await request(base, 'POST', '/api/auto-rules', owner, {
        platform: Platform.FEISHU,
        keyword: '发票',
        replyText: '开票流程见文档',
        priority: 10,
      });
      assert.equal(created.status, 201, '机器主人创建规则应成功（守卫不能挡住本人）');
      assert.equal(created.json.ok, true);
      assert.match(created.json.data.id, /^[0-9a-f-]{36}$/i);
      assert.equal(created.json.data.replyText, '开票流程见文档');

      const list = await request(base, 'GET', '/api/auto-rules', owner);
      assert.equal(list.status, 200);
      assert.equal(list.json.data.length, 1, '主人的写入确实落库');

      const started = await request(base, 'POST', '/api/wechat/bridge/start', owner);
      assert.notEqual(started.status, 403, '主人启停桥不能被守卫挡');
      assert.equal(started.status, 200);
      assert.equal(started.json.ok, true);
      assert.equal(mock.calls.start, 1, '放行后确实调用了 manager.start（mock）');

      // 再注册一个普通成员：同一个桥接口对成员必须 403，且不会执行 manager
      const member = await register(base, 'guard-member-2');
      const denied = await request(base, 'POST', '/api/wechat/bridge/start', member);
      assert.equal(denied.status, 403);
      assert.match(denied.json.error, /只有.*主人/);
      assert.equal(mock.calls.start, 1, '403 时 manager.start 不能被调用');

      const deniedStop = await request(base, 'POST', '/api/wechat/bridge/stop', member);
      assert.equal(deniedStop.status, 403);
      assert.equal(mock.calls.stop, 0, '403 时 manager.stop 不能被调用');

      // 读状态对所有登录用户开放（mock 不会 spawn）
      const status = await request(base, 'GET', '/api/wechat/bridge/status', member);
      assert.equal(status.status, 200);
      assert.equal(status.json.ok, true);
      assert.equal(status.json.data.managed, true);
    }, { autoRules: new AutoRuleStore() });
  } finally {
    mock.restore();
  }
});

test('普通成员的 wechat/bridge/stop 也是 403（启停同一条守卫）', async () => {
  const mock = installMockBridge();
  try {
    await withApp(async ({ base }) => {
      await register(base, 'guard-owner-stop');
      const member = await register(base, 'guard-member-stop');
      const res = await request(base, 'POST', '/api/wechat/bridge/stop', member);
      assert.equal(res.status, 403);
      assert.match(res.json.error, /只有.*主人/);
      assert.equal(mock.calls.stop, 0);
    });
  } finally {
    mock.restore();
  }
});
