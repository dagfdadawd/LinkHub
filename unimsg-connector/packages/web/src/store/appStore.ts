/**
 * 轻量应用状态：一个可订阅的 store + useSyncExternalStore。
 *
 * 不引入额外状态库：消息列表由实时事件驱动，
 * 筛选在本地完成（后端 filter 接口保持一致，后续可直接切换）。
 */
import { MsgStatus } from '../types';
import type {
  AutoRule, AutoRuleInput, ComposeAck, ComposeRequest, ForwardRequest, IdentityRole, MsgType,
  OutboundAttachment, Platform, Priority, PriorityChangeResult, StatsOverview, StatusChangeRequest,
  StatusChangeResult, UnifiedMessage,
} from '../types';
import type {
  AccountInfo, AppConfigSaveResult, AppConfigUpdate, AppConfigView,
  DingtalkLoginOptions, DingtalkLoginStart, DingtalkPersonalStatus, DownloadedFile,
  FeishuOAuthStart, HealthInfo,
  MailAccountInput, MailAccountTestResult, MailAccountView, MessageApi, OnboardingView,
  ReanalyzeResult, WechatBridgeInfo, WechatBridgeStartResult, WechatBridgeStopResult,
} from '../services/api';
import { isDemoApi } from '../services/api';
import { getSession } from '../services/session';
import type { RealtimeClient, RealtimeStatus } from '../services/realtime';
import { sortMessages } from '../utils/format';

export interface Filters {
  platform?: Platform;
  status?: MsgStatus;
  type?: MsgType;
  keyword: string;
  onlyReview: boolean;
  /** 只看未读（阅读状态，与业务状态正交） */
  onlyUnread: boolean;
  /**
   * 只看紧急会话（会话级筛选）。
   *
   * 不放在 `filterMessages` 里按「单条消息优先级」过滤：那样会把会话里的其它消息
   * 一起滤掉，只剩一条紧急消息，读不到上下文。它由收件箱在会话聚合后按
   * `conversation.priority` 过滤，见 InboxPage。
   */
  onlyUrgent: boolean;
}

export interface AppState {
  messages: UnifiedMessage[];
  loading: boolean;
  error: string | null;
  filters: Filters;
  accounts: AccountInfo[];
  health: HealthInfo | null;
  connection: RealtimeStatus;
  demoMode: boolean;
  initialized: boolean;
  /**
   * 最近一次「实时收到」的发送失败（含可读原因）。
   * 只由 WebSocket failed 事件设置——加载历史失败消息不会弹 toast；
   * AppShell 消费后调用 dismissSendFailure 清掉，避免重复提示。
   */
  sendFailure: { traceId: string; reason?: string; at: number } | null;
  /** 授权中心聚合状态（GET /api/onboarding）；旧后端不支持时为 null */
  onboarding: OnboardingView | null;
  /** 平台应用凭据 / 运行配置（GET /api/app-config）；旧后端不支持时为 null */
  appConfig: AppConfigView | null;
}

export const DEFAULT_FILTERS: Filters = {
  platform: undefined,
  status: undefined,
  type: undefined,
  keyword: '',
  onlyReview: false,
  onlyUnread: false,
  onlyUrgent: false,
};

export function filterMessages(messages: UnifiedMessage[], filters: Filters): UnifiedMessage[] {
  const keyword = filters.keyword.trim().toLowerCase();
  const items = messages.filter((m) => {
    if (filters.platform && m.platform !== filters.platform) return false;
    if (filters.status && m.status !== filters.status) return false;
    if (filters.type && m.type !== filters.type) return false;
    if (filters.onlyReview && !m.needsReview) return false;
    if (filters.onlyUnread && m.readAt) return false;
    if (keyword) {
      const hit =
        m.body.toLowerCase().includes(keyword) ||
        m.sender.name.toLowerCase().includes(keyword) ||
        m.traceId.toLowerCase().includes(keyword) ||
        (m.intent ?? '').toLowerCase().includes(keyword);
      if (!hit) return false;
    }
    return true;
  });
  return sortMessages(items);
}

export class AppStore {
  private state: AppState = {
    messages: [],
    loading: true,
    error: null,
    filters: { ...DEFAULT_FILTERS },
    accounts: [],
    health: null,
    connection: 'connected',
    demoMode: true,
    initialized: false,
    sendFailure: null,
    onboarding: null,
    appConfig: null,
  };

  private listeners = new Set<() => void>();
  private offRealtime?: () => void;
  private offStatus?: () => void;

  constructor(
    private api: MessageApi,
    private realtime: RealtimeClient,
  ) {
    // demoMode 由数据源自动派生：接真实后端后，演示入口与 Mock 标识自动隐藏
    this.state = {
      ...this.state,
      demoMode: isDemoApi(api),
      connection: realtime.getStatus(),
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppState => this.state;

  async init(): Promise<void> {
    if (this.state.initialized) return;
    this.offStatus = this.realtime.subscribeStatus((connection) => {
      const prev = this.state.connection;
      this.set({ connection });
      // 断线重连成功后静默重拉，补齐重连期间错过的推送（启动首连同理，幂等）
      if (connection === 'connected' && (prev === 'reconnecting' || prev === 'offline')) {
        void this.reload();
      }
    });
    this.offRealtime = this.realtime.subscribe((event) => this.onRealtime(event));
    this.set({ initialized: true });

    try {
      const [messages, accounts, health] = await Promise.all([
        this.api.list(),
        this.api.accounts(),
        this.api.health(),
      ]);
      this.set({ messages, accounts, health, loading: false, error: null });
      // 授权中心是首启锦上添花：旧后端没有该接口时不阻塞主流程
      void this.refreshOnboarding();
      // 平台应用凭据（白号配置入口）：旧后端没有该接口时同样静默
      void this.refreshAppConfig();
    } catch (e) {
      this.set({ loading: false, error: e instanceof Error ? e.message : '加载失败' });
    }
  }

  dispose(): void {
    this.offRealtime?.();
    this.offStatus?.();
    this.realtime.close();
    // 可重入：卸载后若再次 init，能重新订阅（配合 init 的 initialized 守卫）
    this.offRealtime = undefined;
    this.offStatus = undefined;
    this.set({ initialized: false });
  }

  setFilters(patch: Partial<Filters>): void {
    this.set({ filters: { ...this.state.filters, ...patch } });
  }

  resetFilters(): void {
    this.set({ filters: { ...DEFAULT_FILTERS } });
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /** 清掉最近一次实时发送失败提示（AppShell 弹过 toast 后调用） */
  dismissSendFailure(): void {
    if (this.state.sendFailure) this.set({ sendFailure: null });
  }

  async reply(
    id: string,
    text: string,
    attachments?: OutboundAttachment[],
    identity?: IdentityRole,
    quoteTraceId?: string,
  ): Promise<void> {
    // 不传引用时保持 4 参调用：老测试/老实现都兼容（多传一个 undefined 会改变调用形态）
    const ack = quoteTraceId
      ? await this.api.reply(id, text, attachments, identity, quoteTraceId)
      : await this.api.reply(id, text, attachments, identity);
    // 202 回执兜底：WS 丢包时也能把回复内容与 replied 状态落地。
    // 只补字段、不把状态往回拽（HTTP 202 可能晚于 WS 的 sent/synced 推送）。
    this.upsertReply(ack.message);
    await this.refreshHealth();
  }

  /** 主动向指定平台发送：复用 202 回执兜底 + 健康指标刷新，返回可回放的 traceId */
  async compose(req: ComposeRequest): Promise<string> {
    const ack = await this.api.compose(req);
    this.upsertReply(ack.message);
    await this.refreshHealth();
    return ack.taskId;
  }

  /** 重新生成 AI 建议：把结果写回本地（WS 也会广播同一条），并把后端通道结论交给页面提示 */
  async reanalyze(id: string): Promise<ReanalyzeResult> {
    const result = await this.api.reanalyze(id);
    this.upsert(result.message);
    return result;
  }

  async markDone(id: string): Promise<void> {
    const updated = await this.api.markDone(id);
    this.upsert(updated);
  }

  /** 手动把任意消息加入待办；返回更新后的消息供页面即时反馈 */
  async markTodo(id: string): Promise<UnifiedMessage> {
    const updated = await this.api.markTodo(id);
    this.upsert(updated);
    return updated;
  }

  /** 标记已读 / 未读：只更新阅读状态，不动业务状态 */
  async markRead(id: string, read: boolean): Promise<void> {
    const updated = await this.api.markRead(id, read);
    this.upsert(updated);
  }

  // ---------- 人工处理动作 / 自动回复 / 看板 ----------

  /** 人工流转状态；notify=true 时后端会向原会话发回执 */
  async changeStatus(id: string, req: StatusChangeRequest): Promise<StatusChangeResult> {
    if (!this.api.changeStatus) throw new Error('当前后端版本不支持状态流转，请升级服务端');
    const result = await this.api.changeStatus(id, req);
    this.upsert(result.message);
    return result;
  }

  /** 跨平台转发：后端会新建一条出站消息，这里同步进本地列表 */
  async forward(id: string, req: ForwardRequest): Promise<ComposeAck> {
    if (!this.api.forward) throw new Error('当前后端版本不支持跨平台转发，请升级服务端');
    const ack = await this.api.forward(id, req);
    this.upsert(ack.message);
    return ack;
  }

  /** 人工修改优先级（覆盖规则/AI 判定） */
  async setPriority(id: string, priority: Priority): Promise<PriorityChangeResult> {
    if (!this.api.setPriority) throw new Error('当前后端版本不支持优先级，请升级服务端');
    const result = await this.api.setPriority(id, priority);
    this.upsert(result.message);
    return result;
  }

  async refreshAutoRules(): Promise<AutoRule[]> {
    // 与 loadStats 同款语义：后端不支持时明确报错，而不是把「功能不可用」伪装成「没有规则」
    if (!this.api.autoRules) throw new Error('当前后端版本不支持自动回复规则，请升级服务端');
    return this.api.autoRules();
  }

  async createAutoRule(input: AutoRuleInput): Promise<AutoRule> {
    if (!this.api.createAutoRule) throw new Error('当前后端版本不支持自动回复规则，请升级服务端');
    return this.api.createAutoRule(input);
  }

  async updateAutoRule(id: string, patch: Partial<AutoRuleInput>): Promise<AutoRule> {
    if (!this.api.updateAutoRule) throw new Error('当前后端版本不支持自动回复规则，请升级服务端');
    return this.api.updateAutoRule(id, patch);
  }

  async deleteAutoRule(id: string): Promise<void> {
    if (!this.api.deleteAutoRule) throw new Error('当前后端版本不支持自动回复规则，请升级服务端');
    await this.api.deleteAutoRule(id);
  }

  async loadStats(): Promise<StatsOverview> {
    if (!this.api.stats) throw new Error('当前后端版本不支持统计看板，请升级服务端');
    return this.api.stats();
  }

  /** 全部标为已读：可传 ids 只标记当前筛选范围；后端负责广播，这里同步本地避免闪烁 */
  async markAllRead(ids?: string[]): Promise<number> {
    const changed = await this.api.markAllRead(ids);
    if (changed === 0) return 0;
    const now = new Date().toISOString();
    const scope = ids && ids.length > 0 ? new Set(ids) : undefined;
    this.set({
      messages: this.state.messages.map((m) =>
        m.readAt || (scope && !scope.has(m.traceId)) ? m : { ...m, readAt: now },
      ),
    });
    return changed;
  }

  /** 下载附件：只把 traceId + 索引交给后端，token / 平台资源都不经过页面 */
  downloadAttachment(
    traceId: string,
    index: number,
    field: 'attachments' | 'replyAttachments' = 'attachments',
  ): Promise<DownloadedFile> {
    return this.api.downloadAttachment(traceId, index, field);
  }

  getTrace(id: string) {
    return this.api.trace(id);
  }

  async simulateIncoming(): Promise<void> {
    if (!isDemoApi(this.api)) return;
    await this.api.simulateIncoming();
    await this.refreshHealth();
  }

  armFailure(): void {
    if (isDemoApi(this.api)) this.api.armNextSendFailure();
  }

  /** 静默重拉全量数据（空态注入、外部写入后手动对齐用；失败保持现状） */
  async refresh(): Promise<void> {
    await this.reload();
  }

  /** 飞书 OAuth 回来只更新账号页，不重拉消息（避免打扰当前收件箱视图） */
  async refreshAccounts(): Promise<void> {
    try {
      this.set({ accounts: await this.api.accounts() });
    } catch {
      // 授权页刚关闭时后端可能正忙；保持现状，下一次操作会再拉
    }
  }

  /** 发起飞书用户授权：仅返回授权 URL，打开新标签由页面负责 */
  async feishuOAuthStart(): Promise<FeishuOAuthStart> {
    return this.api.feishuOAuthStart();
  }

  /**
   * 拉起钉钉本人身份登录（本机 dws）：返回操作指引，完成后前端轮询状态判断。
   * mode=browser 走本机 loopback OAuth（推荐）；device 用于远程 / 无浏览器。
   */
  async dingtalkPersonalLogin(options?: DingtalkLoginOptions): Promise<DingtalkLoginStart> {
    return this.api.dingtalkPersonalLogin(options);
  }

  /** 轮询钉钉本人身份登录状态（只读，不打断当前消息视图） */
  async dingtalkPersonalStatus(): Promise<DingtalkPersonalStatus> {
    return this.api.dingtalkPersonalStatus();
  }

  /** 注销钉钉本人身份并刷新账号页（回到机器人 / Mock 通道） */
  async dingtalkPersonalLogout(): Promise<void> {
    await this.api.dingtalkPersonalLogout();
    await this.refreshAccounts();
  }

  async refreshHealth(): Promise<void> {
    try {
      this.set({ health: await this.api.health() });
    } catch {
      // 健康指标失败不影响主流程
    }
  }

  /**
   * 刷新授权中心聚合状态（个人版首启向导）。
   * 失败返回 null 且不覆盖已有数据：旧后端 / 网络抖动时页面可提示「后端版本较旧」。
   */
  async refreshOnboarding(): Promise<OnboardingView | null> {
    try {
      const onboarding = await this.api.onboarding();
      this.set({ onboarding });
      return onboarding;
    } catch {
      return null;
    }
  }

  /** 运行时邮箱账号（脱敏）；失败时抛出给页面展示中文错误 */
  async mailAccounts(): Promise<MailAccountView[]> {
    return this.api.mailAccounts();
  }

  /** 测试邮箱 IMAP / SMTP 登录：只读自检，成功/失败都返回结构化结果 */
  async mailAccountTest(input: MailAccountInput): Promise<MailAccountTestResult> {
    return this.api.mailAccountTest(input);
  }

  /** 保存邮箱账号：落盘 + 热加载，随后刷新授权中心与账号页 */
  async mailAccountCreate(input: MailAccountInput): Promise<void> {
    await this.api.mailAccountCreate(input);
    await Promise.all([this.refreshOnboarding(), this.refreshAccounts()]);
  }

  /** 删除本地邮箱账号（.env 来源后端会拒绝）；随后刷新授权中心与账号页 */
  async mailAccountDelete(key: string): Promise<void> {
    await this.api.mailAccountDelete(key);
    await Promise.all([this.refreshOnboarding(), this.refreshAccounts()]);
  }

  /** 验证已保存的邮箱账号（真实 IMAP/SMTP 自检；成功后账号标记「已验证」） */
  async mailAccountVerify(key: string): Promise<MailAccountTestResult> {
    const result = await this.api.mailAccountVerify(key);
    if (result.ok) await Promise.all([this.refreshOnboarding(), this.refreshAccounts()]);
    return result;
  }

  /** 刷新平台应用凭据 / 运行配置；失败返回 null，不阻塞页面 */
  async refreshAppConfig(): Promise<AppConfigView | null> {
    try {
      const appConfig = await this.api.getAppConfig();
      this.set({ appConfig });
      return appConfig;
    } catch {
      return null;
    }
  }

  /** 读取配置（配置弹窗需要失败时给出中文错误，因此不吞异常） */
  async loadAppConfig(): Promise<AppConfigView> {
    const appConfig = await this.api.getAppConfig();
    this.set({ appConfig });
    return appConfig;
  }

  /** A 形态：探测本机 RPA 桥（配置弹窗用） */
  async wechatBridgeStatus(): Promise<WechatBridgeInfo> {
    return this.api.wechatBridgeStatus();
  }

  /** A 形态：由后端拉起本机 RPA 桥 */
  async startWechatBridge(): Promise<WechatBridgeStartResult> {
    return this.api.startWechatBridge();
  }

  /** A 形态：停止由后端拉起的 RPA 桥 */
  async stopWechatBridge(): Promise<WechatBridgeStopResult> {
    return this.api.stopWechatBridge();
  }

  /** 保存配置（部分更新）：返回是否需重启 / 是否热应用，并刷新本地缓存与健康状态 */
  async saveAppConfig(patch: AppConfigUpdate): Promise<AppConfigSaveResult> {
    const result = await this.api.updateAppConfig(patch);
    await Promise.all([this.refreshAppConfig(), this.refreshHealth()]);
    return result;
  }

  /** 静默重拉全量数据（断线重连后的状态兜底；失败则保持现有数据） */
  private async reload(): Promise<void> {
    try {
      const [messages, accounts, health] = await Promise.all([
        this.api.list(),
        this.api.accounts(),
        this.api.health(),
      ]);
      this.set({ messages, accounts, health, error: null });
      void this.refreshOnboarding();
      void this.refreshAppConfig();
    } catch {
      // 静默失败：保持现有数据，等待下一次实时推送
    }
  }

  private onRealtime(event: { type: string; data?: UnifiedMessage }): void {
    // 认领历史消息后由服务端广播：直接重拉，避免手动刷新
    if (event.type === 'messages.changed') {
      void this.reload();
      return;
    }
    if (!event.data) return;
    // 数据隔离：别人的消息不推进来的收件箱（部署令牌 / 未登录时不过滤）
    const ownerId = (event.data as { ownerId?: string }).ownerId;
    const me = getSession()?.user.id;
    if (ownerId && me && ownerId !== me) return;
    if (event.type === 'message.received' || event.type === 'message.updated' || event.type === 'message.failed') {
      // 实时失败才提示：失败原因直接写进消息，详情页不必再让用户去回放里翻
      if (event.type === 'message.failed' || event.data.status === MsgStatus.FAILED) {
        this.set({
          sendFailure: {
            traceId: event.data.traceId,
            ...(event.data.failureReason ? { reason: event.data.failureReason } : {}),
            at: Date.now(),
          },
        });
      }
      this.upsert(event.data);
    }
  }

  /** 合并 202 回执：本地已推进到 sent/synced 时保留本地状态，避免乱序回退 */
  private upsertReply(incoming: UnifiedMessage): void {
    if (!incoming?.traceId) return;
    const cur = this.state.messages.find((m) => m.traceId === incoming.traceId);
    if (!cur) {
      this.upsert(incoming);
      return;
    }
    const keepLocalStatus = cur.status === MsgStatus.SENT || cur.status === MsgStatus.SYNCED;
    this.upsert({
      ...cur,
      reply: incoming.reply ?? cur.reply,
      /**
       * 回复历史必须一起合并：202 回执里的 message 是「当前这条」，如果只挑几个字段，
       * `replies` 会被丢掉 —— 界面上表现为"刚发的气泡和之前的回复都消失"。
       * 取更长的那个，避免回执比 WS 推送旧时把历史截短。
       */
      replies: (incoming.replies?.length ?? 0) >= (cur.replies?.length ?? 0)
        ? (incoming.replies ?? cur.replies)
        : cur.replies,
      intent: incoming.intent ?? cur.intent,
      replyDraft: incoming.replyDraft ?? cur.replyDraft,
      updatedAt: incoming.updatedAt ?? cur.updatedAt,
      status: keepLocalStatus ? cur.status : incoming.status,
    });
  }

  private upsert(message: UnifiedMessage): void {
    const exists = this.state.messages.some((m) => m.traceId === message.traceId);
    const messages = exists
      ? this.state.messages.map((m) => (m.traceId === message.traceId ? message : m))
      : [message, ...this.state.messages];
    this.set({ messages });
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
}
