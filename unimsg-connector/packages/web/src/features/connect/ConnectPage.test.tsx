import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import type { PlatformIdentityView } from '@unimsg/shared';
import type { OnboardingStep, OnboardingView } from '../../services/api';

const hoisted = vi.hoisted(() => {
  const state = {
    accounts: [] as unknown[],
    health: null as Record<string, unknown> | null,
    demoMode: false,
    error: null as string | null,
    connection: 'connected' as 'connected' | 'reconnecting' | 'offline',
    messages: [] as unknown[],
    onboarding: null as unknown,
    appConfig: null as Record<string, unknown> | null,
  };
  const store = {
    refreshOnboarding: vi.fn(),
    mailAccounts: vi.fn(async () => [] as unknown[]),
    mailAccountTest: vi.fn(),
    mailAccountCreate: vi.fn(async () => {}),
    mailAccountDelete: vi.fn(async () => {}),
    refreshAccounts: vi.fn(async () => {}),
    getSnapshot: vi.fn(() => ({ accounts: [] as unknown[] })),
    feishuOAuthStart: vi.fn(async () => ({ url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=demo' })),
    dingtalkPersonalLogin: vi.fn(),
    dingtalkPersonalStatus: vi.fn(),
    dingtalkPersonalLogout: vi.fn(),
    refreshAppConfig: vi.fn(),
    loadAppConfig: vi.fn(),
    saveAppConfig: vi.fn(),
    mailAccountVerify: vi.fn(),
  };
  return { state, store };
});

vi.mock('../../hooks/useAppState', () => ({
  useAppState: () => hoisted.state,
}));
vi.mock('../../store', () => ({ store: hoisted.store }));

import { ConnectPage } from './ConnectPage';
import {
  FEISHU_OAUTH_UNFINISHED_TITLE,
  markFeishuOAuthPending,
  saveFeishuOAuthRedirectUri,
} from '../accounts/feishuOAuthFeedback';

function identityView(patch: Partial<PlatformIdentityView> = {}): PlatformIdentityView {
  return {
    policy: 'auto',
    effectiveSend: 'user',
    effectiveReceive: 'user',
    user: {
      state: 'linked',
      linked: true,
      displayName: '陈晓',
      hint: '已连接',
      canLink: true,
      linkMethod: 'cli',
    },
    botAvailable: true,
    botHint: '机器人通道可用',
    receiveHint: '个人事件',
    sendHint: '本人发送',
    ...patch,
  };
}

function step(
  id: OnboardingStep['id'],
  state: OnboardingStep['state'],
  patch: Partial<OnboardingStep> = {},
): OnboardingStep {
  return {
    id,
    label: { mail: '邮箱', dingtalk: '钉钉', feishu: '飞书', wechat: '微信' }[id],
    state,
    summary: `${id} 的现状说明`,
    hints: [],
    actions: [],
    ...patch,
  };
}

function onboardingView(patch: Partial<OnboardingView> = {}): OnboardingView {
  return {
    firstRun: true,
    dws: { available: true, version: 'v1.0.68', source: 'tools' },
    overall: { ready: 1, total: 4, needsAction: 3 },
    steps: [
      step('wechat', 'ready', {
        summary: '微信 RPA 通道已就绪',
        hints: ['RPA 桥已就绪'],
        actions: [
          { id: 'wc-link', kind: 'link', label: '打开微信 RPA 说明', url: 'https://weixin.qq.com/' },
          { id: 'wc-copy', kind: 'copy', label: '复制 RPA 启动说明', text: '启动 scripts/wechat-rpa/rpa_bridge.py 并登录微信桌面端。' },
        ],
      }),
      step('feishu', 'needs_user_auth', {
        summary: '飞书应用已配置，需要你本人扫码授权',
        actions: [
          { id: 'fs-login', kind: 'api', label: '连接飞书账号' },
          { id: 'fs-admin', kind: 'copy', label: '复制管理员清单', text: '1. 开通用户身份权限 im:message.send_as_user' },
        ],
      }),
      step('dingtalk', 'needs_install', {
        summary: '本机还没有 dws，先安装再登录',
        detail: { identity: identityView() },
        actions: [
          { id: 'dt-install', kind: 'command', label: '安装 dws', command: 'pnpm run fetch:dws' },
          { id: 'dt-login', kind: 'api', label: '去登录钉钉' },
        ],
      }),
      step('mail', 'needs_user_auth', {
        summary: '还没有添加邮箱账号',
        actions: [{ id: 'mail-add', kind: 'form', label: '添加邮箱账号' }],
      }),
    ],
    ...patch,
  };
}

const EMPTY_APP_CONFIG = {
  identity: { dingtalk: 'auto' },
  platforms: {
    feishu: { fields: {}, missing: [] },
    dingtalk: { fields: {}, missing: [] },
    wechat: { fields: {}, missing: [] },
  },
  llm: {},
  restartRequired: false,
  envFile: null,
  settingsFile: null,
};

const MAIL_ACCOUNTS = [
  {
    key: 'local-1',
    maskedAddress: 'm***e@qq.com',
    provider: 'qq',
    source: 'file',
  },
  {
    key: 'env-1',
    address: 'z***n@163.com',
    provider: '163',
    source: 'env',
  },
];

function makeState(patch: Partial<typeof hoisted.state> = {}) {
  hoisted.state = {
    accounts: [],
    health: { received: 0, deduped: 0, sent: 0, failed: 0, dlq: 0 },
    demoMode: false,
    error: null,
    connection: 'connected',
    messages: [],
    onboarding: null,
    appConfig: null,
    ...patch,
  };
}

function renderPage() {
  render(
    <MemoryRouter>
      <AntApp>
        <ConnectPage />
      </AntApp>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  makeState();
  window.sessionStorage.clear();
  hoisted.store.refreshOnboarding.mockResolvedValue(onboardingView());
  hoisted.store.mailAccounts.mockResolvedValue(MAIL_ACCOUNTS);
  hoisted.store.mailAccountTest.mockResolvedValue({ ok: true, message: 'ok' });
  hoisted.store.mailAccountCreate.mockResolvedValue(undefined);
  hoisted.store.mailAccountDelete.mockResolvedValue(undefined);
  hoisted.store.mailAccountVerify.mockResolvedValue({ ok: true, message: 'ok' });
  hoisted.store.refreshAppConfig.mockResolvedValue(EMPTY_APP_CONFIG);
  hoisted.store.loadAppConfig.mockResolvedValue(EMPTY_APP_CONFIG);
  hoisted.store.saveAppConfig.mockResolvedValue({ saved: true, restartRequired: false, hotApplied: true, changedKeys: ['identity.dingtalk'] });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('连接账号页（授权中心）渲染', () => {
  it('按 邮箱 → 钉钉 → 飞书 → 微信 排序，显示总进度、状态 Tag 与 dws 来源', async () => {
    renderPage();

    expect(await screen.findByText('已就绪 1 / 4')).toBeInTheDocument();
    expect(screen.getByText(/按 邮箱 → 钉钉 → 飞书 → 微信 的顺序连接/)).toBeInTheDocument();
    expect(screen.getByText(/内置 tools 目录/)).toBeInTheDocument();

    const cards = Array.from(document.querySelectorAll('[data-testid^="connect-step-"]'));
    expect(cards.map((el) => el.getAttribute('data-testid'))).toEqual([
      'connect-step-mail',
      'connect-step-dingtalk',
      'connect-step-feishu',
      'connect-step-wechat',
    ]);
    expect(within(cards[0] as HTMLElement).getByText('需本人授权')).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText('需安装')).toBeInTheDocument();
    expect(within(cards[2] as HTMLElement).getByText('需本人授权')).toBeInTheDocument();
    expect(within(cards[3] as HTMLElement).getByText('已就绪')).toBeInTheDocument();
    // 未就绪的卡片直接展开动作；已就绪卡片默认折叠（详情按钮在卡片头，动作按钮在 body）
    expect(within(cards[3] as HTMLElement).getByRole('button', { name: /查看详情/ })).toBeInTheDocument();
    expect(within(cards[3] as HTMLElement).queryByRole('button', { name: /打开微信 RPA 说明/ })).toBeNull();
  });

  it('已就绪卡片可折叠查看详情 + 刷新状态', async () => {
    renderPage();
    const wechat = (await screen.findByTestId('connect-step-wechat')) as HTMLElement;
    fireEvent.click(within(wechat).getByRole('button', { name: /查看详情/ }));
    expect(within(wechat).getByText('RPA 桥已就绪')).toBeInTheDocument();
    expect(within(wechat).getByRole('button', { name: /打开微信 RPA 说明/ })).toBeInTheDocument();

    fireEvent.click(within(wechat).getByRole('button', { name: /刷新状态/ }));
    await waitFor(() => expect(hoisted.store.refreshOnboarding).toHaveBeenCalledTimes(2));
  });

  it('邮箱账号列表：脱敏地址 + 来源标签；只有本地账号可删除', async () => {
    renderPage();
    const list = await screen.findByTestId('mail-accounts');
    expect(within(list).getByText('m***e@qq.com')).toBeInTheDocument();
    expect(within(list).getByText('z***n@163.com')).toBeInTheDocument();
    expect(within(list).getByText('本地')).toBeInTheDocument();
    expect(within(list).getByText('来自 .env')).toBeInTheDocument();
    expect(within(list).getByText(/不可在页面删除，请修改 .env 后重启/)).toBeInTheDocument();
    // env 来源没有删除按钮；file 来源有
    expect(within(list).getAllByRole('button', { name: /删\s*除/ })).toHaveLength(1);

    fireEvent.click(within(list).getByRole('button', { name: /删\s*除/ }));
    await screen.findByText('删除这个邮箱账号？');
    const confirm = document.querySelector('.ant-popconfirm') as HTMLElement;
    fireEvent.click(within(confirm).getByRole('button', { name: /删\s*除/ }));
    await waitFor(() => expect(hoisted.store.mailAccountDelete).toHaveBeenCalledWith('local-1'));
  });

  it('邮箱卡片的 form 动作展开新增表单', async () => {
    renderPage();
    await screen.findByTestId('connect-step-mail');
    fireEvent.click(screen.getByRole('button', { name: /添加邮箱账号/ }));
    expect(await screen.findByTestId('mail-account-form')).toBeInTheDocument();
  }, 15000);

  it('演示模式如实标注，不伪造已连接', async () => {
    makeState({ demoMode: true });
    hoisted.store.refreshOnboarding.mockResolvedValue(
      onboardingView({
        overall: { ready: 0, total: 4, needsAction: 0 },
        steps: (['mail', 'dingtalk', 'feishu', 'wechat'] as const).map((id) =>
          step(id, 'mock', { summary: '演示模式：不会连接真实账号' }),
        ),
      }),
    );
    renderPage();
    expect(await screen.findByText(/当前是纯前端演示模式（Mock）/)).toBeInTheDocument();
    expect(screen.getByText('已就绪 0 / 4')).toBeInTheDocument();
    expect(screen.getAllByText('演示模式').length).toBe(4);
  });

  it('后端未提供 /api/onboarding：给中文升级提示与重试，不白屏', async () => {
    hoisted.store.refreshOnboarding.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText('授权中心暂不可用')).toBeInTheDocument();
    expect(screen.getByText(/可能需要重启或升级后端/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument();
  });
});

describe('连接账号页动作分发', () => {
  it('link 动作：打开官方后台；被浏览器拦截时展示可点击链接与复制', async () => {
    renderPage();
    const wechat = (await screen.findByTestId('connect-step-wechat')) as HTMLElement;
    fireEvent.click(within(wechat).getByRole('button', { name: /查看详情/ }));

    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(within(wechat).getByRole('button', { name: /打开微信 RPA 说明/ }));
    expect(openSpy).toHaveBeenCalledWith('https://weixin.qq.com/', '_blank', 'noopener');
    expect(await screen.findByText('浏览器拦截了新窗口')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /weixin\.qq\.com/ })).toHaveAttribute(
      'href',
      'https://weixin.qq.com/',
    );
  }, 15000);

  it('copy 动作：复制管理员清单到剪贴板', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /复制管理员清单/ }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('1. 开通用户身份权限 im:message.send_as_user'),
    );
  });

  it('command 动作：直接展示可复制命令（如内置 dws 下载）', async () => {
    renderPage();
    expect(await screen.findByText('pnpm run fetch:dws')).toBeInTheDocument();
    expect(screen.getByText('命令')).toBeInTheDocument();
  });

  it('api 动作（钉钉）：只打开「连接钉钉本人账号」弹窗，不预写 identity', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /用钉钉本人账号登录（推荐，无需机器人应用）/ }));
    expect(await screen.findByText('连接钉钉本人账号')).toBeInTheDocument();
    // 二轮 UI 复验 P1：登录前不得 PUT identity（取消/关闭必须无副作用）
    expect(hoisted.store.saveAppConfig).not.toHaveBeenCalled();
  });

  it('api 动作（飞书）：复用现有 OAuth 流程（开空白页后跳授权 URL）', async () => {
    const tab = { opener: null as unknown, location: { href: '' } };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /连接飞书账号/ }));

    await waitFor(() => expect(hoisted.store.feishuOAuthStart).toHaveBeenCalledTimes(1));
    expect(tab.location.href).toBe(
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=demo',
    );
  });

  it('飞书授权未完成（20029）：飞书卡片动作里复用同一套帮助 + 本次真实回调地址', async () => {
    const redirectUri = 'http://localhost:3901/api/feishu/oauth/callback';
    markFeishuOAuthPending(window.sessionStorage);
    saveFeishuOAuthRedirectUri(window.sessionStorage, redirectUri);
    renderPage();

    const feishuCard = (await screen.findByTestId('connect-step-feishu')) as HTMLElement;
    expect(await within(feishuCard).findByText(FEISHU_OAUTH_UNFINISHED_TITLE)).toBeInTheDocument();
    expect(within(feishuCard).getByTestId('feishu-oauth-redirect-uri')).toHaveTextContent(redirectUri);
    expect(within(feishuCard).getByRole('button', { name: /复制地址/ })).toBeInTheDocument();
    expect(within(feishuCard).getByRole('button', { name: /重新授权/ })).toBeInTheDocument();
    expect(within(feishuCard).getByRole('button', { name: /我知道了/ })).toBeInTheDocument();
  });
});




describe('白号改造：缺凭据 / 一登即用 / 邮箱验证', () => {
  function whiteAccountView(): OnboardingView {
    return onboardingView({
      overall: { ready: 0, total: 4, needsAction: 4 },
      steps: [
        step('mail', 'needs_user_auth', {
          summary: '还没有邮箱账号',
          actions: [{ id: 'mail-add', kind: 'form', label: '添加邮箱账号' }],
        }),
        step('dingtalk', 'needs_admin', {
          summary: '缺少机器人应用凭据；可改用仅本人身份',
          detail: { effectiveSend: 'mock', missing: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'] },
          actions: [
            { id: 'dingtalk-personal-login', kind: 'api', label: '用钉钉本人账号登录（推荐，无需机器人应用）' },
          ],
        }),
        step('feishu', 'needs_admin', {
          summary: '缺少飞书应用凭据',
          detail: { missing: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] },
          actions: [{ id: 'feishu-configure', kind: 'form', label: '填写飞书应用凭据' }],
        }),
        step('wechat', 'needs_admin', {
          summary: '缺少微信 RPA 桥配置',
          detail: { missing: ['WECHAT_BRIDGE_URL'] },
          actions: [{ id: 'wechat-configure', kind: 'form', label: '填写微信 RPA 桥地址' }],
        }),
      ],
    });
  }

  it('显示 missing 的人类可读键名 + 「填写配置」打开平台应用配置弹窗', async () => {
    hoisted.store.refreshOnboarding.mockResolvedValue(whiteAccountView());
    renderPage();

    const missing = await screen.findByTestId('connect-missing-feishu');
    expect(missing.textContent).toContain('飞书 App ID');
    expect(missing.textContent).toContain('飞书 App Secret');
    // 不把内部变量名直接铺给客户
    expect(missing.textContent).not.toContain('FEISHU_APP_ID');

    fireEvent.click(within(missing).getByRole('button', { name: /填写配置/ }));
    await waitFor(() =>
      expect(document.querySelector('.ant-modal-title')?.textContent).toContain('平台应用配置'),
    );
  });

  it('钉钉「一登即用」：只打开登录弹窗，登录前不预写 identity', async () => {
    hoisted.store.refreshOnboarding.mockResolvedValue(whiteAccountView());
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /用钉钉本人账号登录（推荐，无需机器人应用）/ }));
    expect(await screen.findByText('连接钉钉本人账号')).toBeInTheDocument();
    expect(hoisted.store.saveAppConfig).not.toHaveBeenCalled();
  });

  it('进度「待处理」按后端 needsAction；ready<total 时绝不显示「全部就绪」', async () => {
    hoisted.store.refreshOnboarding.mockResolvedValue(
      onboardingView({ overall: { ready: 1, total: 4, needsAction: 0 } }),
    );
    renderPage();

    expect(await screen.findByText('已就绪 1 / 4')).toBeInTheDocument();
    // 后端仍给 0 时用「未就绪数」兜底，避免误导客户「没有待办」
    expect(screen.getByText(/待处理 3 项/)).toBeInTheDocument();
    expect(screen.queryByText('四个平台都已就绪')).not.toBeInTheDocument();
  });

  it('未验证邮箱账号：显示「未验证」并可点「测试验证」调用 verify 接口', async () => {
    hoisted.store.mailAccounts.mockResolvedValue([
      { key: 'u1', maskedAddress: 'u***1@qq.com', provider: 'qq', source: 'file', verified: false },
    ]);
    renderPage();

    expect(await screen.findByText('未验证')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /测试验证/ }));
    await waitFor(() => expect(hoisted.store.mailAccountVerify).toHaveBeenCalledWith('u1'));
  });

  it('mail-enable-real：保存 modes.mail=real，需要重启时显示常驻重启提示', async () => {
    hoisted.store.refreshOnboarding.mockResolvedValue(
      onboardingView({
        steps: [
          step('mail', 'needs_user_auth', {
            actions: [{ id: 'mail-enable-real', kind: 'api', label: '启用真实收信' }],
          }),
          step('dingtalk', 'mock', { actions: [] }),
          step('feishu', 'mock', { actions: [] }),
          step('wechat', 'mock', { actions: [] }),
        ],
      }),
    );
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: true,
      restartRequired: true,
      changedKeys: ['modes.mail'],
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /启用真实收信/ }));
    await waitFor(() =>
      expect(hoisted.store.saveAppConfig).toHaveBeenCalledWith({ modes: { mail: 'real' } }),
    );
    expect(await screen.findByText(/需要重启 LinkHub 生效/)).toBeInTheDocument();
  });
});

describe('二轮 UI 复验：钉钉登录时序 / 未登录提示 / .env 锁定', () => {
  it('已启用本人身份但未登录：显式提示并给「重新登录」，不显示 Mock 已连接', async () => {
    const notLinked = identityView({ policy: 'auto', effectiveSend: 'user', effectiveReceive: 'user' });
    notLinked.user = { ...notLinked.user, state: 'not_linked', linked: false, hint: '本人身份未登录' };
    makeState({
      accounts: [
        {
          platform: 'dingtalk',
          label: '钉钉',
          mode: 'real',
          configured: true,
          identity: notLinked,
          missing: [],
          warnings: [],
          issues: [],
          canReceive: false,
          canSend: false,
        },
      ],
      appConfig: { identity: { dingtalk: 'user' } },
      onboarding: onboardingView({
        steps: [
          step('mail', 'needs_user_auth'),
          step('dingtalk', 'needs_user_auth', {
            detail: { effectiveSend: 'user', runtimePolicy: 'user', identity: { state: 'not_linked' } },
            actions: [
              { id: 'dingtalk-login', kind: 'api', label: '用钉钉本人账号登录（推荐，无需机器人应用）' },
            ],
          }),
          step('feishu', 'needs_admin'),
          step('wechat', 'needs_admin'),
        ],
      }),
    });
    renderPage();

    expect(await screen.findByTestId('dingtalk-identity-warning')).toHaveTextContent(
      /已启用「仅本人身份」但当前未登录/,
    );
    expect(await screen.findByRole('button', { name: /重新登录钉钉本人账号/ })).toBeInTheDocument();
  });

  it('.env 锁定 identity：保存后显示常驻警告，不出现「已立即生效」', async () => {
    const linked = identityView({ effectiveSend: 'mock', effectiveReceive: 'mock' });
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: false,
      restartRequired: false,
      hotApplied: false,
      ignoredByEnv: ['DINGTALK_IDENTITY'],
      changedKeys: ['identity.dingtalk'],
    });
    makeState({
      accounts: [
        {
          platform: 'dingtalk',
          label: '钉钉',
          mode: 'mock',
          configured: true,
          identity: linked,
          missing: [],
          warnings: [],
          issues: [],
          canReceive: true,
          canSend: true,
        },
      ],
      onboarding: onboardingView({
        steps: [
          step('mail', 'needs_user_auth'),
          step('dingtalk', 'mock', {
            detail: { effectiveSend: 'mock' },
            actions: [{ id: 'dingtalk-enable-personal-only', kind: 'api', label: '启用本人身份模式' }],
          }),
          step('feishu', 'needs_admin'),
          step('wechat', 'needs_admin'),
        ],
      }),
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /启用本人身份模式/ }));
    expect(await screen.findByTestId('connect-config-warning')).toHaveTextContent(/钉钉身份策略/);
    expect(screen.queryByText(/已立即生效（无需重启）/)).not.toBeInTheDocument();
  });

  it('登录弹窗关闭后无副作用：不 PUT identity、不出现重启提示', async () => {
    makeState({ onboarding: onboardingView() });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /用钉钉本人账号登录（推荐，无需机器人应用）/ }));
    expect(await screen.findByText('连接钉钉本人账号')).toBeInTheDocument();
    const footerClose = document.querySelector('.ant-modal-footer button');
    expect(footerClose).not.toBeNull();
    fireEvent.click(footerClose as HTMLElement);
    expect(hoisted.store.saveAppConfig).not.toHaveBeenCalled();
    expect(screen.queryByText(/需要重启 LinkHub 生效/)).not.toBeInTheDocument();
  });
});


describe('二轮复验：身份热应用 / 飞书真实模式动作', () => {
  it('linked+mock 点「启用本人身份模式」：hotApplied:true 时提示立即生效，不出现重启提示', async () => {
    const linked = identityView({ effectiveSend: 'mock', effectiveReceive: 'mock' });
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: true,
      restartRequired: false,
      hotApplied: true,
      hotAppliedKeys: ['identity.dingtalk'],
      changedKeys: ['identity.dingtalk'],
    });
    makeState({
      accounts: [
        {
          platform: 'dingtalk',
          label: '钉钉',
          mode: 'mock',
          configured: true,
          identity: linked,
          missing: [],
          warnings: [],
          issues: [],
          canReceive: true,
          canSend: true,
        },
      ],
      onboarding: onboardingView({
        steps: [
          step('mail', 'needs_user_auth'),
          step('dingtalk', 'mock', { actions: [{ id: 'dingtalk-enable-personal-only', kind: 'api', label: '仅用本人身份（立即生效，无需重启）' }] }),
          step('feishu', 'needs_admin'),
          step('wechat', 'needs_admin'),
        ],
      }),
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /启用本人身份模式/ }));
    await waitFor(() =>
      expect(hoisted.store.saveAppConfig).toHaveBeenCalledWith({ identity: { dingtalk: 'user' } }),
    );
    expect(await screen.findByText(/已立即生效（无需重启）/)).toBeInTheDocument();
    expect(screen.queryByText(/需要重启 LinkHub 生效/)).not.toBeInTheDocument();
  });

  it('feishu-mode-real：保存 modes.feishu=real 是静态键，走重启提示', async () => {
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: true,
      restartRequired: true,
      hotApplied: false,
      changedKeys: ['modes.feishu'],
    });
    const feishuView = onboardingView({
      steps: [
        step('mail', 'needs_user_auth'),
        step('dingtalk', 'needs_user_auth'),
        step('feishu', 'needs_admin', {
          actions: [
            {
              id: 'feishu-mode-real',
              kind: 'api',
              label: '改为真实模式（保存后需重启 LinkHub）',
              path: '/api/app-config',
              method: 'PUT',
              payload: { modes: { feishu: 'real' } },
            },
          ],
        }),
        step('wechat', 'needs_admin'),
      ],
    });
    hoisted.store.refreshOnboarding.mockResolvedValue(feishuView);
    makeState({ onboarding: feishuView });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /改为真实模式/ }));
    await waitFor(() =>
      expect(hoisted.store.saveAppConfig).toHaveBeenCalledWith({ modes: { feishu: 'real' } }),
    );
    expect(await screen.findByText(/需要重启 LinkHub 生效/)).toBeInTheDocument();
  });
});

