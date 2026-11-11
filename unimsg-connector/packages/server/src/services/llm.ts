/**
 * 大模型服务：OpenAI 兼容协议（默认小米 MiMo）。
 *
 * - mock 模式：按关键词给出确定性的意图/摘要/回复草稿，零密钥可跑。
 * - real 模式：调 `{endpoint}/chat/completions`，要求模型只输出 JSON；
 *   超时 / 非 2xx / 畸形 JSON / 枚举越界 / 低置信一律回退规则识别，
 *   并在结果里带 fallbackReason，由调用方写进闭环日志——绝不静默假装成功。
 * - 单测环境由 config 强制 mock，绝不在测试里外呼。
 */
import { UnifiedMessage } from '@unimsg/shared';
import { config } from '../config';

export const INTENTS = ['待办', '咨询', '通知', '未分类'] as const;
export type Intent = (typeof INTENTS)[number];

export type LlmResult =
  | {
      ok: true;
      intent: string;
      confidence: number;
      summary: string;
      replyDraft: string;
      /** llm = 真实模型给出；rules = 内置规则（含真实调用失败后的回退） */
      source: 'llm' | 'rules';
      /** source=rules 且本应走真实模型时的回退原因 */
      fallbackReason?: string;
      provider?: string;
      model?: string;
      latencyMs?: number;
      tokens?: number;
    }
  | { ok: false; reason: string };

export interface LlmServiceOptions {
  mode: 'mock' | 'real';
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  minConfidence: number;
}

const SYSTEM_PROMPT = [
  '你是统一消息中枢的意图识别器。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。',
  '字段：intent（必须是 待办/咨询/通知/未分类 之一）、',
  'confidence（0 到 1 的小数）、summary（不超过 40 字的中文摘要）、',
  'replyDraft（一句可直接发送的中文回复草稿）。',
].join('');

const MAX_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry-After 支持秒数与 HTTP 日期；封顶 2s，避免现场演示被长时间挂住 */
function retryAfterMs(res: Response): number {
  const raw = res.headers.get('retry-after');
  if (!raw) return 200;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), 2000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 2000) : 200;
}

/** 剥掉 markdown 围栏；模型偶尔夹带说明文字时取第一个花括号块 */
function extractJson(text: string): Record<string, unknown> | undefined {
  const stripped = text.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '').trim();
  for (const candidate of [stripped, stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* 换下一种候选 */
    }
  }
  return undefined;
}

interface RawAnalysis {
  intent: Intent;
  confidence: number;
  summary: string;
  replyDraft: string;
  latencyMs: number;
  tokens?: number;
}

export class LlmService {
  private readonly o: LlmServiceOptions;

  /** 不传参数时读取 config（启动即固定）；单测直接注入本地假端点 */
  constructor(opts: Partial<LlmServiceOptions> = {}) {
    const c = config.llm;
    this.o = {
      mode: opts.mode ?? c.mode,
      provider: opts.provider ?? c.provider,
      endpoint: opts.endpoint ?? c.endpoint,
      model: opts.model ?? c.model,
      apiKey: opts.apiKey ?? c.apiKey,
      timeoutMs: opts.timeoutMs ?? c.timeoutMs,
      minConfidence: opts.minConfidence ?? c.minConfidence,
    };
  }

  async analyze(msg: UnifiedMessage): Promise<LlmResult> {
    const body = msg.body ?? '';
    if (this.o.mode !== 'real') return this.rules(body);

    const started = Date.now();
    const real = await this.callReal(body);
    if (!real.ok) return this.fallback(body, real.reason);
    if (real.data.confidence < this.o.minConfidence) return this.fallback(body, 'low_confidence');

    return {
      ok: true,
      intent: real.data.intent,
      confidence: real.data.confidence,
      summary: real.data.summary,
      replyDraft: real.data.replyDraft,
      source: 'llm',
      provider: this.o.provider,
      model: this.o.model,
      latencyMs: Date.now() - started,
      tokens: real.data.tokens,
    };
  }

  /** 规则兜底；真实调用失败时把原因挂上，供闭环日志与前端标注 */
  private fallback(body: string, reason: string): LlmResult {
    const r = this.rules(body);
    return r.ok ? { ...r, fallbackReason: reason } : r;
  }

  private rules(body: string): LlmResult {
    if (body.includes('[[FAIL_LLM]]')) return { ok: false, reason: 'mock_llm_failure' };

    let intent: Intent = '未分类';
    let confidence = 0.4;
    if (/周报|待办|任务|提醒|截止|deadline/i.test(body)) { intent = '待办'; confidence = 0.92; }
    else if (/[?？]|怎么|如何|为什么|吗/.test(body)) { intent = '咨询'; confidence = 0.8; }
    else if (/通知|公告|会议|安排/.test(body)) { intent = '通知'; confidence = 0.78; }

    const summary = body.length > 40 ? `${body.slice(0, 40)}…` : body;
    const replyDraft =
      intent === '待办' ? '收到，我会在截止前完成。'
      : intent === '咨询' ? '收到，我确认后回复你。'
      : '收到。';
    return { ok: true, intent, confidence, summary, replyDraft, source: 'rules' };
  }

  private async callReal(body: string): Promise<{ ok: true; data: RawAnalysis } | { ok: false; reason: string }> {
    const url = `${this.o.endpoint}/chat/completions`;
    const started = Date.now();
    let reason = 'unknown';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.o.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.o.model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: body },
            ],
            max_completion_tokens: 400,
            temperature: 0.2,
            stream: false,
          }),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
      } catch (e) {
        const name = (e as { name?: string } | undefined)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, reason: 'timeout' };
        return { ok: false, reason: `network: ${e instanceof Error ? e.message : String(e)}` };
      }

      if (res.status === 429 || res.status === 503) {
        reason = `http_${res.status}`;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(retryAfterMs(res));
          continue;
        }
        return { ok: false, reason };
      }
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };

      let json: any;
      try {
        json = await res.json();
      } catch {
        return { ok: false, reason: 'invalid_response_body' };
      }

      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'empty_content' };

      const obj = extractJson(content);
      if (!obj) return { ok: false, reason: 'invalid_json' };

      const intent = obj.intent;
      if (typeof intent !== 'string' || !(INTENTS as readonly string[]).includes(intent)) {
        return { ok: false, reason: `invalid_intent: ${String(intent).slice(0, 20)}` };
      }
      const confidence = Number(obj.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return { ok: false, reason: 'invalid_confidence' };
      }
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      const replyDraft = typeof obj.replyDraft === 'string' ? obj.replyDraft.trim() : '';
      if (!summary || !replyDraft) return { ok: false, reason: 'missing_fields' };

      const tokens = Number(json?.usage?.total_tokens);
      return {
        ok: true,
        data: {
          intent: intent as Intent,
          confidence,
          summary,
          replyDraft,
          latencyMs: Date.now() - started,
          tokens: Number.isFinite(tokens) ? tokens : undefined,
        },
      };
    }

    return { ok: false, reason };
  }
}
