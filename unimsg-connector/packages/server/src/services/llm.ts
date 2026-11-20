/**
 * 大模型服务：OpenAI 兼容协议（默认小米 MiMo）。
 *
 * - mock 模式：按关键词给出确定性的意图/摘要/回复草稿，零密钥可跑。
 * - real 模式：调 `{endpoint}/chat/completions`，要求模型只输出 JSON。
 *   **只要模型成功响应就一律采用**，哪怕 confidence 很低——低把握只影响
 *   「内容精度」（草稿更短、界面标注低精度），不影响「有没有 AI 建议」。
 *   仅超时 / 非 2xx / 畸形 JSON / 枚举越界 / 缺字段才回退规则识别，
 *   并在结果里带 fallbackReason，由调用方写进闭环日志——绝不静默假装成功。
 * - 推理模型（豆包 seed 一类）默认把输出预算全部耗在思维链上，会返回
 *   `content: ""` + `finish_reason: "length"`。这里对火山方舟自动关闭深度思考，
 *   并在仍被截断时放大输出预算重试一次；最终失败会带上可诊断的原因。
 * - 单测环境由 config 强制 mock，绝不在测试里外呼。
 */
import { UnifiedMessage } from '@unimsg/shared';
import { config } from '../config';
import { delay } from './rateLimiter';

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
      /** 仅 source=llm：按 confidence 划分的精度档，低档仍采用模型结果 */
      precision?: 'high' | 'low';
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
  /** 精度分档线：低于它标为 low（仍采用模型结果），不再是「是否丢弃」的开关 */
  minConfidence: number;
  /** 单次输出 token 预算（推理模型需要更大预算），默认 800 */
  maxCompletionTokens?: number;
}

const SYSTEM_PROMPT = [
  '你是统一消息中枢的意图识别器。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。',
  '字段：intent（必须是 待办/咨询/通知/未分类 之一）、',
  'confidence（0 到 1 的小数，如实反映把握程度）、',
  'summary（不超过 40 字的中文摘要）、replyDraft（可直接发送的中文回复草稿）。',
  '按信息量自适应，绝不编造事实：',
  '① 信息充分（有明确事项、时间或问题）时，summary 写明具体事项，replyDraft 给针对性强、可直接发送的完整回复；',
  '② 信息不足（只有一个数字、问候、表情或含糊短语）时，intent 用「未分类」并给低 confidence，',
  'summary 如实说明信息不足，replyDraft 只给一句简短的澄清追问（不超过 25 字），不要臆测对方要什么。',
  '两种情况的 replyDraft 都必须是非空中文；长短与精度随信息量变化，但都要有内容。',
].join('');

const MAX_ATTEMPTS = 2;

/** 单次输出预算：实测豆包 seed 开深度思考时 400 token 会被思维链全部吃光 */
export const DEFAULT_MAX_COMPLETION_TOKENS = 800;
/** 首次被 finish_reason=length 截断时放大预算重试；封顶避免现场演示被拖慢/烧钱 */
const LENGTH_RETRY_MULTIPLIER = 3;
const MAX_RETRY_COMPLETION_TOKENS = 2400;

/**
 * 火山方舟的豆包 seed 系列默认开启深度思考，`thinking` 是该平台私有参数。
 * 别的服务商/模型传未知字段可能直接 400，所以只对「火山端点 + 豆包模型」加；
 * 其余推理模型靠放大输出预算重试兜底。
 */
export function shouldDisableThinking(endpoint: string, model: string): boolean {
  let host = '';
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    host = endpoint.toLowerCase();
  }
  return /volces|volcengine|ark\./.test(host) && /doubao|seed/i.test(model);
}

/** 兼容 content 为字符串或多模态文本片段数组（部分兼容网关返回后者） */
function messageContent(message: any): string {
  const raw = message?.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

/** 正文为空时带上服务商给的关键字段，避免只看到一句 empty_content 无从下手 */
function emptyContentReason(json: any, choice: any): string {
  const finish = String(choice?.finish_reason ?? 'unknown');
  const reasoningTokens = Number(json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
  const hasReasoning = Boolean(choice?.message?.reasoning_content);
  const detail = `finish_reason=${finish}${reasoningTokens > 0 ? `, reasoning_tokens=${reasoningTokens}` : ''}`;
  return hasReasoning || reasoningTokens > 0
    ? `empty_content: 推理模型把输出预算全用在思维链（${detail}），未生成正式答案`
    : `empty_content: 响应缺少正文（${detail}）`;
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
  private readonly maxCompletionTokens: number;

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
    this.maxCompletionTokens = opts.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
  }

  async analyze(msg: UnifiedMessage): Promise<LlmResult> {
    const body = msg.body ?? '';
    if (this.o.mode !== 'real') return this.rules(body);

    const started = Date.now();
    const real = await this.callReal(body);
    // 只有「调用本身失败」才回退规则。模型成功响应却没把握是常态（例如对方只发了一个「1」）：
    // 此时照常采用模型给出的意图 / 摘要 / 草稿，只是标成低精度，由前端如实提示，
    // 绝不把已经生成好的 AI 建议丢掉换成关键词规则。
    if (!real.ok) return this.fallback(body, real.reason);

    return {
      ok: true,
      intent: real.data.intent,
      confidence: real.data.confidence,
      summary: real.data.summary,
      replyDraft: real.data.replyDraft,
      source: 'llm',
      precision: real.data.confidence >= this.o.minConfidence ? 'high' : 'low',
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
    const disableThinking = shouldDisableThinking(this.o.endpoint, this.o.model);
    let reason = 'unknown';
    let scaleUpTokens = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const maxTokens = scaleUpTokens
        ? Math.min(this.maxCompletionTokens * LENGTH_RETRY_MULTIPLIER, MAX_RETRY_COMPLETION_TOKENS)
        : this.maxCompletionTokens;
      const payload: Record<string, unknown> = {
        model: this.o.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: body },
        ],
        max_completion_tokens: maxTokens,
        temperature: 0.2,
        stream: false,
      };
      // 火山方舟豆包 seed 默认开深度思考：不关掉的话输出预算全被 reasoning 吃掉，
      // 返回 content="" + finish_reason=length，看上去像「模型不返回结果」。
      if (disableThinking) payload.thinking = { type: 'disabled' };

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.o.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
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
          await delay(retryAfterMs(res));
          continue;
        }
        return { ok: false, reason };
      }
      if (!res.ok) {
        // 服务商的 4xx 响应体通常直接写明「模型 ID 不存在 / 模型未开通」，
        // 只留 `http_404` 会让用户完全无从下手。截取有限长度写进 trace，
        // 绝不把请求头 / API Key 写进去。
        const raw = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
        let detail = '';
        try {
          const parsed: any = JSON.parse(raw);
          detail = String(parsed?.error?.message ?? parsed?.error?.code ?? parsed?.message ?? parsed?.msg ?? '');
        } catch {
          detail = raw;
        }
        const brief = detail.replace(/\s+/g, ' ').trim().slice(0, 180);
        return { ok: false, reason: `http_${res.status}${brief ? `: ${brief}` : ''}` };
      }

      let json: any;
      try {
        json = await res.json();
      } catch {
        return { ok: false, reason: 'invalid_response_body' };
      }

      const choice = json?.choices?.[0];
      const content = messageContent(choice?.message);
      if (!content.trim()) {
        reason = emptyContentReason(json, choice);
        // 输出预算被思维链耗尽：放大预算再给一次机会（推理模型常见）。
        if (attempt < MAX_ATTEMPTS && String(choice?.finish_reason ?? '') === 'length') {
          scaleUpTokens = true;
          continue;
        }
        return { ok: false, reason };
      }

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
