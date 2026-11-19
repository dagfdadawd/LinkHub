/**
 * `/api/app-config` 路由测试（白号 P0）：
 *  - GET 全 none / 来源与脱敏 / 不含密钥明文；
 *  - PUT 校验（未知键 400）、写入本地文件、restartRequired；
 *  - identity.* 热应用（立即改 config.identity，无需重启；hotApplied=true, restartRequired=false）；
 *  - .env 显式值优先（ignoredByEnv）。
 * 全部使用临时 DATA_DIR，不写真实仓库配置。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { config, monorepoRoot } from '../config';
import { resetIdentityChannelsForTests } from '../services/identityChannels';
import { appConfigRouter } from './appConfig';
import {
  captureRestartBaseline,
  readLocalConfig,
  resetRestartBaselineForTests,
} from '../services/localConfig';
import { makeTempDir } from '../utils/tempDir';

const dirs: string[] = [];
/**
 * 测试期间清空的「凭据/模式类」环境变量。
 * 仓库根 .env 存在时（本地开发）这些变量会被 config.ts 载入 process.env，导致 PUT 被当成
 * 「已被 .env 占用」而跳过写盘，用例必须显式隔离，保证本地与 CI（无 .env）结果一致。
 */
const ISOLATED_ENV_KEYS = [
  'DATA_DIR',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_VERIFY_TOKEN',
  'FEISHU_ENCRYPT_KEY',
  'FEISHU_STREAM',
  'DINGTALK_CLIENT_ID',
  'DINGTALK_CLIENT_SECRET',
  'DINGTALK_ROBOT_CODE',
  'DINGTALK_STREAM',
  'DINGTALK_AES_TOKEN',
  'DINGTALK_AES_KEY',
  'WECOM_CORP_ID',
  'WECOM_AGENT_ID',
  'WECOM_SECRET',
  'WECOM_TOKEN',
  'WECOM_AES_KEY',
  'LLM_PROVIDER',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'FEISHU_IDENTITY',
  'DINGTALK_IDENTITY',
  'FEISHU_USER_RECEIVE',
  'DINGTALK_USER_RECEIVE',
] as const;
const originalEnv = new Map<string, string | undefined>(
  ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
);
const original = {
  identity: {
    feishu: config.identity.feishu.policy,
    dingtalk: config.identity.dingtalk.policy,
    feishuReceive: config.identity.feishu.receive,
    dingtalkReceive: config.identity.dingtalk.receive,
  },
};

function tempDir(): string {
  const dir = makeTempDir('linkhub-app-config-');
  dirs.push(dir);
  return dir;
}

function restoreEnv(): void {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
  config.identity.feishu.policy = original.identity.feishu;
  config.identity.dingtalk.policy = original.identity.dingtalk;
  config.identity.feishu.receive = original.identity.feishuReceive;
  config.identity.dingtalk.receive = original.identity.dingtalkReceive;
  resetIdentityChannelsForTests();
});

after(() => {
  restoreEnv();
  config.identity.feishu.policy = original.identity.feishu;
  config.identity.dingtalk.policy = original.identity.dingtalk;
  config.identity.feishu.receive = original.identity.feishuReceive;
  config.identity.dingtalk.receive = original.identity.dingtalkReceive;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Res {
  status: number;
  json: any;
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', appConfigRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

test('GET /api/app-config：白号初态全 none，字段带 envKey/label/source，无密钥', async () => {
  const dir = tempDir();
  process.env.DATA_DIR = dir;
  await withServer(async (base) => {
    const res = await call(base, 'GET', '/api/app-config');
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.equal(data.version, 1);
    assert.ok(data.identity && data.modes && data.llm && data.platforms);
    const appId = data.platforms.feishu.fields.appId;
    assert.equal(appId.source, 'none');
    assert.equal(appId.configured, false);
    assert.equal(appId.envKey, 'FEISHU_APP_ID');
    assert.ok(appId.label.includes('飞书'));
    assert.ok(data.platforms.feishu.missing.includes('FEISHU_APP_ID'));
    assert.equal(data.identity.dingtalk.source, 'none');
    assert.equal(data.settingsFile.present, false);
    assert.equal(data.restartRequired, false);
    assert.equal(data.envFile === null || typeof data.envFile.mtime === 'string', true);
    // 不含任何密钥形态
    assert.ok(!JSON.stringify(data).includes('appSecret": "'));
  });
});

test('PUT：未知键 → 400 中文；PUT 凭据 → 写本地文件 + restartRequired=true + 脱敏可读', async () => {
  const dir = tempDir();
  process.env.DATA_DIR = dir;
  await withServer(async (base) => {
    const bad = await call(base, 'PUT', '/api/app-config', { platforms: { feishu: { hacked: 'x' } } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /未知配置项/);

    const badEnum = await call(base, 'PUT', '/api/app-config', { identity: { dingtalk: 'robot' } });
    assert.equal(badEnum.status, 400);
    assert.match(badEnum.json.error, /auto \/ bot \/ user/);

    const saved = await call(base, 'PUT', '/api/app-config', {
      platforms: { feishu: { appId: 'cli_test_1234', appSecret: 'secret-abcd-9876' } },
    });
    assert.equal(saved.status, 200);
    const data = saved.json.data;
    assert.equal(data.saved, true);
    assert.equal(data.restartRequired, true, '凭据变更需要重启');
    assert.equal(data.hotApplied, false);
    assert.ok(data.changedKeys.includes('platforms.feishu.appId'));
    assert.ok(data.changedKeys.includes('platforms.feishu.appSecret'));
    assert.match(data.message, /重启/);
    assert.ok(existsSync(join(dir, 'linkhub-config.json')), '已写入 DATA_DIR/linkhub-config.json');

    const get = await call(base, 'GET', '/api/app-config');
    const appId = get.json.data.platforms.feishu.fields.appId;
    assert.equal(appId.source, 'local');
    assert.equal(appId.masked, '****1234');
    const secret = get.json.data.platforms.feishu.fields.appSecret;
    assert.equal(secret.masked, '****9876');
    assert.ok(!JSON.stringify(get.json).includes('secret-abcd-9876'), 'GET 不得返回 secret 明文');
    assert.equal(get.json.data.restartRequired, true);
  });
});

test('PUT identity.dingtalk=user：热应用立即生效（无需重启）+ 持久化 + 重启后仍 user', async () => {
  const dir = tempDir();
  process.env.DATA_DIR = dir;
  await withServer(async (base) => {
    const before = config.identity.dingtalk.policy;
    const saved = await call(base, 'PUT', '/api/app-config', { identity: { dingtalk: 'user' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.data.hotApplied, true);
    assert.equal(saved.json.data.restartRequired, false, '仅身份策略变更无需重启');
    assert.deepEqual(saved.json.data.hotAppliedKeys, ['identity.dingtalk']);
    assert.equal(config.identity.dingtalk.policy, 'user', '运行中的 config 立即生效');
    assert.notEqual(before, undefined);
    // 持久化：再次读取本地文件仍是 user（重启后 config.ts 合并 → 仍 user）
    const get = await call(base, 'GET', '/api/app-config');
    assert.equal(get.json.data.identity.dingtalk.value, 'user');
    assert.equal(get.json.data.identity.dingtalk.source, 'local');

    // userReceive 热应用同时作用于飞书/钉钉
    const receive = await call(base, 'PUT', '/api/app-config', { identity: { userReceive: true } });
    assert.equal(receive.json.data.hotApplied, true);
    assert.equal(config.identity.feishu.receive, true);
    assert.equal(config.identity.dingtalk.receive, true);
  });
});

test('PUT：.env 显式优先 —— 凭据被 ignoredByEnv（不写本地、saved=false），身份策略记录冲突但仍落盘', async () => {
  const dir = tempDir();
  process.env.DATA_DIR = dir;
  process.env.FEISHU_APP_SECRET = 'env-secret-0000';
  process.env.DINGTALK_IDENTITY = 'bot';
  config.identity.dingtalk.policy = 'auto'; // 模拟本进程启动时 .env 解析结果（动态改 env 不会回填 config）
  await withServer(async (base) => {
    const res = await call(base, 'PUT', '/api/app-config', { platforms: { feishu: { appSecret: 'gui-secret' } } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.saved, false, '全部被 .env 占用 → 不写本地');
    assert.ok(res.json.data.ignoredByEnv.includes('FEISHU_APP_SECRET'));
    assert.match(res.json.data.message, /\.env/);

    const identity = await call(base, 'PUT', '/api/app-config', { identity: { dingtalk: 'user' } });
    assert.ok(identity.json.data.ignoredByEnv.includes('DINGTALK_IDENTITY'));
    assert.notEqual(config.identity.dingtalk.policy, 'user', '.env 显式身份优先，热应用不覆盖运行中 config');
    // 但本地仍保存 user，供以后删掉 env 后生效
    const get = await call(base, 'GET', '/api/app-config');
    assert.equal(get.json.data.identity.dingtalk.source, 'env');
    assert.equal(get.json.data.identity.dingtalk.value, 'bot');
  });
});
test('restartRequired（P1-1）：GET 排除 identity 热应用；凭据变化为 true；模拟重启后为 false', async () => {
  const dir = tempDir();
  process.env.DATA_DIR = dir;
  resetRestartBaselineForTests();
  captureRestartBaseline({ version: 1 }); // 模拟进程启动基线：空
  await withServer(async (base) => {
    const identity = await call(base, 'PUT', '/api/app-config', { identity: { dingtalk: 'user' } });
    assert.equal(identity.json.data.hotApplied, true);
    assert.equal(identity.json.data.restartRequired, false);

    const get1 = await call(base, 'GET', '/api/app-config');
    assert.equal(get1.json.data.identity.dingtalk.source, 'local');
    assert.equal(get1.json.data.restartRequired, false, 'identity 热应用后 GET 不得要求重启（P1-1）');

    const creds = await call(base, 'PUT', '/api/app-config', { platforms: { feishu: { appId: 'cli_p1_1234' } } });
    assert.equal(creds.json.data.restartRequired, true);
    const get2 = await call(base, 'GET', '/api/app-config');
    assert.equal(get2.json.data.restartRequired, true, '凭据属于静态键 → 需要重启');

    // 模拟重启：以当前落盘配置为新的启动基线
    captureRestartBaseline(readLocalConfig(monorepoRoot).config);
    const get3 = await call(base, 'GET', '/api/app-config');
    assert.equal(get3.json.data.restartRequired, false, '重启后基线更新 → false');

    // 清除凭据回到当前基线 → 不需要重启
    captureRestartBaseline({ version: 1 });
    await call(base, 'PUT', '/api/app-config', { platforms: { feishu: { appId: null } } });
    const get4 = await call(base, 'GET', '/api/app-config');
    assert.equal(get4.json.data.restartRequired, false, '清除回启动基线 → false');

    // P3：路径只给 basename；settingsFile.mtime 允许 null
    assert.equal(get4.json.data.settingsFile.path, 'linkhub-config.json');
    // CI/全新环境没有仓库 .env → envFile 为 null；本地开发有 .env → 只给 .env basename
    assert.ok(
      get4.json.data.envFile === null || get4.json.data.envFile.path === '.env',
      `envFile: ${JSON.stringify(get4.json.data.envFile)}`,
    );
    assert.ok(get4.json.data.settingsFile.mtime === null || typeof get4.json.data.settingsFile.mtime === 'string');
  });
});
