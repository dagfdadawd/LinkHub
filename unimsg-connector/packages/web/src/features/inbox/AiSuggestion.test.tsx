import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AiSuggestion } from './AiSuggestion';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';

function msg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    traceId: 't-ai-1',
    platform: Platform.DINGTALK,
    externalId: 'e-1',
    sender: { id: 'u1', name: '张三' },
    type: 'text',
    body: '周五前交 Q3 复盘材料',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setup(overrides: Partial<UnifiedMessage> = {}) {
  render(
    <AiSuggestion
      message={msg(overrides)}
      onUseDraft={vi.fn()}
      onRegenerate={vi.fn()}
    />,
  );
}

describe('AiSuggestion 识别来源标注', () => {
  it('真实大模型识别时标注 MiMo', () => {
    setup({ intent: '待办', replyDraft: '收到，周五前发你。', intentSource: 'llm' });
    expect(screen.getByText(/MiMo/)).toBeInTheDocument();
  });

  it('规则兜底时标注「规则兜底」，不冒充大模型', () => {
    setup({ intent: '待办', replyDraft: '收到。', intentSource: 'rules' });
    expect(screen.getByText('规则兜底')).toBeInTheDocument();
    expect(screen.queryByText(/MiMo/)).not.toBeInTheDocument();
  });

  it('意图尚未返回时显示分析中，不显示来源标注', () => {
    setup({});
    expect(screen.getByText('分析中…')).toBeInTheDocument();
    expect(screen.queryByText(/MiMo/)).not.toBeInTheDocument();
    expect(screen.queryByText('规则兜底')).not.toBeInTheDocument();
  });

  it('旧数据没有 intentSource 时不显示来源标注', () => {
    setup({ intent: '待办', replyDraft: '收到。' });
    expect(screen.queryByText(/MiMo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/规则兜底/)).not.toBeInTheDocument();
  });
});

describe('AiSuggestion 三标签面板（消息分析 / 智能回复 / 快捷工具）', () => {
  it('默认停在「消息分析」，切到「智能回复」显示草稿与操作', () => {
    render(
      <AiSuggestion
        message={msg({ intent: '待办', replyDraft: '收到，周五前发你。', intentSource: 'rules' })}
        onUseDraft={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );

    const analyze = screen.getByRole('tab', { name: '消息分析' });
    expect(analyze).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: '智能回复' }));
    expect(screen.getByRole('tab', { name: '智能回复' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('收到，周五前发你。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /采用草稿/ })).toBeInTheDocument();
  });

  it('快捷工具里每个按钮都挂真实回调（不是只有外观）', () => {
    const onCopyBody = vi.fn();
    const onMarkRead = vi.fn();
    const onTrace = vi.fn();
    render(
      <AiSuggestion
        message={msg({ intent: '待办', replyDraft: '收到。' })}
        onUseDraft={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyBody={onCopyBody}
        onMarkRead={onMarkRead}
        onTrace={onTrace}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '快捷工具' }));
    fireEvent.click(screen.getByRole('button', { name: /复制消息内容/ }));
    fireEvent.click(screen.getByRole('button', { name: /标为已读/ }));
    fireEvent.click(screen.getByRole('button', { name: /全链路回放/ }));

    expect(onCopyBody).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onTrace).toHaveBeenCalledTimes(1);
  });

  it('没有注入回调时不渲染假按钮', () => {
    setup({ intent: '待办', replyDraft: '收到。' });
    fireEvent.click(screen.getByRole('tab', { name: '快捷工具' }));
    expect(screen.queryByRole('button', { name: /复制消息内容/ })).not.toBeInTheDocument();
    expect(screen.getByText('当前无可用的消息操作。')).toBeInTheDocument();
  });
});
