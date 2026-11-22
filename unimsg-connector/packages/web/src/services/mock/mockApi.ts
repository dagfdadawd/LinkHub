import { MsgStatus, Platform, FILE_LIMITS } from '../../types';
import type { UnifiedMessage, TraceEntry } from '../../types';
import type {
  AutoRule, AutoRuleInput, ComposeAck, ComposeRequest, ForwardRequest, IdentityRole, OutboundAttachment,
  Priority, PriorityChangeResult, SendCapabilities, StatsOverview, StatusChangeRequest,
  StatusChangeResult,
} from '@unimsg/shared';
import type {
  AccountInfo,
  AppConfigFieldMap,
  AppConfigPlatformId,
  AppConfigSaveResult,
  AppConfigUpdate,
  AppConfigView,
  AuthStatus,
  DownloadedFile,
  ContactDirectory,
  PublicUser,
  DemoApi,
  DingtalkLoginOptions,
  DingtalkLoginStart,
  DingtalkPersonalStatus,
  FeishuOAuthStart,
  HealthInfo,
  MailAccountInput,
  MailAccountTestResult,
  MailAccountView,
  MessageFilter,
  OnboardingView,
  WechatPullRequest,
  WechatPullResult,
  WechatBridgeInfo,
  WechatBridgeStartResult,
  WechatBridgeStopResult,
  ReanalyzeResult,
  ReplyAck,
  TraceResult,
} from '../api';
import { APP_CONFIG_LLM_FIELD_KEYS, APP_CONFIG_PLATFORM_FIELD_KEYS } from '../api';
import { EmitterRealtime } from '../realtime';
import { ACCOUNTS, HEALTH, INCOMING_TEMPLATES, buildTrace, createSeedData } from './fixtures';

/** 与后端一致的前进顺序；failed 是旁路不参与排序（特判见 changeStatus） */
const STATUS_RANK: Record<string, number> = {
  received: 0, processing: 1, replied: 2, sent: 3, synced: 4,
};

/**
 * 纯前端演示模式下的应用配置视图：全部「未配置」、来源 none，并如实标注不能保存。
 * 这样配置弹窗在演示模式仍可打开看字段说明，但保存会给出明确中文提示。
 */
export function demoAppConfig(): AppConfigView {
  const noneFields = (keys: string[]): AppConfigFieldMap =>
    Object.fromEntries(keys.map((key) => [key, { configured: false, source: 'none' as const, key }]));
  const platforms = {} as AppConfigView['platforms'];
  for (const id of ['feishu', 'dingtalk', 'wechat'] as AppConfigPlatformId[]) {
    platforms[id] = { fields: noneFields(APP_CONFIG_PLATFORM_FIELD_KEYS[id]), missing: [] };
  }
  return {
    identity: { feishu: 'auto', dingtalk: 'auto' },
    platforms,
    llm: noneFields(APP_CONFIG_LLM_FIELD_KEYS),
    modes: { feishu: 'mock', dingtalk: 'mock', wechat: 'mock', mail: 'mock' },
    restartRequired: false,
    envFile: null,
    settingsFile: null,
  };
}

/**
 * 纯前端演示模式下的「授权中心」：如实标 4 个平台都是演示模式，
 * 不提供任何「假连接」按钮——用户看到的是真实状态，而不是伪造的已连接。
 */
export function demoOnboarding(): OnboardingView {
  return {
    firstRun: true,
    dws: { available: false, source: 'missing' },
    overall: { ready: 0, total: 4, needsAction: 0 },
    steps: [
      {
        id: 'mail',
        label: '邮箱',
        state: 'mock',
        summary: '演示模式：不会连接真实邮箱。启动真实后端后，可在这里添加自己的邮箱账号。',
        hints: ['个人版推荐先连邮箱：收件箱里直接看邮件，回复以你自己的邮箱发出。'],
        actions: [],
      },
      {
        id: 'dingtalk',
        label: '钉钉',
        state: 'mock',
        summary: '演示模式：不会启动本机 dws，也不会弹出真实钉钉授权页。',
        hints: ['真实模式下用「用浏览器登录（推荐）」完成钉钉官方授权，无需手输设备码。'],
        actions: [],
      },
      {
        id: 'feishu',
        label: '飞书',
        state: 'mock',
        summary: '演示模式：不会发起真实飞书 OAuth 授权。',
        hints: ['真实模式需要飞书企业管理员先开通用户身份权限。'],
        actions: [],
      },
      {
        id: 'wechat',
        label: '微信（RPA）',
        state: 'mock',
        summary: '演示模式：不会操作真实微信。',
        hints: ['微信走 RPA 通道，需本机微信桌面端 + 本地 RPA 桥。'],
        actions: [],
      },
    ],
  };
}

export interface MockOptions {
  /** 基础网络延迟（毫秒） */
  latency?: number;
  /** 回复后「已发送」延迟 */
  sendDelay?: number;
  /** 「已发送」后「已同步」延迟 */
  syncDelay?: number;
  /** 新消息到达后 AI 富化延迟 */
  enrichDelay?: number;
}

const DEFAULTS: Required<MockOptions> = {
  latency: 140,
  sendDelay: 600,
  syncDelay: 800,
  enrichDelay: 650,
};

/** 附件 → 可展示元数据：Mock 演示里同样不把文件内容放进消息/回放 */
function describeOutbound(list?: OutboundAttachment[]): Array<{ name: string; mimeType: string; size: number }> {
  return (list ?? []).map(({ name, mimeType, size }) => ({ name, mimeType, size }));
}

/**
 * Mock 服务：内存实现 MessageApi，并通过 EmitterRealtime 模拟 WS 推送。
 * 行为刻意对齐后端：reply 先同步推进到 replied 并返回回执，sent/synced 异步推送。
 */
export class MockApi implements DemoApi {
  private messages = new Map<string, UnifiedMessage>();
  private traces = new Map<string, TraceEntry[]>();
  private metrics: HealthInfo = { ...HEALTH };
  private options: Required<MockOptions>;
  private seq = 0;
  private incomingSeq = 0;
  private failNextSend = false;
  /** 演示模式的自动回复规则（内存态：刷新回到种子规则） */
  private rules: AutoRule[] = [];
  /** 演示模式的账号表（内存态：刷新即失效，只用于讲清账号闭环） */
  private demoUsers = new Map<string, { user: PublicUser; password: string }>();

  constructor(private realtime: EmitterRealtime, options: MockOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset(): void {
    const seed = createSeedData();
    this.messages = new Map(seed.messages.map((m) => [m.traceId, m]));
    this.traces = seed.traces;
    this.metrics = { ...HEALTH };
    // 演示规则：一条启用（命中「周报」），一条停用的兜底规则，界面上能同时看到两种状态
    const now = new Date().toISOString();
    this.rules = [
      {
        id: 'demo-rule-report',
        platform: Platform.FEISHU,
        keyword: '周报',
        replyText: '收到，周报今天下班前给您',
        priority: 10,
        enabled: true,
        hitCount: 2,
        lastHitAt: now,
        createdAt: now,
      },
      {
        id: 'demo-rule-fallback',
        replyText: '已收到，稍后回复您',
        priority: 900,
        enabled: false,
        hitCount: 0,
        createdAt: now,
      },
    ];
  }

  async list(filter?: MessageFilter): Promise<UnifiedMessage[]> {
    await this.wait();
    let items = [...this.messages.values()];
    if (filter?.platform) items = items.filter((m) => m.platform === filter.platform);
    if (filter?.status) items = items.filter((m) => m.status === filter.status);
    if (filter?.type) items = items.filter((m) => m.type === filter.type);
    if (filter?.onlyReview) items = items.filter((m) => Boolean(m.needsReview));
    if (filter?.keyword) {
      const k = filter.keyword.trim().toLowerCase();
      items = items.filter(
        (m) =>
          m.body.toLowerCase().includes(k) ||
          m.sender.name.toLowerCase().includes(k) ||
          m.traceId.toLowerCase().includes(k) ||
          (m.intent ?? '').toLowerCase().includes(k),
      );
    }
    return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async get(id: string): Promise<UnifiedMessage | undefined> {
    await this.wait();
    return this.messages.get(id);
  }

  async reply(
    id: string,
    text: string,
    attachments?: OutboundAttachment[],
    identity?: IdentityRole,
    quoteTraceId?: string,
  ): Promise<ReplyAck> {
    const cur = this.messages.get(id);
    if (!cur) throw new Error('message not found');
    await this.wait();

    const info = describeOutbound(attachments);
    // 显式引用：只有用户点了某条消息的「回复」才有，与真实后端一致
    const quoted = quoteTraceId ? this.messages.get(quoteTraceId) : undefined;
    const quote = quoted
      ? { text: (quoted.body ?? '').slice(0, 120), senderName: quoted.sender?.name ?? '' }
      : undefined;
    // 与真实后端一致：每次回复都追加到 replies 历史，只写 reply 会互相覆盖
    const withEntry = (payload: Record<string, unknown>) => ({
      ...payload,
      replies: [
        ...(cur.replies ?? []),
        { text, at: new Date().toISOString(), ...(quote ? { quote } : {}) },
      ],
    });
    // 身份只对本次发送有效，Mock 同样不写回消息（与真实后端契约一致）；
    // Mock 也不伪造 delivery.identity（契约：模拟通道不冒充本人 / 机器人）。
    const identityFields = identity ? { requestedIdentity: identity } : {};
    this.patch(
      id,
      withEntry({
        status: MsgStatus.PROCESSING,
        reply: text,
        ...identityFields,
        ...(info.length > 0 ? { attachments: info } : {}),
      }),
      'processing',
      info.length > 0 ? `带 ${info.length} 个附件` : undefined,
    );
    const replied = this.patch(
      id,
      withEntry({ status: MsgStatus.REPLIED, reply: text, ...identityFields }),
      'replied',
    );

    const shouldFail = this.failNextSend;
    this.failNextSend = false;

    // 异步回写：不阻塞调用方，结果通过实时事件推送
    window.setTimeout(() => {
      if (shouldFail) {
        this.metrics.failed += 1;
        this.patch(
          id,
          {
            status: MsgStatus.FAILED,
            // 与真实后端 failureReason 同语义：详情页直接展示可读原因，不用去回放里翻
            failureReason: 'platform 500：重试 3 次仍失败，已写入死信队列',
          },
          'failed',
          'platform 500：重试 3 次仍失败，已写入死信队列',
        );
        return;
      }
      this.patch(
        id,
        { status: MsgStatus.SENT, delivery: { mode: 'mock', at: new Date().toISOString() } },
        'sent',
        '模拟发送（未调用真实平台）',
      );
      window.setTimeout(() => {
        this.patch(id, { status: MsgStatus.SYNCED }, 'synced');
        this.metrics.sent += 1;
        // Mock 模拟发送单独计数：页面上与真实发送区分展示
        this.metrics.sentMock = (this.metrics.sentMock ?? 0) + 1;
      }, this.options.syncDelay);
    }, this.options.sendDelay);

    return { message: replied, taskId: id };
  }

  /**
   * 主动向指定平台发送（Mock 版）。
   * 与真实后端保持一致：新建一条消息、写全链路日志、异步推进 sent/synced，
   * 因此纯前端演示里「新建发送」同样能走通闭环并回放。
   */
  async compose(req: ComposeRequest): Promise<ComposeAck> {
    await this.wait();
    this.seq += 1;
    const now = new Date().toISOString();
    const traceId = `demo-compose-${Date.now().toString(16)}-${String(this.seq).padStart(4, '0')}`;
    const info = describeOutbound(req.attachments);
    const display = req.text || `[附件] ${info.map((a) => a.name).join(', ')}`;
    // 与后端一致：邮箱主动发送落到所选账号，未指定则用首个已配置账号
    const demoMailAccounts = ACCOUNTS.find((a) => a.platform === Platform.MAIL)?.accounts ?? [];
    const mailKey = req.platform === Platform.MAIL
      ? (req.mailAccount ?? demoMailAccounts[0]?.key)
      : undefined;
    const message: UnifiedMessage = {
      traceId,
      platform: req.platform,
      externalId: mailKey ? `${mailKey}:compose:${traceId}` : `compose:${traceId}`,
      sender: { id: 'linkhub', name: 'LinkHub 统一入口' },
      conversation: { id: req.conversationId || 'mock-conversation', type: req.conversationType ?? 'group' },
      // 与后端一致：勾选「同时加为待办」时，这条消息本身就是待办（不另造幽灵消息）
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
      createdAt: now,
      updatedAt: now,
    };
    this.messages.set(traceId, message);
    this.traces.set(traceId, []);
    // 回放里能分清「自动识别成待办」与「新建发送时用户手动加的」
    if (req.todo) {
      const todoParts = ['新建发送时手动加入待办'];
      if (req.todo.title) todoParts.push(`标题：${req.todo.title}`);
      if (req.todo.dueAt) todoParts.push(`截止：${req.todo.dueAt}`);
      this.traces.get(traceId)!.push({
        traceId,
        platform: message.platform,
        status: message.status,
        event: 'todo_added',
        detail: todoParts.join(' · '),
        at: now,
      });
    }
    this.metrics.received += 1;
    this.realtime.emit({ type: 'message.received', data: message });
    // 与真实后端 compose 一致：先写 'composed' 起始事件（统计平均处理时长的起点），
    // 再推进 processing——否则演示模式下「新建发送」的样本永远进不了均值。
    this.patch(
      traceId,
      {},
      'composed',
      `统一入口主动发送 → ${req.platform} · 会话 ${message.conversation?.id ?? ''}`,
    );
    this.patch(traceId, { status: MsgStatus.PROCESSING }, 'processing');
    const replied = this.patch(traceId, { status: MsgStatus.REPLIED }, 'replied');

    window.setTimeout(() => {
      this.patch(
        traceId,
        { status: MsgStatus.SENT, delivery: { mode: 'mock', at: new Date().toISOString() } },
        'sent',
        '模拟发送（未调用真实平台）',
      );
      window.setTimeout(() => {
        this.patch(traceId, { status: MsgStatus.SYNCED }, 'synced');
        this.metrics.sent += 1;
        this.metrics.sentMock = (this.metrics.sentMock ?? 0) + 1;
      }, this.options.syncDelay);
    }, this.options.sendDelay);

    return { message: replied, taskId: traceId };
  }

  // ---------- 人工处理动作 / 自动回复 / 看板（纯前端演示版） ----------

  async changeStatus(id: string, req: StatusChangeRequest): Promise<StatusChangeResult> {
    await this.wait();
    const cur = this.messages.get(id);
    if (!cur) throw new Error('message not found');
    if (req.status !== cur.status) {
      // 与服务端 checkStatusTransition 同款语义：failed 是旁路不参与排序——
      // failed→任意正常态放行（重试起点），正常态→failed 拒绝（failed 由系统写入）。
      // 旧实现给 failed 一个中间 rank，导致 failed→processing 被误判为倒退。
      if (req.status === MsgStatus.FAILED) {
        throw new Error('failed 是系统写入的失败旁路，不能人工设置');
      }
      if (cur.status !== MsgStatus.FAILED) {
        const nextRank = STATUS_RANK[req.status];
        const curRank = STATUS_RANK[cur.status] ?? 0;
        if (nextRank === undefined) throw new Error(`未知状态：${req.status}`);
        if (nextRank <= curRank) {
          throw new Error(`${cur.status}→${req.status} 属于状态倒退（顺序 received<processing<replied<sent<synced）`);
        }
      }
      this.patch(id, { status: req.status }, 'status', `人工流转 ${cur.status}→${req.status}`);
    }
    if (!req.notify) {
      return { message: this.messages.get(id)!, notified: false };
    }
    await this.wait();
    this.patch(id, {}, 'status_notified', '模拟发送状态回执（本地 Mock，未调用真实平台接口）');
    return { message: this.messages.get(id)!, notified: true, notifyMode: 'mock' };
  }

  async forward(id: string, req: ForwardRequest): Promise<ComposeAck> {
    const src = this.messages.get(id);
    if (!src) throw new Error('message not found');
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
    this.patch(id, {}, 'forwarded', `→ ${req.platform}${req.conversationId ? ` · 会话 ${req.conversationId}` : ''} · 新消息 ${ack.message.traceId}`);
    return ack;
  }

  async setPriority(id: string, priority: Priority): Promise<PriorityChangeResult> {
    await this.wait();
    const cur = this.messages.get(id);
    if (!cur) throw new Error('message not found');
    const old = cur.priority ?? 'normal';
    const m = this.patch(
      id,
      { priority, prioritySource: 'manual' },
      'priority',
      `${old}→${priority}（人工纠正${cur.prioritySource ? `，原判定来源 ${cur.prioritySource}` : ''}）`,
    );
    return { message: m, old, source: 'manual' };
  }

  async autoRules(): Promise<AutoRule[]> {
    await this.wait();
    return this.rules.map((r) => ({ ...r }));
  }

  async createAutoRule(input: AutoRuleInput): Promise<AutoRule> {
    await this.wait();
    const replyText = input.replyText?.trim() ?? '';
    if (!replyText) throw new Error('回复内容不能为空');
    const rule: AutoRule = {
      id: `demo-rule-${Date.now().toString(16)}`,
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.keyword?.trim() ? { keyword: input.keyword.trim() } : {}),
      replyText,
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      hitCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.rules.push(rule);
    return { ...rule };
  }

  async updateAutoRule(id: string, patch: Partial<AutoRuleInput>): Promise<AutoRule> {
    await this.wait();
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error('规则不存在');
    if (patch.replyText !== undefined) {
      const text = patch.replyText.trim();
      if (!text) throw new Error('回复内容不能为空');
      rule.replyText = text;
    }
    if (patch.keyword !== undefined) {
      const kw = patch.keyword.trim();
      if (kw) rule.keyword = kw;
      else delete rule.keyword;
    }
    if (patch.platform !== undefined) {
      // null = 清空为「所有平台」（与真实后端 normalizePlatform 的 null 语义一致）
      if (patch.platform === null) delete rule.platform;
      else rule.platform = patch.platform;
    }
    if (patch.priority !== undefined) rule.priority = patch.priority;
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    return { ...rule };
  }

  async deleteAutoRule(id: string): Promise<void> {
    await this.wait();
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  async stats(): Promise<StatsOverview> {
    await this.wait();
    const items = [...this.messages.values()];
    const num = (pred: (m: UnifiedMessage) => boolean) => items.filter(pred).length;
    // 与服务端 stats.ts 同口径：replied = 状态推进到 replied 及以后，**或**已有回复历史
    //（失败但回过一次也算回过）
    const isReplied = (m: UnifiedMessage) => m.status === MsgStatus.REPLIED
      || m.status === MsgStatus.SENT || m.status === MsgStatus.SYNCED
      || (m.replies?.length ?? 0) > 0;
    const byStatus: Record<string, number> = {};
    for (const m of items) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;

    const byPlatform = Object.values(Platform).map((platform) => {
      const rows = items.filter((m) => m.platform === platform);
      return {
        platform,
        total: rows.length,
        inbound: rows.filter((m) => m.direction !== 'out').length,
        outbound: rows.filter((m) => m.direction === 'out').length,
        replied: rows.filter(isReplied).length,
        pending: rows.filter((m) => m.status === MsgStatus.RECEIVED
          || m.status === MsgStatus.PROCESSING).length,
        failed: rows.filter((m) => m.status === MsgStatus.FAILED).length,
      };
    });

    // 平均处理时长：闭环日志里最早的 received/composed → 最早的 sent
    let sum = 0;
    let samples = 0;
    for (const m of items) {
      const log = this.traces.get(m.traceId) ?? [];
      const start = log.find((e) => e.event === 'received' || e.event === 'composed');
      const end = log.find((e) => e.event === 'sent');
      if (!start || !end) continue;
      const seconds = (new Date(end.at).getTime() - new Date(start.at).getTime()) / 1000;
      if (seconds >= 0) {
        sum += seconds;
        samples += 1;
      }
    }

    return {
      totals: {
        messages: items.length,
        inbound: num((m) => m.direction !== 'out'),
        outbound: num((m) => m.direction === 'out'),
        replied: num(isReplied),
        pending: num((m) => m.status === MsgStatus.RECEIVED || m.status === MsgStatus.PROCESSING),
        failed: num((m) => m.status === MsgStatus.FAILED),
        todos: num((m) => m.type === 'todo'),
        done: num((m) => m.done === true),
      },
      byPlatform,
      byStatus,
      delivery: {
        real: num((m) => m.delivery?.mode === 'real'),
        mock: num((m) => m.delivery?.mode === 'mock'),
      },
      dlq: this.metrics.dlq ?? 0,
      // 与服务端一致返回原始浮点（不四舍五入，前端自行格式化）
      avgHandleSeconds: samples > 0 ? sum / samples : null,
      rules: {
        total: this.rules.length,
        hits: this.rules.reduce((acc, r) => acc + (r.hitCount ?? 0), 0),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async capabilities(): Promise<SendCapabilities[]> {
    await this.wait();
    return Object.values(Platform).map((platform) => ({
      platform,
      mode: 'mock' as const,
      text: true,
      file: true,
      maxFiles: FILE_LIMITS.maxFiles,
      maxFileBytes: FILE_LIMITS.maxFileBytes,
      ...(platform === Platform.DINGTALK
        ? { note: '钉钉机器人发送文件需要媒体上传权限；Mock 通道可完整演示' }
        : {}),
    }));
  }

  /** Mock 没有真实通讯录：返回不可用，让 UI 退回「只列已有会话」 */
  async contacts(platform: Platform): Promise<ContactDirectory> {
    await this.wait();
    return {
      platform,
      available: false,
      reason: '演示模式没有真实通讯录，只能发给已有会话。',
      items: [],
    };
  }

  /** 演示模式的账号体系：本地内存校验，刷新即失效，绝不冒充真实后端 */
  async register(input: { username: string; password: string; displayName?: string; signupCode?: string }) {
    await this.wait();
    const username = (input.username ?? '').trim();
    const password = (input.password ?? '').trim();
    if (username.length < 2) throw new Error('用户名需 2-32 位');
    if (password.length < 6) throw new Error('密码至少 6 位');
    const user: PublicUser = {
      id: `mock-${username}`,
      username,
      displayName: (input.displayName ?? '').trim() || username,
      createdAt: new Date().toISOString(),
    };
    this.demoUsers.set(username.toLowerCase(), { user, password });
    return { user, token: `mock-token-${username}`, recoveryCode: 'DEMO-CODE-0001' };
  }

  async login(input: { username: string; password: string }) {
    await this.wait();
    const hit = this.demoUsers.get((input.username ?? '').trim().toLowerCase());
    if (!hit || hit.password !== input.password) throw new Error('用户名或密码不正确');
    return { user: hit.user, token: `mock-token-${hit.user.username}` };
  }

  async logout(): Promise<void> {
    await this.wait();
  }

  async me(): Promise<PublicUser | undefined> {
    return undefined;
  }

  /** 纯前端演示：没有后端、没有账号库，永远不要求登录，注册也始终开放 */
  async authStatus(): Promise<AuthStatus> {
    return {
      requireLogin: false,
      hasUsers: false,
      registration: { open: true, requireCode: false },
      machineOwner: null,
      user: null,
    };
  }

  /** 演示模式：只改内存里的密码，不涉及真实会话 */
  async changePassword(input: { oldPassword: string; newPassword: string }): Promise<{ revoked: number }> {
    await this.wait();
    const entry = [...this.demoUsers.values()].find((u) => u.password === input.oldPassword);
    if (!entry) throw new Error('原密码不正确');
    if ((input.newPassword ?? '').length < 6) throw new Error('密码至少 6 位');
    entry.password = input.newPassword;
    return { revoked: 1 };
  }

  async logoutAll(): Promise<{ revoked: number }> {
    await this.wait();
    return { revoked: 1 };
  }

  /** 演示模式没有真实归属字段，认领即把全部演示消息标记为该账号 */
  async claimMessages(): Promise<{ claimed: number }> {
    await this.wait();
    const count = this.messages.size;
    for (const [id, m] of this.messages) {
      this.messages.set(id, { ...m, ownerId: 'demo' });
    }
    return { claimed: count };
  }

  /** 演示模式：恢复码固定 DEMO-CODE-0001 */
  async resetPassword(input: {
    username: string;
    recoveryCode: string;
    newPassword: string;
  }): Promise<{ revoked: number; recoveryCode?: string }> {
    await this.wait();
    if ((input.recoveryCode ?? '').replace(/[\s-]/g, '').toUpperCase() !== 'DEMOCODE0001') {
      throw new Error('用户名或恢复码不正确');
    }
    const entry = this.demoUsers.get((input.username ?? '').trim().toLowerCase());
    if (!entry) throw new Error('用户名或恢复码不正确');
    if ((input.newPassword ?? '').length < 6) throw new Error('密码至少 6 位');
    entry.password = input.newPassword;
    return { revoked: 1, recoveryCode: 'DEMO-CODE-0001' };
  }

  async feishuOAuthStart(): Promise<FeishuOAuthStart> {
    throw new Error('演示模式未接入真实后端，无法发起飞书用户授权');
  }

  async dingtalkPersonalLogin(_options?: DingtalkLoginOptions): Promise<DingtalkLoginStart> {
    throw new Error('演示模式未接入真实后端，无法连接钉钉本人账号');
  }

  async dingtalkPersonalStatus(): Promise<DingtalkPersonalStatus> {
    return {
      available: false,
      authenticated: false,
      hint: '演示模式（纯前端 Mock）不连接本机 dws；启动真实后端并配置钉钉凭据后即可登录本人账号。',
    };
  }

  async dingtalkPersonalLogout(): Promise<void> {
    throw new Error('演示模式未接入真实后端，无需注销钉钉本人账号');
  }

  async onboarding(): Promise<OnboardingView> {
    return demoOnboarding();
  }

  async wechatPull(_req: WechatPullRequest): Promise<WechatPullResult> {
    // 纯前端演示不可能操作微信桌面端：直接说清楚，不返回假成功
    throw new Error('演示模式不会操作真实微信：拉取需要本机 RPA 桥（启动真实后端 + python rpa_bridge.py --mode rpa）');
  }

  async wechatBridgeStatus(): Promise<WechatBridgeInfo> {
    return {
      managed: false,
      url: 'http://127.0.0.1:8787',
      logPath: '',
      bridge: {
        state: 'unknown',
        reachable: false,
        canSend: false,
        canReceive: false,
        receiveMode: 'none',
        receiveReason: '演示模式不会启动本机 RPA 桥',
      },
    };
  }

  async startWechatBridge(): Promise<WechatBridgeStartResult> {
    throw new Error('演示模式不会启动本机 RPA 桥：请启动真实后端并在本机运行 Python 桥');
  }

  async stopWechatBridge(): Promise<WechatBridgeStopResult> {
    throw new Error('演示模式没有由 LinkHub 启动的 RPA 桥');
  }

  async mailAccounts(): Promise<MailAccountView[]> {
    // 纯前端演示没有真实邮箱账号；不要用假账号制造「已连接」的错觉
    return [];
  }

  async mailAccountTest(_input: MailAccountInput): Promise<MailAccountTestResult> {
    return {
      ok: false,
      message: '演示模式不会连接真实邮箱服务：无法测试 IMAP / SMTP 登录。启动真实后端后再测试。',
    };
  }

  async mailAccountCreate(_input: MailAccountInput): Promise<void> {
    throw new Error('演示模式不会保存邮箱账号：启动真实后端后再添加（不会把授权码写进浏览器存储）');
  }

  async mailAccountDelete(_key: string): Promise<void> {
    throw new Error('演示模式没有可删除的邮箱账号');
  }

  async mailAccountVerify(_key: string): Promise<MailAccountTestResult> {
    return {
      ok: false,
      message: '演示模式不会连接真实邮箱服务：无法验证账号。启动真实后端后再验证。',
    };
  }

  async getAppConfig(): Promise<AppConfigView> {
    return demoAppConfig();
  }

  async updateAppConfig(_patch: AppConfigUpdate): Promise<AppConfigSaveResult> {
    throw new Error('演示模式不会保存平台应用凭据：启动真实后端后再配置');
  }

  /** 演示模式的「重新生成」：本地规则重算，如实标注 source=rules，不冒充大模型 */
  async reanalyze(id: string): Promise<ReanalyzeResult> {
    await this.wait();
    const cur = this.messages.get(id);
    if (!cur) throw new Error(`message not found: ${id}`);
    const body = cur.body ?? '';
    const intent = /周报|待办|任务|提醒|截止|deadline/i.test(body) ? '待办'
      : /[?？]|怎么|如何|为什么|吗/.test(body) ? '咨询'
        : /通知|公告|会议|安排/.test(body) ? '通知' : '未分类';
    const replyDraft = intent === '待办' ? '收到，我会在截止前完成。'
      : intent === '咨询' ? '收到，我确认后回复你。' : '收到。';
    const message = this.patch(
      id,
      {
        intent, replyDraft, intentSource: 'rules',
        aiProvider: undefined, aiModel: undefined,
        aiConfidence: undefined, aiPrecision: undefined,
      },
      'reanalyze',
      '演示模式：本地规则重新生成（未调用大模型）',
    );
    return {
      message,
      llm: { mode: 'mock', reason: '演示模式使用本地规则，不会调用大模型', providerLabel: '演示规则' },
    };
  }

  async markDone(id: string): Promise<UnifiedMessage> {
    await this.wait();
    return this.patch(id, { done: true }, 'done');
  }

  async markTodo(id: string): Promise<UnifiedMessage> {
    await this.wait();
    return this.patch(id, { type: 'todo', done: false }, 'todo_added', '用户手动加入待办');
  }

  async markRead(id: string, read: boolean): Promise<UnifiedMessage> {
    await this.wait();
    const cur = this.messages.get(id);
    if (!cur) throw new Error(`message not found: ${id}`);
    // 与后端一致：已读时间只记第一次，重复标记不刷新
    const readAt = read ? (cur.readAt ?? new Date().toISOString()) : undefined;
    if (cur.readAt === readAt) return cur;
    return this.patch(id, { readAt }, read ? 'read' : 'unread');
  }

  async markAllRead(ids?: string[]): Promise<number> {
    await this.wait();
    const now = new Date().toISOString();
    let changed = 0;
    for (const m of this.messages.values()) {
      if (m.readAt) continue;
      if (ids && !ids.includes(m.traceId)) continue;
      this.messages.set(m.traceId, { ...m, readAt: now, updatedAt: now });
      changed += 1;
    }
    return changed;
  }

  /**
   * 演示模式没有真实平台资源：
   * - 有 data URL 预览的图片可以真的下载（预览串本身就是文件内容）；
   * - 纯文件卡片没有内容，明确报错，不生成一个假文件骗人。
   */
  async downloadAttachment(
    traceId: string,
    index: number,
    field: 'attachments' | 'replyAttachments' = 'attachments',
  ): Promise<DownloadedFile> {
    await this.wait();
    const message = this.messages.get(traceId);
    const list = field === 'replyAttachments' ? message?.replyAttachments : message?.attachments;
    const attachment = list?.[index];
    if (!attachment) throw new Error('附件不存在');
    if (attachment.preview) {
      const res = await fetch(attachment.preview);
      return { blob: await res.blob(), filename: attachment.name };
    }
    throw new Error('演示模式只有附件元数据，没有真实文件内容；接入真实后端后可下载平台上的原文件');
  }

  async trace(id: string): Promise<TraceResult> {
    await this.wait();
    const message = this.messages.get(id);
    return { data: message ? [message] : [], log: this.traces.get(id) ?? [] };
  }

  async accounts(): Promise<AccountInfo[]> {
    await this.wait();
    // 深拷贝到嵌套的邮箱账号 / 目录数组 / 身份视图，避免调用方(或页面)修改返回值污染种子数据
    return ACCOUNTS.map((a) => ({
      ...a,
      missing: a.missing ? [...a.missing] : undefined,
      accounts: a.accounts?.map((m) => ({ ...m, folders: [...m.folders] })),
      identity: a.identity
        ? { ...a.identity, user: { ...a.identity.user } }
        : undefined,
    }));
  }

  async health(): Promise<HealthInfo> {
    await this.wait();
    return { ...this.metrics };
  }

  /** 模拟平台推来一条新消息 */
  async simulateIncoming(): Promise<UnifiedMessage> {
    const template = INCOMING_TEMPLATES[this.incomingSeq % INCOMING_TEMPLATES.length];
    this.incomingSeq += 1;
    this.seq += 1;

    const now = new Date().toISOString();
    const traceId = `demo-${Date.now().toString(16)}-${String(this.seq).padStart(4, '0')}`;
    const message: UnifiedMessage = {
      traceId,
      platform: template.platform,
      externalId: `demo_ext_${this.seq}`,
      sender: { id: template.senderId, name: template.senderName },
      type: template.type ?? 'text',
      body: template.body,
      status: MsgStatus.RECEIVED,
      createdAt: now,
      updatedAt: now,
    };
    this.messages.set(traceId, message);
    this.traces.set(traceId, buildTrace(message, 0));
    this.metrics.received += 1;
    this.realtime.emit({ type: 'message.received', data: message });

    // 最小自动回复引擎（演示）：命中启用的规则就自动回一次，语义与真实后端一致——
    // 走 reply() 同一条链路（replies 历史 / sent / synced / trace），hitCount 可举证。
    const rule = this.rules
      .filter((r) => r.enabled)
      .filter((r) => !r.platform || r.platform === template.platform)
      .filter((r) => !r.keyword || template.body.toLowerCase().includes(r.keyword.toLowerCase()))
      .sort((a, b) => a.priority - b.priority)[0];
    if (rule) {
      rule.hitCount += 1;
      rule.lastHitAt = new Date().toISOString();
      this.patch(
        traceId,
        {},
        'auto_reply',
        `命中规则 ${rule.id}${rule.keyword ? ` · 关键词「${rule.keyword}」` : ' · 兜底规则'}`,
      );
      void this.reply(traceId, rule.replyText);
    }

    // 模拟 OCR / LLM 富化：稍后补上意图与草稿
    window.setTimeout(() => {
      const cur = this.messages.get(traceId);
      if (!cur) return;
      const enriched = this.patch(
        traceId,
        {
          intent: template.intent ?? '未分类',
          replyDraft: template.replyDraft,
          needsReview: cur.needsReview,
        },
        'intent',
        `${template.intent ?? '未分类'}(${template.confidence ?? 0.6})`,
      );
      if (template.type === 'image') {
        this.patch(traceId, { needsReview: true }, 'ocr_low_confidence', 'confidence=0.55，已标记待人工确认');
      }
      void enriched;
    }, this.options.enrichDelay);

    return message;
  }

  /** 演示「发送失败 → DLQ」分支 */
  armNextSendFailure(): void {
    this.failNextSend = true;
  }

  private patch(
    id: string,
    patch: Partial<UnifiedMessage>,
    event: string,
    detail?: string,
  ): UnifiedMessage {
    const cur = this.messages.get(id);
    if (!cur) throw new Error(`message not found: ${id}`);
    const next: UnifiedMessage = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.messages.set(id, next);

    const log = this.traces.get(id) ?? [];
    log.push({
      traceId: id,
      platform: next.platform,
      status: next.status,
      event,
      detail,
      at: next.updatedAt,
    });
    this.traces.set(id, log);

    this.realtime.emit({
      type: next.status === MsgStatus.FAILED ? 'message.failed' : 'message.updated',
      data: next,
    });
    return next;
  }

  private wait(): Promise<void> {
    if (this.options.latency <= 0) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, this.options.latency));
  }
}
