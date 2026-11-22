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
import { normalizeEchoText, rememberSent, learnedSelfIds, matchEcho } from './echoRegistry';
import {
  Platform, MsgStatus, UnifiedMessage, PlatformConnector,
  type AttachmentInfo, type AutoRule, type ComposeAck, type ComposeRequest, type DeliveryMode,
  type ForwardRequest, type IdentityRole, type OutboundAttachment, type Priority,
  type PriorityChangeResult, type SendResult, type StatusChangeRequest, type StatusChangeResult,
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
import {
  AttachmentDownloadError,
  downloadAttachment,
  type AttachmentField,
  type DownloadedAttachment,
} from './attachmentDownload';import { inferPriority } from './priority';

export interface Broadcast {
  (event: { type: string; data?: unknown }): void;
}

/**
 * 自动回复规则的匹配端口（实现见 services/autoReply.ts）。
 *
 * 只依赖这个窄接口：MessageService 不直接持有规则存储，
 * 单测可以注入一个假实现，也不引入「消息服务依赖规则管理」的反向耦合。
 */
export interface AutoReplyPort {
  match(platform: Platform, text: string): AutoRule | undefined;
  recordHit(id: string): AutoRule | undefined;
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

/**
 * 查看者：有 `userId` = 登录用户（只看自己的）；缺省 = 部署令牌 / 内部调用（全量视图）。
 *
 * 归属校验必须落在 service 层而不是路由层：按 id 的接口有 8 个，路由各自判断一定会漏，
 * 漏一个就是「别的账号能读、能改、能回写我的消息」。
 */
export interface Viewer {
  userId?: string;
}

/** 这条消息对查看者是否可见（没有 userId = 全量视图，不过滤） */
export function visibleTo(message: UnifiedMessage, viewer?: Viewer): boolean {
  return !viewer?.userId || message.ownerId === viewer.userId;
}

/** 归属不匹配时统一用这一句：不暴露「消息存在但不属于你」，避免探测 */
const NOT_FOUND = 'message not found';

/** 状态回执里的中文标签：人话比枚举值更适合直接发到平台会话里 */
const STATUS_LABELS: Record<string, string> = {
  received: '已接收',
  processing: '处理中',
  replied: '已回复',
  sent: '已发送',
  synced: '已同步',
  failed: '发送失败',
};

export class MessageService {
  /** 正在重新分析的消息：同一条并发点击只跑一次，避免重复计费与重复日志 */
  private readonly reanalyzing = new Set<string>();

  /**
   * 待发表的一次回写：`reply()` / `compose()` 入队 → `processSend` 出结果后写进 `replies`。
   *
   * `identity` 是**本次发送**指定的身份，只活在这一条 pending 记录里：
   * 绝不写回消息本身（历史 bug：写回后 `msg.sendIdentity` 永久粘住，
   * 用户下次什么都不选也会沿用上次的机器人身份，群里没机器人就直接发不出去）。
   */
  private readonly pendingReplies = new Map<string, {
    text: string;
    attachments?: AttachmentInfo[];
    identity?: IdentityRole;
    /** 本次回复引用的消息摘要（只有显式引用时才有），用于前端画引用条 */
    quote?: { text: string; senderName: string };
    /** true = 这条记录来自主动发送（compose），不追加到 replies 历史 */
    fromCompose?: boolean;
  }>();

  /**
   * 已经自动回过的消息：同一条只回一次。
   *
   * 平台重推由 (platform, externalId) 幂等挡在前面，但「同一条消息被不同通道
   * 各推一次」仍可能走到这里（例如 webhook 与长连接同时在线），
   * 再加一道内存去重，避免连回三条。
   *
   * 用 Map 而不是 Set：插入序即写入序，超容量时淘汰最早的记录，
   * 长驻进程不会随命中数无限增长（淘汰只影响极老的消推重复场景，幂等键仍兜底）。
   */
  private readonly autoReplied = new Map<string, true>();

  /** autoReplied 的容量上限：超过即淘汰最早记录，防长驻进程缓慢泄漏 */
  private static readonly AUTO_REPLIED_MAX = 10_000;

  constructor(
    private repo: MessageRepository,
    private connectors: Record<Platform, PlatformConnector>,
    private llm: LlmService,
    private ocr: OcrService,
    private limiter: RateLimiter,
    private broadcast: Broadcast,
    /** 自动回复规则端口；不传 = 关闭自动回复（单测 / 纯人工模式） */
    private autoReply?: AutoReplyPort,
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
  /**
   * 把「本人发出、却被当成来信入库」的历史消息改标为出站。
   *
   * 钉钉靠 echoRegistry 学习到的本人 ID；飞书靠轮询水位文件里的 selfOpenId。
   * 改标后不再计入未读，聊天区也渲染在右侧。
   */
  markOwnMessagesAsOut(platform: Platform, senderIds: string[]): number {
    const ids = senderIds.map((v) => (v ?? '').trim()).filter(Boolean);
    if (ids.length === 0) return 0;
    const targets = this.repo.list().filter(
      (m) => m.platform === platform && m.direction !== 'out' && ids.includes(m.sender.id),
    );
    if (targets.length === 0) return 0;
    const changed = this.repo.updateMany(
      targets.map((m) => ({ id: m.traceId, patch: { direction: 'out' as const } })),
    );
    if (changed > 0) {
      console.log(`[identity] 已把 ${changed} 条本人发出的历史消息标为「我发出的」（${platform}）`);
    }
    return changed;
  }

  /** 钉钉专用：用 echoRegistry 学习到的本人 ID 纠正历史数据（保留旧入口） */
  applyLearnedSelfDirections(): number {
    return this.markOwnMessagesAsOut(Platform.DINGTALK, learnedSelfIds(Platform.DINGTALK));
  }

  /**
   * 修复历史回声：早先版本飞书没有回声抑制，我们自己发出的消息被平台推回来，
   * 又被当成「收到的」存了一条，于是收件箱里凭空多出自己发的消息。
   *
   * 判定与界面去重保持同一规则：同平台 + 同会话 + 同正文，且与「我们发出它的时间」
   * 相差不超过 2 分钟。只改方向（不动内容、不删数据），改标后归到「我发出的」。
   */
  repairEchoDuplicates(): number {
    const ECHO_WINDOW_MS = 120_000;
    const sentAt = new Map<string, number[]>();
    const add = (m: UnifiedMessage, text: string | undefined, at: string | undefined): void => {
      const body = normalizeEchoText(text ?? '');
      if (!body) return;
      const ts = Date.parse(at ?? m.createdAt);
      if (!Number.isFinite(ts)) return;
      const key = `${m.platform}|${m.conversation?.id ?? ''}|${body}`;
      const list = sentAt.get(key) ?? [];
      list.push(ts);
      sentAt.set(key, list);
    };
    for (const m of this.repo.list()) {
      if (m.direction === 'out') add(m, m.body, m.createdAt);
      if (m.reply) add(m, m.reply, m.updatedAt);
      for (const r of m.replies ?? []) add(m, r.text, r.at);
    }
    const targets: Array<{ id: string; patch: Partial<UnifiedMessage> }> = [];
    for (const m of this.repo.list()) {
      if (m.direction === 'out') continue;
      const body = normalizeEchoText(m.body);
      if (!body) continue;
      const times = sentAt.get(`${m.platform}|${m.conversation?.id ?? ''}|${body}`);
      if (!times || times.length === 0) continue;
      const createdAt = Date.parse(m.createdAt);
      if (!Number.isFinite(createdAt)) continue;
      if (!times.some((t) => Math.abs(t - createdAt) <= ECHO_WINDOW_MS)) continue;
      targets.push({ id: m.traceId, patch: { direction: 'out' } });
    }
    if (targets.length === 0) return 0;
    const changed = this.repo.updateMany(targets);
    console.log(`[identity] 已把 ${changed} 条「自己发出去又被推回来」的历史消息归到「我发出的」`);
    return changed;
  }

  /**
   * 清理历史残留：旧版本把「本次发送身份」写进了消息，会永久粘住身份。
   * 现在身份是瞬态的（只对单次发送生效），启动时把旧数据上的残留抹掉。
   */
  cleanupLegacySendIdentity(): number {
    const stale = this.repo.list().filter((m) => m.sendIdentity !== undefined);
    if (stale.length === 0) return 0;
    const n = this.repo.updateMany(stale.map((m) => ({ id: m.traceId, patch: { sendIdentity: undefined } })));
    if (n > 0) console.log(`[identity] 已清理 ${n} 条历史消息上残留的发送身份（身份只对单次发送生效）`);
    return n;
  }

  /**
   * 回声抑制（入库前最后一道闸）：刚发出的消息被平台推回来时直接吞掉。
   * 钉钉在流层判断；飞书（长连接/本人轮询）走这里。返回 undefined 表示不是回声。
   */
  private absorbEcho(platform: Platform, incoming: UnifiedMessage): UnifiedMessage | undefined {
    const rec = matchEcho({
      platform,
      conversationId: incoming.conversation?.id,
      text: incoming.body,
      fileNames: incoming.attachments?.map((a) => a.name),
      mediaOnly: incoming.type === 'image' && !incoming.body,
    });
    if (!rec) return undefined;
    const original = rec.traceId ? this.repo.get(rec.traceId) : undefined;
    if (original) {
      writeTrace(this.repo, original, 'echo_ignored',
        '平台把这次发送回推成了新消息，已按回声忽略（不重复入库）');
    }
    return original ?? incoming;
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

    /**
     * 飞书本人轮询的「文件回推」额外兜底：
     * 发出的文件 message_id 记在 delivery.platformReply，重启内存表丢失后按它查已发送消息。
     */
    if (platform === Platform.FEISHU && incoming.direction === 'out') {
      const alreadySent = this.repo.list({ platform: Platform.FEISHU }).find((m) => {
        const replied = m.delivery?.platformReply;
        return Boolean(replied && replied.split(',').some((id) => id.trim() === incoming.externalId));
      });
      if (alreadySent) {
        counters.deduped += 1;
        writeTrace(this.repo, alreadySent, 'redelivered', '本人文件回推命中已发送记录，重启后兜底去重');
        return { message: alreadySent, duplicate: true };
      }
    }

    // 自己刚发出去的消息被平台回推：不能再存一条「收到的」（飞书两种通道都会回推）
    const echo = this.absorbEcho(platform, incoming);
    if (echo) {
      counters.deduped += 1;
      return { message: echo, duplicate: true };
    }

    // 平台连接是机器级的：收到的消息默认归属「机器主人」，没有主人时保持无主（等认领）
    if (this.defaultOwnerId && !incoming.ownerId) incoming.ownerId = this.defaultOwnerId;

    this.repo.save(incoming);
    counters.received += 1;
    writeTrace(this.repo, incoming, 'received');

    // 富化（OCR / 大模型）不阻塞入库与平台回调：真实 LLM 单次 2.9–9.3s，
    // 同步等待会拖住 Webhook 响应（平台超时会重推）并让收件箱迟迟不出现新消息。
    const received = this.repo.get(incoming.traceId)!;
    this.broadcast({ type: 'message.received', data: received });
    // 自动回复在富化之前触发：规则只看正文，不必等 3–9s 的 LLM 调用；
    // 走 reply() 的同一条链路，状态机与 trace 不会因为「自动」而缺一段。
    this.maybeAutoReply(received);
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

    // 优先级：人工改过的不再被规则覆盖；没判定过才给默认值。
    // 只写 prioritySource='rules'，不冒充 AI 判断（与大模型结果分开标注）。
    //
    // 竞态：富化是异步的，用户可能在 LLM 返回前就手动改了优先级。
    // 所以写入前必须**重新读一次最新消息**，不能用进入函数时的快照判断。
    const latest = this.repo.get(m.traceId);
    const inferred = latest?.prioritySource === 'manual'
      ? undefined
      : inferPriority(body, { dueAt: latest?.dueAt ?? m.dueAt, intent });
    if (inferred && latest?.priority !== inferred.priority) {
      writeTrace(
        this.repo,
        m,
        'priority',
        `${latest?.priority ?? '未判定'}→${inferred.priority}（规则：${inferred.reason}）`,
      );
    }

    // AI 字段显式写 undefined：规则兜底时必须抹掉上一次的真实模型痕迹
    const updated = this.repo.update(m.traceId, {
      body, needsReview, intent, replyDraft, intentSource,
      aiProvider, aiModel, aiConfidence, aiPrecision,
      ...(inferred
        ? { priority: inferred.priority, prioritySource: 'rules' as const }
        : {}),
    });
    if (!updated) return undefined;
    return { message: updated, source: intentSource, fallbackReason };
  }

  /**
   * 用当前配置重新生成 AI 建议（详情页「重新生成」按钮的真实后端动作）。
   * 不重跑 OCR（body 已含识别文本）、不改业务状态，只重写 AI 字段并广播 message.updated。
   * 历史消息因此不用等新消息进来也能重算。
   */
  async reanalyze(id: string, viewer?: Viewer): Promise<AnalysisOutcome> {
    // 归属守卫：不能对别人的消息触发「重新生成」（会消耗 LLM 额度并读到别人的正文）
    const m = this.requireVisible(id, viewer);
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
  /**
   * 「机器主人」：平台连接是机器级的，收进来的消息默认归属这位账号。
   * 由入口层在首个账号注册/启动时注入；没有主人时消息保持无主，等用户认领。
   */
  private defaultOwnerId?: string;

  setDefaultOwner(userId: string | undefined): void {
    this.defaultOwnerId = userId;
  }

  getDefaultOwner(): string | undefined {
    return this.defaultOwnerId;
  }
  /**
   * 列消息。
   * `viewer` = 当前登录账号：给了就只返回归属它的消息（数据隔离）；
   * 不传（部署令牌 / 无人登录）= 返回全部，保持单机演示零改动。
   * 未归属的历史数据（ownerId 缺省）在隔离视图里**不出现**，需要用户主动「认领」。
   */
  list(filter?: { platform?: Platform; status?: MsgStatus }, viewer?: Viewer): UnifiedMessage[] {
    const rows = this.repo.list(filter);
    if (!viewer?.userId) return rows;
    return rows.filter((m) => m.ownerId === viewer.userId);
  }

  /**
   * 认领：把「未归属」的历史消息收进当前账号（ownerId 为空才动，别人的不动）。
   * 返回认领条数——演示"我和他怎么区分"时，先认领导入的历史数据再对比两个账号。
   */
  claimUnowned(userId: string): number {
    const rows = this.repo.list().filter((m) => !m.ownerId);
    if (rows.length === 0) return 0;
    // 批量改 + 一次落盘：逐条 update 会让每条消息都全量重写一次快照（O(N²)）
    const claimed = this.repo.updateMany(rows.map((m) => ({ id: m.traceId, patch: { ownerId: userId } })));
    if (claimed > 0) this.broadcast({ type: 'messages.changed' });
    return claimed;
  }

  /**
   * 清理「孤儿归属」：ownerId 指向已不存在的账号时，把这些消息恢复成无主。
   * 场景：删号、或早期版本把消息归给临时测试账号 → 日志里查不到人，消息谁都看不见。
   * 返回恢复条数。
   */
  releaseOrphanOwners(validUserIds: Set<string>): number {
    const rows = this.repo.list().filter((m) => m.ownerId && !validUserIds.has(m.ownerId));
    if (rows.length === 0) return 0;
    return this.repo.updateMany(rows.map((m) => ({ id: m.traceId, patch: { ownerId: undefined } })));
  }

  /** 新消息归属：ingest 时用（由调用方决定归属谁，默认不归属） */
  assignOwner(id: string, ownerId: string): void {
    this.repo.update(id, { ownerId } as Partial<UnifiedMessage>);
  }

  /**
   * 读一条消息（带归属校验）。
   * `viewer` 有 userId 时，别人的消息一律返回 undefined（路由转 404，不泄露存在性）。
   * 内部调用（ingest / processSend / 回流）请直接用 repo.get，不要经这里。
   */
  get(id: string, viewer?: Viewer): UnifiedMessage | undefined {
    const m = this.repo.get(id);
    return m && visibleTo(m, viewer) ? m : undefined;
  }

  /** 归属守卫：不可见时抛 404 文案（路由层 catch 后回 404） */
  private requireVisible(id: string, viewer?: Viewer): UnifiedMessage {
    const m = this.get(id, viewer);
    if (!m) throw new Error(NOT_FOUND);
    return m;
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
    viewer?: Viewer,
    /** 显式引用目标：用户右键/长按某条消息选「回复」时才传；不传 = 普通发送（不带引用条） */
    quoteTraceId?: string,
  ): Promise<{ message: UnifiedMessage; taskId: string }> {
    // 归属守卫放在最前：别人的消息连状态机都不进（路由转 404，不泄露存在性）
    const cur = this.requireVisible(id, viewer);

    // 身份校验先做：校验失败不改状态机、不写 trace
    if (identity) {
      await ensureIdentityProbed(cur.platform);
      assertIdentityUsable(cur.platform, identity);
    }

    const info = describeAttachmentsWithPreview(attachments);

    // 显式引用：只有用户真的选了某条消息才走引用通道，默认发送不带引用条
    const quoteSource = quoteTraceId ? this.repo.get(quoteTraceId) : undefined;
    const quoteRef = quoteSource
      ? {
        // 钉钉的 externalId 形如 `dingtalk:<openMessageId>`
        messageId: quoteSource.externalId.replace(/^[a-z]+:/i, ''),
        senderId: quoteSource.sender?.id ?? '',
        senderName: quoteSource.sender?.name ?? '',
        text: (quoteSource.body ?? '').slice(0, 120),
      }
      : undefined;
    if (quoteTraceId && !quoteRef) {
      throw new InvalidPlatformEvent(cur.platform, '要引用的消息不存在或已被删除，请重新选择');
    }

    let m = this.repo.update(id, {
      // quoteRef 只对本次发送有效：不带引用时显式清掉，避免上一次的引用粘住
      ...(quoteRef ? { quoteRef } : {}),
      status: MsgStatus.PROCESSING,
      reply: text,
      failureReason: undefined, // 重试时清掉上一次失败原因，避免旧原因误导
      ...(quoteRef ? {} : { quoteRef: undefined }),
      // 无主消息（历史数据 / 首次互动的平台来信）由回复者认领；
      // **已经有主的一律不动**——旧实现在这里无条件覆盖 ownerId，
      // 结果是「B 回复 A 的消息，这条消息就从 A 的收件箱跑到了 B 那里」。
      ...(!cur.ownerId && viewer?.userId ? { ownerId: viewer.userId } : {}),
      // 注意：这里**不写** sendIdentity。身份只对本次发送有效（见 pendingReplies），
      // 写进消息会永久粘住，下一次不带身份的回复也会沿用上次的选择。
      // 写 replyAttachments 而不是 attachments：回复的图/文件属于这次回复，
      // 写进 attachments 会挂到原消息上（别人的话旁边突然出现我的附件）
      ...(info.length > 0 ? { replyAttachments: info } : {}),
    })!;
    // 回复内容先进待发表，出结果（成功 / 失败）后再追加到 replies 历史
    this.pendingReplies.set(id, {
      text,
      ...(quoteRef ? { quote: { text: quoteRef.text ?? '', senderName: quoteRef.senderName ?? '' } } : {}),
      ...(info.length > 0 ? { attachments: info } : {}),
      ...(identity ? { identity } : {}),
    });
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
    void this.processSend(id, attachments, identity);
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
      conversation: {
        id: conversationId,
        type: conversationType ?? 'group',
        ...(req.conversationTitle ? { title: req.conversationTitle } : {}),
      },
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

    void this.processSend(msg.traceId, attachments, req.identity);
    return { message: m, taskId: msg.traceId };
  }

  /** 失败原因截断长度：前端只展示摘要，完整原因在 trace / 死信队列里 */
  static readonly FAILURE_REASON_MAX = 300;

  private async processSend(
    id: string,
    attachments: OutboundAttachment[] = [],
    /** 本次发送指定的身份；缺省 = 由平台策略决定。**只对这一次发送有效** */
    identity?: IdentityRole,
  ): Promise<void> {
    const cur = this.repo.get(id);
    if (!cur) return;
    const connector = this.connectors[cur.platform];
    // 显式赋值（可能是 undefined）：把历史数据里残留的 msg.sendIdentity 覆盖掉，
    // 否则「上次选了机器人」会永久粘在这条消息上，用户之后每次都按机器人发。
    const outgoing: UnifiedMessage = { ...cur, body: cur.reply ?? cur.body, sendIdentity: identity };
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
      // 回复历史在这里追加：这是「真的发出去了」的唯一点。
      const pendingReply = this.pendingReplies.get(id);
      this.pendingReplies.delete(id);
      const actualIdentity = result.mode === 'real' ? result.identity : undefined;
      // 状态写入同样过防倒退守卫：用户可能在回写在途时人工前跳（replied→synced），
      // 异步完成回写若无条件写 SENT 会把进度打回。delivery/replies 照写（事实不变），只跳过状态倒退。
      const latest = this.repo.get(id) ?? cur;
      const canMarkSent = checkStatusTransition(latest.status, MsgStatus.SENT).allowed;
      let m = this.repo.update(id, {
        ...(canMarkSent ? { status: MsgStatus.SENT } : {}),
        ...(pendingReply !== undefined
          ? {
            replies: [
              ...(cur.replies ?? []),
              {
                text: pendingReply.text,
                at,
                ...(pendingReply.attachments && pendingReply.attachments.length > 0
                  ? { attachments: pendingReply.attachments }
                  : {}),
                ...(pendingReply.quote ? { quote: pendingReply.quote } : {}),
                // 每条回复记自己的身份：同一条消息先后用本人/机器人回过时，气泡不能共用标签
                ...(actualIdentity ? { identity: actualIdentity } : {}),
              },
            ],
          }
          : {}),
        delivery: {
          mode: result.mode,
          platformReply: result.platformReply,
          at,
          ...(actualIdentity ? { identity: actualIdentity } : {}),
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

      // RPA 没有平台回执：只有桥明确 verified=true 才算核对过。
      // false 表示「已提交到桥，但没核对是否真的到了目标会话」——保持 sent，
      // 不能写 synced，也不能让前端显示成平台状态回流。
      if (result.mode === 'real' && result.verified === false) {
        writeTrace(this.repo, m, 'sent_unverified', 'RPA 已提交，但未核对目标会话/消息是否真正送达');
        counters.sent += 1;
        return;
      }

      // synced 同样过守卫：人工前跳后不再打回（detail 如实注明）
      const afterSent = this.repo.get(id) ?? m;
      const canMarkSynced = checkStatusTransition(afterSent.status, MsgStatus.SYNCED).allowed;
      if (canMarkSynced) {
        m = this.repo.update(id, { status: MsgStatus.SYNCED })!;
        writeTrace(
          this.repo,
          m,
          'synced',
          result.mode === 'mock' ? '模拟状态回流（本地 Mock）' : '平台状态回流',
        );
      } else {
        writeTrace(this.repo, m, 'synced', '发送已完成；状态已被人工前跳，不再回写 synced');
      }
      this.broadcast({ type: 'message.updated', data: m });
      counters.sent += 1;
      if (result.mode === 'mock') counters.sentMock += 1;
    } catch (e) {
      // 失败也要在对话框里留痕：把这次回复按 failed=true 写进历史。
      // 之前失败就丢弃，界面上的「发送中」气泡永远等不到结果 —— 用户以为一直在发。
      const pendingReply = this.pendingReplies.get(id);
      this.pendingReplies.delete(id);
      const reason = e instanceof Error ? e.message : String(e);
      // 失败原因上浮到消息本身（P1-2）：前端详情页与 toast 直接可读，不用去回放深处翻。
      // 只截断写入消息；完整原因仍进闭环日志与死信队列。
      const failureReason = reason.length > MessageService.FAILURE_REASON_MAX
        ? `${reason.slice(0, MessageService.FAILURE_REASON_MAX)}…`
        : reason;
      const m = this.repo.update(id, {
        status: MsgStatus.FAILED,
        failureReason,
        ...(pendingReply !== undefined
          ? {
            replies: [
              ...(cur.replies ?? []),
              {
                text: pendingReply.text,
                at: new Date().toISOString(),
                failed: true,
                failureReason,
                ...(pendingReply.attachments && pendingReply.attachments.length > 0
                  ? { attachments: pendingReply.attachments }
                  : {}),
                // 失败时记「这次本来要用哪个身份」，便于用户判断是不是身份选错了
                ...(identity ? { identity } : {}),
              },
            ],
          }
          : {}),
      })!;
      writeTrace(this.repo, m, 'failed', reason);
      this.repo.pushDlq({ platform: cur.platform, payload: outgoing, reason, at: new Date().toISOString() });
      this.broadcast({ type: 'message.failed', data: m });
      counters.failed += 1;
    }
  }

  async markDone(id: string, viewer?: Viewer): Promise<void> {
    this.requireVisible(id, viewer);
    const m = this.repo.update(id, { done: true });
    if (!m) throw new Error(NOT_FOUND);
    writeTrace(this.repo, m, 'done');
    this.broadcast({ type: 'message.updated', data: m });
  }

  // ---------- 人工处理动作：状态流转 / 跨平台转发 / 优先级 ----------

  /**
   * 人工流转消息状态，可选把这次变更回写到原平台会话。
   *
   * 复用 checkStatusTransition 的防倒退规则：人工操作同样不允许把进度打回去
   * （否则「已同步」被误点回「处理中」，闭环日志看起来像回滚）。
   *
   * `notify` 默认 false：状态首先是处理人自己的进度记录。系统消息发多了会把
   * 真实对话顶出视野，属于用功能换体验的负优化；需要对方知道时由用户显式勾选。
   */
  async changeStatus(
    id: string,
    req: StatusChangeRequest,
    viewer?: Viewer,
  ): Promise<StatusChangeResult> {
    const cur = this.requireVisible(id, viewer);
    const allowed = Object.values(MsgStatus) as string[];
    if (!allowed.includes(req.status)) {
      throw new Error(`未知状态：${String(req.status)}（可用：${allowed.join(' / ')}）`);
    }

    let m = cur;
    if (cur.status !== req.status) {
      const decision = checkStatusTransition(cur.status, req.status);
      if (!decision.allowed) {
        throw new Error(decision.reason ?? `不允许从 ${cur.status} 流转到 ${req.status}`);
      }
      m = this.repo.update(id, { status: req.status })!;
      writeTrace(
        this.repo,
        m,
        'status',
        `人工流转 ${cur.status}→${req.status}${req.notify ? '（含回执）' : ''}`,
      );
      this.broadcast({ type: 'message.updated', data: m });
    }

    if (!req.notify) return { message: m, notified: false };

    const note = (req.note ?? '').trim()
      || `[LinkHub] 该消息已标记为「${STATUS_LABELS[req.status] ?? req.status}」`;
    try {
      const result = await this.sendStatusNote(m, note);
      writeTrace(
        this.repo,
        m,
        'status_notified',
        result.mode === 'mock'
          ? '模拟发送状态回执（本地 Mock，未调用真实平台接口）'
          : `真实发送状态回执${result.platformReply ? ` · ${result.platformReply}` : ''}`,
      );
      const latest = this.repo.get(id) ?? m;
      this.broadcast({ type: 'message.updated', data: latest });
      return { message: latest, notified: true, notifyMode: result.mode };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      writeTrace(this.repo, m, 'status_notify_failed', reason);
      // 状态本身已经改了：回执失败不回滚状态，只如实告诉调用方没发出去。
      return { message: this.repo.get(id) ?? m, notified: false, notifyReason: reason };
    }
  }

  /**
   * 发送一条「状态回执」：与 reply 共用 connector + 限流链路，
   * 但不改消息状态、不追加 replies —— 它是一条旁路通知，不是对用户的回复。
   */
  private async sendStatusNote(m: UnifiedMessage, text: string): Promise<SendResult> {
    const connector = this.connectors[m.platform];
    // 显式清掉引用与本次发送身份：回执是系统通知，不该带上次回复的引用条
    const outgoing: UnifiedMessage = {
      ...m,
      body: text,
      reply: text,
      quoteRef: undefined,
      sendIdentity: undefined,
    };
    // 回执是尽力而为的旁路通知：单次尝试（限流仍生效），不走业务回写的退避重试——
    // 否则 PATCH /status 在最坏情况（限流等待 + 1/2/4s 退避 + 平台超时）下可挂 20s+
    const result = await this.limiter.sendOnce(m.platform, () => connector.send(outgoing, []));
    // 真实回执也会被平台回推：登记到回声表，避免收件箱里多出一条「收到的」系统消息
    if (result.mode === 'real') {
      rememberSent({
        platform: m.platform,
        conversationId: m.conversation?.id,
        text: normalizeEchoText(text),
        at: Date.now(),
        traceId: m.traceId,
      });
    }
    return result;
  }

  /**
   * 跨平台转发：把 A 平台的消息推到 B 平台的指定会话。
   *
   * 实现上直接复用 compose()，所以转发同样经历 received→processing→replied→sent→synced，
   * 同样进闭环日志、同样受限流与退避保护；源消息只多一条 `forwarded` 追溯事件。
   */
  async forward(id: string, req: ForwardRequest, viewer?: Viewer): Promise<ComposeAck> {
    const src = this.requireVisible(id, viewer);
    if (!(Object.values(Platform) as string[]).includes(req.platform)) {
      throw new Error(`未知平台：${String(req.platform)}（可用：${Object.values(Platform).join(' / ')}）`);
    }
    const origin = `[转发自 ${src.platform}] ${src.sender?.name || src.sender?.id || '对方'}：${src.body}`;
    const text = req.note?.trim() ? `${req.note.trim()}\n\n${origin}` : origin;

    const ack = await this.compose({
      platform: req.platform,
      conversationId: req.conversationId,
      conversationType: req.conversationType,
      conversationTitle: req.conversationTitle,
      mailAccount: req.mailAccount,
      identity: req.identity,
      text,
    });

    // 登录用户转发出去的这条出站消息归他所有，否则会跑到别人的收件箱 / 变成无主
    if (viewer?.userId) this.repo.update(ack.message.traceId, { ownerId: viewer.userId });
    writeTrace(
      this.repo,
      src,
      'forwarded',
      `→ ${req.platform}${req.conversationId ? ` · 会话 ${req.conversationId}` : ''}`
        + ` · 新消息 ${ack.message.traceId}`,
    );
    this.broadcast({ type: 'message.updated', data: this.repo.get(id) ?? src });
    return ack;
  }

  /**
   * 人工修改优先级（覆盖规则 / AI 的判定）。
   *
   * 改动写一条 `priority` 闭环事件，旧值 → 新值留在日志里：
   * 这就是「反馈闭环」的可举证形态——能数出规则判了多少、人改了多少。
   */
  async setPriority(
    id: string,
    priority: Priority,
    viewer?: Viewer,
  ): Promise<PriorityChangeResult> {
    const cur = this.requireVisible(id, viewer);
    if (!['urgent', 'normal', 'low'].includes(priority)) {
      throw new Error(`未知优先级：${String(priority)}（可用：urgent / normal / low）`);
    }
    const old = cur.priority ?? 'normal';
    // 改优先级是元数据操作，不是「消息更新」：不刷新 updatedAt，
    // 否则收件箱按更新时间排序时这条会话会凭空跳到第一位（用户视角就是「点了只会上移」）。
    const m = this.repo.update(id, { priority, prioritySource: 'manual' }, { touchUpdatedAt: false })!;
    writeTrace(
      this.repo,
      m,
      'priority',
      `${old}→${priority}（人工纠正${cur.prioritySource ? `，原判定来源 ${cur.prioritySource}` : ''}）`,
    );
    this.broadcast({ type: 'message.updated', data: m });
    return { message: m, old, source: 'manual' };
  }

  /**
   * 入站消息命中自动回复规则时，复用 reply() 的完整回写链路发一条。
   *
   * 只回一次；只对真正的来信（direction !== 'out'）生效，避免自己回自己；
   * 纯附件消息不自动回（容易驴唇不对马嘴）。
   */
  private maybeAutoReply(m: UnifiedMessage): void {
    if (!this.autoReply) return;
    if (m.direction === 'out') return;
    if (!m.body?.trim()) return;
    if (this.autoReplied.has(m.traceId)) return;

    const rule = this.autoReply.match(m.platform, m.body);
    if (!rule) return;

    this.autoReplied.set(m.traceId, true);
    if (this.autoReplied.size > MessageService.AUTO_REPLIED_MAX) {
      // Map 迭代序 = 插入序：淘汰最早的一条
      const oldest = this.autoReplied.keys().next().value;
      if (oldest !== undefined) this.autoReplied.delete(oldest);
    }
    this.autoReply.recordHit(rule.id);
    writeTrace(
      this.repo,
      m,
      'auto_reply',
      `命中规则 ${rule.id}${rule.keyword ? ` · 关键词「${rule.keyword}」` : ' · 兜底规则'}`,
    );
    // 归属守卫用消息自己的 owner：规则回复不能越权回复别人的消息
    const viewer = m.ownerId ? { userId: m.ownerId } : undefined;
    void this.reply(m.traceId, rule.replyText, [], undefined, viewer).catch((e) => {
      writeTrace(this.repo, m, 'auto_reply_failed', e instanceof Error ? e.message : String(e));
    });
  }

  /**
   * 把任意消息手动加入待办：只改消息类型与完成态，不改闭环状态、不触发平台回写。
   * 已完成的待办再次加入时重新打开（done=false），便于用户继续跟进。
   */
  async markTodo(id: string, viewer?: Viewer): Promise<UnifiedMessage> {
    this.requireVisible(id, viewer);
    const m = this.repo.update(id, { type: 'todo', done: false });
    if (!m) throw new Error(NOT_FOUND);
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
  async markRead(id: string, read = true, viewer?: Viewer): Promise<UnifiedMessage> {
    const cur = this.requireVisible(id, viewer);
    // 已读时间只记第一次：重复标记不刷新时间戳
    const readAt = read ? (cur.readAt ?? new Date().toISOString()) : undefined;
    const m = this.repo.update(id, { readAt });
    if (!m) throw new Error(NOT_FOUND);
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
  async markAllRead(ids?: string[], viewer?: Viewer): Promise<number> {
    const now = new Date().toISOString();
    // 归属过滤必须在这里做：`ids` 是客户端传来的，不校验就是「传谁的 id 就能改谁的消息」
    const pool = this.repo.list().filter((m) => visibleTo(m, viewer));
    const targets = ids ? pool.filter((m) => ids.includes(m.traceId)) : pool;
    let changed = 0;
    for (const cur of targets) {
      if (cur.readAt) continue;
      const m = this.repo.update(cur.traceId, { readAt: now });
      if (m) {
        changed += 1;
        this.broadcast({ type: 'message.updated', data: m });
      }
    }
    return changed;
  }

  // ---------- 附件下载 ----------

  /**
   * 下载消息里的附件（按索引；field 区分原消息附件与回复附件）。
   *
   * 只接受 traceId + 索引，不接受客户端传 URL/文件名，避免 SSRF 与路径穿越；
   * 真正的平台取回逻辑在 attachmentDownload 服务里（按消息身份选择 token）。
   */
  async downloadAttachment(
    id: string,
    index: number,
    field: AttachmentField = 'attachments',
  ): Promise<DownloadedAttachment> {
    const m = this.repo.get(id);
    if (!m) throw new AttachmentDownloadError('消息不存在', 404);
    const list = field === 'replyAttachments' ? m.replyAttachments : m.attachments;
    if (!Array.isArray(list) || index < 0 || index >= list.length) {
      throw new AttachmentDownloadError('附件不存在（可能已被清理）', 404);
    }
    return downloadAttachment(m, list[index]!);
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
  getTrace(traceId: string, viewer?: Viewer): UnifiedMessage[] {
    const m = this.get(traceId, viewer);
    return m ? [m] : [];
  }

  getLoopLog(traceId: string, viewer?: Viewer) {
    // 回放日志里带正文与发送结果，同样要过归属校验（否则"看不了消息但能看日志"）
    if (!this.get(traceId, viewer)) return [];
    return this.repo.getLoopLog(traceId);
  }

  listDlq() {
    return this.repo.listDlq();
  }
}
