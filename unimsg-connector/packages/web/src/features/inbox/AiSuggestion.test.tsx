import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
