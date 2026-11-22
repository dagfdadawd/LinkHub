import userEvent from '@testing-library/user-event';
/**
 * InboxPage 接线测试：证明首屏空态接的是「一键注入入口」而不是文档说明。
 *
 * 用 vi.mock 隔离全局 store 单例（真实 store 会创建 WebSocket），
 * 以「状态驱动」的方式覆盖：真实后端空收件箱 → 显示 QuickStart；Mock 模式 / 有消息 / 加载失败 → 不显示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ACCOUNTS } from '../../services/mock/fixtures';
import { resetSessionForTest, setSession } from '../../services/session';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';

const hoisted = vi.hoisted(() => {
  const state = {
    messages: [] as unknown[],
    loading: false,
    error: null as string | null,
    filters: {
      keyword: '',
      onlyReview: false,
      onlyUnread: false,
      onlyUrgent: false,
      platform: undefined as Platform | undefined,
    },
    accounts: [] as unknown[],
    health: null as null | { received: number },
    connection: 'connected' as 'connected' | 'reconnecting' | 'offline',
    demoMode: false,
    initialized: true,
    onboarding: null as null | { firstRun?: boolean; overall?: { ready: number; total: number } },
    hasOlder: false,
    loadingOlder: false,
  };
  const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
  return { state, toast };
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
      wechatPull: vi.fn(async () => ({
        ok: true,
        conversation: '项目群',
        parsed: 1,
        forwarded: 1,
        duplicates: 0,
        failed: [],
        conversationVerified: false,
      })),
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
    refresh: vi.fn(async () => {}),
    refreshHealth: vi.fn(),
    simulateIncoming: vi.fn(),
    // 问题②：真实服务下点「先体验演示」走带登录态的示例接口（消息归属当前账号）
    injectDemo: vi.fn(async () => ({ traceId: 't-demo', duplicate: false })),
    // 问题⑤：首屏只拉第一页，更早的消息按时间游标翻
    loadOlder: vi.fn(async () => {}),
    armFailure: vi.fn(),
    refreshOnboarding: vi.fn(async () => null),
  },
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    // InboxPage 只用到 App.useApp().message；测试里没有 <App> provider，
    // 给一个最小实现，避免拉取成功/失败分支因 toast 方法缺失变成 unhandled rejection。
    App: {
      useApp: () => ({
        message: hoisted.toast,
      }),
    },
  };
});

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
    filters: {
      keyword: '',
      onlyReview: false,
      onlyUnread: false,
      onlyUrgent: false,
      platform: undefined as Platform | undefined,
    },
    accounts: [],
    health: null,
    connection: 'connected',
    demoMode: false,
    initialized: true,
    onboarding: null,
    hasOlder: false,
    loadingOlder: false,
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
  // 会话是模块级单例（localStorage 持久化）：每个用例都从「未登录」开始
  resetSessionForTest();
  vi.clearAllMocks();
});

afterEach(() => {
  resetSessionForTest();
  vi.unstubAllGlobals();
});

describe('InboxPage 首启空态接线', () => {
  it('真实服务 + 空收件箱：首屏只给客户引导（去连接账号 / 先体验演示），不再堆叠三重引导', () => {
    // 旧实现依赖 health.received===0 才显示引导：这里故意让进程计数非 0，
    // 验证成员账号的空收件箱仍能看到引导（问题④）
    mockState({ demoMode: false, accounts: ACCOUNTS, health: { received: 7 } });
    renderInboxPage();

    // P1-3 / P0-1：首启引导必须真的渲染到页面上，且不再把开发者命令铺在首屏
    expect(screen.getByTestId('first-run-guide')).toBeInTheDocument();
    expect(screen.getByText('欢迎使用 LinkHub')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('后端已连上');
    expect(screen.getAllByRole('button', { name: /去连接账号/ }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /先体验演示（注入示例消息）/ }).length,
    ).toBeGreaterThan(0);

    // 首启引导还在时，空态不重复堆注入入口（P2-9）；只显示「还没有收到消息」+ 引导
    expect(screen.queryByTestId('quickstart')).not.toBeInTheDocument();
    expect(screen.getByText('还没有收到消息')).toBeInTheDocument();
    // 不再显示误导性的「没有匹配的会话 / 换一个渠道或状态」
    expect(screen.queryByText('没有匹配的会话')).not.toBeInTheDocument();
    expect(screen.queryByText('清空筛选')).not.toBeInTheDocument();

    // 点「知道了」后引导收起，空态恢复一键注入入口
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
    expect(screen.getByTestId('quickstart')).toBeInTheDocument();
  });

  it('新账号（已登录、0 条消息、无筛选）：显示「这个账号还没有消息」和可点的注入入口', async () => {
    setSession({
      token: 'token-member',
      user: { id: 'u-member', username: 'member', displayName: '成员', createdAt: '2026-11-01T00:00:00.000Z' },
    });
    mockState({ demoMode: false, accounts: ACCOUNTS });
    renderInboxPage();

    expect(screen.getByText('这个账号还没有消息')).toBeInTheDocument();
    expect(
      screen.getByText(/点下面按钮注入一条示例消息试试。/),
    ).toBeInTheDocument();
    // 不再把「没归属给我」当成空收件箱的原因（问题②/④）
    expect(screen.queryByText('没有匹配的会话')).not.toBeInTheDocument();
    expect(screen.queryByText(/认领无主的历史消息/)).not.toBeInTheDocument();

    const { store } = await import('../../store');
    fireEvent.click(screen.getByRole('button', { name: /注入一条飞书示例消息/ }));
    await vi.waitFor(() => expect(store.injectDemo).toHaveBeenCalledWith(Platform.FEISHU));
    expect(hoisted.toast.success).toHaveBeenCalledWith('已注入一条飞书示例消息，就在当前账号的收件箱里');
  });

  it('点「先体验演示」：走登录态的示例接口（消息归属当前账号），提示里不出现 webhook / API', async () => {
    const { store } = await import('../../store');
    mockState({ demoMode: false, accounts: ACCOUNTS });
    renderInboxPage();

    fireEvent.click(screen.getByRole('button', { name: /先体验演示（注入示例消息）/ }));

    await vi.waitFor(() => expect(store.injectDemo).toHaveBeenCalledWith(Platform.FEISHU));
    expect(hoisted.toast.success).toHaveBeenCalledWith('已注入一条飞书示例消息，就在当前账号的收件箱里');
    const shown = String(hoisted.toast.success.mock.calls[0][0]);
    expect(shown).not.toMatch(/webhook|API|后端/i);
  });

  it('旧版本服务没有示例接口（404）：回退公开 webhook 注入并提示已注入，不把 404 抛给用户', async () => {
    const { store } = await import('../../store');
    vi.mocked(store.injectDemo).mockRejectedValueOnce(
      Object.assign(new Error('资源不存在'), { status: 404 }),
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mockState({ demoMode: false, accounts: ACCOUNTS });
    renderInboxPage();

    fireEvent.click(screen.getByRole('button', { name: /先体验演示（注入示例消息）/ }));

    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchMock).mock.calls[0][0])).toContain('/api/webhook/feishu');
    expect(hoisted.toast.success).toHaveBeenCalledWith('已注入一条飞书示例消息');
    expect(hoisted.toast.error).not.toHaveBeenCalled();
  });

  it('注入失败（非 404）：给人话错误提示，不假装成功', async () => {
    const { store } = await import('../../store');
    vi.mocked(store.injectDemo).mockRejectedValueOnce(
      new Error('示例消息没能放进收件箱：服务繁忙'),
    );
    mockState({ demoMode: false, accounts: ACCOUNTS });
    renderInboxPage();

    fireEvent.click(screen.getByRole('button', { name: /先体验演示（注入示例消息）/ }));

    await vi.waitFor(() =>
      expect(hoisted.toast.error).toHaveBeenCalledWith(
        '没能注入示例消息：示例消息没能放进收件箱：服务繁忙',
      ),
    );
    expect(hoisted.toast.success).not.toHaveBeenCalled();
  });

  it('有更早的消息：会话列表下方显示「加载更早的消息」，点击调用 store.loadOlder', async () => {
    const { store } = await import('../../store');
    mockState({ messages: [MESSAGE], accounts: ACCOUNTS, hasOlder: true });
    renderInboxPage();

    const button = screen.getByRole('button', { name: /加载更早的消息/ });
    fireEvent.click(button);
    expect(store.loadOlder).toHaveBeenCalledTimes(1);
  });

  it('没有更早的消息（hasOlder=false）：不显示「加载更早的消息」', () => {
    mockState({ messages: [MESSAGE], accounts: ACCOUNTS, hasOlder: false });
    renderInboxPage();
    expect(screen.queryByRole('button', { name: /加载更早的消息/ })).not.toBeInTheDocument();
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
    mockState({ error: '无法连接 LinkHub 服务，请确认它还在运行' });
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

describe('微信按需拉取（4.x）', () => {
  it('群聊拉取会带 conversationType=group，不能默认按单聊入库', async () => {
    const { services } = await import('../../store');
    const user = userEvent.setup();
    mockState({
      messages: [],
      accounts: ACCOUNTS,
      filters: {
        keyword: '',
        onlyReview: false,
        onlyUnread: false,
        onlyUrgent: false,
        platform: Platform.WECHAT,
      },
    });
    renderInboxPage();

    await user.click(screen.getByRole('button', { name: /从微信拉取当前会话/ }));
    await user.type(screen.getByLabelText(/会话名/), '项目群');
    await user.type(screen.getByLabelText(/你的微信昵称/), '阿彬');
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByText('群聊'));
    await user.click(screen.getByRole('button', { name: '开始拉取' }));

    await vi.waitFor(() => {
      expect(services.api.wechatPull).toHaveBeenCalledWith({
        conversation: '项目群',
        conversationType: 'group',
        selfName: '阿彬',
      });
    });
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

  it('「未读 / 待处理 / 紧急 / 稍后处理」互斥：点一个会清掉其它几个，不叠加条件', async () => {
    const { store } = await import('../../store');
    mockState({ messages: [MESSAGE], accounts: ACCOUNTS });
    renderInboxPage();

    fireEvent.click(screen.getByRole('button', { name: '未读' }));
    // 互斥：开「未读」必须同时关掉其它几个，否则多个胶囊会一起高亮、条件也会叠成空结果
    expect(store.setFilters).toHaveBeenCalledWith({
      onlyUnread: true,
      onlyReview: false,
      onlyUrgent: false,
      onlySnoozed: false,
    });

    fireEvent.click(screen.getByRole('button', { name: '待处理' }));
    expect(store.setFilters).toHaveBeenCalledWith({
      onlyReview: true,
      onlyUnread: false,
      onlyUrgent: false,
      onlySnoozed: false,
    });

    fireEvent.click(screen.getByRole('button', { name: /^紧急/ }));
    expect(store.setFilters).toHaveBeenCalledWith({
      onlyUrgent: true,
      onlyUnread: false,
      onlyReview: false,
      onlySnoozed: false,
    });

    fireEvent.click(screen.getByRole('button', { name: /^稍后处理/ }));
    expect(store.setFilters).toHaveBeenCalledWith({
      onlySnoozed: true,
      onlyUnread: false,
      onlyReview: false,
      onlyUrgent: false,
    });
  });

  it('「紧急」筛选：只显示有紧急待处理消息的会话，并在列表行显示紧急徽标', async () => {
    const urgentPeer: UnifiedMessage = {
      ...MESSAGE,
      traceId: 't-urgent',
      externalId: 'e-urgent',
      direction: 'in',
      body: '这份合同今天必须确认',
      priority: 'urgent',
      prioritySource: 'manual',
      conversation: { id: 'c-urgent', type: 'p2p' },
      sender: { id: 'u-urgent', name: '郑友佳' },
    };
    const normalPeer: UnifiedMessage = {
      ...MESSAGE,
      traceId: 't-normal',
      externalId: 'e-normal',
      direction: 'in',
      body: '周报不急',
      conversation: { id: 'c-normal', type: 'p2p' },
      sender: { id: 'u-normal', name: '钉钉小王' },
    };
    mockState({
      messages: [urgentPeer, normalPeer],
      accounts: ACCOUNTS,
      filters: {
        keyword: '',
        onlyReview: false,
        onlyUnread: false,
        onlyUrgent: true,
        platform: undefined,
      },
    });
    renderInboxPage();

    // 紧急会话带「紧急置顶」语义的行；普通会话被筛掉
    expect(screen.getByRole('button', { name: /紧急置顶/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /钉钉小王/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('紧急').length).toBeGreaterThan(0);
  });

  it('紧急会话排在同组最前面（会话内置顶），其余仍按最近消息排序', async () => {
    const base = { ...MESSAGE, direction: 'in' as const };
    const urgentOld: UnifiedMessage = {
      ...base,
      traceId: 't-a',
      externalId: 'e-a',
      priority: 'urgent',
      conversation: { id: 'c-a', type: 'p2p' },
      sender: { id: 'u1', name: '紧急的人' },
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: '2026-11-20T00:00:00Z',
    };
    const freshNormal: UnifiedMessage = {
      ...base,
      traceId: 't-b',
      externalId: 'e-b',
      conversation: { id: 'c-b', type: 'p2p' },
      sender: { id: 'u2', name: '刚发消息的人' },
      createdAt: '2026-11-21T00:00:00Z',
      updatedAt: '2026-11-21T00:00:00Z',
    };
    mockState({ messages: [urgentOld, freshNormal], accounts: ACCOUNTS });
    renderInboxPage();

    const rows = [...document.querySelectorAll('.conv-row')];
    expect(rows[0]?.textContent).toContain('紧急的人');
    expect(rows[1]?.textContent).toContain('刚发消息的人');
  });
});
