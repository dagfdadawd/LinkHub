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
    expect(screen.getByText('发送失败（已写入死信队列）')).toBeInTheDocument();
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

describe('回复气泡的身份与失败态（按条渲染，不能共用一条消息的投递身份）', () => {
  const base: UnifiedMessage = {
    ...FAILED,
    traceId: 't-ident',
    body: '原始消息',
    status: MsgStatus.FAILED,
    failureReason: undefined,
    reply: '',
  };

  it('同一会话里本人 / 机器人各回过一次 → 两个气泡各标各的身份', () => {
    const target: UnifiedMessage = {
      ...base,
      replies: [
        { text: '本人回的', at: '2026-11-19T02:00:00.000Z', identity: 'user' },
        { text: '机器人回的', at: '2026-11-19T02:01:00.000Z', identity: 'bot' },
      ],
      delivery: { mode: 'real', identity: 'bot', at: '2026-11-19T02:01:00.000Z' },
      createdAt: '2026-11-19T01:59:00.000Z',
      updatedAt: '2026-11-19T02:01:00.000Z',
    };
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={target} thread={[target]} />
        </AntApp>
      </MemoryRouter>,
    );
    const bubbles = [...document.querySelectorAll('.bubble-row--out')];
    const texts = bubbles.map((b) => b.textContent ?? '');
    const userBubble = texts.find((t) => t.includes('本人回的')) ?? '';
    const botBubble = texts.find((t) => t.includes('机器人回的')) ?? '';
    expect(userBubble).toContain('本人');
    expect(botBubble).toContain('机器人');
  });

  it('失败的回复要显示「发送失败 / 未送达」，而不是永远停在发送中', () => {
    const target: UnifiedMessage = {
      ...base,
      replies: [
        {
          text: '这条没发出去',
          at: '2026-11-19T02:00:00.000Z',
          failed: true,
          failureReason: '飞书拒绝发送：机器人不在这个会话里（code 230002）',
        },
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
    const failed = document.querySelector('[data-reply-failed="true"]');
    expect(failed).toBeTruthy();
    expect(failed?.textContent ?? '').toContain('发送失败');
    expect(failed?.textContent ?? '').toContain('未送达');
  });
});

describe('新建发送的消息只画一个气泡（body 与 reply 是同一段话）', () => {
  it('出站消息不会把 reply 再画成第二条气泡', () => {
    const now = new Date().toISOString();
    const composed: UnifiedMessage = {
      traceId: 't-compose-1',
      platform: Platform.FEISHU,
      externalId: 'compose:abc',
      sender: { id: 'linkhub', name: 'LinkHub 统一入口' },
      conversation: { id: 'oc_demo', type: 'p2p', title: 'Jarvis' },
      type: 'text',
      body: '这是一条主动发送',
      reply: '这是一条主动发送',
      direction: 'out',
      status: MsgStatus.SYNCED,
      delivery: { mode: 'real', identity: 'user', at: now },
      createdAt: now,
      updatedAt: now,
    };
    render(
      <MemoryRouter>
        <AntApp>
          <DetailPanel message={composed} thread={[composed]} />
        </AntApp>
      </MemoryRouter>,
    );
    const texts = [...document.querySelectorAll('.message-body')].map((el) => el.textContent);
    expect(texts.filter((t) => t === '这是一条主动发送')).toHaveLength(1);
  });
});
