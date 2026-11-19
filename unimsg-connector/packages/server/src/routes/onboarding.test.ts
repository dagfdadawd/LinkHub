/**
 * `GET /api/onboarding` 路由测试（回环 127.0.0.1，fake-dws，不连真实平台）：
 *  - Bearer 鉴权、4 个步骤、dws 来源如实标注；
 *  - 响应绝不含 token / authCode；
 *  - 与 /api/mail/accounts 一起挂载可用。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../utils/tempDir';

const FAKE_DWS = fileURLToPath(new URL('../../../../scripts/fake-dws.mjs', import.meta.url));
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('linkhub-onboarding-api-');
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('GET /api/onboarding：Bearer 鉴权 + 4 步聚合 + dws 来源 + 无任何密钥', async () => {
  const dir = tempDir();
  process.env.DWS_BIN = `node ${FAKE_DWS}`;
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'fake-dws-state.json');
  process.env.FEISHU_MODE = 'mock';
  process.env.DINGTALK_MODE = 'mock';
  process.env.WECOM_MODE = 'mock';
  process.env.MAIL_MODE = 'mock';
  process.env.DATA_DIR = dir;

  // env 必须在 import config/app 之前就绪（config 在模块加载时解析）
  const { createApp } = await import('../app');
  const { config } = await import('../config');
  const { resolveApiToken } = await import('../middlewares/auth');
  const { InMemoryRepository } = await import('../db/repository');
  const { connectors } = await import('../connectors/registry');
  const { LlmService } = await import('../services/llm');
  const { OcrService } = await import('../services/ocr');
  const { RateLimiter } = await import('../services/rateLimiter');
  const { MessageService } = await import('../services/message');

  const svc = new MessageService(
    new InMemoryRepository(), connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  const token = resolveApiToken(config.apiToken);
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const unauth = await fetch(`${base}/api/onboarding`);
    assert.equal(unauth.status, 401, 'onboarding 必须要求 Bearer');

    const res = await fetch(`${base}/api/onboarding`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    const data = json.data;
    assert.deepEqual(data.steps.map((s: { id: string }) => s.id), ['mail', 'dingtalk', 'feishu', 'wecom']);
    assert.equal(data.overall.total, 4);
    assert.equal(typeof data.overall.ready, 'number');
    assert.equal(typeof data.firstRun, 'boolean');
    assert.ok(data.startedAt);
    assert.ok(data.generatedAt);
    // DWS_BIN 显式指定 → 来源如实标 env
    assert.equal(data.dws.source, 'env');
    assert.equal(typeof data.dws.available, 'boolean');
    // P3：认证接口的路径字段只给 basename（不泄露本机绝对路径）
    if (data.envFile) assert.equal(data.envFile.path, '.env');
    const mailStep = data.steps.find((step: { id: string }) => step.id === 'mail');
    assert.ok(!String(JSON.stringify(mailStep)).includes('C:\\'), 'mail detail 不应包含本机绝对路径');
    assert.equal(mailStep.detail.filePath, mailStep.detail.filePath.split(/[\\/]/).pop());
    // 各步骤有 state/summary/hints/actions 结构
    for (const step of data.steps) {
      assert.ok(['ready', 'needs_user_auth', 'needs_install', 'needs_admin', 'mock', 'error'].includes(step.state));
      assert.equal(typeof step.summary, 'string');
      assert.ok(Array.isArray(step.hints));
      assert.ok(Array.isArray(step.actions));
      for (const action of step.actions) {
        assert.ok(['api', 'form', 'link', 'copy', 'command'].includes(action.kind));
        assert.ok(action.label);
      }
    }
    // 安全：不得出现 token / 授权码
    const text = JSON.stringify(json);
    for (const bad of ['access_token', 'refresh_token', 'authCode', 'appSecret', 'clientSecret', 'dev-token']) {
      assert.ok(!text.includes(bad), `响应不应包含 ${bad}`);
    }

    // 邮箱账号接口同 app 挂载可用（空列表也不崩）
    const mail = await fetch(`${base}/api/mail/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(mail.status, 200);
    const mailJson = await mail.json();
    assert.ok(Array.isArray(mailJson.data.accounts));
    assert.ok(!JSON.stringify(mailJson).includes('authCode'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});