/**
 * InboxPage 接线测试：证明首屏空态接的是「一键注入入口」而不是文档说明。
 *
 * 用 vi.mock 隔离全局 store 单例（真实 store 会创建 WebSocket），
 * 以「状态驱动」的方式覆盖：真实后端空收件箱 → 显示 QuickStart；Mock 模式 / 有消息 / 加载失败 → 不显示。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ACCOUNTS } from '../../services/mock/fixtures';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';

const hoisted = vi.hoisted(() => {
  const state = {
    messages: [] as unknown[],
    loading: false,
    error: null as string | null,
    filters: { keyword: '', onlyReview: false },
    accounts: [] as unknown[],
    health: null as null | { received: number },
    connection: 'connected' as 'connected' | 'reconnecting' | 'offline',
    demoMode: false,
    initialized: true,
    onboarding: null as null | { firstRun?: boolean; overall?: { ready: number; total: number } },
  };
  return { state };
});

vi.mock('../../hooks/useAppState', () => ({
  useAppState: () => hoisted.state,
}));

// 只提供 InboxPage / DetailPanel 用到的 store 方法；避免 import 真实单例创建 WS 连接
vi.mock('../../store', () => ({
  // 会话名录接口：默认「不可用」，用例需要时再覆写
  services: {
    api: {
      contacts: vi.fn(async (platform: string) => ({ platform, available: false, items: [] })),
    },
  },
  store: {
    setFilters: vi.fn(),
    resetFilters: vi.fn(),
    dismissError: vi.fn(),
    reply: vi.fn(),
    markDone: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(async () => 0),
    getTrace: vi.fn(),
    refreshHealth: vi.fn(),
    simulateIncoming: vi.fn(),
    armFailure: vi.fn(),
    refreshOnboarding: vi.fn(async () => null),
  },
}));

import { InboxPage } from './InboxPage';

const MESSAGE: UnifiedMessage = {
  traceId: 't-inbox-1',
  platform: Platform.FEISHU,
  externalId: 'e-inbox-1',
  sender: { id: 'u1', name: '张三' },
  type: 'text',
  body: '周五前交周报。',
  status: MsgStatus.RECEIVED,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function mockState(patch: Partial<typeof hoisted.state> = {}) {
  hoisted.state = {
    messages: [],
    loading: false,
    error: null,
    filters: { keyword: '', onlyReview: false },
    accounts: [],
    health: null,
    connection: 'connected',
    demoMode: false,
    initialized: true,
    onboarding: null,
    ...patch,
  };
}

/**
 * 必须用 <Routes> 提供真实路由上下文，否则 useParams() 永远拿到 {}：
 * 「选中某条消息 / 自动跳转」这类用例测不到路由参数。
 */
function renderInboxPage(path = '/inbox') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/inbox/:traceId" element={<InboxPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('InboxPage 首启空态接线', () => {
  it('真实后端 + 空收件箱：首屏只给客户引导（去连接账号 / 先体验演示），不再堆叠三重引导', () => {
    mockState({ demoMode: false, accounts: ACCOUNTS, health: { received: 0 } });
    renderInboxPage();

    // P1-3 / P0-1：首启引导必须真的渲染到页面上，且不再把开发者命令铺在首屏
    expect(screen.getByTestId('first-run-guide')).toBeInTheDocument();
    expect(screen.getByText('后端已连上，但还没有消息')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /去连接账号/ }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /先体验演示（注入示例消息）/ }).length,
    ).toBeGreaterThan(0);

    // 首启引导还在时，空态不重复堆注入入口（P2-9）；只显示「还没有收到消息」+ 引导
    expect(screen.queryByTestId('quickstart')).not.toBeInTheDocument();
    expect(screen.getByText('还没有收到消息')).toBeInTheDocument();
    expect(screen.queryByText('没有匹配的消息')).not.toBeInTheDocument();
    expect(screen.queryByText('清空筛选')).not.toBeInTheDocument();

    // 点「知道了」后引导收起，空态恢复一键注入入口
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
    expect(screen.getByTestId('quickstart')).toBeInTheDocument();
  });

  it('前端 Mock 演示模式：空收件箱不渲染注入入口（无平台可假装）', () => {
    mockState({ demoMode: true, accounts: ACCOUNTS });
    renderInboxPage();
    expect(screen.queryByTestId('quickstart')).not.toBeInTheDocument();
  });

  it('已有消息：不渲染注入入口（列表加载中也不误判为空）', () => {
    mockState({ loading: true, messages: [MESSAGE], accounts: ACCOUNTS });
    renderInboxPage();
    expect(screen.queryByTestId('quickstart')).not.toBeInTheDocument();
  });

  it('加载失败：不渲染注入入口，空态提示「消息加载失败」而不是「没收到消息」', () => {
    mockState({ error: '无法连接后端服务，请确认服务已启动' });
    renderInboxPage();
    expect(screen.queryByTestId('quickstart')).not.toBeInTheDocument();
    expect(screen.getByText('消息加载失败')).toBeInTheDocument();
    expect(screen.queryByText('还没有收到消息')).not.toBeInTheDocument();
  });

  it('URL 里的 traceId 已不存在（重启后内存清空）：回退到卡片网格，不替用户选一条', async () => {
    mockState({ messages: [MESSAGE], accounts: ACCOUNTS });
    renderInboxPage('/inbox/stale-trace-id-from-before-restart');

    // 意图与队友那次修复一致：右侧不留空白、不让人误以为消息丢了。
    // 但默认态是卡片网格，替用户打开"最新一条"会让他以为自己点错了消息，
    // 所以这里回退到网格——消息本身就在眼前。
    expect(await screen.findByText('周五前交周报。')).toBeInTheDocument();
    // 没有打开任何详情：详情面板不存在（网格模式右侧的占位只是被 CSS 隐藏，不算"空白"）
    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
  });

  it('URL 里的 traceId 有效：保持用户当前选中的消息，不跳转', async () => {
    const other: UnifiedMessage = { ...MESSAGE, traceId: 't-inbox-2', body: '另一条消息' };
    mockState({ messages: [MESSAGE, other], accounts: ACCOUNTS });
    renderInboxPage('/inbox/t-inbox-1');

    expect(await screen.findByTestId('detail-panel')).toBeInTheDocument();
    expect(within(screen.getByTestId('detail-panel')).getByText('周五前交周报。')).toBeInTheDocument();
  });
});


describe('首启入口（连接账号横幅）', () => {
  it('首次打开：收件箱顶部提示去「连接账号」，点击后写入本地标记不再打扰', () => {
    mockState({ accounts: ACCOUNTS });
    renderInboxPage();

    const banner = screen.getByTestId('onboarding-banner');
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/首次使用：先连接你自己的账号/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '去连接账号' }));
    expect(window.localStorage.getItem('linkhub.onboarded')).toBe('1');
    expect(screen.queryByTestId('onboarding-banner')).toBeNull();
  });

  it('点过「稍后再说」后不再打扰', () => {
    window.localStorage.setItem('linkhub.onboarded', '1');
    mockState({ accounts: ACCOUNTS });
    renderInboxPage();
    expect(screen.queryByTestId('onboarding-banner')).toBeNull();
  });

  it('点过「稍后再说」或「去连接账号」后，即使后端 firstRun=true 也不再打扰（P1-6）', () => {
    window.localStorage.setItem('linkhub.onboarded', '1');
    mockState({
      accounts: ACCOUNTS,
      onboarding: { firstRun: true, overall: { ready: 1, total: 4 } },
    });
    renderInboxPage();
    expect(screen.queryByTestId('onboarding-banner')).toBeNull();
  });

  it('全部平台已就绪 / 纯前端演示模式：不出现横幅', () => {
    mockState({
      accounts: ACCOUNTS,
      onboarding: { firstRun: false, overall: { ready: 4, total: 4 } },
    });
    renderInboxPage();
    expect(screen.queryByTestId('onboarding-banner')).toBeNull();
  });
});

describe('收件箱筛选与搜索接线（三栏工作台）', () => {
  it('搜索框输入即写入 filters.keyword（走既有筛选能力，不是本地假过滤）', async () => {
    const { store } = await import('../../store');
    mockState({ messages: [MESSAGE], accounts: ACCOUNTS });
    renderInboxPage();

    fireEvent.change(screen.getByLabelText('搜索消息'), { target: { value: '周报' } });
    expect(store.setFilters).toHaveBeenCalledWith({ keyword: '周报' });
  });

  it('「未读 / 待处理」快捷胶囊分别切换 onlyUnread / onlyReview', async () => {
    const { store } = await import('../../store');
    mockState({ messages: [MESSAGE], accounts: ACCOUNTS });
    renderInboxPage();

    fireEvent.click(screen.getByRole('button', { name: '未读' }));
    expect(store.setFilters).toHaveBeenCalledWith({ onlyUnread: true });

    fireEvent.click(screen.getByRole('button', { name: '待处理' }));
    expect(store.setFilters).toHaveBeenCalledWith({ onlyReview: true });
  });
});
