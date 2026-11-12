import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const hoisted = vi.hoisted(() => ({
  state: { messages: [] as unknown[], loading: false, demoMode: false, accounts: [], error: null },
  store: { getTrace: vi.fn(async () => ({ log: [] })) },
}));

vi.mock('../../hooks/useAppState', () => ({ useAppState: () => hoisted.state }));
vi.mock('../../store', () => ({ store: hoisted.store }));

import { TracePage, customerTraceDetail } from './TracePage';

afterEach(() => vi.restoreAllMocks());

function renderTrace() {
  render(
    <MemoryRouter initialEntries={['/trace']}>
      <AntApp>
        <Routes>
          <Route path="/trace" element={<TracePage />} />
          <Route path="/inbox" element={<div>收件箱占位</div>} />
          <Route path="/connect" element={<div>连接账号占位</div>} />
        </Routes>
      </AntApp>
    </MemoryRouter>,
  );
}

describe('TracePage 空态下一步（白号 P2-2）', () => {
  it('没有消息时给出「去收件箱选一条 / 连接账号」，不再是一句死文案', () => {
    renderTrace();
    expect(screen.getAllByText('选择一条消息').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '去收件箱选一条' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接账号' })).toBeInTheDocument();
  });

  it('点「去收件箱选一条」真的跳到收件箱', () => {
    renderTrace();
    fireEvent.click(screen.getByRole('button', { name: '去收件箱选一条' }));
    expect(screen.getByText('收件箱占位')).toBeInTheDocument();
  });
});
describe('customerTraceDetail（回放技术细节客户化 P2-7）', () => {
  it('`待办(0.92) via rules` → 规则识别（置信度 0.92）', () => {
    expect(customerTraceDetail('待办(0.92) via rules')).toBe('规则识别（置信度 0.92）');
    expect(customerTraceDetail('咨询(0.88) via llm')).toBe('AI 识别（置信度 0.88）');
  });

  it('其他技术词兜底：via rules / conversationId 中文化，未知内容原样返回', () => {
    expect(customerTraceDetail('意图 via rules')).toBe('意图（规则识别）');
    expect(customerTraceDetail('conversationId=oc_1')).toBe('会话 ID=oc_1');
    expect(customerTraceDetail('平台返回 10003')).toBe('平台返回 10003');
    expect(customerTraceDetail(undefined)).toBeUndefined();
  });
});

