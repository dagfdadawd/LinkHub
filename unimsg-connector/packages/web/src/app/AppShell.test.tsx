/**
 * 顶栏版式回归（本次产品要求固化，避免以后再改回去）：
 *  1. 「我」的头像放在侧栏顶部（原 LinkHub monogram 的位置），顶栏不再有头像；
 *  2. 搜索框在顶栏正中（标题 / 搜索 / 操作三段式）；
 *  3. 顶栏不再重复展示「实时连接」——左下角已有服务状态；
 *  4. 明暗切换紧挨在「新建发送」左侧，且「新建发送」是顶栏最右的操作。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ThemeProvider } from './ThemeProvider';
import { resetSessionForTest, setSession } from '../services/session';

const hoisted = vi.hoisted(() => ({
  state: {
    messages: [],
    loading: false,
    error: null,
    filters: { keyword: '', onlyReview: false, onlyUnread: false },
    accounts: [],
    health: null,
    connection: 'connected',
    demoMode: false,
    initialized: true,
    sendFailure: null,
    onboarding: null,
    appConfig: null,
  },
}));

// 隔离全局 store 单例（真实 store 会创建 WebSocket）；AppShell 关闭态只渲染外壳，不需要真实数据。
vi.mock('../hooks/useAppState', () => ({
  useAppState: () => hoisted.state,
}));

vi.mock('../store', () => ({
  store: {
    getSnapshot: () => ({ messages: [], accounts: [] }),
    dismissSendFailure: vi.fn(),
    dismissError: vi.fn(),
    resetFilters: vi.fn(),
    simulateIncoming: vi.fn(),
    armFailure: vi.fn(),
  },
}));

function renderShell() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/inbox" element={<div>inbox-content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('AppShell 顶栏布局', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSessionForTest();
  });

  it('「我」头像占据侧栏顶部，顶栏不再有个人入口', () => {
    const { container } = renderShell();
    const sideBrand = container.querySelector('.side__brand');
    expect(sideBrand).not.toBeNull();

    const avatar = within(sideBrand as HTMLElement).getByRole('button', { name: '打开个人设置' });
    expect(avatar).toBeInTheDocument();
    expect(within(sideBrand as HTMLElement).getByText('LinkHub')).toBeInTheDocument();

    const cmdbar = container.querySelector('.cmdbar') as HTMLElement;
    expect(within(cmdbar).queryByRole('button', { name: '打开个人设置' })).toBeNull();
  });

  it('三段式结构：标题 → 居中搜索 → 右侧操作', () => {
    const { container } = renderShell();
    const cmdbar = container.querySelector('.cmdbar') as HTMLElement;
    const sections = Array.from(cmdbar.children).map((el) => el.className);
    expect(sections).toEqual(['cmdbar__lead', 'cmdbar__search', 'cmdbar__actions']);

    const search = within(cmdbar).getByRole('button', { name: '打开命令面板' });
    expect(search.parentElement).toHaveClass('cmdbar__search');
  });

  it('顶栏不再重复展示「实时连接」：状态只在左下角服务状态里', () => {
    const { container } = renderShell();
    const cmdbar = container.querySelector('.cmdbar') as HTMLElement;
    expect(within(cmdbar).queryByText(/实时连接/)).toBeNull();
    expect(cmdbar.querySelector('.connection-dot')).toBeNull();

    expect(container.querySelector('.side-status')).not.toBeNull();
  });

  it('明暗切换在「新建发送」左侧，新建发送是顶栏最右操作', () => {
    const { container } = renderShell();
    const actions = container.querySelector('.cmdbar__actions') as HTMLElement;
    const buttons = within(actions).getAllByRole('button');
    expect(buttons.map((el) => el.getAttribute('aria-label'))).toEqual([
      '切换明暗主题',
      '新建发送',
    ]);
  });
});

describe('侧栏账号菜单（多开）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSessionForTest();
  });

  const person = (id: string, username: string, displayName: string) => ({
    id,
    username,
    displayName,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('本机两个账号都列在菜单里，当前账号打勾、另一个可点', () => {
    setSession({ token: 'token-a', user: person('u1', 'alice', '爱丽丝') });
    setSession({ token: 'token-b', user: person('u2', 'bob', '鲍勃') });
    renderShell();

    fireEvent.click(screen.getByTestId('account-menu-trigger'));

    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.getByText('@bob')).toBeInTheDocument();
    // 当前是最后登录的 bob
    expect(screen.getByTestId('acct-row-bob')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('acct-row-alice')).not.toHaveAttribute('aria-current');
    // 菜单里直接给出「再加一个」的入口
    expect(screen.getByText('添加账号')).toBeInTheDocument();
    expect(screen.getByText('退出当前账号')).toBeInTheDocument();
  });

  it('只有一个账号时不显示「+N」角标，多于一个才显示', () => {
    setSession({ token: 'token-a', user: person('u1', 'alice', '爱丽丝') });
    const first = renderShell();
    expect(first.container.querySelector('.side-account__more')).toBeNull();
    first.unmount();

    setSession({ token: 'token-b', user: person('u2', 'bob', '鲍勃') });
    const second = renderShell();
    expect(second.container.querySelector('.side-account__more')?.textContent).toBe('+1');
  });
});
