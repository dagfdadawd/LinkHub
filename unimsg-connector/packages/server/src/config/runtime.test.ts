/**
 * 可替换性核心单测：环境变量 → 邮箱账号 / 平台运行模式。
 * 全部是纯函数测试，不触网、不改全局 process.env。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '@unimsg/shared';
import {
  buildPlatformRuntime,
  inferMailProvider,
  parseMailAccounts,
  readPlatformCredentials,
  resolveLlmRuntime,
  resolveFeishuScopes,
  resolveModePolicies,
  type MailAccount,
  type PlatformCredentials,
  resolveIdentityConfig,
  parseDingtalkEventKinds,
  parseFeishuIdentityPolicy,
} from './runtime';

function creds(): PlatformCredentials {
  return {
    feishu: { appId: '', appSecret: '', verifyToken: '', encryptKey: '', stream: false, baseUrl: 'https://open.feishu.cn' },
    dingtalk: { appKey: '', appSecret: '', robotCode: '', aesToken: '', aesKey: '', stream: false, baseUrl: 'https://api.dingtalk.com' },
    wechat: { bridgeUrl: 'http://127.0.0.1:8787' },
  };
}

function mailAccount(over: Partial<MailAccount> = {}): MailAccount {
  return {
    key: 'qq',
    label: 'QQ邮箱',
    address: 'me@qq.com',
    authCode: 'auth',
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

function runtimeOf(env: NodeJS.ProcessEnv, over: { platforms?: PlatformCredentials; mailAccounts?: MailAccount[]; mailEnabled?: boolean; mailEnabledExplicit?: boolean } = {}) {
  return buildPlatformRuntime({
    env,
    platforms: over.platforms ?? readPlatformCredentials(env),
    mailAccounts: over.mailAccounts ?? [],
    mailIssues: [],
    mailEnabled: over.mailEnabled ?? (over.mailAccounts ?? []).length > 0,
    mailEnabledExplicit: over.mailEnabledExplicit,
    underTest: false,
  });
}

// ---------------------------------------------------------------------------
// 邮箱账号解析：任意服务商 / 任意数量
// ---------------------------------------------------------------------------

test('mail：不写 MAIL_ACCOUNTS 时自动发现 MAIL_<KEY>_ADDRESS，老配置零改动', () => {
  const r = parseMailAccounts({
    MAIL_QQ_ADDRESS: 'me@qq.com',
    MAIL_QQ_AUTH_CODE: 'code-qq',
    MAIL_163_ADDRESS: 'me@163.com',
    MAIL_163_AUTH_CODE: 'code-163',
  });
  assert.equal(r.accounts.length, 2);
  assert.deepEqual(r.accounts.map((a) => a.key), ['163', 'qq']); // 稳定字母序
  assert.equal(r.accounts.find((a) => a.key === 'qq')?.provider, 'qq');
  assert.equal(r.accounts.find((a) => a.key === '163')?.imapHost, 'imap.163.com');
  assert.equal(r.issues.length, 0);
});

test('mail：MAIL_ACCOUNTS 显式列账号 + 顺序保留 + 同名服务商多账号', () => {
  const r = parseMailAccounts({
    MAIL_ACCOUNTS: 'work,personal',
    MAIL_WORK_ADDRESS: 'a@corp.example.com',
    MAIL_WORK_AUTH_CODE: 'code-a',
    MAIL_WORK_IMAP_HOST: 'imap.corp.example.com',
    MAIL_WORK_SMTP_HOST: 'smtp.corp.example.com',
    MAIL_PERSONAL_ADDRESS: 'b@gmail.com',
    MAIL_PERSONAL_AUTH_CODE: 'code-b',
  });
  assert.deepEqual(r.accounts.map((a) => a.key), ['work', 'personal']);
  const work = r.accounts[0];
  assert.equal(work.provider, 'custom');
  assert.equal(work.imapHost, 'imap.corp.example.com');
  assert.equal(work.imapPort, 993);
  assert.equal(work.smtpPort, 465);
  assert.equal(work.smtpSecure, true);
  // Gmail 走内置预设；Gmail 需要应用专用密码，本质上也是"授权码"
  assert.equal(r.accounts[1].provider, 'gmail');
  assert.equal(r.accounts[1].imapHost, 'imap.gmail.com');
});

test('mail：按域名推断服务商（126 / yeah / outlook / icloud / 公司域名）', () => {
  assert.equal(inferMailProvider('a@126.com'), '126');
  assert.equal(inferMailProvider('a@yeah.net'), 'yeah');
  assert.equal(inferMailProvider('a@outlook.com'), 'outlook');
  assert.equal(inferMailProvider('a@hotmail.com'), 'outlook');
  assert.equal(inferMailProvider('a@icloud.com'), 'icloud');
  assert.equal(inferMailProvider('a@company.cn'), 'custom');
  assert.equal(inferMailProvider('a@qq.com', 'gmail'), 'gmail', '显式 provider 优先于域名');
});

test('mail：587 端口自动推断 STARTTLS，显式 _SMTP_SECURE 可覆盖', () => {
  const r = parseMailAccounts({
    MAIL_OUT_ADDRESS: 'a@outlook.com',
    MAIL_OUT_AUTH_CODE: 'x',
  });
  assert.equal(r.accounts[0].smtpPort, 587);
  assert.equal(r.accounts[0].smtpSecure, false, '587 走 STARTTLS 而不是隐式 TLS');
  assert.equal(r.accounts[0].imapSecure, true);

  const explicit = parseMailAccounts({
    MAIL_A_ADDRESS: 'a@outlook.com',
    MAIL_A_AUTH_CODE: 'x',
    MAIL_A_SMTP_SECURE: 'true',
  });
  assert.equal(explicit.accounts[0].smtpSecure, true);
});

test('mail：自定义服务商必须给 host，缺授权码/地址会进 issues 而不是静默跳过', () => {
  const r = parseMailAccounts({
    MAIL_ACCOUNTS: 'corp,broken,half',
    MAIL_CORP_ADDRESS: 'me@corp.cn',
    MAIL_CORP_AUTH_CODE: 'x',
    MAIL_BROKEN_ADDRESS: 'x@qq.com',
    MAIL_HALF_AUTH_CODE: 'only-auth-code',
  });
  assert.equal(r.accounts.length, 0, 'corp 缺 host、broken/half 缺地址或授权码，都不应算作可用账号');
  const msgs = r.issues.map((i) => i.message).join('\n');
  assert.match(msgs, /IMAP_HOST/);
  assert.match(msgs, /AUTH_CODE/);
  assert.match(msgs, /MAIL_HALF_ADDRESS/);
});

test('mail：单个账号的 host/port/label/folders 可逐项覆盖', () => {
  const r = parseMailAccounts({
    MAIL_QQ_ADDRESS: 'me@qq.com',
    MAIL_QQ_AUTH_CODE: 'x',
    MAIL_QQ_LABEL: '主邮箱',
    MAIL_QQ_IMAP_HOST: 'imap.example-proxy.com',
    MAIL_QQ_IMAP_PORT: '143',
    MAIL_QQ_SMTP_PORT: '25',
    MAIL_QQ_FOLDERS: 'INBOX, Junk',
  });
  const a = r.accounts[0];
  assert.equal(a.label, '主邮箱');
  assert.equal(a.imapHost, 'imap.example-proxy.com');
  assert.equal(a.imapPort, 143);
  assert.equal(a.imapSecure, false, '143 → STARTTLS');
  assert.equal(a.smtpPort, 25);
  assert.equal(a.smtpSecure, false, '25 → STARTTLS');
  assert.deepEqual(a.folders, ['INBOX', 'Junk']);
});

// ---------------------------------------------------------------------------
// 模式解析：auto / real / mock 与旧 MOCK 兼容
// ---------------------------------------------------------------------------

test('mode：没配凭据时 auto → 全部 mock，且不出现"假装真实"', () => {
  const rt = runtimeOf({}, { mailAccounts: [], mailEnabled: false });
  for (const p of Object.values(Platform)) {
    assert.equal(rt[p].mode, 'mock', `${p} 应为 mock`);
    assert.equal(rt[p].policy, 'auto');
    // 微信 RPA 的桥地址有默认值，天然「已就绪」，但仍强制 mock——这里只对需要凭据的平台断言未配置
    if (p !== Platform.WECHAT) assert.equal(rt[p].configured, false);
  }
});

test('mode：只配钉钉 → 钉钉 real，其余 mock（可替换性的关键场景）', () => {
  const rt = runtimeOf({
    DINGTALK_CLIENT_ID: 'ding1',
    DINGTALK_CLIENT_SECRET: 'secret1',
    DINGTALK_STREAM: 'true',
  });
  assert.equal(rt[Platform.DINGTALK].mode, 'real');
  assert.equal(rt[Platform.DINGTALK].canReceive, true, 'Stream 长连接可收');
  assert.equal(rt[Platform.DINGTALK].canSend, true, 'ROBOT_CODE 缺省等于 Client ID');
  assert.deepEqual(rt[Platform.DINGTALK].missing, [], 'Stream 模式不需要 HTTP 回调用 AES Token/Key');
  assert.equal(rt[Platform.FEISHU].mode, 'mock');
  assert.equal(rt[Platform.WECHAT].mode, 'mock');
  assert.equal(rt[Platform.MAIL].mode, 'mock');
  assert.match(rt[Platform.DINGTALK].reason, /真实接口/);
});

test('钉钉：仅本人身份关闭机器人 Stream → 不再误报缺 AES / 收不到消息，canReceive 仍如实为 false', () => {
  const env = {
    DINGTALK_CLIENT_ID: 'ding1',
    DINGTALK_CLIENT_SECRET: 'secret1',
    DINGTALK_STREAM: 'false',
    DINGTALK_IDENTITY: 'user',
  };
  const personal = runtimeOf(env)[Platform.DINGTALK];
  assert.equal(personal.mode, 'real', '凭据齐全，auto 仍走真实通道');
  assert.equal(personal.canReceive, false, '机器人凭据确实不能收，绝不假装成功');
  assert.deepEqual(personal.missing, [], '仅本人身份不需要 HTTP 回调 AES Token/Key');
  assert.match(personal.warnings.join('|'), /dws 本人事件流/);
  assert.doesNotMatch(personal.warnings.join('|'), /暂时收不到消息/);

  // 未固定本人身份时保持原诊断口径
  const bot = runtimeOf({ ...env, DINGTALK_IDENTITY: 'auto' })[Platform.DINGTALK];
  assert.deepEqual(bot.missing, ['DINGTALK_AES_TOKEN', 'DINGTALK_AES_KEY']);
  assert.match(bot.warnings.join('|'), /暂时收不到消息/);
});

test('mode：显式 mock 即使有凭据也走本地模拟（绝不偷偷打真实接口）', () => {
  const rt = runtimeOf({
    FEISHU_MODE: 'mock',
    FEISHU_APP_ID: 'a',
    FEISHU_APP_SECRET: 'b',
    FEISHU_VERIFY_TOKEN: 'c',
  });
  assert.equal(rt[Platform.FEISHU].mode, 'mock');
  assert.equal(rt[Platform.FEISHU].policy, 'mock');
  assert.match(rt[Platform.FEISHU].reason, /演示模式/);
});

test('mode：微信 auto 恒为 mock（桥地址有默认值，不能因“凭据齐全”误判真实）；显式 real 才 real', () => {
  const auto = runtimeOf({});
  assert.equal(auto[Platform.WECHAT].mode, 'mock', 'auto 下微信默认走模拟，必须显式 real 才操作真实微信');

  const forced = runtimeOf({ WECHAT_MODE: 'real' });
  assert.equal(forced[Platform.WECHAT].mode, 'real');
});

test('mode：旧 MOCK=true / false 仍可用但会提示废弃', () => {
  const on = resolveModePolicies({ MOCK: 'true' });
  assert.equal(on.policies[Platform.FEISHU], 'mock');
  assert.match(on.warnings.join('\n'), /MOCK 已废弃/);

  const off = resolveModePolicies({ MOCK: 'false' });
  assert.equal(off.policies[Platform.MAIL], 'real');

  // *_MODE 优先级高于 MOCK
  const mixed = resolveModePolicies({ MOCK: 'true', FEISHU_MODE: 'real' });
  assert.equal(mixed.policies[Platform.FEISHU], 'real');
  assert.equal(mixed.policies[Platform.DINGTALK], 'mock');
});

test('mode：非法 *_MODE 值回退 auto 并给出警告', () => {
  const r = resolveModePolicies({ FEISHU_MODE: 'yes-please' });
  assert.equal(r.policies[Platform.FEISHU], 'auto');
  assert.match(r.warnings.join('\n'), /FEISHU_MODE/);
});

test('mode：测试环境默认 mock（单测绝不外呼），unless 显式 force', () => {
  const rt = buildPlatformRuntime({
    env: { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_VERIFY_TOKEN: 'c' },
    platforms: readPlatformCredentials({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_VERIFY_TOKEN: 'c' }),
    mailAccounts: [],
    mailIssues: [],
    mailEnabled: false,
    underTest: true,
  });
  assert.equal(rt[Platform.FEISHU].mode, 'mock');
});

// ---------------------------------------------------------------------------
// 能力画像：前端/doctor 使用的 missing / warnings
// ---------------------------------------------------------------------------

test('capability：飞书只配 AppID/Secret（默认长连接）→ 收发均✓，不要求 Verification Token（P2-6）', () => {
  const rt = runtimeOf({
    FEISHU_APP_ID: 'a',
    FEISHU_APP_SECRET: 'b',
  });
  const f = rt[Platform.FEISHU];
  assert.equal(f.mode, 'real');
  assert.equal(f.canSend, true);
  assert.equal(f.canReceive, true, '默认 FEISHU_STREAM=true 时只配 App ID/Secret 即可收');
  assert.ok(!f.missing.includes('FEISHU_VERIFY_TOKEN'), '长连接不要求 Verify Token');
  assert.ok(f.warnings.some((w) => w.includes('已开启飞书长连接')));
});

test('capability：飞书显式 HTTP 回调（FEISHU_STREAM=false）且缺 Verify Token → 发✓收✗并进 missing', () => {
  const rt = runtimeOf({
    FEISHU_APP_ID: 'a',
    FEISHU_APP_SECRET: 'b',
    FEISHU_STREAM: 'false',
  });
  const f = rt[Platform.FEISHU];
  assert.equal(f.mode, 'real');
  assert.equal(f.canSend, true);
  assert.equal(f.canReceive, false);
  assert.ok(f.warnings.some((w) => w.includes('只能发不能收')));
  assert.ok(f.missing.includes('FEISHU_VERIFY_TOKEN'));
});

test('capability：微信默认 mock —— 配了桥地址也不谎报能收（P0）', () => {
  const rt = runtimeOf({});
  assert.equal(rt[Platform.WECHAT].configured, true, '桥地址有默认值，视为配置齐全');
  assert.equal(rt[Platform.WECHAT].mode, 'mock', '默认 auto 对微信解析为 mock：不会操作真实微信');
  assert.equal(rt[Platform.WECHAT].canSend, true);
  assert.equal(rt[Platform.WECHAT].canReceive, false, 'mock 不采集真实微信消息，不能报"能收"');
  assert.equal(rt[Platform.WECHAT].missing.length, 0);
  assert.ok(rt[Platform.WECHAT].warnings.some((w) => w.includes('不采集真实微信消息')));
});

test('capability：微信显式 real —— 配置上收发可用，真实能力由桥探针判定', () => {
  const rt = runtimeOf({ WECHAT_MODE: 'real' });
  assert.equal(rt[Platform.WECHAT].mode, 'real');
  assert.equal(rt[Platform.WECHAT].canSend, true);
  assert.equal(rt[Platform.WECHAT].canReceive, true, 'real 模式下配置层面允许接收');
  assert.ok(rt[Platform.WECHAT].warnings.some((w) => w.includes('RPA 桥的运行态')));
});

test('capability：邮箱有账号 → 收发均 ✓；MAIL_ENABLED=false 时只发不收', () => {
  const accounts = [mailAccount()];
  const on = runtimeOf({}, { mailAccounts: accounts, mailEnabled: true });
  assert.equal(on[Platform.MAIL].mode, 'real');
  assert.equal(on[Platform.MAIL].canReceive, true);
  assert.equal(on[Platform.MAIL].canSend, true);

  const off = runtimeOf({}, { mailAccounts: accounts, mailEnabled: false });
  assert.equal(off[Platform.MAIL].canReceive, false);
  assert.ok(off[Platform.MAIL].warnings.some((w) => w.includes('MAIL_ENABLED=false')));
});

test('capability：邮箱一个账号都没配时，reason 不误报 MAIL_ENABLED=false', () => {
  const rt = runtimeOf({}, { mailAccounts: [], mailEnabled: false });
  assert.doesNotMatch(rt[Platform.MAIL].reason, /MAIL_ENABLED=false/);
  assert.match(rt[Platform.MAIL].reason, /还没填好|没生效/);
});

test('readPlatformCredentials：旧钉钉变量名兼容 + baseUrl 可覆盖并可去尾斜杠', () => {
  const c = readPlatformCredentials({
    DINGTALK_APP_KEY: 'old-key',
    DINGTALK_APP_SECRET: 'old-secret',
    FEISHU_BASE_URL: 'https://open.larksuite.com/',
  });
  assert.equal(c.dingtalk.appKey, 'old-key');
  assert.equal(c.dingtalk.robotCode, 'old-key', 'ROBOT_CODE 缺省 = Client ID');
  assert.equal(c.feishu.baseUrl, 'https://open.larksuite.com');
  assert.equal(c.dingtalk.baseUrl, 'https://api.dingtalk.com');
});

// ---------- 大模型运行模式（LLM 也走「绝不静默假装成功」的解析规则） ----------

test('LLM：未配置 provider 时走规则 Mock，并说明原因', () => {
  const r = resolveLlmRuntime({});
  assert.equal(r.mode, 'mock');
  assert.equal(r.ready, false);
  assert.match(r.reason, /mock/i);
});

test('LLM：provider=openai 但缺 API Key → 降级 Mock 且列出缺失项', () => {
  const r = resolveLlmRuntime({ LLM_PROVIDER: 'openai' });
  assert.equal(r.mode, 'mock');
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes('LLM_API_KEY'));
  assert.match(r.reason, /LLM_API_KEY|降级/);
});

test('LLM：provider=openai + Key → 真实模式，默认 MiMo flash 端点与 15s 超时', () => {
  const r = resolveLlmRuntime({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-test' });
  assert.equal(r.mode, 'real');
  assert.equal(r.ready, true);
  assert.equal(r.provider, 'mimo');
  assert.equal(r.model, 'mimo-v2.6-flash');
  assert.equal(r.endpoint, 'https://api.xiaomimimo.com/v1');
  assert.equal(r.timeoutMs, 15000);
  assert.equal(r.minConfidence, 0.6);
  assert.deepEqual(r.missing, []);
});

test('LLM：model / endpoint / 超时 / 置信阈值均可覆盖，endpoint 去尾斜杠', () => {
  const r = resolveLlmRuntime({
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'mimo-v2.6-pro',
    LLM_ENDPOINT: 'https://api.deepseek.com/v1/',
    LLM_TIMEOUT_MS: '20000',
    LLM_MIN_CONFIDENCE: '0.8',
  });
  assert.equal(r.model, 'mimo-v2.6-pro');
  assert.equal(r.endpoint, 'https://api.deepseek.com/v1');
  assert.equal(r.timeoutMs, 20000);
  assert.equal(r.minConfidence, 0.8);
});

test('LLM：不支持的 provider 明确降级，不静默当成真实', () => {
  const r = resolveLlmRuntime({ LLM_PROVIDER: 'wenxin', LLM_API_KEY: 'sk-test' });
  assert.equal(r.mode, 'mock');
  assert.equal(r.ready, false);
  assert.match(r.reason, /wenxin|不支持/);
  assert.match(r.reason, /协议类型/);
  assert.match(r.reason, /openai/);
});

test('LLM：厂商中文名 / 别名归一为 OpenAI 兼容协议，不再因名字不对而降级', () => {
  for (const provider of ['火山引擎', '火山方舟', 'DeepSeek', '通义千问', '智谱', '自定义']) {
    const r = resolveLlmRuntime({ LLM_PROVIDER: provider, LLM_API_KEY: 'sk-test' });
    assert.equal(r.mode, 'real', `${provider} 应识别为真实模式`);
    assert.equal(r.policy, 'openai');
  }
});

test('LLM：按端点推断真实厂商名，AI 来源标签不再固定写 MiMo', () => {
  const r = resolveLlmRuntime({
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'sk-test',
    LLM_ENDPOINT: 'https://ark.cn-beijing.volces.com/api/v3',
    LLM_MODEL: 'doubao-seed-1-6-250615',
  });
  assert.equal(r.provider, 'volcengine');
  assert.equal(r.providerLabel, '火山方舟');
  assert.equal(r.endpointFrom, 'LLM_ENDPOINT');
  assert.equal(r.model, 'doubao-seed-1-6-250615');
  assert.match(r.reason, /火山方舟/);
});

test('LLM：GUI 写的 LLM_BASE_URL 会被读取，显式 LLM_ENDPOINT 优先', () => {
  const legacy = resolveLlmRuntime({
    LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-test',
    LLM_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3/',
  });
  assert.equal(legacy.endpoint, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(legacy.endpointFrom, 'LLM_BASE_URL');
  assert.equal(legacy.providerLabel, '火山方舟');

  const both = resolveLlmRuntime({
    LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-test',
    LLM_ENDPOINT: 'https://api.deepseek.com/v1',
    LLM_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3',
  });
  assert.equal(both.endpoint, 'https://api.deepseek.com/v1');
  assert.equal(both.endpointFrom, 'LLM_ENDPOINT');
  assert.equal(both.providerLabel, 'DeepSeek');
});


test('Mock 模式不冒充"已开启长连接"：改为"已配置但当前为 Mock、不会实际连接"', () => {
  const mock = runtimeOf({ FEISHU_STREAM: 'true', FEISHU_MODE: 'mock', DINGTALK_STREAM: 'true', DINGTALK_MODE: 'mock' }, {});
  const feishuWarn = mock[Platform.FEISHU].warnings.join('|');
  assert.ok(!/已开启.*长连接/.test(feishuWarn), `mock 下不得说已开启：${feishuWarn}`);
  assert.match(feishuWarn, /不会实际连接/);
  const dingtalkWarn = mock[Platform.DINGTALK].warnings.join('|');
  assert.ok(!/已开启.*长连接/.test(dingtalkWarn));
  assert.match(dingtalkWarn, /不会实际连接/);

  const real = runtimeOf({ FEISHU_STREAM: 'true', FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_MODE: 'real' }, {});
  assert.match(real[Platform.FEISHU].warnings.join('|'), /已开启飞书长连接/);
});

test('邮箱轮询关闭原因：显式 MAIL_ENABLED=false 与"未开启"区分文案', () => {
  const accounts = [mailAccount()];
  const explicit = runtimeOf({}, { mailAccounts: accounts, mailEnabled: false, mailEnabledExplicit: true });
  assert.match(explicit[Platform.MAIL].reason, /MAIL_ENABLED=false/);
  const implicit = runtimeOf({}, { mailAccounts: accounts, mailEnabled: false, mailEnabledExplicit: false });
  assert.doesNotMatch(implicit[Platform.MAIL].reason, /MAIL_ENABLED=false/);
  assert.match(implicit[Platform.MAIL].reason, /邮箱轮询未启用/);
});


test('resolveFeishuScopes：本人接收开启时 OAuth 必须一并申请读消息 + 列会话权限（否则授权后仍 99991672/99991679）', () => {
  const auto = resolveFeishuScopes({ policy: 'auto', receive: 'auto' });
  assert.ok(auto.includes('im:message'));
  assert.ok(auto.includes('im:message.send_as_user'));
  assert.ok(auto.includes('im:resource'));
  assert.ok(auto.includes('im:message.p2p_msg:get_as_user'), 'auto 必须申请单聊读消息权限');
  assert.ok(auto.includes('im:message.group_msg:get_as_user'), 'auto 必须申请群聊读消息权限');
  assert.ok(auto.includes('im:chat:read'), 'auto 必须申请列会话权限（缺它对 user token 报 99991679）');
  assert.ok(auto.includes('offline_access'));

  const forcedReceive = resolveFeishuScopes({ policy: 'bot', receive: true });
  assert.ok(forcedReceive.includes('im:message.p2p_msg:get_as_user'), '显式 receive=true 也要申请');
  assert.ok(forcedReceive.includes('im:chat:read'), '显式 receive=true 也要申请列会话权限');

  const botOnly = resolveFeishuScopes({ policy: 'bot', receive: 'auto' });
  assert.ok(!botOnly.includes('im:message.p2p_msg:get_as_user'), '固定机器人不需要读消息权限');
  assert.ok(!botOnly.includes('im:chat:read'), '固定机器人不需要列会话权限');
  assert.ok(botOnly.includes('im:message.send_as_user'));

  const receiveOff = resolveFeishuScopes({ policy: 'auto', receive: false });
  assert.ok(!receiveOff.includes('im:message.group_msg:get_as_user'), '关闭本人接收时不申请读消息权限');
  assert.ok(!receiveOff.includes('im:chat:read'), '关闭本人接收时不申请列会话权限');
});

test('身份配置默认值：未设置时必须用文档默认值（clampInt 空串 bug 回归）', () => {
  const conf = resolveIdentityConfig({});
  assert.equal(conf.feishu.receive, 'auto');
  assert.equal(conf.feishu.pollMs, 20_000, 'FEISHU_USER_RECEIVE_SECONDS 默认 20s');
  assert.equal(conf.feishu.chatLimit, 20, 'FEISHU_USER_CHAT_LIMIT 默认 20');
  assert.equal(conf.feishu.backfillHours, 0);
  assert.equal(conf.dingtalk.policy, 'auto');
  assert.equal(conf.dingtalk.receive, 'auto');
  assert.deepEqual(conf.dingtalk.eventKinds, ['all-direct', 'at-me']);
  assert.equal(conf.dingtalk.bin, 'dws');
  assert.equal(conf.dingtalk.authTimeoutMs, 15_000, 'DWS_AUTH_TIMEOUT_MS 默认 15000');
  assert.equal(conf.dingtalk.sendTimeoutMs, 30_000, 'DWS_SEND_TIMEOUT_MS 默认 30000');
});

test('身份配置：显式值 / 0 / 非法值 / 越界分别按契约处理', () => {
  const warnings: string[] = [];
  const conf = resolveIdentityConfig({
    FEISHU_USER_RECEIVE_SECONDS: '8',
    FEISHU_USER_CHAT_LIMIT: '7',
    FEISHU_USER_BACKFILL_HOURS: '24',
    DWS_AUTH_TIMEOUT_MS: '20000',
    DWS_SEND_TIMEOUT_MS: '40000',
  }, warnings);
  assert.equal(conf.feishu.pollMs, 8_000);
  assert.equal(conf.feishu.chatLimit, 7);
  assert.equal(conf.feishu.backfillHours, 24);
  assert.equal(conf.dingtalk.authTimeoutMs, 20_000);
  assert.equal(conf.dingtalk.sendTimeoutMs, 40_000);

  // 显式 0：轮询间隔低于最小值 → 夹到 5s 并告警；回溯 0 是合法值
  const zero = resolveIdentityConfig({
    FEISHU_USER_RECEIVE_SECONDS: '0',
    FEISHU_USER_CHAT_LIMIT: '0',
    FEISHU_USER_BACKFILL_HOURS: '0',
    DWS_AUTH_TIMEOUT_MS: '0',
    DWS_SEND_TIMEOUT_MS: '0',
  }, warnings);
  assert.equal(zero.feishu.pollMs, 5_000);
  assert.equal(zero.feishu.chatLimit, 1);
  assert.equal(zero.feishu.backfillHours, 0);
  assert.equal(zero.dingtalk.authTimeoutMs, 1_000);
  assert.equal(zero.dingtalk.sendTimeoutMs, 1_000);
  assert.ok(warnings.some((w) => w.includes('FEISHU_USER_RECEIVE_SECONDS')));

  // 非法值回退默认
  const bad = resolveIdentityConfig({
    FEISHU_USER_RECEIVE_SECONDS: 'abc',
    FEISHU_USER_CHAT_LIMIT: 'x',
    DWS_AUTH_TIMEOUT_MS: 'NaN',
  });
  assert.equal(bad.feishu.pollMs, 20_000);
  assert.equal(bad.feishu.chatLimit, 20);
  assert.equal(bad.dingtalk.authTimeoutMs, 15_000);

  // 越界夹取
  const over = resolveIdentityConfig({ FEISHU_USER_CHAT_LIMIT: '9999', DWS_SEND_TIMEOUT_MS: '999999' });
  assert.equal(over.feishu.chatLimit, 100);
  assert.equal(over.dingtalk.sendTimeoutMs, 600_000);
});

test('DINGTALK_USER_EVENT_KINDS：group/sender 需要目标参数 → 忽略并告警；未知值也告警', () => {
  const warnings: string[] = [];
  const kinds = parseDingtalkEventKinds('all-direct,group,sender,all-group,unknown-kind', warnings);
  assert.deepEqual(kinds, ['all-direct', 'all-group']);
  assert.ok(warnings.some((w) => w.includes('"group"') && w.includes('不支持')));
  assert.ok(warnings.some((w) => w.includes('"sender"')));
  assert.ok(warnings.some((w) => w.includes('unknown-kind')));
  // 全部被过滤时回退默认，绝不静默不收消息
  assert.deepEqual(parseDingtalkEventKinds('group,sender', []), ['all-direct', 'at-me']);
});

test('FEISHU_IDENTITY 优先；只有旧 FEISHU_SEND_AS 时继承并给废弃提示', () => {
  const warnings: string[] = [];
  assert.equal(parseFeishuIdentityPolicy({ FEISHU_IDENTITY: 'user', FEISHU_SEND_AS: 'bot' }, warnings), 'user');
  assert.equal(parseFeishuIdentityPolicy({ FEISHU_SEND_AS: 'bot' }, warnings), 'bot');
  assert.ok(warnings.some((w) => w.includes('已废弃') && w.includes('FEISHU_SEND_AS')));
});

test('飞书长连接默认开启（P2-6）：未显式 FEISHU_STREAM 时只缺 App ID/Secret，不把 Verify Token 算缺失', () => {
  const defaults = runtimeOf({}, {});
  assert.ok(!defaults[Platform.FEISHU].missing.includes('FEISHU_VERIFY_TOKEN'), '默认长连接不应要求 Verify Token');
  assert.deepEqual(defaults[Platform.FEISHU].missing, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const http = runtimeOf({ FEISHU_STREAM: 'false' }, {});
  assert.ok(http[Platform.FEISHU].missing.includes('FEISHU_VERIFY_TOKEN'), '显式 HTTP 回调模式才要求 Verify Token');
  const explicitOn = runtimeOf({ FEISHU_STREAM: 'true' }, {});
  assert.ok(!explicitOn[Platform.FEISHU].missing.includes('FEISHU_VERIFY_TOKEN'));
});


test('Mock 模式不冒充"已开启长连接"：改为"已配置但当前为 Mock、不会实际连接"', () => {
  const mock = runtimeOf({ FEISHU_STREAM: 'true', FEISHU_MODE: 'mock', DINGTALK_STREAM: 'true', DINGTALK_MODE: 'mock' }, {});
  const feishuWarn = mock[Platform.FEISHU].warnings.join('|');
  assert.ok(!/已开启.*长连接/.test(feishuWarn), `mock 下不得说已开启：${feishuWarn}`);
  assert.match(feishuWarn, /不会实际连接/);
  const dingtalkWarn = mock[Platform.DINGTALK].warnings.join('|');
  assert.ok(!/已开启.*长连接/.test(dingtalkWarn));
  assert.match(dingtalkWarn, /不会实际连接/);

  const real = runtimeOf({ FEISHU_STREAM: 'true', FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_MODE: 'real' }, {});
  assert.match(real[Platform.FEISHU].warnings.join('|'), /已开启飞书长连接/);
});

test('邮箱轮询关闭原因：显式 MAIL_ENABLED=false 与"未开启"区分文案', () => {
  const accounts = [mailAccount()];
  const explicit = runtimeOf({}, { mailAccounts: accounts, mailEnabled: false, mailEnabledExplicit: true });
  assert.match(explicit[Platform.MAIL].reason, /MAIL_ENABLED=false/);
  const implicit = runtimeOf({}, { mailAccounts: accounts, mailEnabled: false, mailEnabledExplicit: false });
  assert.doesNotMatch(implicit[Platform.MAIL].reason, /MAIL_ENABLED=false/);
  assert.match(implicit[Platform.MAIL].reason, /邮箱轮询未启用/);
});


test('resolveFeishuScopes：本人接收开启时 OAuth 必须一并申请读消息 + 列会话权限（否则授权后仍 99991672/99991679）', () => {
  const auto = resolveFeishuScopes({ policy: 'auto', receive: 'auto' });
  assert.ok(auto.includes('im:message'));
  assert.ok(auto.includes('im:message.send_as_user'));
  assert.ok(auto.includes('im:resource'));
  assert.ok(auto.includes('im:message.p2p_msg:get_as_user'), 'auto 必须申请单聊读消息权限');
  assert.ok(auto.includes('im:message.group_msg:get_as_user'), 'auto 必须申请群聊读消息权限');
  assert.ok(auto.includes('im:chat:read'), 'auto 必须申请列会话权限（缺它对 user token 报 99991679）');
  assert.ok(auto.includes('offline_access'));

  const forcedReceive = resolveFeishuScopes({ policy: 'bot', receive: true });
  assert.ok(forcedReceive.includes('im:message.p2p_msg:get_as_user'), '显式 receive=true 也要申请');
  assert.ok(forcedReceive.includes('im:chat:read'), '显式 receive=true 也要申请列会话权限');

  const botOnly = resolveFeishuScopes({ policy: 'bot', receive: 'auto' });
  assert.ok(!botOnly.includes('im:message.p2p_msg:get_as_user'), '固定机器人不需要读消息权限');
  assert.ok(!botOnly.includes('im:chat:read'), '固定机器人不需要列会话权限');
  assert.ok(botOnly.includes('im:message.send_as_user'));

  const receiveOff = resolveFeishuScopes({ policy: 'auto', receive: false });
  assert.ok(!receiveOff.includes('im:message.group_msg:get_as_user'), '关闭本人接收时不申请读消息权限');
  assert.ok(!receiveOff.includes('im:chat:read'), '关闭本人接收时不申请列会话权限');
});

test('身份配置默认值：未设置时必须用文档默认值（clampInt 空串 bug 回归）', () => {
  const conf = resolveIdentityConfig({});
  assert.equal(conf.feishu.receive, 'auto');
  assert.equal(conf.feishu.pollMs, 20_000, 'FEISHU_USER_RECEIVE_SECONDS 默认 20s');
  assert.equal(conf.feishu.chatLimit, 20, 'FEISHU_USER_CHAT_LIMIT 默认 20');
  assert.equal(conf.feishu.backfillHours, 0);
  assert.equal(conf.dingtalk.policy, 'auto');
  assert.equal(conf.dingtalk.receive, 'auto');
  assert.deepEqual(conf.dingtalk.eventKinds, ['all-direct', 'at-me']);
  assert.equal(conf.dingtalk.bin, 'dws');
  assert.equal(conf.dingtalk.authTimeoutMs, 15_000, 'DWS_AUTH_TIMEOUT_MS 默认 15000');
  assert.equal(conf.dingtalk.sendTimeoutMs, 30_000, 'DWS_SEND_TIMEOUT_MS 默认 30000');
});

test('身份配置：显式值 / 0 / 非法值 / 越界分别按契约处理', () => {
  const warnings: string[] = [];
  const conf = resolveIdentityConfig({
    FEISHU_USER_RECEIVE_SECONDS: '8',
    FEISHU_USER_CHAT_LIMIT: '7',
    FEISHU_USER_BACKFILL_HOURS: '24',
    DWS_AUTH_TIMEOUT_MS: '20000',
    DWS_SEND_TIMEOUT_MS: '40000',
  }, warnings);
  assert.equal(conf.feishu.pollMs, 8_000);
  assert.equal(conf.feishu.chatLimit, 7);
  assert.equal(conf.feishu.backfillHours, 24);
  assert.equal(conf.dingtalk.authTimeoutMs, 20_000);
  assert.equal(conf.dingtalk.sendTimeoutMs, 40_000);

  // 显式 0：轮询间隔低于最小值 → 夹到 5s 并告警；回溯 0 是合法值
  const zero = resolveIdentityConfig({
    FEISHU_USER_RECEIVE_SECONDS: '0',
    FEISHU_USER_CHAT_LIMIT: '0',
    FEISHU_USER_BACKFILL_HOURS: '0',
    DWS_AUTH_TIMEOUT_MS: '0',
    DWS_SEND_TIMEOUT_MS: '0',
  }, warnings);
  assert.equal(zero.feishu.pollMs, 5_000);
  assert.equal(zero.feishu.chatLimit, 1);
  assert.equal(zero.feishu.backfillHours, 0);
  assert.equal(zero.dingtalk.authTimeoutMs, 1_000);
  assert.equal(zero.dingtalk.sendTimeoutMs, 1_000);
  assert.ok(warnings.some((w) => w.includes('FEISHU_USER_RECEIVE_SECONDS')));

  // 非法值回退默认
  const bad = resolveIdentityConfig({
    FEISHU_USER_RECEIVE_SECONDS: 'abc',
    FEISHU_USER_CHAT_LIMIT: 'x',
    DWS_AUTH_TIMEOUT_MS: 'NaN',
  });
  assert.equal(bad.feishu.pollMs, 20_000);
  assert.equal(bad.feishu.chatLimit, 20);
  assert.equal(bad.dingtalk.authTimeoutMs, 15_000);

  // 越界夹取
  const over = resolveIdentityConfig({ FEISHU_USER_CHAT_LIMIT: '9999', DWS_SEND_TIMEOUT_MS: '999999' });
  assert.equal(over.feishu.chatLimit, 100);
  assert.equal(over.dingtalk.sendTimeoutMs, 600_000);
});

test('DINGTALK_USER_EVENT_KINDS：group/sender 需要目标参数 → 忽略并告警；未知值也告警', () => {
  const warnings: string[] = [];
  const kinds = parseDingtalkEventKinds('all-direct,group,sender,all-group,unknown-kind', warnings);
  assert.deepEqual(kinds, ['all-direct', 'all-group']);
  assert.ok(warnings.some((w) => w.includes('"group"') && w.includes('不支持')));
  assert.ok(warnings.some((w) => w.includes('"sender"')));
  assert.ok(warnings.some((w) => w.includes('unknown-kind')));
  // 全部被过滤时回退默认，绝不静默不收消息
  assert.deepEqual(parseDingtalkEventKinds('group,sender', []), ['all-direct', 'at-me']);
});

test('FEISHU_IDENTITY 优先；只有旧 FEISHU_SEND_AS 时继承并给废弃提示', () => {
  const warnings: string[] = [];
  assert.equal(parseFeishuIdentityPolicy({ FEISHU_IDENTITY: 'user', FEISHU_SEND_AS: 'bot' }, warnings), 'user');
  assert.equal(parseFeishuIdentityPolicy({ FEISHU_SEND_AS: 'bot' }, warnings), 'bot');
  assert.ok(warnings.some((w) => w.includes('已废弃') && w.includes('FEISHU_SEND_AS')));
});

test('飞书长连接默认开启（P2-6）：未显式 FEISHU_STREAM 时只缺 App ID/Secret，不把 Verify Token 算缺失', () => {
  const defaults = runtimeOf({}, {});
  assert.ok(!defaults[Platform.FEISHU].missing.includes('FEISHU_VERIFY_TOKEN'), '默认长连接不应要求 Verify Token');
  assert.deepEqual(defaults[Platform.FEISHU].missing, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const http = runtimeOf({ FEISHU_STREAM: 'false' }, {});
  assert.ok(http[Platform.FEISHU].missing.includes('FEISHU_VERIFY_TOKEN'), '显式 HTTP 回调模式才要求 Verify Token');
  const explicitOn = runtimeOf({ FEISHU_STREAM: 'true' }, {});
  assert.ok(!explicitOn[Platform.FEISHU].missing.includes('FEISHU_VERIFY_TOKEN'));
});
