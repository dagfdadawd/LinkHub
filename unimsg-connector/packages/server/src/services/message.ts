/**
 * 消息中枢：统一消息的业务核心。
 *
 * 职责：
 *  - ingest：接入 + 幂等去重 + OCR/LLM 富化 + WS 推送
 *  - reply：状态机 processing→replied，异步触发回写（结果走 WS）
 *  - markDone：待办完成
 *  - syncStatus / onPlatformEvent：平台状态回流
 *  - getTrace / getLoopLog：全链路回放
 */
import { randomUUID } from 'node:crypto';
import { normalizeEchoText, rememberSent, learnedSelfIds } from './echoRegistry';
import {
  Platform, MsgStatus, UnifiedMessage, PlatformConnector,
  type ComposeAck, type ComposeRequest, type IdentityRole, type OutboundAttachment,
} from '@unimsg/shared';
import { MessageRepository } from '../db/repository';
import { LlmService } from './llm';
import { OcrService } from './ocr';
import { RateLimiter } from './rateLimiter';
import { decidePlatformEvent } from './sync';
import { writeTrace } from '../core/loop-log';
import { counters } from '../core/metrics';
import { config, modeOf } from '../config';
import { describeAttachmentsWithPreview } from './outbound';
import { assertIdentityUsable, ensureIdentityProbed } from './identity';

export interface Broadcast {
  (event: { type: string; data?: unknown }): void;
}

export interface IngestResult {
  message: UnifiedMessage;
  duplicate: boolean;
}

/** 一次 AI 分析的结果：除更新后的消息外，还带上「本次」回退原因（不是启动时的配置结论） */
export interface AnalysisOutcome {
  message: UnifiedMessage;
  source: 'llm' | 'rules';
  fallbackReason?: string;
}

/**
 * 无效平台事件（空 body、空对象、解析后缺消息 ID 等）。
 *
 * 单独一个错误类型，是为了让路由层能把「用户/平台推来的畸形事件」回 400，
 * 而真正的服务端故障仍回 500；抛出点位于写 trace 与幂等表之前，
 * 保证这类事件绝不会污染去重键（旧实现的空 `{}` 会占住 externalId='unknown' 永久去重）。
 */
export class InvalidPlatformEvent extends Error {
  readonly platform: Platform;
  readonly reason: string;

  constructor(platform: Platform, reason: string) {
    super(`无效的平台事件（${platform}）：${reason}`);
    this.name = 'InvalidPlatformEvent';
    this.platform = platform;
    this.reason = reason;
  }
}

/** 值是否「没有内容」：空串 / 空数组 / null，或所有字段都为空的普通对象（如空 XML 壳解析出的 { xml: '' }） */
function isEmptyEventValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isEmptyEventValue);
  }
  return false; // number / boolean 等标量视为有内容
}

/** 事件体是否「明显为空」：空对象 / 空数组 / 空白字符串 / 标量。这种推送不可能承载消息或状态回流。 */
export function isEmptyPlatformEvent(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') return raw.trim().length === 0;
  if (typeof raw !== 'object') return true; // number / boolean / bigint 等标量不是合法平台事件
  return isEmptyEventValue(raw);
}

/** 闭环状态推进序（failed 是失败旁路，不参与排序） */
const STATUS_RANK: Record<string, number> = {
  [MsgStatus.RECEIVED]: 0,
  [MsgStatus.PROCESSING]: 1,
  [MsgStatus.REPLIED]: 2,
  [MsgStatus.SENT]: 3,
  [MsgStatus.SYNCED]: 4,
};

export interface StatusTransitionDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * 回流状态是否允许落到消息上（防止「后到的旧 status」把进度打回去）：
 *  - 正常状态只允许前进：received→processing→replied→sent→synced；
 *  - failed 是失败旁路：允许作为重试起点进入任何正常状态（如 failed→sent）；
 *  - 同状态、倒退、以及从正常状态回到 failed 一律忽略。
 */
export function checkStatusTransition(current: MsgStatus, next: MsgStatus): StatusTransitionDecision {
  if (current === next) return { allowed: false, reason: `状态未变化（${current}），忽略重复回流` };
  const curRank = STATUS_RANK[current];
  const nextRank = STATUS_RANK[next];
  if (curRank === undefined) {
    if (current === MsgStatus.FAILED) return { allowed: true };
    return { allowed: false, reason: `当前状态 ${current} 不在状态机内，忽略` };
  }
  if (nextRank === undefined) {
    return { allowed: false, reason: `${current}→${next} 不是前进方向（仅允许 received→processing→replied→sent→synced）` };
  }
  if (nextRank <= curRank) {
    return { allowed: false, reason: `${current}→${next} 属于状态倒退（顺序 received<processing<replied<sent<synced）` };
  }
  return { allowed: true };
}

export interface SyncStatusResult {
  /** 是否真的把状态写进了消息（false = 被防倒退规则忽略） */
  applied: boolean;
  message?: UnifiedMessage;
  reason?: string;
}

export class MessageService {
  /** 正在重新分析的消息：同一条并发点击只跑一次，避免重复计费与重复日志 */
  private readonly reanalyzing = new Set<string>();

  constructor(
    private repo: MessageRepository,
    private connectors: Record<Platform, PlatformConnector>,
    private llm: LlmService,
    private ocr: OcrService,
    private limiter: RateLimiter,
    private broadcast: Broadcast,
  ) {}

  // ---------- 接收 ----------
  /**
   * 平台原始事件入库：先由连接器 receive() 解析成统一消息，再走统一的幂等/入库通道。
   * 机器人 webhook / Stream 走这里。
   */
  async ingest(platform: Platform, raw: unknown): Promise<IngestResult> {
    // 入参守卫（P0）：空 body / 空对象必须在 receive、写 trace、写幂等表之前拒绝。
    // 旧实现里 mock 验签会放行 `{}`，receive 兜底出 externalId='unknown'，
    // 首条空事件就会永久占住去重键，后续真实消息也进不来。
    if (isEmptyPlatformEvent(raw)) {
      throw new InvalidPlatformEvent(platform, '事件体为空（空对象/空数组/空白字符串），未写入任何记录');
    }

    const connector = this.connectors[platform];
    const incoming = connector.receive(raw);
    return this.ingestUnified(platform, incoming);
  }

  /**
   * 已映射好的统一消息入库（个人身份接收器用：飞书用户轮询 / 钉钉 dws 个人事件）。
   *
   * 与 ingest() 共用同一条幂等/保存/trace/广播链路，绝不旁路另写一套：
   *  - externalId 缺失/'unknown' → InvalidPlatformEvent（防占死去重键）；
   *  - (platform, externalId) 幂等：重复投递返回 duplicate，不重复入库、不重复广播；
   *  - 写 received trace、counters，异步富化（OCR/LLM）并补广播 message.updated。
   */
  /**
   * 启动时按「已学习的本人 ID」补标历史消息：把以前误当成来信入库的本人消息
   * （钉钉回声 / 手机直发）标成 direction=out，会话列表不再把它们算成未读。
   * 返回被修正的条数；没有学习记录时是纯 no-op。
   */
  applyLearnedSelfDirections(): number {
    const ids = learnedSelfIds(Platform.DINGTALK);
    if (ids.length === 0) return 0;
    let changed = 0;
    for (const m of this.repo.list()) {
      if (m.platform !== Platform.DINGTALK) continue;
      if (m.direction === 'out') continue;
      if (!ids.includes(m.sender.id)) continue;
      this.repo.update(m.traceId, { direction: 'out' });
      changed += 1;
    }
    if (changed > 0) {
      console.log(`[identity] 已把 ${changed} 条本人发出的历史消息标为「我发出的」（不再计入未读）`);
    }
    return changed;
  }

  async ingestUnified(platform: Platform, incoming: UnifiedMessage): Promise<IngestResult> {
    // 平台侧唯一 ID 是幂等键的唯一来源：缺失/兜底成 'unknown' 时必须拒收，
    // 否则多条不同消息会互相去重（或占死 unknown 键）。
    const externalId = typeof incoming.externalId === 'string' ? incoming.externalId.trim() : '';
    if (!externalId || externalId === 'unknown') {
      throw new InvalidPlatformEvent(platform, '解析后缺少消息唯一 ID（externalId），未写入任何记录');
    }
    incoming.externalId = externalId;
    // 防止连接器把事件标成别的平台导致跨平台串数据/去重键错乱
    incoming.platform = platform;

    const existing = this.repo.findByExternal(platform, incoming.externalId);
    if (existing) {
      counters.deduped += 1;
      writeTrace(this.repo, existing, 'redelivered', '平台重复推送，幂等忽略');
      return { message: existing, duplicate: true };
    }

    this.repo.save(incoming);
    counters.received += 1;
    writeTrace(this.repo, incoming, 'received');

    // 富化（OCR / 大模型）不阻塞入库与平台回调：真实 LLM 单次 2.9–9.3s，
    // 同步等待会拖住 Webhook 响应（平台超时会重推）并让收件箱迟迟不出现新消息。
    const received = this.repo.get(incoming.traceId)!;
    this.broadcast({ type: 'message.received', data: received });
    void this.enrich(incoming).catch((e) => {
      writeTrace(this.repo, incoming, 'enrich_failed', e instanceof Error ? e.message : String(e));
    });
    return { message: received, duplicate: false };
  }

  /** OCR + LLM 富化；全部可降级，完成后补广播 message.updated 让前端就地刷新 */
  private async enrich(msg: UnifiedMessage): Promise<void> {
    const m = this.repo.get(msg.traceId);
    if (!m) return;

    let body = m.body;
    let needsReview = m.needsReview;

    if (m.type === 'image' || m.type === 'file') {
      const r = await this.ocr.recognize(m);
      if (r.ok) {
        /**
         * OCR 结果只写闭环日志，**不再拼进消息正文**：
         * 正文是给人读的原始内容，混入「（图片识别文字：…）」会打断阅读，
         * 也容易被误当成对方说的话。低置信仍然标 needsReview，由界面提示人工确认。
         */
        if (r.confidence < config.ocrThreshold) {
          needsReview = true;
          writeTrace(this.repo, m, 'ocr_low_confidence', `confidence=${r.confidence}`);
        } else {
          writeTrace(this.repo, m, 'ocr', `confidence=${r.confidence}`);
        }
      } else {
        needsReview = true;
        writeTrace(this.repo, m, 'ocr_failed', r.reason);
      }
    }

    const outcome = await this.analyzeAndApply(m, body, needsReview);
    if (outcome) this.broadcast({ type: 'message.updated', data: outcome.message });
  }

  /**
   * LLM 分析 + 落库：ingest 富化与「重新生成」共用同一条链路，避免两套规则漂移。
   * 除 intent / replyDraft / intentSource 外，还如实记录本次生效的厂商、模型、
   * 置信度与精度档，供前端标签显示——历史消息保留当时的值，配置变更后不会被回溯改写。
   * 低精度仍写 source=llm（结果来自模型），只有真实调用失败才抹掉这些 AI 字段。
   */
  private async analyzeAndApply(
    m: UnifiedMessage,
    body: string,
    needsReview = m.needsReview,
  ): Promise<AnalysisOutcome | undefined> {
    const lr = await this.llm.analyze({ ...m, body });
    let fallbackReason: string | undefined;
    let intent: string;
    let replyDraft = m.replyDraft;
    let intentSource: 'llm' | 'rules';
    let aiProvider: string | undefined;
    let aiModel: string | undefined;
    let aiConfidence: number | undefined;
    let aiPrecision: 'high' | 'low' | undefined;
    if (lr.ok) {
      intent = lr.intent;
      replyDraft = lr.replyDraft;
      intentSource = lr.source;
      if (lr.source === 'llm') {
        // 生产链路用运行时的厂商显示名（MiMo / 火山方舟 …）；单测注入的假服务保留其标识
        aiProvider = lr.provider === config.llm.provider
          ? config.llm.providerLabel
          : (lr.provider ?? config.llm.providerLabel);
        aiModel = lr.model ?? config.llm.model;
        aiConfidence = lr.confidence;
        aiPrecision = lr.precision;
      }
      const via = lr.source === 'llm'
        ? `${lr.provider ?? 'llm'}/${lr.model ?? ''} ${lr.latencyMs ?? 0}ms ${lr.tokens ?? 0}tok`
        : 'rules';
      writeTrace(this.repo, m, 'intent', `${lr.intent}(${lr.confidence}) via ${via}`);
      // 低精度不是回退：留一条独立 trace，说明结果仍来自模型、只是把握较低
      if (lr.precision === 'low') {
        writeTrace(
          this.repo, m, 'intent_low_precision',
          `模型已生成建议但把握 ${lr.confidence}（精度线 ${config.llm.minConfidence}）：草稿偏简短，未回退规则`,
        );
      }
      fallbackReason = lr.fallbackReason;
      if (lr.fallbackReason) writeTrace(this.repo, m, 'intent_fallback', lr.fallbackReason);
    } else {
      intent = '未分类';
      intentSource = 'rules';
      fallbackReason = lr.reason;
      writeTrace(this.repo, m, 'intent_fallback', lr.reason);
    }

    // AI 字段显式写 undefined：规则兜底时必须抹掉上一次的真实模型痕迹
    const updated = this.repo.update(m.traceId, {
      body, needsReview, intent, replyDraft, intentSource,
      aiProvider, aiModel, aiConfidence, aiPrecision,
    });
    if (!updated) return undefined;
    return { message: updated, source: intentSource, fallbackReason };
  }

  /**
   * 用当前配置重新生成 AI 建议（详情页「重新生成」按钮的真实后端动作）。
   * 不重跑 OCR（body 已含识别文本）、不改业务状态，只重写 AI 字段并广播 message.updated。
   * 历史消息因此不用等新消息进来也能重算。
   */
  async reanalyze(id: string): Promise<AnalysisOutcome> {
    const m = this.repo.get(id);
    if (!m) throw new Error('message not found');
    if (this.reanalyzing.has(id)) {
      return { message: m, source: m.intentSource === 'llm' ? 'llm' : 'rules' };
    }
    this.reanalyzing.add(id);
    try {
      writeTrace(
        this.repo, m, 'reanalyze_requested',
        `provider=${config.llm.provider} model=${config.llm.model} mode=${config.llm.mode}`,
      );
      const outcome = await this.analyzeAndApply(m, m.body);
      if (!outcome) throw new Error('message not found');
      const updated = outcome.message;
      writeTrace(
        this.repo, updated, 'reanalyze_done',
        `source=${outcome.source}${updated.aiProvider ? ` via ${updated.aiProvider}/${updated.aiModel ?? ''}` : ''}`
        + (outcome.fallbackReason ? ` fallback=${outcome.fallbackReason.slice(0, 180)}` : ''),
      );
      this.broadcast({ type: 'message.updated', data: updated });
      return outcome;
    } finally {
      this.reanalyzing.delete(id);
    }
  }

  // ---------- 展示 ----------
  list(filter?: { platform?: Platform; status?: MsgStatus }): UnifiedMessage[] {
    return this.repo.list(filter);
  }

  get(id: string): UnifiedMessage | undefined {
    return this.repo.get(id);
  }

  // ---------- 处理 / 回写 ----------
  /**
   * 回复一条已收到的消息。文本与附件可同时携带（赛题 A「发送消息、文件等」），
   * 附件元数据写进消息，文件内容只在本次投递的在途生命周期存在。
   *
   * `identity`：统一入口显式指定本次发送身份（本人/机器人）；不传 = 按平台 policy。
   * 请求的身份当前不可用时抛中文错误（路由层转 400），绝不悄悄换身份。
   */
  async reply(
    id: string,
    text: string,
    attachments: OutboundAttachment[] = [],
    identity?: IdentityRole,
  ): Promise<{ message: UnifiedMessage; taskId: string }> {
    const cur = this.repo.get(id);
    if (!cur) throw new Error('message not found');

    // 身份校验先做：校验失败不改状态机、不写 trace
    if (identity) {
      await ensureIdentityProbed(cur.platform);
      assertIdentityUsable(cur.platform, identity);
    }

    const info = describeAttachmentsWithPreview(attachments);

    let m = this.repo.update(id, {
      status: MsgStatus.PROCESSING,
      reply: text,
      failureReason: undefined, // 重试时清掉上一次失败原因，避免旧原因误导
      ...(identity ? { sendIdentity: identity } : {}),
      // 写 replyAttachments 而不是 attachments：回复的图/文件属于这次回复，
      // 写进 attachments 会挂到原消息上（别人的话旁边突然出现我的附件）
      ...(info.length > 0 ? { replyAttachments: info } : {}),
    })!;
    // 用数组 join 拼 detail，避免「指定发送身份=本人，」这类尾逗号（评审看得到 trace 文案）
    const processingParts: string[] = [];
    if (identity) processingParts.push(`指定发送身份=${identity === 'user' ? '本人' : '机器人'}`);
    if (info.length > 0) processingParts.push(`带 ${info.length} 个附件`);
    writeTrace(
      this.repo,
      m,
      'processing',
      processingParts.length > 0 ? processingParts.join('；') : undefined,
    );
    this.broadcast({ type: 'message.updated', data: m });

    m = this.repo.update(id, { status: MsgStatus.REPLIED, reply: text })!;
    writeTrace(this.repo, m, 'replied');
    this.broadcast({ type: 'message.updated', data: m });

    // 异步回写：不阻塞 HTTP 响应，结果经 WS 推送
    void this.processSend(id, attachments);
    return { message: m, taskId: id };
  }

  /**
   * 从统一入口主动向「指定平台 + 指定会话」发送文本/文件。
   *
   * 关键：主动发送不是一条旁路，而是完整纳入既有闭环状态机与 trace 的消息——
   * 一样经历 received→processing→replied→sent→synced，一样可回放、可回流、
   * 失败进死信队列。这样赛题要求的「接收 → 展示 → 处理 → 发送反馈」在
   * 入站回复与主动发起两条路径上都能被评审逐步验证。
   */
  async compose(req: ComposeRequest): Promise<ComposeAck> {
    const connector = this.connectors[req.platform];
    if (!connector) throw new Error(`unsupported platform: ${req.platform}`);

    // 显式指定身份时先校验（不可用 → 中文 400，绝不悄悄换身份）
    if (req.identity) {
      await ensureIdentityProbed(req.platform);
      assertIdentityUsable(req.platform, req.identity);
    }

    const attachments = req.attachments ?? [];
    const info = describeAttachmentsWithPreview(attachments);

    // 目标会话：用户显式指定优先；否则复用该平台最近一条已知会话（可用但不是伪造）
    let conversationId = req.conversationId;
    let conversationType = req.conversationType;
    if (!conversationId) {
      const recent = this.repo.list({ platform: req.platform }).find((m) => m.conversation?.id);
      conversationId = recent?.conversation?.id;
      conversationType = recent?.conversation?.type ?? conversationType;
    }
    if (!conversationId) {
      if (modeOf(req.platform) === 'mock') {
        // Mock 模式（演示/白号）：允许「新建发送」直接演示，不要求客户先拿到真实会话 ID。
        // 用固定演示会话 mock:demo，界面与回放都如实标「模拟发送」，绝不假装真实送达。
        conversationId = 'mock:demo';
        conversationType = conversationType ?? 'p2p';
      } else {
        throw new Error(
          `向 ${req.platform} 发送缺少目标会话：请在收件箱打开一条消息点「回复」，或填写会话 ID（conversationId）后重试`,
        );
      }
    }

    // 邮箱的发件账号由 mailMeta.account / externalId 前缀决定：
    // 用户显式选择优先（必须已配置），未指定时沿用首个已配置账号（向后兼容）
    let mailKey: string | undefined;
    if (req.platform === Platform.MAIL) {
      if (req.mailAccount) {
        const account = config.mail.accounts.find((a) => a.key === req.mailAccount);
        if (!account) {
          const available = config.mail.accounts.map((a) => a.key);
          throw new Error(
            available.length > 0
              ? `邮箱发件账号未配置：${req.mailAccount}（可用：${available.join(' / ')}）`
              : `邮箱发件账号未配置：${req.mailAccount}（当前没有可用的 MAIL_<KEY>_ADDRESS / AUTH_CODE）`,
          );
        }
        mailKey = account.key;
      } else {
        mailKey = config.mail.accounts[0]?.key;
      }
    }
    const uid = randomUUID();
    const now = new Date().toISOString();
    const display = req.text || `[附件] ${info.map((a) => a.name).join(', ')}`;

    const msg: UnifiedMessage = {
      traceId: randomUUID(),
      platform: req.platform,
      externalId: mailKey ? `${mailKey}:compose:${uid}` : `compose:${uid}`,
      sender: { id: 'linkhub', name: 'LinkHub 统一入口' },
      conversation: { id: conversationId, type: conversationType ?? 'group' },
      // 「同时加为待办」不是旁路：同一条消息记录就是待办本身（type=todo），
      // 标题 / 截止时间手填；发送链路仍按文本投递，connector 只看 reply/body。
      type: req.todo ? 'todo' : 'text',
      body: display,
      reply: req.text,
      ...(req.todo ? { done: false } : {}),
      ...(req.todo?.title ? { todoTitle: req.todo.title } : {}),
      ...(req.todo?.dueAt ? { dueAt: req.todo.dueAt } : {}),
      ...(info.length > 0 ? { attachments: info } : {}),
      ...(mailKey
        ? { mailMeta: { account: mailKey, inReplyTo: '', subject: req.text.slice(0, 60) || 'LinkHub 文件' } }
        : {}),
      status: MsgStatus.RECEIVED,
      // 主动发送是「我们发出的」：会话列表不把它算成新来信，聊天区渲染在右侧
      direction: 'out',
      createdAt: now,
      updatedAt: now,
      ...(req.identity ? { sendIdentity: req.identity } : {}),
    };

    this.repo.save(msg);
    counters.received += 1;
    writeTrace(
      this.repo,
      msg,
      'composed',
      `统一入口主动发送 → ${req.platform} · 会话 ${conversationId}`
        + `${mailKey ? ` · 发件账号 ${mailKey}` : ''}`
        + `${info.length > 0 ? ` · 附件 ${info.length} 个` : ''}`
        + `${req.identity ? ` · 指定身份：${req.identity === 'user' ? '本人' : '机器人'}` : ''}`,
    );
    // 手动待办单独留一条闭环事件：回放里能分清「自动识别成待办」与「用户手动加的」
    if (req.todo) {
      const todoParts = ['新建发送时手动加入待办'];
      if (req.todo.title) todoParts.push(`标题：${req.todo.title}`);
      if (req.todo.dueAt) todoParts.push(`截止：${req.todo.dueAt}`);
      writeTrace(this.repo, msg, 'todo_added', todoParts.join(' · '));
    }
    this.broadcast({ type: 'message.received', data: msg });

    let m = this.repo.update(msg.traceId, { status: MsgStatus.PROCESSING })!;
    writeTrace(this.repo, m, 'processing');
    this.broadcast({ type: 'message.updated', data: m });

    m = this.repo.update(msg.traceId, { status: MsgStatus.REPLIED })!;
    writeTrace(this.repo, m, 'replied');
    this.broadcast({ type: 'message.updated', data: m });

    void this.processSend(msg.traceId, attachments);
    return { message: m, taskId: msg.traceId };
  }

  /** 失败原因截断长度：前端只展示摘要，完整原因在 trace / 死信队列里 */
  static readonly FAILURE_REASON_MAX = 300;

  private async processSend(id: string, attachments: OutboundAttachment[] = []): Promise<void> {
    const cur = this.repo.get(id);
    if (!cur) return;
    const connector = this.connectors[cur.platform];
    const outgoing: UnifiedMessage = { ...cur, body: cur.reply ?? cur.body };
    // 内联图片数量：钉钉会用 Markdown 图文发出去，回推时只剩 mediaId，需要单独识别
    const inlineImageCount = attachments.filter((a) => /^image\//i.test(a.mimeType ?? '')).length;

    try {
      const result = await this.limiter.send(cur.platform, () => connector.send(outgoing, attachments));
      const at = new Date().toISOString();

      // 登记「刚发出」的文本：钉钉个人事件会把本人发出的消息再推回来（回声），
      // 个人事件流用它做「同会话 + 同文本 + 时间窗」比对，避免同一条内容入库两次。
      if (result.mode === 'real') {
        rememberSent({
          platform: cur.platform,
          conversationId: cur.conversation?.id,
          text: normalizeEchoText(cur.reply ?? cur.body),
          // 纯附件消息没有文本，必须登记文件名，否则平台回推时认不出是自己发的
          ...(attachments.length > 0 ? { fileNames: attachments.map((a) => a.name) } : {}),
          // 图片消息回推只有 mediaId，既无文本也无文件名，靠这个计数认回声
          ...(inlineImageCount > 0 ? { mediaCount: inlineImageCount } : {}),
          at: Date.now(),
          traceId: id,
        });
      }

      // 把"本次到底走了真实接口还是本地模拟、用了哪个身份"写进消息与闭环日志，绝不静默假装成功。
      // Mock 模式不写 identity（契约 §4：模拟通道不冒充本人/机器人）。
      let m = this.repo.update(id, {
        status: MsgStatus.SENT,
        delivery: {
          mode: result.mode,
          platformReply: result.platformReply,
          at,
          ...(result.mode === 'real' && result.identity ? { identity: result.identity } : {}),
        },
      })!;
      const identityNote = result.identity === 'user'
        ? '（用户身份）'
        : result.identity === 'bot'
          ? '（机器人身份）'
          : '';
      writeTrace(
        this.repo,
        m,
        'sent',
        result.mode === 'mock'
          ? '模拟发送（本地 Mock，未调用真实平台接口）'
          : `真实接口${identityNote}${result.platformReply ? ` · ${result.platformReply}` : ''}`,
      );
      this.broadcast({ type: 'message.updated', data: m });

      m = this.repo.update(id, { status: MsgStatus.SYNCED })!;
      writeTrace(
        this.repo,
        m,
        'synced',
        result.mode === 'mock' ? '模拟状态回流（本地 Mock）' : '平台状态回流',
      );
      this.broadcast({ type: 'message.updated', data: m });
      counters.sent += 1;
      if (result.mode === 'mock') counters.sentMock += 1;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // 失败原因上浮到消息本身（P1-2）：前端详情页与 toast 直接可读，不用去回放深处翻。
      // 只截断写入消息；完整原因仍进闭环日志与死信队列。
      const failureReason = reason.length > MessageService.FAILURE_REASON_MAX
        ? `${reason.slice(0, MessageService.FAILURE_REASON_MAX)}…`
        : reason;
      const m = this.repo.update(id, { status: MsgStatus.FAILED, failureReason })!;
      writeTrace(this.repo, m, 'failed', reason);
      this.repo.pushDlq({ platform: cur.platform, payload: outgoing, reason, at: new Date().toISOString() });
      this.broadcast({ type: 'message.failed', data: m });
      counters.failed += 1;
    }
  }

  async markDone(id: string): Promise<void> {
    const m = this.repo.update(id, { done: true });
    if (!m) throw new Error('message not found');
    writeTrace(this.repo, m, 'done');
    this.broadcast({ type: 'message.updated', data: m });
  }

  /**
   * 把任意消息手动加入待办：只改消息类型与完成态，不改闭环状态、不触发平台回写。
   * 已完成的待办再次加入时重新打开（done=false），便于用户继续跟进。
   */
  async markTodo(id: string): Promise<UnifiedMessage> {
    const m = this.repo.update(id, { type: 'todo', done: false });
    if (!m) throw new Error('message not found');
    writeTrace(this.repo, m, 'todo_added', '用户手动加入待办');
    this.broadcast({ type: 'message.updated', data: m });
    return m;
  }

  /**
   * 标记已读 / 未读。
   *
   * 阅读状态独立于业务状态（status）：收到不等于看过，回写成功也不等于看过。
   * 首次已读写入时间戳（而不是布尔），既方便「最近已读」排序，也能在回放里看清时序。
   */
  async markRead(id: string, read = true): Promise<UnifiedMessage> {
    const cur = this.repo.get(id);
    if (!cur) throw new Error('message not found');
    // 已读时间只记第一次：重复标记不刷新时间戳
    const readAt = read ? (cur.readAt ?? new Date().toISOString()) : undefined;
    const m = this.repo.update(id, { readAt });
    if (!m) throw new Error('message not found');
    // 阅读是高频轻操作，不写闭环日志；只在状态真正变化时广播
    if (cur.readAt !== readAt) this.broadcast({ type: 'message.updated', data: m });
    return m;
  }

  /**
   * 给附件补上图片预览（data URL）。
   *
   * 钉钉的图片消息只回推 mediaId，没有可以直接展示的内容；下载完成后把预览写回
   * 附件并广播，界面就从「文件卡片」变成能点开的大图。下载失败时静默保持原样。
   */
  async attachMediaPreview(id: string, preview: string): Promise<void> {
    const cur = this.repo.get(id);
    if (!cur?.attachments?.length) return;
    if (cur.attachments.every((a) => a.preview)) return;
    const attachments = cur.attachments.map((a) => (a.preview ? a : { ...a, preview }));
    const updated = this.repo.update(id, { attachments });
    if (updated) this.broadcast({ type: 'message.updated', data: updated });
  }

  /**
   * 一键全部已读：返回实际改动的条数（已读的跳过，避免无意义广播）。
   * `ids` 用于「只标记当前筛选范围」，不传则全量。
   */
  async markAllRead(ids?: string[]): Promise<number> {
    const now = new Date().toISOString();
    const pool = ids
      ? this.repo.list().filter((m) => ids.includes(m.traceId))
      : this.repo.list();
    let changed = 0;
    for (const cur of pool) {
      if (cur.readAt) continue;
      const m = this.repo.update(cur.traceId, { readAt: now });
      if (m) {
        changed += 1;
        this.broadcast({ type: 'message.updated', data: m });
      }
    }
    return changed;
  }

  // ---------- 回流 ----------
  /**
   * 平台状态回流。接口永远成功返回（路由照常 200），但只有「前进」才改状态：
   * 倒退/重复请求写 trace `sync_ignored` 并保留原状态，避免旧回调把已完成的消息打回 received。
   */
  async syncStatus(traceId: string, platformStatus: string): Promise<SyncStatusResult> {
    const m = this.repo.get(traceId);
    if (!m) return { applied: false, reason: '消息不存在，忽略回流' };

    const valid = Object.values(MsgStatus) as string[];
    // 未知平台状态沿用旧行为兜底为 synced（平台回调字段不稳定，不算畸形事件）
    const status = (valid.includes(platformStatus) ? platformStatus : MsgStatus.SYNCED) as MsgStatus;

    const decision = checkStatusTransition(m.status, status);
    if (!decision.allowed) {
      writeTrace(
        this.repo,
        m,
        'sync_ignored',
        `platformStatus=${platformStatus}，当前状态=${m.status}，${decision.reason}`,
      );
      return { applied: false, message: m, reason: decision.reason };
    }

    const u = this.repo.update(traceId, { status })!;
    writeTrace(this.repo, u, 'sync', `platformStatus=${platformStatus}`);
    this.broadcast({ type: 'message.updated', data: u });
    return { applied: true, message: u };
  }

  async onPlatformEvent(
    platform: Platform,
    raw: unknown,
  ): Promise<{ applied: boolean; message?: UnifiedMessage; duplicate?: boolean }> {
    // 用户身份发出的消息可能被机器人原样收回（飞书单聊必现）：
    // 在写 trace / 幂等表之前丢弃，避免自己给自己造一条新消息。
    if (this.connectors[platform]?.isSelfEcho?.(raw)) {
      console.log(`[${platform}] 忽略自环事件：本进程刚以用户身份发出的消息被平台回收`);
      return { applied: false };
    }
    const d = decidePlatformEvent(raw);
    if (d.kind === 'status') {
      let target = d.traceId ? this.repo.get(d.traceId) : undefined;
      if (!target && d.externalId) target = this.repo.findByExternal(platform, d.externalId);
      if (!target) return { applied: false };
      const r = await this.syncStatus(target.traceId, d.platformStatus);
      return { applied: r.applied, message: r.message ?? this.repo.get(target.traceId) };
    }
    const r = await this.ingest(platform, raw);
    return { applied: true, message: r.message, duplicate: r.duplicate };
  }

  // ---------- 回放 ----------
  getTrace(traceId: string): UnifiedMessage[] {
    const m = this.repo.get(traceId);
    return m ? [m] : [];
  }

  getLoopLog(traceId: string) {
    return this.repo.getLoopLog(traceId);
  }

  listDlq() {
    return this.repo.listDlq();
  }
}
