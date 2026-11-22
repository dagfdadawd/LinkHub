import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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


describe('大群聊渲染窗口（几千条消息不能一次全铺）', () => {
  function threadOf(count: number): UnifiedMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      ...FAILED,
      traceId: `t-w-${i}`,
      externalId: `om_w_${i}`,
      body: `第 ${i} 条消息`,
      status: MsgStatus.RECEIVED,
      failureReason: undefined,
      reply: undefined,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
    }));
  }

  function renderThread(thread: UnifiedMessage[]) {
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={thread[thread.length - 1]} thread={thread} />
        </AntApp>
      </MemoryRouter>,
    );
  }

  it('默认只渲染最近 150 条，并提示还有多少条更早的消息', () => {
    renderThread(threadOf(400));

    expect(screen.getByText(/查看更早的消息（还有 250 条）/)).toBeInTheDocument();
    expect(screen.getByText('第 399 条消息')).toBeInTheDocument();
    // 最早的消息没有进入 DOM（数据还在，只是没渲染）
    expect(screen.queryByText('第 0 条消息')).not.toBeInTheDocument();
  });

  it('点「查看更早的消息」按整页展开，已渲染的内容不丢', () => {
    renderThread(threadOf(400));

    fireEvent.click(screen.getByRole('button', { name: /查看更早的消息/ }));

    // 400 - 300 = 100 条仍在窗口外
    expect(screen.getByText(/查看更早的消息（还有 100 条）/)).toBeInTheDocument();
    expect(screen.getByText('第 100 条消息')).toBeInTheDocument();
    expect(screen.getByText('第 399 条消息')).toBeInTheDocument();
  });

  it('深链/搜索打开窗口外的旧消息：锚点自动进入窗口，不能被窗口藏掉', () => {
    const thread = threadOf(400);
    // 锚点是最早那条：全量渲染时代它一定可见，窗口化后也必须可见
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={thread[0]} thread={thread} />
        </AntApp>
      </MemoryRouter>,
    );

    expect(screen.getByText('第 0 条消息')).toBeInTheDocument();
    expect(screen.getByText('第 399 条消息')).toBeInTheDocument();
    expect(screen.queryByText(/查看更早的消息/)).not.toBeInTheDocument();
  });
});

describe('引用回复：默认普通发送，显式引用才有引用条', () => {
  const inbound: UnifiedMessage = {
    ...FAILED,
    traceId: 't-in-1',
    body: '请问你想约什么时间？',
    status: MsgStatus.RECEIVED,
    failureReason: undefined,
    reply: undefined,
    createdAt: '2026-11-19T02:00:00.000Z',
    updatedAt: '2026-11-19T02:00:00.000Z',
  };

  it('不点「回复」直接发送：不带 quoteTraceId（普通消息）', async () => {
    const reply = vi.spyOn(store, 'reply').mockResolvedValue();
    renderPanel(inbound);

    fireEvent.change(screen.getByPlaceholderText(/输入回复内容/), { target: { value: '好的' } });
    fireEvent.click(screen.getByTestId('send-reply'));

    await waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0][4]).toBeUndefined();
  });

  it('点消息上的「回复」→ 出现引用条，发送时带上 quoteTraceId', async () => {
    const reply = vi.spyOn(store, 'reply').mockResolvedValue();
    renderPanel(inbound);

    fireEvent.click(screen.getByLabelText('回复这条消息'));
    const chip = await screen.findByTestId('quote-chip');
    expect(chip).toHaveTextContent('请问你想约什么时间');

    fireEvent.change(screen.getByPlaceholderText(/输入回复内容/), { target: { value: '周六下午' } });
    fireEvent.click(screen.getByTestId('send-reply'));

    await waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0][4]).toBe('t-in-1');
  });

  it('发出的气泡里出现引用块', () => {
    const target: UnifiedMessage = {
      ...inbound,
      status: MsgStatus.SYNCED,
      reply: '周六下午',
      replies: [
        {
          text: '周六下午',
          at: '2026-11-19T02:05:00.000Z',
          quote: { text: '请问你想约什么时间？', senderName: '郑乐斌' },
        },
      ],
    };
    renderPanel(target);

    const block = screen.getByTestId('quoted-block');
    expect(block).toHaveTextContent('郑乐斌');
    expect(block).toHaveTextContent('请问你想约什么时间');
  });
});

describe('发文件的消息不能是空气泡', () => {
  it('纯附件回复（没有正文）要把文件名画出来', () => {
    const target: UnifiedMessage = {
      ...FAILED,
      traceId: 't-file',
      body: '原始消息',
      status: MsgStatus.SYNCED,
      failureReason: undefined,
      reply: '',
      replies: [
        { text: '', at: '2026-11-19T02:00:00.000Z', attachments: [{ name: '季度报表.xlsx', size: 2048 } as never] },
      ],
      createdAt: '2026-11-19T01:59:00.000Z',
      updatedAt: '2026-11-19T02:00:00.000Z',
    };
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={target} thread={[target]} />
        </AntApp>
      </MemoryRouter>,
    );

    const bubbles = [...document.querySelectorAll('.bubble--out')];
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].textContent).toContain('季度报表.xlsx');
    expect(bubbles[0].textContent).not.toBe('');
  });

  it('正文和附件都没有时给出占位，不留空气泡', () => {
    const target: UnifiedMessage = {
      ...FAILED,
      traceId: 't-empty',
      body: '原始消息',
      status: MsgStatus.SYNCED,
      failureReason: undefined,
      reply: '',
      replies: [{ text: '', at: '2026-11-19T02:00:00.000Z' }],
      createdAt: '2026-11-19T01:59:00.000Z',
      updatedAt: '2026-11-19T02:00:00.000Z',
    };
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={target} thread={[target]} />
        </AntApp>
      </MemoryRouter>,
    );

    expect(document.querySelector('.bubble--out')?.textContent).toContain('（空内容）');
  });
});

describe('重复发送同一条内容：每条都要保留', () => {
  it('replies 里有两条相同文本 → 对话框里出现两个气泡', () => {
    const at = '2026-11-19T01:00:00.000Z';
    const target: UnifiedMessage = {
      ...FAILED,
      traceId: 't-dup',
      body: '原始消息',
      status: MsgStatus.REPLIED,
      failureReason: undefined,
      reply: '收到。',
      replies: [
        { text: '收到。', at },
        { text: '收到。', at: '2026-11-19T01:00:30.000Z' },
      ],
      createdAt: '2026-11-19T00:59:00.000Z',
      updatedAt: '2026-11-19T01:00:30.000Z',
    };
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={target} thread={[target]} />
        </AntApp>
      </MemoryRouter>,
    );

    const texts = [...document.querySelectorAll('.message-body')].map((el) => el.textContent);
    expect(texts.filter((t) => t === '收到。')).toHaveLength(2);
  });
});

describe('线程顺序：回复必须按发生时间排，而不是粘在旧消息下面', () => {
  it('11-12 收到的消息、11-15 又来一条、11-18 才回复 → 回复排最后', () => {
    const older: UnifiedMessage = {
      ...FAILED,
      traceId: 't-old',
      body: '老消息',
      status: MsgStatus.RECEIVED,
      failureReason: undefined,
      reply: '收到。',
      createdAt: '2026-11-12T10:36:00.000Z',
      updatedAt: '2026-11-18T22:30:00.000Z',
    };
    const newer: UnifiedMessage = {
      ...FAILED,
      traceId: 't-new',
      body: '后来的消息',
      status: MsgStatus.RECEIVED,
      failureReason: undefined,
      reply: undefined,
      createdAt: '2026-11-15T09:00:00.000Z',
      updatedAt: '2026-11-15T09:00:00.000Z',
    };
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={older} thread={[older, newer]} />
        </AntApp>
      </MemoryRouter>,
    );

    const texts = [...document.querySelectorAll('.message-body')].map((el) => el.textContent);
    expect(texts).toEqual(['老消息', '后来的消息', '收到。']);
  });
});

describe('发送中的回复气泡（不能让用户以为消息没发出去）', () => {
  it('点发送立刻上屏「发送中…」，成功后移除 pending 气泡', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((r) => { resolve = r; });
    vi.spyOn(store, 'reply').mockReturnValue(pending as Promise<void>);
    renderPanel({ ...FAILED, status: MsgStatus.RECEIVED, reply: undefined, failureReason: undefined });

    fireEvent.change(screen.getByPlaceholderText(/输入回复内容/), { target: { value: '这条应该立刻出现' } });
    fireEvent.click(screen.getByTestId('send-reply'));

    const bubble = await screen.findByTestId('pending-reply');
    expect(bubble).toHaveTextContent('这条应该立刻出现');
    expect(bubble).toHaveTextContent('发送中…');
    // 入场动效只挂在「发送中」气泡上：确认后的正式气泡不再做一次淡入，否则替换时会闪
    expect(bubble.className).toContain('bubble-row--pending');

    await act(async () => { resolve(); });
    await waitFor(() => expect(screen.queryByTestId('pending-reply')).toBeNull());
    expect(document.querySelector('.bubble-row--pending')).toBeNull();
  });

  it('发送失败时气泡留在对话框里，给出原因并可以重发', async () => {
    vi.spyOn(store, 'reply').mockRejectedValue(new Error('飞书拒绝发送：外部会话无权限'));
    renderPanel({ ...FAILED, status: MsgStatus.RECEIVED, reply: undefined, failureReason: undefined });

    fireEvent.change(screen.getByPlaceholderText(/输入回复内容/), { target: { value: '失败也要看得见' } });
    fireEvent.click(screen.getByTestId('send-reply'));

    const bubble = await screen.findByTestId('pending-reply');
    expect(bubble).toHaveTextContent('失败也要看得见');
    await waitFor(() => expect(bubble).toHaveTextContent(/外部会话无权限/));
    expect(screen.getByRole('button', { name: '重发' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '丢弃' })).toBeInTheDocument();
  });
});

describe('DetailPanel 发送失败原因（P1-2）', () => {
  it('失败区域直接展示可读原因，不再只让用户去回放里翻', () => {
    renderPanel();
    expect(screen.getByText('发送失败（没有送达平台）')).toBeInTheDocument();
    expect(screen.getByText(/原因：飞书 tenant_access_token 获取失败/)).toBeInTheDocument();
    expect(screen.getByTestId('retry-send')).toBeEnabled();
  });

  it('点「重试发送」用同一条回复内容重新提交，不要求用户改文案', async () => {
    const reply = vi.spyOn(store, 'reply').mockResolvedValue();
    renderPanel();

    fireEvent.click(screen.getByTestId('retry-send'));
    await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    // 回复不再带身份参数：一律跟随后端平台策略（要换身份去「新建发送」）
    expect(reply).toHaveBeenCalledWith('t-fail-1', '收到，周五前交。');
  });

  it('没有可读原因时给回放兜底文案，并提供「查看闭环日志」入口', () => {
    renderPanel({ ...FAILED, failureReason: undefined });
    expect(screen.getByText(/暂时没有可读的失败原因/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /查看详细记录/ })).toBeInTheDocument();
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

describe('DetailPanel 会话优先级', () => {
  const inboundUrgent: UnifiedMessage = {
    ...FAILED,
    traceId: 't-in-urgent',
    direction: 'in',
    status: MsgStatus.RECEIVED,
    body: '这份合同今天必须确认',
    priority: 'urgent',
    prioritySource: 'manual',
    failureReason: undefined,
    reply: undefined,
    createdAt: '2026-11-19T02:00:00.000Z',
    updatedAt: '2026-11-19T02:00:00.000Z',
  };
  const outLater: UnifiedMessage = {
    ...FAILED,
    traceId: 't-out-later',
    direction: 'out',
    status: MsgStatus.SYNCED,
    body: '好的',
    failureReason: undefined,
    reply: undefined,
    createdAt: '2026-11-19T02:05:00.000Z',
    updatedAt: '2026-11-19T02:05:00.000Z',
  };

  it('顶部优先级取会话里待处理消息的最紧急值，不跟着选中的出站消息走', () => {
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={outLater} thread={[inboundUrgent, outLater]} />
        </AntApp>
      </MemoryRouter>,
    );

    // 选中的是自己后来发的那条普通消息，但会话里还有未完成的紧急来信 → 顶部必须显示紧急
    expect(screen.getByTestId('priority-select')).toHaveTextContent('紧急');
  });
});

describe('DetailPanel 右键菜单', () => {
  const inbound: UnifiedMessage = {
    ...FAILED,
    traceId: 't-ctx-1',
    direction: 'in',
    status: MsgStatus.RECEIVED,
    body: '周五前交周报',
    failureReason: undefined,
    reply: undefined,
  };

  it('右键消息给出引用 / 待办 / 优先级 / 完成 / 复制 / 转发，点「加入待办」按被右键的消息执行', async () => {
    const markTodo = vi.spyOn(store, 'markTodo').mockResolvedValue({ ...inbound, type: 'todo' });
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={inbound} thread={[inbound]} />
        </AntApp>
      </MemoryRouter>,
    );

    const bubble = document.querySelector('.bubble-row--in');
    expect(bubble).not.toBeNull();
    fireEvent.contextMenu(bubble!);

    expect(await screen.findByText('引用回复')).toBeInTheDocument();
    expect(screen.getByText('加入待办')).toBeInTheDocument();
    expect(screen.getByText('优先级')).toBeInTheDocument();
    expect(screen.getByText('标记完成')).toBeInTheDocument();
    expect(screen.getByText('复制正文')).toBeInTheDocument();
    expect(screen.getByText('转发到其他平台')).toBeInTheDocument();

    fireEvent.click(screen.getByText('加入待办'));
    await waitFor(() => expect(markTodo).toHaveBeenCalledWith('t-ctx-1'));
  });

  it('右键 → 优先级 → 紧急：改的是右键那一条消息', async () => {
    const setPriority = vi.spyOn(store, 'setPriority').mockResolvedValue({
      message: { ...inbound, priority: 'urgent', prioritySource: 'manual' },
      old: 'normal',
      source: 'manual',
    });
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={inbound} thread={[inbound]} />
        </AntApp>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(document.querySelector('.bubble-row--in')!);
    const submenuTitle = await screen.findByText('优先级');
    fireEvent.mouseEnter(submenuTitle);
    const urgentItem = await screen.findByText('紧急');
    fireEvent.click(urgentItem);

    await waitFor(() => expect(setPriority).toHaveBeenCalledWith('t-ctx-1', 'urgent'));
  });
});
