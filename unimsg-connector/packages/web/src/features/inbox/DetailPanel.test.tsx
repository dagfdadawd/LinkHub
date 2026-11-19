import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { DetailPanel } from './DetailPanel';
import { store } from '../../store';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';

// 保存文件会碰 URL.createObjectURL / a.click，jsdom 里没有完整实现；
// 这里只验证「下载按钮 → 调后端」这一段，保存动作本身由 download.test 覆盖。
vi.mock('../../utils/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/download')>();
  return { ...actual, saveBlobAsFile: vi.fn() };
});

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

describe('DetailPanel 重新生成 AI 建议', () => {
  it('点「重新生成」真调后端，不再只弹一句提示', async () => {
    const reanalyze = vi.spyOn(store, 'reanalyze').mockResolvedValue({
      message: {
        ...FAILED,
        intent: '待办',
        intentSource: 'llm',
        aiProvider: '火山方舟',
        aiModel: 'doubao-seed-1-6-250615',
        replyDraft: '收到，周五前发你。',
      },
      llm: { mode: 'real', reason: '真实大模型已就绪', providerLabel: '火山方舟' },
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }));

    await waitFor(() => expect(reanalyze).toHaveBeenCalledWith('t-fail-1'));
    // 成功时结果已在 AI 面板就地更新：不额外弹 toast（右下浮层会挡住发送按钮）
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(document.querySelector('.ant-message-notice')).toBeNull();
  });

  it('低精度结果仍就地更新：不弹 toast、不误报规则兜底', async () => {
    const reanalyze = vi.spyOn(store, 'reanalyze').mockResolvedValue({
      message: {
        ...FAILED,
        intent: '未分类', intentSource: 'llm', aiProvider: '火山方舟',
        aiPrecision: 'low', aiConfidence: 0.3, replyDraft: '请问您具体需要什么？',
      },
      llm: {
        mode: 'real', reason: '真实模型已生成建议，但信息量较少（把握 0.3），草稿偏简短、精度较低，未回退规则',
        providerLabel: '火山方舟', precision: 'low', confidence: 0.3,
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }));

    await waitFor(() => expect(reanalyze).toHaveBeenCalledWith('t-fail-1'));
    // 低精度也是真实模型结果：面板里有常驻精度说明，无需（也不该）再弹浮层
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(document.querySelector('.ant-message-notice')).toBeNull();
    expect(screen.queryByText(/仍由关键词规则生成/)).not.toBeInTheDocument();
  });

  it('重新分析仍走规则时把后端原因如实展示，不假装成功', async () => {
    vi.spyOn(store, 'reanalyze').mockResolvedValue({
      message: { ...FAILED, intent: '未分类', intentSource: 'rules', replyDraft: '收到。' },
      llm: { mode: 'mock', reason: '缺少 LLM_API_KEY，已降级为规则识别', providerLabel: 'MiMo' },
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }));

    expect(await screen.findByText(/仍由关键词规则生成/)).toBeInTheDocument();
  });
});

describe('DetailPanel 附件下载', () => {
  it('有平台资源引用的附件显示下载按钮，点击调后端（本人发来的文件也可下载）', async () => {
    const download = vi.spyOn(store, 'downloadAttachment').mockResolvedValue({
      blob: new Blob(['%PDF'], { type: 'application/pdf' }),
      filename: '周报.pdf',
    });
    renderPanel({
      ...FAILED,
      status: MsgStatus.RECEIVED,
      attachments: [{
        name: '周报.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        fileId: 'file-123',
        resourceType: 'file',
      }],
    });

    const button = screen.getByTestId('download-attachment-attachments-0');
    expect(button).toHaveTextContent('下载');
    fireEvent.click(button);

    await waitFor(() => expect(download).toHaveBeenCalledWith('t-fail-1', 0, 'attachments'));
  });

  it('只有元数据、没有平台资源引用的附件不显示假下载按钮', () => {
    renderPanel({
      ...FAILED,
      status: MsgStatus.RECEIVED,
      attachments: [{ name: '本地文件.pdf', mimeType: 'application/pdf', size: 1024 }],
    });
    expect(screen.queryByRole('button', { name: /下载 本地文件\.pdf/ })).toBeNull();
  });
});