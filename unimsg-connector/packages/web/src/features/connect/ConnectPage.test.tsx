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
  };
  return { state, store };
});

vi.mock('../../hooks/useAppState', () => ({
  useAppState: () => hoisted.state,
}));
vi.mock('../../store', () => ({ store: hoisted.store }));

import { ConnectPage } from './ConnectPage';

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
    label: { mail: '邮箱', dingtalk: '钉钉', feishu: '飞书', wecom: '企业微信' }[id],
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
      step('wecom', 'ready', {
        summary: '企业微信机器人通道已就绪',
        hints: ['可信 IP 已配置'],
        actions: [
          { id: 'wc-link', kind: 'link', label: '打开企业微信后台', url: 'https://work.weixin.qq.com/' },
          { id: 'wc-copy', kind: 'copy', label: '复制可信 IP 说明', text: '把 LinkHub 服务器的出口 IP 加入企业微信可信 IP。' },
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
});

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('连接账号页（授权中心）渲染', () => {
  it('按 邮箱 → 钉钉 → 飞书 → 企微 排序，显示总进度、状态 Tag 与 dws 来源', async () => {
    renderPage();

    expect(await screen.findByText('已就绪 1 / 4')).toBeInTheDocument();
    expect(screen.getByText(/按 邮箱 → 钉钉 → 飞书 → 企业微信 的顺序连接/)).toBeInTheDocument();
    expect(screen.getByText(/内置 tools 目录/)).toBeInTheDocument();

    const cards = Array.from(document.querySelectorAll('[data-testid^="connect-step-"]'));
    expect(cards.map((el) => el.getAttribute('data-testid'))).toEqual([
      'connect-step-mail',
      'connect-step-dingtalk',
      'connect-step-feishu',
      'connect-step-wecom',
    ]);
    expect(within(cards[0] as HTMLElement).getByText('需本人授权')).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText('需安装')).toBeInTheDocument();
    expect(within(cards[2] as HTMLElement).getByText('需本人授权')).toBeInTheDocument();
    expect(within(cards[3] as HTMLElement).getByText('已就绪')).toBeInTheDocument();
    // 未就绪的卡片直接展开动作；已就绪卡片默认折叠（详情按钮在卡片头，动作按钮在 body）
    expect(within(cards[3] as HTMLElement).getByRole('button', { name: /查看详情/ })).toBeInTheDocument();
    expect(within(cards[3] as HTMLElement).queryByRole('button', { name: /打开企业微信后台/ })).toBeNull();
  });

  it('已就绪卡片可折叠查看详情 + 刷新状态', async () => {
    renderPage();
    const wecom = (await screen.findByTestId('connect-step-wecom')) as HTMLElement;
    fireEvent.click(within(wecom).getByRole('button', { name: /查看详情/ }));
    expect(within(wecom).getByText('可信 IP 已配置')).toBeInTheDocument();
    expect(within(wecom).getByRole('button', { name: /打开企业微信后台/ })).toBeInTheDocument();

    fireEvent.click(within(wecom).getByRole('button', { name: /刷新状态/ }));
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
  });

  it('演示模式如实标注，不伪造已连接', async () => {
    makeState({ demoMode: true });
    hoisted.store.refreshOnboarding.mockResolvedValue(
      onboardingView({
        overall: { ready: 0, total: 4, needsAction: 0 },
        steps: (['mail', 'dingtalk', 'feishu', 'wecom'] as const).map((id) =>
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
    const wecom = (await screen.findByTestId('connect-step-wecom')) as HTMLElement;
    fireEvent.click(within(wecom).getByRole('button', { name: /查看详情/ }));

    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(within(wecom).getByRole('button', { name: /打开企业微信后台/ }));
    expect(openSpy).toHaveBeenCalledWith('https://work.weixin.qq.com/', '_blank', 'noopener');
    expect(await screen.findByText('浏览器拦截了新窗口')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /work\.weixin\.qq\.com/ })).toHaveAttribute(
      'href',
      'https://work.weixin.qq.com/',
    );
  });

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

  it('api 动作（钉钉）：打开现有「连接钉钉本人账号」弹窗，而不是重复实现登录流程', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /去登录钉钉/ }));
    expect(await screen.findByText('连接钉钉本人账号')).toBeInTheDocument();
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
});


