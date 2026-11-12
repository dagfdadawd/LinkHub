/**
 * 顶栏版式回归（本次产品要求固化，避免以后再改回去）：
 *  1. 「我」的头像放在侧栏顶部（原 LinkHub monogram 的位置），顶栏不再有头像；
 *  2. 搜索框在顶栏正中（标题 / 搜索 / 操作三段式）；
 *  3. 顶栏不再重复展示「实时连接」——左下角已有服务状态；
 *  4. 明暗切换紧挨在「新建发送」左侧，且「新建发送」是顶栏最右的操作。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ThemeProvider } from './ThemeProvider';
import { DEFAULT_PROFILE } from '../features/settings/profile';

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
  });

  it('「我」头像占据侧栏顶部，顶栏不再有个人入口', () => {
    const { container } = renderShell();
    const railBrand = container.querySelector('.rail__brand');
    expect(railBrand).not.toBeNull();

    const avatar = within(railBrand as HTMLElement).getByRole('button', { name: '打开个人设置' });
    expect(avatar).toBeInTheDocument();
    expect(within(railBrand as HTMLElement).getByText(DEFAULT_PROFILE.name)).toBeInTheDocument();

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

    expect(container.querySelector('.rail-status')).not.toBeNull();
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