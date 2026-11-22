import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReplyComposer } from './ReplyComposer';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';
import { resetTemplates } from '../settings/templates';

const message: UnifiedMessage = {
  traceId: 't-composer-1',
  platform: Platform.FEISHU,
  externalId: 'e-1',
  sender: { id: 'u1', name: '张三' },
  type: 'text',
  body: '周五前交周报',
  status: MsgStatus.RECEIVED,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function setup(
  overrides: {
    value?: string;
    sending?: boolean;
    sendDisabled?: boolean;
    message?: Partial<UnifiedMessage>;
  } = {},
) {
  const onSend = vi.fn();
  const onChange = vi.fn();
  render(
    <ReplyComposer
      message={{ ...message, ...overrides.message }}
      value={overrides.value ?? ''}
      sending={overrides.sending ?? false}
      sendDisabled={overrides.sendDisabled ?? false}
      onChange={onChange}
      onSend={onSend}
    />,
  );
  return { onSend, onChange, textarea: screen.getByRole('textbox') as HTMLTextAreaElement };
}

describe('ReplyComposer', () => {
  it('空内容时发送按钮禁用，Ctrl+Enter 不触发', () => {
    const { onSend, textarea } = setup();
    expect(screen.getByTestId('send-reply')).toBeDisabled();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('非空内容按 Ctrl+Enter 触发发送', () => {
    const { onSend, textarea } = setup({ value: '收到，我确认一下' });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('普通 Enter 不发送（避免误触换行提交）', () => {
    const { onSend, textarea } = setup({ value: '收到' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sending 中禁用发送，防止重复提交', () => {
    const { onSend, textarea } = setup({ value: '收到', sending: true });
    expect(screen.getByTestId('send-reply')).toBeDisabled();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('发送成功后的冷却期（sendDisabled）禁止再次发送，防止手滑重复（P2-2）', () => {
    const { onSend, textarea } = setup({ value: '收到', sendDisabled: true });
    expect(screen.getByTestId('send-reply')).toBeDisabled();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('不再渲染「按平台格式转换」这类解释文案，只保留输入区与发送按钮', () => {
    const { textarea } = setup({ value: '收到' });
    expect(screen.queryByText(/格式转换/)).not.toBeInTheDocument();
    expect(textarea.placeholder).toContain('输入回复内容');
  });

  it('未回写的消息：发送按钮为明亮待发态', () => {
    setup({ value: '收到' });
    const btn = screen.getByTestId('send-reply');
    expect(btn).toHaveClass('ripple-btn--ready');
    expect(btn).toHaveAttribute('data-send-state', 'ready');
  });

  it('回写成功后按钮切换为暗色已发态（replied / sent / synced 同理）', () => {
    for (const status of [MsgStatus.REPLIED, MsgStatus.SENT, MsgStatus.SYNCED]) {
      const { unmount } = render(
        <ReplyComposer
          message={{ ...message, status, reply: '已收到，马上处理' }}
          value="收到"
          sending={false}
          onChange={vi.fn()}
          onSend={vi.fn()}
        />,
      );
      const btn = screen.getByTestId('send-reply');
      expect(btn).toHaveClass('ripple-btn--sent');
      expect(btn).toHaveAttribute('data-send-state', 'sent');
      unmount();
    }
  });

  it('状态滞后但已有回写内容时也判定为已发送（不依赖 WS 推送）', () => {
    setup({
      value: '收到',
      message: { status: MsgStatus.RECEIVED, reply: '落库已有回复' },
    });
    expect(screen.getByTestId('send-reply')).toHaveClass('ripple-btn--sent');
  });

  it('进死信队列时保持明亮态，提示可修改后重试', () => {
    setup({
      value: '再试一次',
      message: { status: MsgStatus.FAILED, reply: '上次失败的内容' },
    });
    expect(screen.getByTestId('send-reply')).toHaveClass('ripple-btn--ready');
  });

  it('模板菜单：点击模板把 {对方称呼} 替换成发送人并追加到输入框（评审 P1-5）', () => {
    resetTemplates();
    const { onChange } = setup({ value: '' });
    fireEvent.click(screen.getByLabelText('插入快捷回复模板'));
    // 默认第一条「收到」没有变量；直接点第二项验证替换
    fireEvent.click(screen.getByText('应承'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const inserted = onChange.mock.calls[0][0] as string;
    expect(inserted).toContain('好的，没问题，张三。');
    expect(inserted).not.toContain('{对方称呼}');
  });

  it('模板追加到已有内容时先换行，不把两句话黏在一起', () => {
    resetTemplates();
    const { onChange } = setup({ value: '先说结论：' });
    fireEvent.click(screen.getByLabelText('插入快捷回复模板'));
    fireEvent.click(screen.getByText('收到'));
    const inserted = onChange.mock.calls[0][0] as string;
    expect(inserted).toBe('先说结论：\n收到，我看一下，稍后回复你。');
  });

  it('粘贴文件直接进附件（评审 P2-12）；无文件的粘贴不拦截', async () => {
    const { textarea } = setup();
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], '截屏.png', { type: 'image/png' });
    fireEvent.paste(textarea, { clipboardData: { files: [png] } });
    expect(await screen.findByText(/截屏\.png/)).toBeInTheDocument();

    // 纯文本粘贴：不进附件、不拦截默认行为
    fireEvent.paste(textarea, { clipboardData: { files: [] } });
    expect(screen.getAllByText(/截屏\.png/)).toHaveLength(1);
  });
});
