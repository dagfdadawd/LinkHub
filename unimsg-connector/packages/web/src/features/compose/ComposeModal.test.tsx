import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { ComposeModal } from './ComposeModal';
import { Platform } from '../../types';
import { store } from '../../store';

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
});
