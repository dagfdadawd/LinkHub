import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { DetailPanel } from './DetailPanel';
import { store } from '../../store';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';

const FAILED: UnifiedMessage = {
  traceId: 't-fail-1',
  platform: Platform.FEISHU,
  externalId: 'om_fail_1',
  sender: { id: 'u1', name: '张三' },
  type: 'text',
  body: '周五前交周报。',
  status: MsgStatus.FAILED,
  reply: '收到，周五前交。',
  failureReason: '飞书 tenant_access_token 获取失败: 10003 invalid param',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderPanel(message: UnifiedMessage = FAILED) {
  render(
    <MemoryRouter>
      <AntApp>
        <DetailPanel message={message} />
      </AntApp>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('DetailPanel 发送失败原因（P1-2）', () => {
  it('失败区域直接展示可读原因，不再只让用户去回放里翻', () => {
    renderPanel();
    expect(screen.getByText('发送失败（已写入死信队列）')).toBeInTheDocument();
    expect(screen.getByText(/原因：飞书 tenant_access_token 获取失败/)).toBeInTheDocument();
    expect(screen.getByTestId('retry-send')).toBeEnabled();
  });

  it('点「重试发送」用同一条回复内容重新提交，不要求用户改文案', async () => {
    const reply = vi.spyOn(store, 'reply').mockResolvedValue();
    renderPanel();

    fireEvent.click(screen.getByTestId('retry-send'));
    await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply).toHaveBeenCalledWith('t-fail-1', '收到，周五前交。');
  });

  it('没有可读原因时给回放兜底文案，并提供「查看闭环日志」入口', () => {
    renderPanel({ ...FAILED, failureReason: undefined });
    expect(screen.getByText(/暂未拿到可读原因/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /查看闭环日志/ })).toBeInTheDocument();
  });

  it('含附件的失败消息禁用重试，说明需要重新附加文件', () => {
    renderPanel({
      ...FAILED,
      attachments: [{ name: '周报.xlsx', mimeType: 'application/vnd.ms-excel', size: 1024 }],
    });
    expect(screen.getByTestId('retry-send')).toBeDisabled();
    expect(screen.getByText(/含附件的失败消息请在下方回复框重新附加文件/)).toBeInTheDocument();
  });

  it('没有回复内容的失败消息也不给无效重试', () => {
    renderPanel({ ...FAILED, reply: undefined });
    expect(screen.getByTestId('retry-send')).toBeDisabled();
    expect(screen.getByText('这条消息没有可重试的回复内容')).toBeInTheDocument();
  });
});