/**
 * 「连接账号 / 授权中心」聚合视图单测（白号审计修正后状态机）：
 *  - 缺凭据 → needs_admin（可配置动作可达），不再 mock 死胡同；
 *  - 钉钉 personal-only（identityChannelsReal）未登录 → needs_user_auth + 登录/热应用动作；
 *  - linked + mock 绝不得 ready（P0-2）；linked + real → ready；
 *  - 邮箱未验证不算 ready；验证+real → ready；验证但 mock → needs_admin（可一键启用）；
 *  - overall.needsAction = 非 ready 数；firstRun = 全部非 ready；
 *  - actions 有 cwd 提示、feishu-status 指向 /api/accounts、清单含 .env 键名+重启；响应无任何密钥。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, type PlatformIdentityView } from '@unimsg/shared';
import type { PlatformRuntime } from '../config/runtime';
import {
  buildOnboarding,
  dingtalkAdminChecklist,
  feishuAdminChecklist,
  type OnboardingDeps,
} from './onboarding';
import type { MaskedMailAccount } from './mailAccounts';
import type { WechatBridgeStatus } from './wechatBridge';

function view(overrides: Partial<PlatformIdentityView> & { user?: Partial<PlatformIdentityView['user']> } = {}): PlatformIdentityView {
  const { user: userOverrides, ...rest } = overrides;
  const user = {
    state: 'not_linked' as const,
    linked: false,
    hint: '尚未连接本人身份',
    canLink: true,
    linkMethod: 'cli' as const,
    ...userOverrides,
  };
  return {
    policy: 'auto',
    effectiveSend: 'mock',
    effectiveReceive: 'mock',
    botAvailable: false,
    botHint: '',
    receiveHint: '模拟接收',
    sendHint: '模拟发送',
    ...rest,
    user,
  };
}

function runtime(overrides: Partial<PlatformRuntime> = {}): PlatformRuntime {
  return {
    platform: Platform.DINGTALK,
    label: '钉钉',
    policy: 'auto',
    mode: 'mock',
    configured: false,
    canReceive: false,
    canSend: false,
    missing: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'],
    warnings: [],
    reason: 'auto 无凭据 → mock',
    ...overrides,
  };
}

function masked(overrides: Partial<MaskedMailAccount> = {}): MaskedMailAccount {
  return {
    key: 'qq',
    label: 'QQ邮箱',
    address: 'z*******@qq.com',
    provider: 'qq',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    folders: ['INBOX'],
    source: 'file',
    removable: true,
    verified: true,
    ...overrides,
  };
}

function deps(overrides: Partial<OnboardingDeps> = {}): OnboardingDeps {
  return {
    now: () => 1_731_000_000_000,
    startedAt: '2024-11-08T02:13:20.000Z',
    envFile: null,
    mail: { accounts: [], filePath: '.linkhub-mail-accounts.json', issues: [], mode: 'mock', policy: 'auto', pollSeconds: 45 },
    dingtalk: {
      view: view(),
      runtime: runtime(),
      dws: { available: true, source: 'tools', version: 'v1.0.68-beta.1' },
      identityChannelsReal: false,
    },
    feishu: {
      view: view({ user: { canLink: false, linkMethod: 'oauth', hint: '未配置飞书应用凭据' } as never }),
      runtime: runtime({ platform: Platform.FEISHU, label: '飞书', missing: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] }),
      scopes: ['im:message', 'offline_access'],
      redirectUri: 'http://127.0.0.1:3001/api/feishu/oauth/callback',
      identityChannelsReal: false,
    },
    wechat: { runtime: runtime({ platform: Platform.WECHAT, label: '微信', missing: [] }) },
    port: 3001,
    ...overrides,
  };
}

function step(id: string, d = deps()) {
  return buildOnboarding(d).data.steps.find((s) => s.id === id)!;
}

test('白号基线：4 步骤全非 ready → needsAction=4 / firstRun=true；缺凭据给 needs_admin 且配置动作可达', () => {
  const onboarding = buildOnboarding(deps());
  assert.deepEqual(onboarding.data.steps.map((s) => s.id), ['mail', 'dingtalk', 'feishu', 'wechat']);
  assert.equal(onboarding.data.overall.total, 4);
  assert.equal(onboarding.data.overall.ready, 0);
  assert.equal(onboarding.data.overall.needsAction, 4, '白号不得显示「待处理 0 项」');
  assert.equal(onboarding.data.firstRun, true);

  const feishu = onboarding.data.steps.find((s) => s.id === 'feishu')!;
  assert.equal(feishu.state, 'needs_admin');
  assert.ok(feishu.actions.some((a) => a.id === 'feishu-configure' && a.kind === 'form'));
  assert.ok(feishu.actions.some((a) => a.id === 'feishu-admin' && a.kind === 'link'));
  const checklist = feishu.actions.find((a) => a.id === 'feishu-admin-checklist')!;
  assert.ok(checklist.text?.includes('FEISHU_APP_ID'), '清单必须含 .env 键名');
  assert.ok(checklist.text?.includes('重启'), '清单必须含重启步骤');

  // 微信 RPA：默认 mock（不阻断白号），有自检动作
  const wechat = onboarding.data.steps.find((s) => s.id === 'wechat')!;
  assert.equal(wechat.state, 'mock');
  assert.ok(wechat.actions.some((a) => a.id === 'wechat-doctor'));

  // 命令动作带 cwd 提示
  const doctor = onboarding.data.steps[0]!.actions.find((a) => a.kind === 'command')!;
  assert.match(doctor.command ?? '', /cd unimsg-connector/);
  assert.match(doctor.command ?? '', /doctor/);
});

test('钉钉 P0-2：linked + mock 绝不得 ready（给热应用动作）；linked + real → ready', () => {
  const linkedMock = step('dingtalk', deps({
    dingtalk: {
      view: view({ user: { state: 'linked', linked: true, displayName: '陈', canLink: true, linkMethod: 'cli', hint: '' } as never }),
      runtime: runtime(),
      dws: { available: true, source: 'tools' },
      identityChannelsReal: false,
    },
  }));
  assert.notEqual(linkedMock.state, 'ready', 'linked + mock 不得 ready（假成功红线）');
  assert.equal(linkedMock.state, 'needs_admin');
  const enable = linkedMock.actions.find((a) => a.id === 'dingtalk-enable-personal-only')!;
  assert.equal(enable.kind, 'api');
  assert.equal(enable.path, '/api/app-config');
  assert.equal(enable.method, 'PUT');
  assert.deepEqual(enable.payload, { identity: { dingtalk: 'user' } });
  assert.match(linkedMock.summary, /演示模式/);

  const linkedReal = step('dingtalk', deps({
    dingtalk: {
      view: view({
        user: { state: 'linked', linked: true, displayName: '陈', canLink: true, linkMethod: 'cli', hint: '' } as never,
        effectiveSend: 'user',
        effectiveReceive: 'user',
      }),
      runtime: runtime({ mode: 'real', configured: false, canSend: true, canReceive: true }),
      dws: { available: true, source: 'tools' },
      identityChannelsReal: true,
    },
  }));
  assert.equal(linkedReal.state, 'ready');
  assert.match(linkedReal.summary, /陈/);
});

test('钉钉白号：无机器人凭据 + dws 可用 + 未登录 → needs_user_auth + dingtalk-login（只登录；成功后后端自动启用身份）', () => {
  const d = step('dingtalk');
  assert.equal(d.state, 'needs_user_auth');
  assert.match(d.summary, /无需机器人应用/);
  const personalLogin = d.actions.find((a) => a.id === 'dingtalk-login')!;
  assert.equal(personalLogin.kind, 'api');
  assert.equal(personalLogin.path, '/api/dingtalk/personal/login');
  assert.equal(personalLogin.method, 'POST');
  assert.equal(personalLogin.payload?.mode, 'browser');
  assert.equal((personalLogin as { then?: unknown }).then, undefined, '不应再预先 PUT identity（未授权不改配置）');
  assert.match(personalLogin.label, /用钉钉本人账号登录（推荐，无需机器人应用）/);
  assert.ok(d.hints.some((h) => /登录成功后会自动启用本人身份/.test(h)));
  assert.ok(d.hints.some((h) => /未完成授权不会改变任何配置/.test(h)));
  // 管理员清单含 CLI 访问 + 登录命令 --recommend + 重启
  const checklist = d.actions.find((a) => a.id === 'dingtalk-admin-checklist')!;
  assert.ok(checklist.text?.includes('CLI 访问管理'));
  assert.ok(checklist.text?.includes('--recommend'));
  assert.ok(checklist.text?.includes('重启'));
});

test('钉钉：personal-only 生效但未登录 → needs_user_auth + 登录动作；dws 缺失 → needs_install', () => {
  const realNotLinked = step('dingtalk', deps({
    dingtalk: {
      view: view({ user: { canLink: true, linkMethod: 'cli', hint: '尚未登录' } as never }),
      runtime: runtime({ mode: 'mock', configured: false }),
      dws: { available: true, source: 'tools' },
      identityChannelsReal: true,
    },
  }));
  assert.equal(realNotLinked.state, 'needs_user_auth');
  assert.ok(realNotLinked.actions.some((a) => a.id === 'dingtalk-login' && a.path === '/api/dingtalk/personal/login'));

  const missing = step('dingtalk', deps({
    dingtalk: {
      view: view(),
      runtime: runtime(),
      dws: { available: false, source: 'missing', pathHint: '未找到 dws……' },
      identityChannelsReal: false,
    },
  }));
  assert.equal(missing.state, 'needs_install');
  const install = missing.actions.find((a) => a.id === 'dws-install')!;
  assert.match(install.command ?? '', /cd unimsg-connector && pnpm run fetch:dws/);
});

test('钉钉显式 mock 策略 → 如实 mock 且仍给恢复动作；飞书 linked+mock 不得 ready，ready 态 feishu-status path=/api/accounts', () => {
  const explicitMock = step('dingtalk', deps({
    dingtalk: { view: view(), runtime: runtime({ policy: 'mock', mode: 'mock' }), dws: { available: true, source: 'tools' }, identityChannelsReal: false },
  }));
  assert.equal(explicitMock.state, 'mock');
  assert.match(explicitMock.summary, /演示模式/);
  assert.ok(explicitMock.actions.some((a) => a.id === 'dingtalk-login' && /用钉钉本人账号登录/.test(a.label)));

  const feishuLinkedMock = step('feishu', deps({
    feishu: {
      view: view({ user: { state: 'linked', linked: true, canLink: true, linkMethod: 'oauth', hint: '' } as never }),
      runtime: runtime({ platform: Platform.FEISHU, configured: true }),
      scopes: ['im:message'],
      redirectUri: 'http://127.0.0.1:3001/api/feishu/oauth/callback',
      identityChannelsReal: false,
    },
  }));
  assert.notEqual(feishuLinkedMock.state, 'ready');
  assert.equal(feishuLinkedMock.state, 'needs_admin');
  // P2-3：已配置凭据时不得让用户「填入应用凭据」；应归因于演示模式/改 mode
  assert.match(feishuLinkedMock.summary, /演示模式/);
  assert.doesNotMatch(feishuLinkedMock.summary, /缺少.*凭据/);
  assert.ok(feishuLinkedMock.actions.some((a) => a.id === 'feishu-mode-real' && a.path === '/api/app-config'));
  assert.match(feishuLinkedMock.actions.find((a) => a.id === 'feishu-mode-real')!.label, /重新打开/);

  const feishuLinkedMockNoCreds = step('feishu', deps({
    feishu: {
      view: view({ user: { state: 'linked', linked: true, canLink: true, linkMethod: 'oauth', hint: '' } as never }),
      runtime: runtime({ platform: Platform.FEISHU, configured: false, missing: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] }),
      scopes: ['im:message'],
      redirectUri: 'http://127.0.0.1:3001/api/feishu/oauth/callback',
      identityChannelsReal: false,
    },
  }));
  assert.equal(feishuLinkedMockNoCreds.state, 'needs_admin');
  assert.match(feishuLinkedMockNoCreds.summary, /缺少飞书应用凭据/);

  const feishuReady = step('feishu', deps({
    feishu: {
      view: view({
        user: { state: 'linked', linked: true, displayName: '小王', canLink: true, linkMethod: 'oauth', hint: '' } as never,
        effectiveSend: 'user',
        effectiveReceive: 'user',
      }),
      runtime: runtime({ platform: Platform.FEISHU, mode: 'real', configured: true, canSend: true, canReceive: true }),
      scopes: ['im:message'],
      redirectUri: 'http://127.0.0.1:3001/api/feishu/oauth/callback',
      identityChannelsReal: true,
    },
  }));
  assert.equal(feishuReady.state, 'ready');
  const status = feishuReady.actions.find((a) => a.id === 'feishu-status')!;
  assert.equal(status.path, '/api/accounts', 'P1-6：不再指向 404 的 /api/feishu/oauth/status');
});

test('邮箱（P2-1/P2-2）：白号 auto 提示「验证后自动启用、无需改 .env/重启」；显式 mock 才写 MAIL_MODE；已验证 mock 不下发误导性一键动作', () => {
  const none = step('mail');
  assert.equal(none.state, 'needs_user_auth');
  assert.ok(none.actions.some((a) => a.id === 'mail-add-account' && a.kind === 'form'));
  const whiteText = none.hints.join('\n');
  assert.ok(whiteText.includes('测试连接'), '白号应引导测试连接');
  assert.ok(whiteText.includes('无需改 .env') || whiteText.includes('不需要改配置'), '白号应说明验证后自动启用、无需改配置/重启');
  assert.ok(!whiteText.includes('显式 MAIL_MODE=mock'), '白号 auto 回退 mock 不得说成显式 mock（P2-1）');

  // 显式 MAIL_MODE=mock 才写 env 文案
  const explicitMock = step('mail', deps({
    mail: { accounts: [], filePath: 'x', issues: [], mode: 'mock', policy: 'mock', pollSeconds: 45 },
  }));
  assert.ok(explicitMock.hints.join('\n').includes('演示模式'), '显式 mock 场景要如实说成演示模式');

  const unverified = step('mail', deps({
    mail: { accounts: [masked({ verified: false })], filePath: 'x', issues: [], mode: 'mock', policy: 'auto', pollSeconds: 45 },
  }));
  assert.equal(unverified.state, 'needs_user_auth');
  assert.match(unverified.summary, /还没有验证通过/);

  const ready = step('mail', deps({
    mail: { accounts: [masked()], filePath: 'x', issues: [], mode: 'real', policy: 'auto', pollSeconds: 30 },
  }));
  assert.equal(ready.state, 'ready');
  assert.match(ready.summary, /已验证账号/);

  const verifiedMockAuto = step('mail', deps({
    mail: { accounts: [masked()], filePath: 'x', issues: [], mode: 'mock', policy: 'auto', pollSeconds: 45 },
  }));
  assert.equal(verifiedMockAuto.state, 'needs_admin');
  assert.ok(!verifiedMockAuto.actions.some((a) => a.id === 'mail-enable-real'), '静态键动作不下发（P2-2），避免「无需重启」误导');
  assert.match(verifiedMockAuto.hints.join('\n'), /重启/);

  const verifiedMockExplicit = step('mail', deps({
    mail: { accounts: [masked()], filePath: 'x', issues: [], mode: 'mock', policy: 'mock', pollSeconds: 45 },
  }));
  assert.equal(verifiedMockExplicit.state, 'needs_admin');
  assert.ok(!verifiedMockExplicit.actions.some((a) => a.id === 'mail-enable-real'));
  assert.match(verifiedMockExplicit.summary, /显式设为演示模式/);
});

test('overall：任一 ready 后 firstRun=false、needsAction 递减；安全：响应不含 token/authCode/secret', () => {
  const d = deps({
    mail: { accounts: [masked()], filePath: 'x', issues: [], mode: 'real', policy: 'auto', pollSeconds: 45 },
  });
  const onboarding = buildOnboarding(d);
  assert.equal(onboarding.data.overall.ready, 1);
  assert.equal(onboarding.data.overall.needsAction, 3);
  assert.equal(onboarding.data.firstRun, false);

  const text = JSON.stringify(onboarding);
  for (const bad of ['authCode', 'access_token', 'refresh_token', 'appSecret', 'clientSecret', 'env-secret-code']) {
    assert.ok(!text.includes(bad), `响应不应包含 ${bad}`);
  }
});
test('P2-5/P3：管理员清单为纯文本（无 Markdown 星号）、按钮名与实际一致、登录命令不含本机绝对路径', () => {
  const feishu = feishuAdminChecklist('http://127.0.0.1:3001/api/feishu/oauth/callback', ['im:message', 'im:message.p2p_msg:readonly']);
  assert.ok(!feishu.includes('**'), 'copy 是纯文本，不能出现 Markdown 星号');
  assert.match(feishu, /填写飞书应用凭据/);
  assert.match(feishu, /连接飞书本人账号/);
  assert.match(feishu, /Verify Token[\s\S]*可不填/);
  assert.match(feishu, /重启后端/);

  const ding = dingtalkAdminChecklist('C:\\Users\\zx\\Desktop\\LinkHub\\unimsg-connector\\tools\\dws.exe auth login');
  assert.ok(!ding.includes('**'), '钉钉清单也不能有 Markdown 星号');
  assert.match(ding, /tools\\dws\.exe auth login/);
  assert.ok(!/[A-Za-z]:\\\\Users/.test(ding), 'P3：清单里的登录命令不得包含本机盘符绝对路径');

});

test('P2-6：飞书缺凭据时 missing 只有 App ID/Secret，hint 说明长连接 Verify Token 可不填', () => {
  const d = step('feishu');
  assert.equal(d.state, 'needs_admin');
  const joined = d.hints.join('\n');
  assert.ok(!joined.includes('FEISHU_VERIFY_TOKEN'), '默认长连接不应把 Verify Token 列为缺失');
  assert.match(joined, /校验用的几项都可以不填/);
  assert.match(joined, /长连接/);
});

// ---------------------------------------------------------------------------
// 微信 RPA：P0「配了 real 就报 ready」修复后的状态机
// ---------------------------------------------------------------------------

function wechatRealRuntime(over: Partial<PlatformRuntime> = {}): PlatformRuntime {
  return runtime({
    platform: Platform.WECHAT,
    label: '微信',
    policy: 'real',
    mode: 'real',
    configured: true,
    canSend: true,
    canReceive: true,
    missing: [],
    warnings: [],
    ...over,
  });
}

function bridge(over: Partial<WechatBridgeStatus> = {}): WechatBridgeStatus {
  return {
    state: 'rpa',
    url: 'http://127.0.0.1:8787',
    reachable: true,
    mode: 'rpa',
    canSend: true,
    canReceive: true,
    receiveMode: 'auto',
    receiveReason: '轮询正常：可读取微信窗口消息',
    reportedReceive: true,
    checkedAt: '2024-11-08T02:13:20.000Z',
    ...over,
  };
}

test('微信 P0：WECHAT_MODE=real 但从没探测到桥 → needs_install，绝不 ready', () => {
  const s = step('wechat', deps({ wechat: { runtime: wechatRealRuntime(), bridge: null } }));
  assert.equal(s.state, 'needs_install');
  assert.match(s.summary, /还没检测到本机辅助程序/);
  assert.ok(s.detail.bridge === null);
});

test('微信 P0：桥连不上 → needs_install，且给出启动命令', () => {
  const s = step('wechat', deps({
    wechat: {
      runtime: wechatRealRuntime(),
      bridge: bridge({
        state: 'unreachable', reachable: false, mode: undefined, canReceive: false,
        receiveReason: '连不上本机 RPA 桥', error: 'ECONNREFUSED',
      }),
    },
  }));
  assert.equal(s.state, 'needs_install');
  assert.match(s.summary, /连不上本机辅助程序/);
  assert.ok(s.hints.join('\n').includes('--mode rpa'));
});

test('微信 P0：桥在 mock 模式 → needs_install（发送会被拒绝，不写 real）', () => {
  const s = step('wechat', deps({
    wechat: { runtime: wechatRealRuntime(), bridge: bridge({ state: 'mock', mode: 'mock', canReceive: false, receiveReason: '桥运行在 mock 模式' }) },
  }));
  assert.equal(s.state, 'needs_install');
  assert.match(s.summary, /「演示」模式/);
});

test('微信 P0：桥 rpa 但接收没就绪 → needs_install，说明"能发不能收"', () => {
  const s = step('wechat', deps({
    wechat: {
      runtime: wechatRealRuntime(),
      bridge: bridge({ canReceive: false, receiveReason: '未找到微信主窗口：请登录并打开微信桌面端' }),
    },
  }));
  assert.equal(s.state, 'needs_install');
  assert.match(s.summary, /真实接收还没就绪/);
  assert.match(s.summary, /未找到微信主窗口/);
  assert.ok(s.hints.some((h) => h.includes('发送已经可用')));
});

test('微信：桥 rpa 且接收可用 → 才允许 ready', () => {
  const s = step('wechat', deps({ wechat: { runtime: wechatRealRuntime(), bridge: bridge() } }));
  assert.equal(s.state, 'ready');
  assert.match(s.summary, /发送真实操作微信桌面端/);
  assert.ok(s.hints[0]!.includes('轮询正常'));
});

test('微信 4.x：桥报 weixin4 → ready（发送可用 + 按需拉取），但仍说明「自动轮询要 3.9」', () => {
  const s = step('wechat', deps({
    wechat: {
      runtime: wechatRealRuntime(),
      bridge: bridge({
        canReceive: false,
        receiveReason: '检测到微信 4.x（Weixin，Qt 自绘）：不暴露可访问性控件树',
        client: {
          kind: 'weixin4',
          uiaUsable: false,
          reason: '检测到微信 4.x（Weixin，Qt 自绘）：不暴露可访问性控件树',
          className: 'Qt51514QWindowIcon',
        },
      }),
    },
  }));
  // 4.x 不是"不可用"：不该把用户推去装 3.9，他知道按需拉取就能用
  assert.equal(s.state, 'ready');
  assert.match(s.summary, /4\.x/);
  assert.match(s.summary, /按需拉取/);
  assert.ok(s.hints.some((h) => h.includes('拉取')), '要说清怎么收');
  assert.ok(s.hints.some((h) => h.includes('3.9')), '仍要给出「想自动收就换 3.9」的选项');
});
