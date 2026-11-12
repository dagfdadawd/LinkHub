import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageCard } from './MessageCard';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';

const message: UnifiedMessage = {
  traceId: 't-card-1',
  platform: Platform.FEISHU,
  externalId: 'e-1',
  sender: { id: 'u1', name: '张三' },
  type: 'text',
  body: '周五前交周报，重点写联调进展。',
  intent: '待办',
  status: MsgStatus.RECEIVED,
  needsReview: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('MessageCard', () => {
  it('渲染平台、状态、意图与需人工确认标记', () => {
    render(<MessageCard message={message} active={false} onSelect={() => {}} />);
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(screen.getByText('飞书')).toBeInTheDocument();
    expect(screen.getByText('已接收')).toBeInTheDocument();
    expect(screen.getByText('待办')).toBeInTheDocument();
    expect(screen.getByText('需人工确认')).toBeInTheDocument();
  });

  it('点击卡片回传 traceId', async () => {
    const onSelect = vi.fn();
    render(<MessageCard message={message} active={false} onSelect={onSelect} />);
    // 卡片本身是 role=button，行内快捷操作是它内部的按钮，这里按可访问名称定位卡片
    await userEvent.click(screen.getByRole('button', { name: /张三/ }));
    expect(onSelect).toHaveBeenCalledWith('t-card-1');
  });

  it('本人账号接收 + 本人发送：如实标注接收身份与发送身份', () => {
    render(
      <MessageCard
        message={{
          ...message,
          receivedAs: 'user',
          delivery: { mode: 'real', identity: 'user', platformReply: 'om_1', at: new Date().toISOString() },
        }}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('本人账号接收')).toBeInTheDocument();
    expect(screen.getByText('本人发送')).toBeInTheDocument();
  });

  it('机器人接收 + 机器人发送：标注机器人身份，不冒充本人', () => {
    render(
      <MessageCard
        message={{
          ...message,
          receivedAs: 'bot',
          delivery: { mode: 'real', identity: 'bot', at: new Date().toISOString() },
        }}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('机器人接收')).toBeInTheDocument();
    expect(screen.getByText('机器人发送')).toBeInTheDocument();
    expect(screen.queryByText('本人账号接收')).toBeNull();
  });

  it('Mock 回写：卡片标注「模拟发送」，绝不显示成本人真实发出', () => {
    render(
      <MessageCard
        message={{ ...message, delivery: { mode: 'mock', at: new Date().toISOString() } }}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('模拟发送')).toBeInTheDocument();
  });

  it('Mock 演示消息（无 receivedAs）：不显示接收身份，不冒充真实接收', () => {
    render(<MessageCard message={message} active={false} onSelect={() => {}} />);
    expect(screen.queryByText('本人账号接收')).toBeNull();
    expect(screen.queryByText('机器人接收')).toBeNull();
  });
});