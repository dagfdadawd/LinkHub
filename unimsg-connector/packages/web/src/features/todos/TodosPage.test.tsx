import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';

const hoisted = vi.hoisted(() => ({
  store: { simulateIncoming: vi.fn(async () => {}), markDone: vi.fn(async () => {}) },
  state: { messages: [] as unknown[], loading: false, demoMode: true, accounts: [], error: null },
}));

vi.mock('../../hooks/useAppState', () => ({ useAppState: () => hoisted.state }));
vi.mock('../../store', () => ({ store: hoisted.store }));

import { TodosPage } from './TodosPage';

afterEach(() => vi.restoreAllMocks());

describe('TodosPage 空态下一步（白号 P2-2）', () => {
  it('空态给出「去收件箱 / 注入示例消息 / 连接账号」三个可执行入口', () => {
    render(
      <MemoryRouter>
        <AntApp>
          <TodosPage />
        </AntApp>
      </MemoryRouter>,
    );

    expect(screen.getByText('暂无待办')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去收件箱' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注入示例消息' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接账号' })).toBeInTheDocument();
  });

  it('演示模式下点「注入示例消息」走本地模拟，不假装调用真实平台', async () => {
    render(
      <MemoryRouter>
        <AntApp>
          <TodosPage />
        </AntApp>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '注入示例消息' }));
    expect(hoisted.store.simulateIncoming).toHaveBeenCalledTimes(1);
  });
});