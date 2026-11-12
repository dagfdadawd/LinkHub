/**
 * 「连接账号 / 授权中心」聚合视图单测：各平台 state 判定、actions 形态、firstRun/overall，
 * 以及「绝不下发 token / 授权码」的诚实性约束。纯函数注入，不连任何平台。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, type PlatformIdentityView } from '@unimsg/shared';
import type { PlatformRuntime } from '../config/runtime';
import { buildOnboarding, type OnboardingDeps } from './onboarding';
import type { MaskedMailAccount } from './mailAccounts';

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
    effectiveSend: 'bot',
    effectiveReceive: 'bot',
    botAvailable: true,
    botHint: '',
    receiveHint: '机器人接收',
    sendHint: '机器人发送',
    ...rest,
    user,
  };
}

function runtime(overrides: Partial<PlatformRuntime> = {}): PlatformRuntime {
  return {
    platform: Platform.DINGTALK,
    label: '钉钉',
    policy: 'auto',
    mode: 'real',
    configured: true,
    canReceive: true,
    canSend: true,
    missing: [],
    warnings: [],
    reason: 'ok',
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
    ...overrides,
  };
}

function deps(overrides: Partial<OnboardingDeps> = {}): OnboardingDeps {
  return {
    now: () => 1_731_000_000_000,
    startedAt: '2024-11-08T02:13:20.000Z',
    envFile: null,
    mail: { accounts: [], filePath: 'C:\\umimsg\\.linkhub-mail-accounts.json', issues: [], mode: 'mock' },
    dingtalk: { view: view(), runtime: runtime(), dws: { available: true, source: 'tools', version: 'v1.0.68-beta.1' } },
    feishu: {
      view: view({ user: { canLink: false, linkMethod: 'oauth', hint: '未配置飞书应用凭据' } as never }),
      runtime: runtime({ platform: Platform.FEISHU, label: '飞书', configured: false, missing: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] }),
      scopes: ['im:message', 'offline_access'],
      redirectUri: 'http://127.0.0.1:3001/api/feishu/oauth/callback',
    },
    wecom: { runtime: runtime({ platform: Platform.WECOM, label: '企业微信', configured: false, missing: ['WECOM_CORP_ID'] }) },
    port: 3001,
    ...overrides,
  };
}

function step(id: string, d = deps()) {
  const onboarding = buildOnboarding(d);
  return onboarding.data.steps.find((s) => s.id === id)!;
}

test('onboarding：4 个步骤 + overall/firstRun/时间字段', () => {
  const onboarding = buildOnboarding(deps());
  assert.deepEqual(onboarding.data.steps.map((s) => s.id), ['mail', 'dingtalk', 'feishu', 'wecom']);
  assert.equal(onboarding.data.overall.total, 4);
  assert.equal(onboarding.data.overall.ready, 0);
  assert.equal(onboarding.data.firstRun, true);
  assert.equal(onboarding.data.generatedAt, new Date(1_731_000_000_000).toISOString());
  assert.equal(onboarding.data.startedAt, '2024-11-08T02:13:20.000Z');
  assert.equal(onboarding.data.dws.source, 'tools');
});

test('邮箱步骤：无账号 → needs_user_auth + form 动作；有账号+real → ready；mock → 明确演示模式', () => {
  const none = step('mail');
  assert.equal(none.state, 'needs_user_auth');
  assert.ok(none.actions.some((a) => a.kind === 'form' && a.label === '添加邮箱账号'));
  assert.ok(none.hints.some((h) => /授权码/.test(h)));

  const withAccount = buildOnboarding(deps({
    mail: {
      accounts: [masked()],
      filePath: 'C:\\data\\mail-accounts.json',
      issues: [],
      mode: 'real',
    },
  })).data.steps.find((s) => s.id === 'mail')!;
  assert.equal(withAccount.state, 'ready');
  assert.match(withAccount.summary, /本地导入 1/);
  assert.equal(withAccount.detail.accounts instanceof Array, true);

  const mock = buildOnboarding(deps({
    mail: {
      accounts: [masked()],
      filePath: 'C:\\data\\mail-accounts.json',
      issues: [],
      mode: 'mock',
    },
  })).data.steps.find((s) => s.id === 'mail')!;
  assert.equal(mock.state, 'mock');
  assert.match(mock.summary, /演示模式/);
});

test('钉钉步骤：mock / needs_install / needs_user_auth / ready / needs_admin 五态', () => {
  const mock = step('dingtalk', deps({
    dingtalk: { view: view(), runtime: runtime({ mode: 'mock' }), dws: { available: true, source: 'tools' } },
  }));
  assert.equal(mock.state, 'mock');

  const install = step('dingtalk', deps({
    dingtalk: { view: view(), runtime: runtime(), dws: { available: false, source: 'missing', pathHint: '未找到 dws……' } },
  }));
  assert.equal(install.state, 'needs_install');
  const installCmd = install.actions.find((a) => a.kind === 'command');
  assert.equal(installCmd?.command, 'pnpm run fetch:dws');
  assert.ok(install.actions.some((a) => a.kind === 'link' && a.url?.includes('github.com')));

  const auth = step('dingtalk');
  assert.equal(auth.state, 'needs_user_auth');
  const login = auth.actions.find((a) => a.id === 'dingtalk-login');
  assert.equal(login?.kind, 'api');
  assert.equal(login?.path, '/api/dingtalk/personal/login');
  assert.equal(login?.method, 'POST');

  const ready = step('dingtalk', deps({
    dingtalk: {
      view: view({ user: { state: 'linked', linked: true, displayName: '陈', canLink: true, linkMethod: 'cli', hint: '' } as never }),
      runtime: runtime(),
      dws: { available: true, source: 'tools', version: 'v1.0.68-beta.1' },
    },
  }));
  assert.equal(ready.state, 'ready');
  assert.match(ready.summary, /陈/);

  const admin = step('dingtalk', deps({
    dingtalk: {
      view: view({ user: { state: 'unavailable', linked: false, canLink: false, linkMethod: 'cli', hint: '需要管理员开通 CLI 访问' } as never }),
      runtime: runtime(),
      dws: { available: true, source: 'tools' },
    },
  }));
  assert.equal(admin.state, 'needs_admin');
  const checklist = admin.actions.find((a) => a.kind === 'copy');
  assert.ok(checklist?.text?.includes('管理'));
  assert.ok(admin.actions.some((a) => a.kind === 'link' && a.url?.includes('open-dev.dingtalk.com')));
});

test('飞书步骤：mock / needs_user_auth / ready / needs_admin（含回调 URL 清单，不含 token）', () => {
  const mock = step('feishu', deps({
    feishu: { view: view(), runtime: runtime({ platform: Platform.FEISHU, mode: 'mock' }), scopes: [], redirectUri: 'http://127.0.0.1/x' },
  }));
  assert.equal(mock.state, 'mock');

  const auth = step('feishu', deps({
    feishu: {
      view: view({ user: { canLink: true, linkMethod: 'oauth', hint: '尚未连接' } as never }),
      runtime: runtime({ platform: Platform.FEISHU }),
      scopes: ['im:message'],
      redirectUri: 'http://127.0.0.1:3001/api/feishu/oauth/callback',
    },
  }));
  assert.equal(auth.state, 'needs_user_auth');
  assert.ok(auth.actions.some((a) => a.kind === 'api' && a.path === '/api/feishu/oauth/start'));

  const admin = step('feishu');
  assert.equal(admin.state, 'needs_admin');
  const copy = admin.actions.find((a) => a.kind === 'copy');
  assert.ok(copy?.text?.includes('http://127.0.0.1:3001/api/feishu/oauth/callback'));
  assert.ok(copy?.text?.includes('FEISHU_APP_ID') === false, '清单不应含实现变量名，只含权限/URL');
  assert.ok(admin.actions.some((a) => a.kind === 'link' && a.url?.includes('open.feishu.cn')));

  const ready = step('feishu', deps({
    feishu: {
      view: view({ user: { state: 'linked', linked: true, displayName: '小王', canLink: true, linkMethod: 'oauth', hint: '' } as never }),
      runtime: runtime({ platform: Platform.FEISHU }),
      scopes: ['im:message'],
      redirectUri: 'http://127.0.0.1:3001/api/feishu/oauth/callback',
    },
  }));
  assert.equal(ready.state, 'ready');
});

test('企业微信步骤：mock/needs_admin（含可信 IP 清单），real+configured→ready；整体 ready/firstRun 联动', () => {
  const mock = step('wecom');
  assert.equal(mock.state, 'mock');
  assert.ok(mock.actions.some((a) => a.kind === 'copy' && a.text?.includes('可信 IP')));
  assert.ok(mock.hints.some((h) => /管理员/.test(h)));

  const ready = buildOnboarding(deps({
    wecom: { runtime: runtime({ platform: Platform.WECOM, label: '企业微信', mode: 'real', configured: true }) },
  }));
  assert.equal(ready.data.steps.find((s) => s.id === 'wecom')!.state, 'ready');
  assert.equal(ready.data.overall.ready, 1);
  assert.equal(ready.data.firstRun, false);
  assert.equal(ready.data.overall.needsAction, 3);
});

test('安全：整个 onboarding 响应不含 token/authCode/secret', () => {
  const withSecret = buildOnboarding(deps({
    mail: {
      accounts: [masked()],
      filePath: 'C:\\data\\mail-accounts.json',
      issues: [],
      mode: 'real',
    },
  }));
  const text = JSON.stringify(withSecret);
  for (const bad of ['authCode', 'access_token', 'refresh_token', 'appSecret', 'clientSecret', 'env-secret-code']) {
    assert.ok(!text.includes(bad), `响应不应包含 ${bad}`);
  }
});