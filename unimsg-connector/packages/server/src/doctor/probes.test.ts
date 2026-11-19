/**
 * doctor 探针单测：绝不联网。
 *
 *  - HTTP 探针（飞书 / 钉钉）：stub globalThis.fetch，断言 errcode → 中文建议映射；
 *    每个用例用 withStubFetch 的 finally 恢复真实 fetch；
 *  - 邮箱探针：注入假的 fetchNewMails / verifySmtpAuth（绝不真的连 IMAP/SMTP）；
 *  - 纯函数（错误分类 / host 解析 / 配置检查）直接断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '@unimsg/shared';
import type { MailAccount } from '../config';
import {
  classifyNetworkError,
  dingtalkConfigChecks,
  explainFeishuError,
  explainImapError,
  explainSmtpError,
  hostOf,
  probeDingtalkToken,
  probeFeishuToken,
  probeMailAccount,
  runProbes,
  probeLlm,
  type DingtalkProbeInput,
  type FeishuProbeInput,
  type LlmProbeInput,
  type PlatformProbeRuntime,
  type ProbeInput,
  probeFeishuIdentity,
  probeDingtalkIdentity,
} from './probes';

// ---------------------------------------------------------------------------
// fetch 打桩工具（严格在 finally 里恢复）
// ---------------------------------------------------------------------------

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function withStubFetch<T>(handler: FetchHandler, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

// ---------------------------------------------------------------------------
// synthetic 凭据 / 账号
// ---------------------------------------------------------------------------

const FEISHU: FeishuProbeInput = {
  appId: 'cli_test',
  appSecret: 'feishu-secret-test',
  baseUrl: 'https://open.feishu.cn',
};

const DINGTALK: DingtalkProbeInput = {
  appKey: 'ding_test',
  appSecret: 'dingtalk-secret-test',
  robotCode: 'robot_test',
  robotCodeExplicit: true,
  aesToken: '',
  aesKey: '',
  stream: true,
  baseUrl: 'https://api.dingtalk.com',
};

function mailAccount(over: Partial<MailAccount> = {}): MailAccount {
  return {
    key: 'qq',
    label: 'QQ邮箱',
    address: 'zhangsan@qq.com',
    authCode: 'AUTH-CODE-SHOULD-NOT-LEAK',
    provider: 'qq',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    folders: ['INBOX'],
    ...over,
  };
}

function mockRuntime(
  over: Partial<Record<Platform, PlatformProbeRuntime>> = {},
): Record<Platform, PlatformProbeRuntime> {
  const base: PlatformProbeRuntime = {
    policy: 'auto',
    mode: 'mock',
    canSend: false,
    canReceive: false,
    missing: [],
    warnings: [],
  };
  return {
    [Platform.FEISHU]: { ...base },
    [Platform.DINGTALK]: { ...base },
    [Platform.MAIL]: { ...base },
    [Platform.WECHAT]: { ...base },
    ...over,
  };
}

function probeInput(over: Partial<ProbeInput> = {}): ProbeInput {
  return {
    feishu: FEISHU,
    dingtalk: DINGTALK,
    mail: { accounts: [], enabled: false },
    llm: llmInput({ ready: false }),
    runtime: mockRuntime(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 通用：网络错误分类 / host 解析 / fetch 恢复
// ---------------------------------------------------------------------------

test('网络错误分类：超时 / DNS / 拒绝连接 / TLS 各自归类', () => {
  assert.equal(classifyNetworkError(Object.assign(new Error('fetch failed'), { code: 'ETIMEDOUT' })), 'timeout');
  assert.equal(classifyNetworkError(new Error('The operation was aborted due to timeout')), 'timeout');
  assert.equal(classifyNetworkError(new Error('IMAP 连接超时 imap.qq.com:993')), 'timeout');
  assert.equal(classifyNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })), 'dns');
  assert.equal(classifyNetworkError(new Error('getaddrinfo EAI_AGAIN open.feishu.cn')), 'dns');
  assert.equal(classifyNetworkError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), 'refused');
  assert.equal(classifyNetworkError(new Error('unable to verify the first certificate')), 'tls');
  assert.equal(classifyNetworkError(new Error('SMTP 535：认证失败')), 'other');
});

test('hostOf：兼容 URL 与 host:port 两种写法', () => {
  assert.equal(hostOf('https://open.feishu.cn/open-apis/x'), 'open.feishu.cn');
  assert.equal(hostOf('https://qyapi.weixin.qq.com/cgi-bin/gettoken'), 'qyapi.weixin.qq.com');
  assert.equal(hostOf('imap.qq.com:993'), 'imap.qq.com');
  assert.equal(hostOf('smtp.163.com'), 'smtp.163.com');
});

test('fetch 打桩工具：withStubFetch 在 finally 恢复 globalThis.fetch', async () => {
  const original = globalThis.fetch;
  await withStubFetch(
    () => jsonResponse({ ok: true }),
    async () => {
      assert.notEqual(globalThis.fetch, original);
    },
  );
  assert.equal(globalThis.fetch, original);
});

// ---------------------------------------------------------------------------
// 飞书探针
// ---------------------------------------------------------------------------

test('飞书探针：code=0 且返回 token → PASS（只换 token）', async () => {
  const r = await withStubFetch(
    (url, init) => {
      assert.ok(url.endsWith('/open-apis/auth/v3/tenant_access_token/internal'));
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { app_id: 'cli_test', app_secret: 'feishu-secret-test' });
      return jsonResponse({ code: 0, tenant_access_token: 't-123', expire: 7200 });
    },
    () => probeFeishuToken(FEISHU),
  );
  assert.equal(r.status, 'PASS');
  assert.ok(r.detail.includes('7200'));
});

test('飞书探针：21001 → FAIL，建议提示「租户策略 / 企业认证」（代码无解）', async () => {
  const r = await withStubFetch(
    () => jsonResponse({ code: 21001, msg: 'tenant policy denied' }),
    () => probeFeishuToken(FEISHU),
  );
  assert.equal(r.status, 'FAIL');
  assert.ok(r.detail.includes('21001'));
  assert.ok((r.hint ?? '').includes('企业认证'));
  assert.ok((r.hint ?? '').includes('租户策略'));
});

test('飞书探针：10014 → FAIL，建议指向 App Secret 错误', async () => {
  const r = await withStubFetch(
    () => jsonResponse({ code: 10014, msg: 'invalid app secret' }),
    () => probeFeishuToken(FEISHU),
  );
  assert.equal(r.status, 'FAIL');
  assert.ok(r.detail.includes('10014'));
  assert.ok((r.hint ?? '').includes('App Secret'));
  assert.ok((r.hint ?? '').includes('FEISHU_APP_SECRET'));
});

test('飞书探针：网络超时 / DNS 失败 → FAIL，且不建议改凭据', async () => {
  const timeout = await withStubFetch(
    () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ETIMEDOUT' });
    },
    () => probeFeishuToken(FEISHU),
  );
  assert.equal(timeout.status, 'FAIL');
  assert.ok(timeout.detail.includes('超时'));
  assert.ok((timeout.hint ?? '').includes('代理'));

  const dns = await withStubFetch(
    () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), { code: 'ENOTFOUND' });
    },
    () => probeFeishuToken(FEISHU),
  );
  assert.equal(dns.status, 'FAIL');
  assert.ok(dns.detail.includes('域名解析失败'));
  assert.ok((dns.hint ?? '').includes('nslookup'));
});

test('飞书错误映射纯函数：未知错误码也有兜底建议', () => {
  const advice = explainFeishuError(12345, 'unknown');
  assert.ok(advice.detail.includes('12345'));
  assert.ok(advice.hint.includes('open.feishu.cn'));
});

// ---------------------------------------------------------------------------
// 钉钉探针 + 收发配置检查
// ---------------------------------------------------------------------------

test('钉钉探针：accessToken 获取成功 → PASS', async () => {
  const r = await withStubFetch(
    (url, init) => {
      assert.ok(url.endsWith('/v1.0/oauth2/accessToken'));
      assert.deepEqual(JSON.parse(String(init?.body)), { appKey: 'ding_test', appSecret: 'dingtalk-secret-test' });
      return jsonResponse({ accessToken: 'dt-123', expireIn: 7200 });
    },
    () => probeDingtalkToken(DINGTALK),
  );
  assert.equal(r.status, 'PASS');
  assert.ok(r.detail.includes('7200'));
});

test('钉钉探针：InvalidAuthentication → FAIL，建议核对 Client ID / Secret', async () => {
  const r = await withStubFetch(
    () => jsonResponse({ code: 'InvalidAuthentication', message: '不合法的ClientId或ClientSecret' }, 400),
    () => probeDingtalkToken(DINGTALK),
  );
  assert.equal(r.status, 'FAIL');
  assert.ok((r.hint ?? '').includes('DINGTALK_CLIENT_ID'));
  assert.ok((r.hint ?? '').includes('DINGTALK_CLIENT_SECRET'));
});

test('钉钉配置检查：机器人编码 + Stream 状态都 PASS', () => {
  const checks = dingtalkConfigChecks(DINGTALK);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.status === 'PASS'));
  assert.ok(checks.some((c) => c.id === 'dingtalk:robot'));
  assert.ok(checks.some((c) => c.id === 'dingtalk:stream'));
});

test('钉钉配置检查：缺 ROBOT_CODE 且无 Stream/回调 → 两条 FAIL 且带修复建议', () => {
  const checks = dingtalkConfigChecks({
    ...DINGTALK,
    robotCode: '',
    robotCodeExplicit: false,
    stream: false,
    aesToken: '',
    aesKey: '',
  });
  const failed = checks.filter((c) => c.status === 'FAIL');
  assert.equal(failed.length, 2);
  assert.ok(failed.some((c) => c.hint?.includes('DINGTALK_ROBOT_CODE')));
  assert.ok(failed.some((c) => c.hint?.includes('DINGTALK_STREAM=true')));
});

test('钉钉配置检查：仅本人身份关闭机器人 Stream 是有意配置，不再误报 FAIL', () => {
  const base = { ...DINGTALK, stream: false, aesToken: '', aesKey: '' };
  const personal = dingtalkConfigChecks({ ...base, personalReceive: true });
  const personalStream = personal.find((c) => c.id === 'dingtalk:stream');
  assert.equal(personalStream?.status, 'PASS');
  assert.match(personalStream?.detail ?? '', /本人事件流/);
  assert.match(personalStream?.hint ?? '', /DINGTALK_STREAM/);

  // 未固定本人身份（auto/bot）时，关掉机器人通道仍是真实的收信故障
  const bot = dingtalkConfigChecks({ ...base, personalReceive: false });
  assert.equal(bot.find((c) => c.id === 'dingtalk:stream')?.status, 'FAIL');
  assert.equal(dingtalkConfigChecks(base).find((c) => c.id === 'dingtalk:stream')?.status, 'FAIL');
});

// ---------------------------------------------------------------------------
// 邮箱错误映射（纯函数）
// ---------------------------------------------------------------------------

test('IMAP 错误映射：Unsafe Login / 登录失败 → 提示授权码与开启 IMAP', () => {
  const target = mailAccount();
  const unsafe = explainImapError(new Error('IMAP 登录失败：Unsafe Login'), target);
  assert.ok(unsafe.detail.includes('Unsafe Login'));
  assert.ok(unsafe.hint.includes('授权码'));
  assert.ok(unsafe.hint.includes('MAIL_QQ_AUTH_CODE'));

  const auth = explainImapError(new Error('IMAP 登录失败：AUTHENTICATIONFAILED'), target);
  assert.ok(auth.detail.includes('登录失败'));
  assert.ok(auth.hint.includes('授权码'));
});

test('IMAP 错误映射：ENOTFOUND 提示 host/DNS，且不出现完整邮箱地址', () => {
  const advice = explainImapError(
    Object.assign(new Error('getaddrinfo ENOTFOUND imap.qq.com'), { code: 'ENOTFOUND' }),
    mailAccount(),
  );
  assert.ok(advice.detail.includes('域名解析失败'));
  assert.ok(advice.hint.includes('nslookup'));
  // 网络类错误只展示 host，不含邮箱地址；也绝不能出现明文地址
  assert.ok(!advice.detail.includes('zhangsan@qq.com'));
});

test('SMTP 错误映射：535 → 授权码错误；ENOTFOUND → host/端口/网络', () => {
  const target = mailAccount();
  const auth = explainSmtpError(new Error('SMTP 535：Error: authentication failed'), target);
  assert.ok(auth.detail.includes('535'));
  assert.ok(auth.hint.includes('授权码'));
  assert.ok(auth.hint.includes('MAIL_QQ_AUTH_CODE'));
  assert.ok(!auth.detail.includes('zhangsan@qq.com'));
  assert.ok(auth.detail.includes('z******@qq.com'));

  const dns = explainSmtpError(
    Object.assign(new Error('getaddrinfo ENOTFOUND smtp.qq.com'), { code: 'ENOTFOUND' }),
    target,
  );
  assert.ok(dns.detail.includes('域名解析失败'));
  assert.ok(dns.hint.includes('smtp.qq.com') || dns.hint.includes('nslookup'));

  const timeout = explainSmtpError(new Error('SMTP 连接超时 smtp.qq.com:465'), target);
  assert.ok(timeout.detail.includes('超时'));
  assert.ok(timeout.hint.includes('防火墙') || timeout.hint.includes('网络'));
});

test('SMTP 错误映射：未声明 STARTTLS 时建议改 465 隐式 TLS', () => {
  const advice = explainSmtpError(
    new Error('SMTP 服务器 smtp.example.com:587 未声明 STARTTLS，无法安全登录'),
    mailAccount({ key: 'work', address: 'work@example.com', smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecure: false }),
  );
  assert.ok(advice.hint.includes('465'));
  assert.ok(advice.hint.includes('MAIL_WORK_SMTP_PORT'));
});

// ---------------------------------------------------------------------------
// 邮箱探针：注入假实现，绝不联网
// ---------------------------------------------------------------------------

test('邮箱探针（成功）：IMAP 只 SEARCH 立基线、SMTP 只登录，且授权码/地址不泄漏', async () => {
  const checks = await probeMailAccount(mailAccount(), {
    deps: {
      fetchNewMails: async () => ({ mails: [], maxUid: 42, greeting: '* OK' }),
      verifySmtpAuth: async () => ({ ok: true, server: 'smtp.qq.com', auth: 'plain', secure: true }),
    },
  });
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.status === 'PASS'));
  assert.ok(checks[0].detail.includes('42'));
  assert.ok(checks[0].detail.includes('UID SEARCH'));
  assert.ok(checks[1].detail.includes('PLAIN'));

  const text = checks.map((c) => `${c.title}${c.detail}${c.hint ?? ''}`).join('\n');
  assert.ok(!text.includes('AUTH-CODE-SHOULD-NOT-LEAK'), '探针输出泄露了授权码');
  assert.ok(!text.includes('zhangsan@qq.com'), '探针输出泄露了完整邮箱地址');
  assert.ok(text.includes('z******@qq.com'));
});

test('邮箱探针（失败）：Unsafe Login / SMTP 535 分别给出对应建议', async () => {
  const checks = await probeMailAccount(mailAccount(), {
    deps: {
      fetchNewMails: async () => {
        throw new Error('IMAP 登录失败：Unsafe Login');
      },
      verifySmtpAuth: async () => {
        throw new Error('SMTP 535：Error: authentication failed');
      },
    },
  });
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.status === 'FAIL'));
  assert.ok(checks[0].hint?.includes('授权码'));
  assert.ok(checks[1].detail.includes('535'));
  assert.ok(checks[1].hint?.includes('授权码'));
});

test('邮箱探针（超时）：注入永不 resolve 的实现 → FAIL 且原因含「超时」', async () => {
  const checks = await probeMailAccount(mailAccount(), {
    timeoutMs: 20,
    deps: {
      fetchNewMails: () => new Promise<never>(() => {}),
      verifySmtpAuth: async () => ({ ok: true, server: 'smtp.qq.com', auth: 'login', secure: true }),
    },
  });
  assert.equal(checks[0].status, 'FAIL');
  assert.ok(checks[0].detail.includes('超时'));
  assert.equal(checks[1].status, 'PASS');
});

// ---------------------------------------------------------------------------
// 编排：mock → SKIP；real → 探测；--platform 过滤
// ---------------------------------------------------------------------------

test('runProbes：全部平台 mock → 每个平台一条 SKIP + 一条大模型 SKIP（不发起任何请求）', async () => {
  const { checks } = await runProbes(probeInput());
  assert.equal(checks.length, 5, '4 个平台 + 1 条大模型');
  assert.ok(checks.every((c) => c.status === 'SKIP'));
  assert.ok(checks.some((c) => c.id === 'feishu:skipped'));
  assert.ok(checks.some((c) => c.id === 'mail:skipped'));
  assert.ok(checks.some((c) => c.id === 'llm:chat' && c.group === 'llm'));
  const platformChecks = checks.filter((c) => c.id !== 'llm:chat');
  assert.ok(platformChecks.every((c) => (c.hint ?? '').includes('_MODE=real') || (c.hint ?? '').includes('补齐')));
});

test('runProbes：--platform 过滤后只检查指定平台', async () => {
  const { checks } = await runProbes(probeInput(), { platformFilter: [Platform.FEISHU] });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, 'feishu:skipped');
  assert.equal(checks[0].group, Platform.FEISHU);
});

test('runProbes：mail 策略 real 但没有账号 → FAIL（不发任何请求）', async () => {
  const input = probeInput({
    runtime: mockRuntime({
      [Platform.MAIL]: {
        policy: 'real',
        mode: 'real',
        canSend: false,
        canReceive: false,
        missing: ['MAIL_ACCOUNTS'],
        warnings: [],
      },
    }),
  });
  const { checks } = await runProbes(input, { platformFilter: [Platform.MAIL] });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'FAIL');
  assert.ok(checks[0].detail.includes('没有可探测的邮箱账号'));
});

test('runProbes：mail real + 注入假实现 → 两条 PASS，且不联网', async () => {
  const input = probeInput({
    mail: { accounts: [mailAccount()], enabled: true },
    runtime: mockRuntime({
      [Platform.MAIL]: {
        policy: 'auto',
        mode: 'real',
        canSend: true,
        canReceive: true,
        missing: [],
        warnings: [],
      },
    }),
  });
  const { checks } = await runProbes(input, {
    platformFilter: [Platform.MAIL],
    deps: {
      fetchNewMails: async () => ({ mails: [], maxUid: 7, greeting: '* OK' }),
      verifySmtpAuth: async () => ({ ok: true, server: 'smtp.qq.com', auth: 'login', secure: true }),
    },
  });
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.status === 'PASS'));
});

test('runProbes：钉钉 real → token + 机器人 + Stream 三条检查', async () => {
  const input = probeInput({
    runtime: mockRuntime({
      [Platform.DINGTALK]: {
        policy: 'auto',
        mode: 'real',
        canSend: true,
        canReceive: true,
        missing: [],
        warnings: [],
      },
    }),
  });
  const { checks } = await withStubFetch(
    () => jsonResponse({ accessToken: 'dt-123', expireIn: 7200 }),
    () => runProbes(input, { platformFilter: [Platform.DINGTALK] }),
  );
  assert.equal(checks.length, 3);
  assert.ok(checks.every((c) => c.status === 'PASS'));
});


// ---------------------------------------------------------------------------
// 大模型探针：只发一条固定样例，确认鉴权、协议与 JSON 约束
// ---------------------------------------------------------------------------

function llmInput(over: Partial<LlmProbeInput> = {}): LlmProbeInput {
  return {
    ready: true,
    provider: 'mimo',
    model: 'mimo-v2.6-flash',
    endpoint: 'https://api.xiaomimimo.com/v1',
    apiKey: 'sk-test',
    minConfidence: 0.6,
    ...over,
  };
}

function openaiBody(content: string): unknown {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { total_tokens: 120 },
  };
}

test('LLM 探针：未配置真实大模型 → SKIP，且绝不发请求', async () => {
  let calls = 0;
  const check = await withStubFetch(
    () => { calls += 1; return jsonResponse({}); },
    () => probeLlm(llmInput({ ready: false })),
  );
  assert.equal(check.status, 'SKIP');
  assert.equal(check.group, 'llm');
  assert.equal(calls, 0);
});

test('LLM 探针：正常返回 → PASS 并报告模型与耗时', async () => {
  const check = await withStubFetch(
    (url) => {
      assert.ok(url.endsWith('/chat/completions'), `应请求 chat/completions，实际 ${url}`);
      return jsonResponse(openaiBody(JSON.stringify({ intent: '待办', confidence: 0.9, summary: 's', replyDraft: 'd' })));
    },
    () => probeLlm(llmInput()),
  );
  assert.equal(check.status, 'PASS');
  assert.ok(check.detail.includes('mimo-v2.6-flash'));
  assert.ok(check.detail.includes('待办'));
});

test('LLM 探针：401 → FAIL，提示检查 Key', async () => {
  const check = await withStubFetch(
    () => jsonResponse({ error: 'unauthorized' }, 401),
    () => probeLlm(llmInput()),
  );
  assert.equal(check.status, 'FAIL');
  assert.match(check.hint ?? '', /LLM_API_KEY|Key/i);
});

test('LLM 探针：返回非 JSON 内容 → FAIL，指出模型没有遵守输出约束', async () => {
  const check = await withStubFetch(
    () => jsonResponse(openaiBody('抱歉，我无法完成')),
    () => probeLlm(llmInput()),
  );
  assert.equal(check.status, 'FAIL');
  assert.match(check.detail, /JSON/i);
});

test('LLM 探针：网络错误 → FAIL 并附排查建议', async () => {
  const check = await withStubFetch(
    () => { throw new Error('getaddrinfo ENOTFOUND api.xiaomimimo.com'); },
    () => probeLlm(llmInput()),
  );
  assert.equal(check.status, 'FAIL');
  assert.ok((check.hint ?? '').length > 0);
});


// ---------------------------------------------------------------------------
// 本人身份探针（只读；未配置一律 SKIP/FAIL 可操作）
// ---------------------------------------------------------------------------

test('probeFeishuIdentity：Mock 模式 SKIP；未连接 auto SKIP、显式 user FAIL', async () => {
  const mock = await probeFeishuIdentity({ mode: 'mock', policy: 'auto', receiveEnabled: true, baseUrl: 'https://open.feishu.cn' });
  assert.equal(mock[0]!.status, 'SKIP');
  assert.match(mock[0]!.detail, /模拟模式/);

  const notLinked = await probeFeishuIdentity(
    { mode: 'real', policy: 'auto', receiveEnabled: true, baseUrl: 'https://open.feishu.cn' },
    { feishu: { status: () => ({ state: 'none', accessExpiresAt: undefined }), canAuthorize: () => true } },
  );
  assert.equal(notLinked[0]!.status, 'SKIP');
  assert.match(notLinked[0]!.hint ?? '', /连接本人账号/);

  const forced = await probeFeishuIdentity(
    { mode: 'real', policy: 'user', receiveEnabled: true, baseUrl: 'https://open.feishu.cn' },
    { feishu: { status: () => ({ state: 'none' }), canAuthorize: () => true } },
  );
  assert.equal(forced[0]!.status, 'FAIL');
  assert.match(forced[0]!.detail, /发送会显式失败/);
});

test('probeFeishuIdentity：已连接时只读拉一次 chats；权限错误给出 scope 修复提示', async () => {
  const status = () => ({ state: 'active' as const, accessExpiresAt: '2026-11-12T10:00:00.000Z' });
  const okFetch = (async () => new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 })) as unknown as typeof fetch;
  const pass = await probeFeishuIdentity(
    { mode: 'real', policy: 'auto', receiveEnabled: true, baseUrl: 'https://open.feishu.cn' },
    { feishu: { status, canAuthorize: () => true, accessToken: async () => 'tok', fetchImpl: okFetch } },
  );
  assert.equal(pass[0]!.status, 'PASS');
  assert.equal(pass[1]!.status, 'PASS');
  assert.match(pass[1]!.detail, /轮询延迟 5–30s/);

  const denyFetch = (async () => new Response(JSON.stringify({ code: 99991672, msg: 'denied' }), { status: 200 })) as unknown as typeof fetch;
  const denied = await probeFeishuIdentity(
    { mode: 'real', policy: 'auto', receiveEnabled: true, baseUrl: 'https://open.feishu.cn' },
    { feishu: { status, canAuthorize: () => true, accessToken: async () => 'tok', fetchImpl: denyFetch } },
  );
  assert.equal(denied[1]!.status, 'FAIL');
  assert.match(denied[1]!.hint ?? '', /im:message\.p2p_msg:get_as_user/);
});

test('probeDingtalkIdentity：dws 未安装 auto SKIP / user FAIL；未登录给出登录命令；已登录 PASS', async () => {
  const notInstalled = await probeDingtalkIdentity(
    { mode: 'real', policy: 'auto', receiveEnabled: true },
    { dingtalk: { version: async () => ({ error: '未找到 dws' }) } },
  );
  assert.equal(notInstalled[0]!.status, 'SKIP');
  assert.match(notInstalled[0]!.hint ?? '', /DWS_BIN|dingtalk-workspace-cli/);

  const forced = await probeDingtalkIdentity(
    { mode: 'real', policy: 'user', receiveEnabled: true },
    { dingtalk: { version: async () => ({ error: '未找到 dws' }) } },
  );
  assert.equal(forced[0]!.status, 'FAIL');

  const notLogged = await probeDingtalkIdentity(
    { mode: 'real', policy: 'auto', receiveEnabled: true },
    {
      dingtalk: {
        version: async () => ({ version: 'v1.0.68-beta.1' }),
        authStatus: async () => ({ available: true, authenticated: false, checkedAt: Date.now(), message: '未登录' }),
        loginCommand: () => 'dws auth login --device',
      },
    },
  );
  assert.equal(notLogged[0]!.status, 'SKIP');
  assert.match(notLogged[0]!.hint ?? '', /dws auth login --device/);

  const linked = await probeDingtalkIdentity(
    { mode: 'real', policy: 'auto', receiveEnabled: true },
    {
      dingtalk: {
        version: async () => ({ version: 'v1.0.68-beta.1' }),
        authStatus: async () => ({ available: true, authenticated: true, checkedAt: Date.now() }),
        eventListAvailable: async () => ({ ok: true, detail: 'dws event list 可用' }),
      },
    },
  );
  assert.equal(linked[0]!.status, 'PASS');
  assert.match(linked[0]!.detail, /本人身份已登录/);
  assert.equal(linked[1]!.status, 'PASS');
});

// ---------------------------------------------------------------------------
// 微信：real 模式必须真的探测桥（P0：不能"配了 real 就 SKIP/PASS"）
// ---------------------------------------------------------------------------

test('微信 real + 桥在 mock → FAIL，提示用 --mode rpa 重启', async () => {
  await withStubFetch(
    (url) => (/\/health$/.test(url)
      ? jsonResponse({ ok: true, mode: 'mock' })
      : textResponse('not found', 404)),
    async () => {
      const input = probeInput({
        runtime: mockRuntime({
          [Platform.WECHAT]: { policy: 'real', mode: 'real', canSend: true, canReceive: true, missing: [], warnings: [] },
        }),
        wechat: { bridgeUrl: 'http://127.0.0.1:8787' },
      });
      const { checks } = await runProbes(input, { platformFilter: [Platform.WECHAT] });
      assert.equal(checks.length, 1);
      assert.equal(checks[0]!.id, 'wechat:bridge');
      assert.equal(checks[0]!.status, 'FAIL');
      assert.match(checks[0]!.detail, /mock 模式/);
      assert.match(String(checks[0]!.hint), /--mode rpa/);
    },
  );
});

test('微信 real + 桥在 rpa 且接收可用 → 发送/接收两条都 PASS', async () => {
  await withStubFetch(
    (url) => (/\/health$/.test(url)
      ? jsonResponse({ ok: true, mode: 'rpa', receive: { implemented: true, supported: true } })
      : textResponse('not found', 404)),
    async () => {
      const input = probeInput({
        runtime: mockRuntime({
          [Platform.WECHAT]: { policy: 'real', mode: 'real', canSend: true, canReceive: true, missing: [], warnings: [] },
        }),
        wechat: { bridgeUrl: 'http://127.0.0.1:8787' },
      });
      const { checks } = await runProbes(input, { platformFilter: [Platform.WECHAT] });
      assert.deepEqual(checks.map((c) => c.id), ['wechat:bridge', 'wechat:receive']);
      assert.ok(checks.every((c) => c.status === 'PASS'));
    },
  );
});

test('微信 real + 桥 rpa 但接收未就绪 → 发送 PASS / 接收 FAIL（如实区分）', async () => {
  await withStubFetch(
    (url) => (/\/health$/.test(url)
      ? jsonResponse({
        ok: true,
        mode: 'rpa',
        receive: { implemented: true, supported: false, reason: '未找到微信主窗口' },
      })
      : textResponse('not found', 404)),
    async () => {
      const input = probeInput({
        runtime: mockRuntime({
          [Platform.WECHAT]: { policy: 'real', mode: 'real', canSend: true, canReceive: true, missing: [], warnings: [] },
        }),
        wechat: { bridgeUrl: 'http://127.0.0.1:8787' },
      });
      const { checks } = await runProbes(input, { platformFilter: [Platform.WECHAT] });
      assert.equal(checks[0]!.status, 'PASS');
      assert.equal(checks[1]!.status, 'FAIL');
      assert.match(checks[1]!.detail, /未找到微信主窗口/);
    },
  );
});

test('微信 4.x：接收项 SKIP（不是 FAIL），并指到按需拉取', async () => {
  await withStubFetch(
    (url) => (/\?|health$/.test(url) && /\/health/.test(url)
      ? jsonResponse({
        ok: true,
        mode: 'rpa',
        receive: { implemented: true, supported: false, reason: '微信 4.x 不暴露控件树' },
        client: { kind: 'weixin4', uiaUsable: false, reason: '微信 4.x（Qt 自绘）' },
      })
      : textResponse('not found', 404)),
    async () => {
      const input = probeInput({
        runtime: mockRuntime({
          [Platform.WECHAT]: { policy: 'real', mode: 'real', canSend: true, canReceive: true, missing: [], warnings: [] },
        }),
        wechat: { bridgeUrl: 'http://127.0.0.1:8788' },
      });
      const { checks } = await runProbes(input, { platformFilter: [Platform.WECHAT] });
      const send = checks.find((c) => c.id === 'wechat:bridge')!;
      const recv = checks.find((c) => c.id === 'wechat:receive')!;
      assert.equal(send.status, 'PASS');
      assert.equal(recv.status, 'SKIP', '4.x 是"不适用"，不该报失败');
      assert.match(recv.detail, /按需拉取/);
      assert.match(String(recv.hint), /\/api\/wechat\/pull/);
    },
  );
});
