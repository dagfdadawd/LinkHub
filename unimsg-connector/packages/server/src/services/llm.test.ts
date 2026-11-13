/**
 * 真实大模型适配器单测。
 *
 * 全部用本地 node:http 假服务模拟 OpenAI 兼容端点，走真实 fetch / 真实超时 /
 * 真实重试，不断言 mock 调用次数以外的内部实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Platform, MsgStatus, type UnifiedMessage } from '@unimsg/shared';
import { LlmService, DEFAULT_MAX_COMPLETION_TOKENS, shouldDisableThinking, type LlmServiceOptions } from './llm';

function msg(body: string): UnifiedMessage {
  return {
    traceId: 't-1',
    platform: Platform.FEISHU,
    externalId: 'ext-1',
    sender: { name: '张三', id: 'u-1' },
    type: 'text',
    body,
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

type Handler = (body: any, res: ServerResponse, attempt: number) => void | Promise<void>;

interface Fake {
  url: string;
  calls: () => number;
  close: () => Promise<void>;
}

async function fakeOpenAI(handler: Handler): Promise<Fake> {
  let calls = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    calls += 1;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = {};
    }
    await handler(body, res, calls);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function reply(res: ServerResponse, content: string, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  }));
}

function opts(url: string, over: Partial<LlmServiceOptions> = {}): LlmServiceOptions {
  return {
    mode: 'real',
    provider: 'mimo',
    endpoint: url,
    model: 'mimo-v2.6-flash',
    apiKey: 'sk-test',
    timeoutMs: 2000,
    minConfidence: 0.6,
    ...over,
  };
}

const GOOD = JSON.stringify({
  intent: '待办', confidence: 0.93, summary: '周五前交 Q3 复盘材料', replyDraft: '收到，周五前发你。',
});

test('mock 模式：走内置规则，不发任何网络请求', async () => {
  let hit = 0;
  const fake = await fakeOpenAI(() => { hit += 1; });
  try {
    const svc = new LlmService(opts(fake.url, { mode: 'mock' }));
    const r = await svc.analyze(msg('明天十点对齐排期'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.equal(hit, 0);
  } finally {
    await fake.close();
  }
});

test('real 模式：合法 JSON → 采用模型结果并标注来源 / 模型 / 耗时', async () => {
  const fake = await fakeOpenAI((_b, res) => reply(res, GOOD));
  try {
    const svc = new LlmService(opts(fake.url));
    const r = await svc.analyze(msg('麻烦把 Q3 复盘的材料在周五下班前发我一份'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'llm');
    assert.equal(r.intent, '待办');
    assert.equal(r.summary, '周五前交 Q3 复盘材料');
    assert.equal(r.replyDraft, '收到，周五前发你。');
    assert.equal(r.confidence, 0.93);
    assert.equal(r.precision, 'high');
    assert.equal(r.model, 'mimo-v2.6-flash');
    assert.equal(r.tokens, 140);
    assert.ok((r.latencyMs ?? -1) >= 0);
  } finally {
    await fake.close();
  }
});

test('real 模式：模型用 ```json 围栏包裹时也能解析', async () => {
  const fake = await fakeOpenAI((_b, res) => reply(res, '```json\n' + GOOD + '\n```'));
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'llm');
    assert.equal(r.intent, '待办');
  } finally {
    await fake.close();
  }
});

test('real 模式：畸形 JSON 回退规则识别，并记录原因', async () => {
  const fake = await fakeOpenAI((_b, res) => reply(res, '这不是 JSON'));
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('系统升级通知，今晚维护'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.match(r.fallbackReason ?? '', /json/i);
    assert.equal(r.intent, '通知');
  } finally {
    await fake.close();
  }
});

test('real 模式：intent 不在枚举内 → 回退规则，不把脏值写进闭环', async () => {
  const fake = await fakeOpenAI((_b, res) =>
    reply(res, JSON.stringify({ intent: '随便编的', confidence: 0.9, summary: 'x', replyDraft: 'y' })));
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('这个接口怎么用？'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.equal(r.intent, '咨询');
    assert.match(r.fallbackReason ?? '', /intent/);
  } finally {
    await fake.close();
  }
});

test('real 模式：低置信仍采用模型结果，只标为低精度（绝不回退规则）', async () => {
  const fake = await fakeOpenAI((_b, res) =>
    reply(res, JSON.stringify({
      intent: '未分类', confidence: 0.3,
      summary: '仅发送数字，意图不明', replyDraft: '请问您具体需要什么？',
    })));
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('1'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'llm', '模型成功响应就必须有 AI 建议');
    assert.equal(r.precision, 'low');
    assert.equal(r.confidence, 0.3);
    assert.equal(r.intent, '未分类');
    assert.equal(r.replyDraft, '请问您具体需要什么？', '草稿必须原样采用，不能换成规则模板');
    assert.equal(r.fallbackReason, undefined, '低精度不是回退，不能带 fallbackReason');
  } finally {
    await fake.close();
  }
});

test('real 模式：高置信标为高精度；阈值只分档，不影响是否采用', async () => {
  const fake = await fakeOpenAI((_b, res) => reply(res, GOOD));
  try {
    const svc = new LlmService(opts(fake.url, { minConfidence: 0.99 }));
    const r = await svc.analyze(msg('周五前交周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'llm', '即使阈值调到 0.99，0.93 也不能被丢弃');
    assert.equal(r.precision, 'low', '只降级为低精度，不回退规则');
    assert.equal(r.replyDraft, '收到，周五前发你。');
  } finally {
    await fake.close();
  }
});

test('real 模式：HTTP 500 → 回退规则，不抛异常', async () => {
  const fake = await fakeOpenAI((_b, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.match(r.fallbackReason ?? '', /500/);
  } finally {
    await fake.close();
  }
});

test('real 模式：超时 → 回退规则并明确标注 timeout', async () => {
  const fake = await fakeOpenAI(async (_b, res) => {
    await new Promise((r) => setTimeout(r, 300));
    reply(res, GOOD);
  });
  try {
    const r = await new LlmService(opts(fake.url, { timeoutMs: 50 })).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.match(r.fallbackReason ?? '', /timeout/i);
  } finally {
    await fake.close();
  }
});

test('real 模式：429 按 Retry-After 重试一次后成功', async () => {
  const fake = await fakeOpenAI((_b, res, attempt) => {
    if (attempt === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end('{"error":"rate_limited"}');
      return;
    }
    reply(res, GOOD);
  });
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'llm');
    assert.equal(fake.calls(), 2);
  } finally {
    await fake.close();
  }
});

test('real 模式：连续 429 只重试一次，随后回退规则', async () => {
  const fake = await fakeOpenAI((_b, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
    res.end('{"error":"rate_limited"}');
  });
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.equal(fake.calls(), 2);
    assert.match(r.fallbackReason ?? '', /429/);
  } finally {
    await fake.close();
  }
});

test('规则失败标记 [[FAIL_LLM]] 仍返回 ok:false（保留原降级语义）', async () => {
  const r = await new LlmService(opts('http://127.0.0.1:1/v1', { mode: 'mock' })).analyze(msg('[[FAIL_LLM]] 帮我看看'));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'mock_llm_failure');
});

test('real 模式：404 保留服务商响应体，模型不存在 / 未开通可定位', async () => {
  const fake = await fakeOpenAI((_b, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Your account has not activated the model doubao-seed' } }));
  });
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.match(r.fallbackReason ?? '', /http_404/);
    assert.match(r.fallbackReason ?? '', /has not activated the model/);
  } finally {
    await fake.close();
  }
});

/** 推理模型：输出预算全被思维链吃掉，content 为空、finish_reason=length */
function reasoningOnlyReply(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{
      index: 0,
      finish_reason: 'length',
      message: { role: 'assistant', content: '', reasoning_content: '先分析一下这条消息…' },
    }],
    usage: { completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 400 }, total_tokens: 528 },
  }));
}

test('real 模式：推理模型耗尽输出预算 → 自动放大预算重试并采用模型结果', async () => {
  const budgets: number[] = [];
  const fake = await fakeOpenAI((body, res, attempt) => {
    budgets.push(Number(body?.max_completion_tokens));
    if (attempt === 1) {
      reasoningOnlyReply(res);
      return;
    }
    reply(res, GOOD);
  });
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'llm');
    assert.equal(r.intent, '待办');
    assert.equal(fake.calls(), 2);
    assert.deepEqual(budgets, [DEFAULT_MAX_COMPLETION_TOKENS, DEFAULT_MAX_COMPLETION_TOKENS * 3]);
  } finally {
    await fake.close();
  }
});

test('real 模式：两次都只有思维链 → 回退规则，原因带 finish_reason / reasoning_tokens', async () => {
  const fake = await fakeOpenAI((_b, res) => reasoningOnlyReply(res));
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.equal(fake.calls(), 2);
    assert.match(r.fallbackReason ?? '', /empty_content/);
    assert.match(r.fallbackReason ?? '', /finish_reason=length/);
    assert.match(r.fallbackReason ?? '', /reasoning_tokens=400/);
  } finally {
    await fake.close();
  }
});

test('real 模式：空正文且非 length → 不重试，直接回退并给诊断', async () => {
  const fake = await fakeOpenAI((_b, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: '…' } }],
      usage: { completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 300 } },
    }));
  });
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'rules');
    assert.equal(fake.calls(), 1);
    assert.match(r.fallbackReason ?? '', /empty_content/);
    assert.match(r.fallbackReason ?? '', /reasoning_tokens=300/);
  } finally {
    await fake.close();
  }
});

test('real 模式：content 为多模态文本片段数组时也能解析', async () => {
  const fake = await fakeOpenAI((_b, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: GOOD }] } }],
    }));
  });
  try {
    const r = await new LlmService(opts(fake.url)).analyze(msg('周报'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.source, 'llm');
    assert.equal(r.intent, '待办');
  } finally {
    await fake.close();
  }
});

test('火山方舟 + 豆包模型关闭深度思考，其它服务商不会误加私有参数', () => {
  assert.equal(shouldDisableThinking('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-lite-260915'), true);
  assert.equal(shouldDisableThinking('https://api.deepseek.com/v1', 'deepseek-reasoner'), false);
  assert.equal(shouldDisableThinking('https://ark.cn-beijing.volces.com/api/v3', 'deepseek-r1'), false);
});
