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

function setup(overrides: Partial<UnifiedMessage> = {}, regenerating = false) {
  const onRegenerate = vi.fn();
  render(
    <AiSuggestion
      message={msg(overrides)}
      onUseDraft={vi.fn()}
      onRegenerate={onRegenerate}
      regenerating={regenerating}
    />,
  );
  return { onRegenerate };
}

describe('AiSuggestion 识别来源标注', () => {
  it('真实大模型识别时按消息记录的厂商标注，不写死厂商名', () => {
    setup({
      intent: '待办', replyDraft: '收到，周五前发你。', intentSource: 'llm',
      aiProvider: 'MiMo', aiModel: 'mimo-v2.6-flash',
    });
    expect(screen.getByText('MiMo 识别')).toBeInTheDocument();
  });

  it('换成火山方舟后标签随之变化，不再冒充 MiMo', () => {
    setup({
      intent: '待办', replyDraft: '收到。', intentSource: 'llm',
      aiProvider: '火山方舟', aiModel: 'doubao-seed-1-6-250615',
    });
    expect(screen.getByText('火山方舟 识别')).toBeInTheDocument();
    expect(screen.queryByText(/MiMo/)).not.toBeInTheDocument();
  });

  it('旧数据没有厂商记录时只说「大模型识别」，不冒充具体厂商', () => {
    setup({ intent: '待办', replyDraft: '收到。', intentSource: 'llm' });
    expect(screen.getByText('大模型识别')).toBeInTheDocument();
    expect(screen.queryByText(/MiMo/)).not.toBeInTheDocument();
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

describe('AiSuggestion 低精度结果（信息量不足但不回退规则）', () => {
  it('仍标注真实模型，展示低精度提示，不写成规则兜底', () => {
    setup({
      intent: '未分类', replyDraft: '请问您具体需要什么？', intentSource: 'llm',
      aiProvider: '火山方舟', aiConfidence: 0.3, aiPrecision: 'low',
    });
    expect(screen.getByText('火山方舟 识别')).toBeInTheDocument();
    expect(screen.getByText(/信息量较少 · 模型把握 30%/)).toBeInTheDocument();
    expect(screen.getByText('信息不足，模型暂未归类')).toBeInTheDocument();
    expect(screen.queryByText('规则兜底')).not.toBeInTheDocument();
    expect(screen.queryByText('未识别，已回退未分类')).not.toBeInTheDocument();
  });

  it('高精度结果不显示低精度提示', () => {
    setup({
      intent: '待办', replyDraft: '收到。', intentSource: 'llm',
      aiConfidence: 0.98, aiPrecision: 'high',
    });
    expect(screen.queryByText(/信息量较少/)).not.toBeInTheDocument();
  });
});

describe('AiSuggestion 重新生成', () => {
  it('点击「重新生成」触发回调（不再只是弹提示）', () => {
    const { onRegenerate } = setup({ intent: '待办', intentSource: 'rules' });
    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('重新分析进行中按钮禁用，避免连点重复调用模型', () => {
    setup({ intent: '待办', intentSource: 'rules' }, true);
    const btn = screen.getByRole('button', { name: /重新生成/ });
    expect(btn).toBeDisabled();
  });
});
