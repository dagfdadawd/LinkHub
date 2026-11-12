import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { ComposeModal } from './ComposeModal';
import { Platform } from '../../types';
import { services, store } from '../../store';

function setup() {
  const compose = vi.spyOn(store, 'compose').mockResolvedValue('trace-compose-1');
  const onClose = vi.fn();
  render(
    <AntApp>
      <ComposeModal open onClose={onClose} />
    </AntApp>,
  );
  return { compose, onClose };
}

afterEach(() => vi.restoreAllMocks());

describe('ComposeModal（统一入口主动发送）', () => {
  it('可选平台/会话，提交文本并走 store.compose', async () => {
    const { compose } = setup();
    expect(screen.getByText('新建发送 · 向指定平台发送消息或文件')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('目标会话'), { target: { value: 'oc_demo_1' } });
    fireEvent.change(screen.getByLabelText('发送文本'), { target: { value: '请查收周报' } });
    expect(screen.getByTestId('compose-send')).toBeEnabled();
    fireEvent.click(screen.getByTestId('compose-send'));

    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).toMatchObject({
      platform: Platform.FEISHU,
      conversationId: 'oc_demo_1',
      text: '请查收周报',
    });
  });

  it('文本与附件都为空时禁止发送', () => {
    setup();
    expect(screen.getByTestId('compose-send')).toBeDisabled();
  });

  it('选邮箱平台时可切换发件邮箱，并随请求提交所选账号', async () => {
    // 测试环境可能指向真实后端；账号列表打桩，避免依赖本机服务
    vi.spyOn(services.api, 'accounts').mockResolvedValue([{
      platform: Platform.MAIL,
      configured: true,
      accounts: [
        { key: 'qq', label: 'QQ邮箱', address: 'me@qq.com', imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', folders: ['INBOX'] },
        { key: '163', label: '163邮箱', address: 'team@163.com', imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', folders: ['INBOX'] },
      ],
    }]);
    const { compose } = setup();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '目标平台' }));
    fireEvent.click(await screen.findByTitle('邮箱'));

    const mailSelect = await screen.findByRole('combobox', { name: '发件邮箱' });
    // 默认选中第一个已配置账号
    await screen.findByText('QQ邮箱（me@qq.com）');

    fireEvent.mouseDown(mailSelect);
    fireEvent.click(await screen.findByTitle('163邮箱（team@163.com）'));

    fireEvent.change(screen.getByLabelText('目标会话'), { target: { value: 'to@example.com' } });
    fireEvent.change(screen.getByLabelText('发送文本'), { target: { value: '请查收发件账号测试' } });
    fireEvent.click(screen.getByTestId('compose-send'));

    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).toMatchObject({
      platform: Platform.MAIL,
      conversationId: 'to@example.com',
      mailAccount: '163',
      text: '请查收发件账号测试',
    });
  });
});
