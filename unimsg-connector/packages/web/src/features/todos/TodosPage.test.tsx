import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';

const hoisted = vi.hoisted(() => ({
  store: { simulateIncoming: vi.fn(async () => {}), markDone: vi.fn(async () => {}) },
  state: {
    messages: [] as unknown[],
    loading: false,
    demoMode: true,
    accounts: [],
    error: null,
  },
}));

vi.mock('../../hooks/useAppState', () => ({ useAppState: () => hoisted.state }));
vi.mock('../../store', () => ({ store: hoisted.store }));

import { TodosPage } from './TodosPage';

afterEach(() => {
  hoisted.state.messages.splice(0, hoisted.state.messages.length);
  vi.restoreAllMocks();
});

/** 渲染待办页（最小路由 + antd App 上下文，与页面真实挂载方式一致） */
function renderPage() {
  render(
    <MemoryRouter>
      <AntApp>
        <TodosPage />
      </AntApp>
    </MemoryRouter>,
  );
}

describe('TodosPage 空态下一步（白号 P2-2）', () => {
  it('空态给出「去收件箱 / 注入示例消息 / 连接账号」三个可执行入口', () => {
    renderPage();

    expect(screen.getByText('暂无待办')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去收件箱' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注入示例消息' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接账号' })).toBeInTheDocument();
  });

  it('演示模式下点「注入示例消息」走本地模拟，不假装调用真实平台', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '注入示例消息' }));
    expect(hoisted.store.simulateIncoming).toHaveBeenCalledTimes(1);
  });
});

describe('TodosPage 手动添加的待办（新建发送时勾选「同时加为待办」）', () => {
  const manualTodo = {
    traceId: 't-manual-todo',
    platform: 'feishu',
    externalId: 'compose:t-manual-todo',
    sender: { id: 'linkhub', name: 'LinkHub 统一入口' },
    conversation: { id: 'oc_demo_1', type: 'p2p' },
    type: 'todo',
    done: false,
    direction: 'out',
    body: '明天把周报发我',
    todoTitle: '跟进周报',
    dueAt: '2026-11-20T10:00:00.000Z',
    status: 'synced',
    createdAt: '2026-11-13T08:00:00.000Z',
    updatedAt: '2026-11-13T08:00:01.000Z',
  };

  it('优先展示手填待办标题；发起人是自己时显示「我发起」而不是内部发送者名', () => {
    hoisted.state.messages.splice(0, hoisted.state.messages.length, manualTodo);
    renderPage();

    expect(screen.getByText('跟进周报')).toBeInTheDocument();
    expect(screen.getByText('我发起')).toBeInTheDocument();
    // 手动加的待办有明确来源标识，不和自动识别的混淆
    expect(screen.getByText('手动添加')).toBeInTheDocument();
    // 「LinkHub 统一入口」是实现细节，待办清单里不该出现
    expect(screen.queryByText('LinkHub 统一入口')).toBeNull();
    // 正文不被标题覆盖：详情里仍看得到原话
    expect(screen.queryByText('明天把周报发我')).toBeNull();
    // 截止时间如实展示（具体文案由 formatDue 生成，只断言卡片存在截止元素）
    expect(document.querySelector('.todo-card__due')).not.toBeNull();
  });

  it('没有手填标题时回退消息正文；普通收到的待办仍显示原发送人', () => {
    hoisted.state.messages.splice(
      0,
      hoisted.state.messages.length,
      { ...manualTodo, traceId: 't-manual-2', todoTitle: undefined },
      {
        ...manualTodo,
        traceId: 't-inbound',
        externalId: 'om_inbound',
        sender: { id: 'u1', name: '张三' },
        direction: 'in',
        body: '周报下午发你',
        todoTitle: undefined,
        dueAt: undefined,
      },
    );
    renderPage();

    expect(screen.getByText('明天把周报发我')).toBeInTheDocument();
    expect(screen.getByText('周报下午发你')).toBeInTheDocument();
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(screen.getAllByText('我发起')).toHaveLength(1);
  });
});