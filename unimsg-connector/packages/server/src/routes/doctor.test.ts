/**
 * GET /api/doctor HTTP 层单测：鉴权、响应形状、脱敏与「探针失败不 500」语义。
 *
 * 复用 messages.download.test.ts 的「起服务 + fetch」harness：
 *   createApp 只装配路由（svc 用最小假实现），server.listen(0) 拿随机端口，
 *   用 Node 内置 fetch 打真实 HTTP 请求，最后 close 等待收尾。
 *
 * 外呼隔离约定：node:test 子进程带 NODE_TEST_CONTEXT → config.underTest=true →
 * 所有平台强制 Mock，runProbes 只会产出 SKIP（绝不联网、绝不起 dws 子进程），
 * 用例据此断言「mock 模式全 SKIP」，也不得绕过（不设 FEISHU_MODE=real 之类）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { MessageService } from '../services/message';
import { apiAuth, resolveApiToken } from '../middlewares/auth';
import { config } from '../config';
import { doctorRouter, type DoctorRouterDeps } from './doctor';

const TOKEN = resolveApiToken(config.apiToken);

/** 与 index.ts 完全一致的挂载方式（apiAuth 在前）；路由挂载常规在 app.ts，白名单外故这里手动追加 */
async function withDoctorApp(
  deps: DoctorRouterDeps | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = createApp({} as unknown as MessageService);
  app.use('/api', apiAuth, doctorRouter(deps));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('doctor：未带 Bearer 令牌 → 401', async () => {
  await withDoctorApp(undefined, async (base) => {
    const res = await fetch(`${base}/api/doctor`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'unauthorized' });
  });
});

test('doctor：带 Bearer 令牌 → 200，checks 数组且每项含 status（mock 模式全 SKIP）', async () => {
  // 单测必须在 NODE_TEST_CONTEXT 下运行：underTest 会把所有平台锁成 mock，绝不外呼
  assert.equal(config.underTest, true, 'doctor 自检单测必须在 NODE_TEST_CONTEXT 下运行（强制 Mock）');
  await withDoctorApp(undefined, async (base) => {
    const res = await fetch(`${base}/api/doctor`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; data: { generatedAt: string; checks: unknown[] } };
    assert.equal(body.ok, true);
    assert.equal(typeof body.data.generatedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(body.data.generatedAt)), 'generatedAt 必须是可解析的时间戳');
    assert.ok(Array.isArray(body.data.checks));
    assert.ok(body.data.checks.length > 0, 'mock 模式下也应产出 SKIP 结论（LLM/四平台各至少一条）');
    for (const check of body.data.checks as { group: string; id: string; title: string; status: string; detail: string }[]) {
      assert.equal(typeof check.id, 'string');
      assert.ok(check.id.length > 0);
      assert.equal(typeof check.title, 'string');
      assert.ok(typeof check.detail === 'string');
      assert.ok(
        check.status === 'PASS' || check.status === 'FAIL' || check.status === 'SKIP',
        `status 必须是 PASS/FAIL/SKIP，实际：${check.status}`,
      );
      // mock 隔离护栏：若这里出现 PASS/FAIL，说明有探针在测试环境里真实外呼了，必须查明
      assert.equal(check.status, 'SKIP', `mock 模式下不应出现 ${check.status}：${check.id}`);
    }
  });
});

/** 响应里递归收集所有 JSON 字段名（数组展开），用于断言「结构上不带凭据字段」 */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key);
      collectKeys(nested, out);
    }
  }
  return out;
}

/** 本机配置里全部非空凭据值（探针输入侧真实持有、绝不允许出现在响应里的东西） */
function configuredSecretValues(): string[] {
  const values = [
    resolveApiToken(config.apiToken),
    config.platforms.feishu.appSecret,
    config.platforms.feishu.verifyToken,
    config.platforms.feishu.encryptKey,
    config.platforms.dingtalk.appSecret,
    config.platforms.dingtalk.aesToken,
    config.platforms.dingtalk.aesKey,
    config.llm.apiKey,
    config.ocr.apiKey,
    config.ocr.secretId,
    config.authSignupCode,
    ...config.mail.accounts.map((a) => a.authCode),
  ];
  // 长度阈值过滤空串与过短值，避免把「恰好撞上普通英文单词」的值变成误报源
  return [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length >= 6))];
}

test('doctor：mock 模式响应不含真实凭据/密钥泄露', async () => {
  await withDoctorApp(undefined, async (base) => {
    const res = await fetch(`${base}/api/doctor`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = JSON.stringify(body);
    const lower = text.toLowerCase();

    // 1) 连写敏感串：环境变量名都带下划线（AUTH_CODE / APP_SECRET / API_KEY / CLIENT_SECRET /
    //    AES_TOKEN / AES_KEY），中文文案用「授权码」；正文出现这些连写小写串只可能是
    //    泄露的字段名或凭据值（任务点名的 'authCode'、'secret' 按此口径落地，避免把
    //    合法的变量名提示误伤成失败）。
    for (const marker of ['authcode', 'appsecret', 'clientsecret', 'apikey', 'aestoken', 'aeskey']) {
      assert.ok(!lower.includes(marker), `响应疑似泄露敏感字段：${marker}`);
    }

    // 2) 字段名白名单：响应结构里不允许出现任何凭据类 key（CheckResult 只有 group/id/title/status/detail/hint）
    const forbiddenKey = /(secret|password|passwd|authcode|apikey|credential|aeskey|accesstoken|bearer|token)/i;
    for (const key of collectKeys(body)) {
      assert.ok(!forbiddenKey.test(key), `响应字段名疑似携带凭据：${key}`);
    }

    // 3) 真实凭据值逐一比对：探针输入侧（ProbeInput）确实持有本机 .env 的真凭据，
    //    但它们只应在服务端内存中流转——任何一个值出现在响应里都视为泄露
    const secrets = configuredSecretValues();
    assert.ok(secrets.length > 0, '本机至少应取到 API_TOKEN（或回退 dev-token）用于比对');
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), '响应泄露了配置中的真实凭据值（已按白名单隐藏具体值）');
    }
  });
});

test('doctor：探针编排抛错 → 200 + FAIL 结论，绝不 500', async () => {
  await withDoctorApp(
    {
      // 注入抛错桩：模拟「个别探针没兜住」把 runProbes 整个炸掉的最坏情况
      runProbes: async () => {
        throw new Error('模拟探针编排崩溃（测试桩）');
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/doctor`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      // 探针失败是合法输出：必须是 200，而不是 500
      assert.equal(res.status, 200);
      const body = await res.json() as {
        ok: boolean;
        data: { generatedAt: string; checks: { id: string; status: string; detail: string }[] };
      };
      assert.equal(body.ok, true);
      assert.equal(typeof body.data.generatedAt, 'string');
      assert.equal(body.data.checks.length, 1);
      const check = body.data.checks[0];
      assert.equal(check.id, 'doctor:internal');
      assert.equal(check.status, 'FAIL');
      assert.match(check.detail, /模拟探针编排崩溃/);
    },
  );
});
