import { MsgStatus, Platform, FILE_LIMITS } from '../../types';
import type { UnifiedMessage, TraceEntry } from '../../types';
import type {
  ComposeAck, ComposeRequest, OutboundAttachment, SendCapabilities,
} from '@unimsg/shared';
import type {
  AccountInfo,
  AppConfigFieldMap,
  AppConfigPlatformId,
  AppConfigSaveResult,
  AppConfigUpdate,
  AppConfigView,
  ContactDirectory,
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
  ReanalyzeResult,
  ReplyAck,
  TraceResult,
} from '../api';
import { APP_CONFIG_LLM_FIELD_KEYS, APP_CONFIG_PLATFORM_FIELD_KEYS } from '../api';
import { EmitterRealtime } from '../realtime';
import { ACCOUNTS, HEALTH, INCOMING_TEMPLATES, buildTrace, createSeedData } from './fixtures';

/**
 * 纯前端演示模式下的应用配置视图：全部「未配置」、来源 none，并如实标注不能保存。
 * 这样配置弹窗在演示模式仍可打开看字段说明，但保存会给出明确中文提示。
 */
export function demoAppConfig(): AppConfigView {
  const noneFields = (keys: string[]): AppConfigFieldMap =>
    Object.fromEntries(keys.map((key) => [key, { configured: false, source: 'none' as const, key }]));
  const platforms = {} as AppConfigView['platforms'];
  for (const id of ['feishu', 'dingtalk', 'wecom'] as AppConfigPlatformId[]) {
    platforms[id] = { fields: noneFields(APP_CONFIG_PLATFORM_FIELD_KEYS[id]), missing: [] };
  }
  return {
    identity: { feishu: 'auto', dingtalk: 'auto' },
    platforms,
    llm: noneFields(APP_CONFIG_LLM_FIELD_KEYS),
    modes: { feishu: 'mock', dingtalk: 'mock', wecom: 'mock', mail: 'mock' },
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
        id: 'wecom',
        label: '企业微信',
        state: 'mock',
        summary: '演示模式：不会连接真实企业微信。',
        hints: ['企业微信需要管理员配置应用与可信 IP。'],
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

  constructor(private realtime: EmitterRealtime, options: MockOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset(): void {
    const seed = createSeedData();
    this.messages = new Map(seed.messages.map((m) => [m.traceId, m]));
    this.traces = seed.traces;
    this.metrics = { ...HEALTH };
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

  async reply(id: string, text: string, attachments?: OutboundAttachment[]): Promise<ReplyAck> {
    const cur = this.messages.get(id);
    if (!cur) throw new Error('message not found');
    await this.wait();

    const info = describeOutbound(attachments);
    this.patch(
      id,
      { status: MsgStatus.PROCESSING, reply: text, ...(info.length > 0 ? { attachments: info } : {}) },
      'processing',
      info.length > 0 ? `带 ${info.length} 个附件` : undefined,
    );
    const replied = this.patch(id, { status: MsgStatus.REPLIED, reply: text }, 'replied');

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

    // 模拟 OCR / LLM 富化：稍后补上意图与草稿
    window.setTimeout(() => {
      const cur = this.messages.get(traceId);
      if (!cur) return;
      const enriched = this.patch(
        traceId,
        {
          intent: template.intent ?? '未分类',
          replyDraft: template.replyDraft,
          needsReview: template.platform === 'wecom' && template.type === 'image' ? true : cur.needsReview,
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
