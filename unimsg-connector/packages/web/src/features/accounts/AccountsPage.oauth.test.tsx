/**
 * 账号页「小白卡点」接线测试（P1-5 / P1-6 / P2-4）：
 * 用 vi.mock 隔离全局 store 与 useAppState，只验证页面行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import type { PlatformIdentityView, UserIdentityStatus } from '@unimsg/shared';
import { ACCOUNTS } from '../../services/mock/fixtures';
import { Platform } from '../../types';

const hoisted = vi.hoisted(() => {
  const state = {
    accounts: [] as unknown[],
    health: null as Record<string, unknown> | null,
    demoMode: false,
    error: null as string | null,
    connection: 'connected' as 'connected' | 'reconnecting' | 'offline',
    messages: [] as unknown[],
  };
  const store = {
    refreshAccounts: vi.fn(async () => {}),
    refreshHealth: vi.fn(async () => {}),
    feishuOAuthStart: vi.fn(async () => ({ url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=demo' })),
    dingtalkPersonalLogin: vi.fn(),
    dingtalkPersonalStatus: vi.fn(),
    dingtalkPersonalLogout: vi.fn(async () => {}),
    getSnapshot: vi.fn(() => ({ accounts: [] as unknown[] })),
  };
  return { state, store };
});

vi.mock('../../hooks/useAppState', () => ({
  useAppState: () => hoisted.state,
}));

vi.mock('../../store', () => ({ store: hoisted.store }));

import { AccountsPage } from './AccountsPage';
import {
  FEISHU_OAUTH_PENDING_KEY,
  markFeishuOAuthPending,
} from './feishuOAuthFeedback';

const FEISHU_ACCOUNT = ACCOUNTS.find((a) => a.platform === Platform.FEISHU)!;

function identityView(
  patch: Partial<PlatformIdentityView> = {},
  userPatch: Partial<UserIdentityStatus> = {},
): PlatformIdentityView {
  return {
    policy: 'auto',
    effectiveSend: 'bot',
    effectiveReceive: 'bot',
    user: {
      state: 'not_linked',
      linked: false,
      hint: '未连接本人账号：当前以机器人收发；点「连接本人账号」开始。',
      canLink: true,
      linkMethod: 'oauth',
      ...userPatch,
    },
    botAvailable: true,
    botHint: '机器人凭据齐全',
    receiveHint: '机器人长连接',
    sendHint: '机器人接口发送',
    ...patch,
  };
}

function makeState(patch: Partial<typeof hoisted.state> = {}) {
  hoisted.state = {
    accounts: [{ ...FEISHU_ACCOUNT, identity: identityView() }],
    health: { received: 0, deduped: 0, sent: 0, sentMock: 0, failed: 0, dlq: 0 },
    demoMode: false,
    error: null,
    connection: 'connected',
    messages: [],
    ...patch,
  };
  return hoisted.state;
}

function renderPage() {
  render(
    <MemoryRouter>
      <AntApp>
        <AccountsPage />
      </AntApp>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  makeState();
  hoisted.store.feishuOAuthStart.mockResolvedValue({
    url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=demo',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('账号页 P1-5：.env 改了没重启', () => {
  it('envFile.mtime 晚于 startedAt：页顶提示需重启并给可复制命令', async () => {
    makeState({
      health: {
        received: 3,
        deduped: 1,
        sent: 5,
        sentMock: 3,
        failed: 1,
        dlq: 0,
        startedAt: '2026-11-12T01:00:00.000Z',
        envFile: { path: 'C:\\proj\\unimsg-connector\\.env', mtime: '2026-11-12T01:05:00.000Z' },
      },
    });
    renderPage();

    expect(await screen.findByText('.env 已修改，需要重启后端才生效')).toBeInTheDocument();
    expect(screen.getByText('pnpm --filter @unimsg/server start')).toBeInTheDocument();
    expect(screen.getByText(/当前运行中的后端仍在用「启动时读取的配置」/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /重新检查/ }));
    expect(hoisted.store.refreshHealth).toHaveBeenCalledTimes(1);
  });

  it('指标口径：发送共 N（真实 A / 模拟 B）+ 标题写「本次启动以来」', async () => {
    makeState({
      health: { received: 3, deduped: 1, sent: 5, sentMock: 3, failed: 1, dlq: 0 },
    });
    renderPage();

    expect(
      await screen.findByText('接收 3 · 发送共 5（真实 2 / 模拟 3） · 失败 1'),
    ).toBeInTheDocument();
    expect(screen.getByText('运行指标 · 本次启动以来')).toBeInTheDocument();
    expect(screen.getByTestId('metric-sent')).toHaveTextContent('发送共5真实 2 · 模拟 3');
  });

  it('健康数据缺 startedAt/envFile（旧后端）时不提示重启', () => {
    makeState();
    renderPage();
    expect(screen.queryByText(/需要重启后端才生效/)).not.toBeInTheDocument();
  });
});

describe('账号页 P1-6：飞书 OAuth 失败/被拦截的反馈', () => {
  it('弹窗被拦截：展示可点的授权链接与复制入口，且不再整页跳走', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /连接本人账号/ }));

    await waitFor(() => expect(hoisted.store.feishuOAuthStart).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('浏览器拦截了飞书授权窗口')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /打开飞书授权页/ }),
    ).toHaveAttribute('href', 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=demo');
    expect(window.sessionStorage.getItem(FEISHU_OAUTH_PENDING_KEY)).toBeTruthy();
  });

  it('授权回来仍未连接：展示中文原因 + 配置清单，可关闭提示', async () => {
    markFeishuOAuthPending(window.sessionStorage);
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderPage();

    expect(await screen.findByText('飞书授权未完成')).toBeInTheDocument();
    // 中文解释里就有常见原因，不再让用户对着裸错误码猜
    expect(screen.getAllByText(/重定向 URL/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('查看配置步骤（常见失败原因）'));
    expect(screen.getByText(/personal-identity\.md「飞书」一节/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /我知道了/ }));
    await waitFor(() => expect(screen.queryByText('飞书授权未完成')).not.toBeInTheDocument());
    expect(window.sessionStorage.getItem(FEISHU_OAUTH_PENDING_KEY)).toBeNull();
  });

  it('授权回来已连接本人：清标记并提示成功', async () => {
    markFeishuOAuthPending(window.sessionStorage);
    makeState({
      accounts: [
        {
          ...FEISHU_ACCOUNT,
          identity: identityView(
            { effectiveSend: 'user', effectiveReceive: 'user' },
            { state: 'linked', linked: true, displayName: '陈晓' },
          ),
        },
      ],
    });
    hoisted.store.getSnapshot.mockReturnValue({
      accounts: hoisted.state.accounts,
    });
    renderPage();

    await waitFor(() =>
      expect(window.sessionStorage.getItem(FEISHU_OAUTH_PENDING_KEY)).toBeNull(),
    );
  });
});
