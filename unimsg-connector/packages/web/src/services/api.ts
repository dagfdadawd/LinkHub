/**
 * 前端数据访问契约。
 *
 * 页面与状态层只依赖这一个接口：
 *  - 现在：MockApi（内存数据 + 模拟推送）
 *  - 后续：HttpApi（对接 packages/server 的 REST/WS），页面代码零改动
 */
import type {
  ComposeAck, ComposeRequest, DeliveryMode, OutboundAttachment, PlatformIdentityView,
  SendCapabilities, UserIdentityStatus,
} from '@unimsg/shared';
import type { MsgType, TraceEntry, UnifiedMessage } from '../types';
import type { Platform, MsgStatus } from '../types';

export interface MessageFilter {
  platform?: Platform;
  status?: MsgStatus;
  type?: MsgType;
  keyword?: string;
  onlyReview?: boolean;
}

/** 回复回执：与后端 202 响应同构 */
export interface ReplyAck {
  message: UnifiedMessage;
  taskId: string;
}

/**
 * 「重新生成」结果：完整消息 + 后端当前 LLM 通道结论。
 * 带上 reason 是为了在仍是规则兜底时如实告诉用户原因，而不是弹一句无信息量的提示。
 */
export interface ReanalyzeResult {
  message: UnifiedMessage;
  llm: {
    mode: 'mock' | 'real';
    reason: string;
    providerLabel: string;
    /** 仅真实模型结果：精度档与把握程度，低精度仍是模型生成，不是规则兜底 */
    precision?: 'high' | 'low';
    confidence?: number;
  };
}

/** 通道策略：auto=按凭据自动选择（有凭据走真实，否则 Mock）；real / mock=强制指定 */
export type AccountPolicy = 'auto' | 'real' | 'mock';

/** 发起飞书用户授权的返回值 */
export interface FeishuOAuthStart {
  url: string;
  redirectUri?: string;
}

/** 钉钉登录方式：auto=后端决定（优先浏览器 loopback，失败回退设备码）；browser=本机浏览器；device=远程/无浏览器设备码 */
export type DingtalkLoginMode = 'auto' | 'browser' | 'device';

/** POST /api/dingtalk/personal/login 请求体 */
export interface DingtalkLoginOptions {
  mode?: DingtalkLoginMode;
  /** true = 杀掉进行中的登录流程并重新发起（重新获取设备码 / 换方式） */
  force?: boolean;
}

/**
 * 钉钉本人身份登录：POST /api/dingtalk/personal/login 的返回。
 * 后端只负责把本机 dws 登录流程拉起来并把操作指引返回给前端（接口立即返回，不阻塞）。
 *  - browser：dws 会打开浏览器做 loopback OAuth 授权（授权完成自动回调），前端轮询 /status 等结果；
 *  - device ：无浏览器 / 容器环境，展示授权码 + 授权链接，需在有效期内由另一台设备完成。
 */
export interface DingtalkLoginStart {
  started: boolean;
  /** 后端实际采用的登录方式（请求 auto 时可能是 browser 或 device） */
  mode: 'browser' | 'device';
  /** 用户请求的方式（auto/browser/device）：后端诊断用，前端可忽略 */
  requestedMode?: DingtalkLoginMode;
  /** 实际执行的命令（可复制到终端） */
  command: string;
  /** 人话操作指引（中文） */
  instructions: string;
  /** device / browser 模式都可能返回的授权链接 */
  url?: string;
  /** device 模式的用户码（在浏览器打开 url 后输入） */
  code?: string;
  /** 本次登录流程有效期（秒）：设备码过期 / 浏览器授权超时用 */
  expiresInSec?: number;
  /** 有效期截止时间（ISO，后端能推算时下发；与 expiresInSec 二选一或都给） */
  expiresAt?: string;
  /** 本次登录流程 ID（后端用于避免重复发起 / 恢复状态） */
  loginId?: string;
}

/** GET /api/dingtalk/personal/status：登录倒计时轮询用（后端有缓存，不每次等 dws） */
export interface DingtalkPersonalStatus {
  /** 本机是否可用 dws（已安装） */
  available: boolean;
  /** dws 版本（可用时） */
  version?: string;
  authenticated: boolean;
  /** 与 UserIdentityStatus.state 同枚举，可直接映射 */
  state?: UserIdentityStatus['state'];
  displayName?: string;
  detail?: string;
  /** 当前状态 + 下一步（中文、可操作） */
  hint: string;
  /** 用户需要在终端执行的登录命令（无浏览器 / 容器部署时展示） */
  loginCommand?: string;
  /** 仅在 available=false 时返回：dws 安装指引 */
  installHint?: string;
  /** 当前是否有登录流程在进行（用于打开弹窗时恢复 URL / 设备码 / 倒计时） */
  loginInProgress?: boolean;
  loginMode?: 'browser' | 'device';
  /** 进行中的授权链接（设备码模式为设备授权页；浏览器模式为 loopback OAuth 页） */
  loginUrl?: string;
  /** 进行中的设备授权码 */
  loginCode?: string;
  /** 进行中的登录流程过期时间（ISO） */
  loginExpiresAt?: string;
  /** 登录剩余有效秒数（后端算好，避免本机时钟偏差；与 loginExpiresAt 二选一或都给） */
  loginExpiresInSec?: number;
  /** 进行中流程的操作指引（中文；恢复弹窗时原样展示） */
  loginInstructions?: string;
  /** 进行中登录的唯一 ID：前端据此判断是否同一次流程 */
  loginId?: string;
}

/** 邮箱平台下的单个账号：只含展示所需的非敏感字段，授权码永不下发前端 */
export interface MailAccountInfo {
  key: string;
  label: string;
  address: string;
  imapHost: string;
  smtpHost: string;
  folders: string[];
  mode?: DeliveryMode;
}

/** 邮箱平台的配置问题：只含级别与文案，绝不含密钥值 */
export interface AccountIssue {
  level: 'error' | 'warn';
  message: string;
}

/**
 * 平台账号状态（与后端 /api/accounts 对齐）：
 * configured 只表示凭据是否齐全；mode 才是本次实际通道。
 */
export interface AccountInfo {
  platform: Platform;
  /** 平台展示名（后端下发，前端可用 PLATFORM_META 兜底） */
  label?: string;
  configured: boolean;
  /** 通道策略：auto=凭据齐全走真实、缺失回退 Mock */
  policy?: AccountPolicy;
  /** 本次实际通道：real=真实接口，mock=本地模拟 */
  mode?: DeliveryMode;
  canReceive?: boolean;
  canSend?: boolean;
  /** 缺失的环境变量名（只有变量名，绝不含密钥值） */
  missing?: string[];
  /** 能力缺口 / 风险提示（如「只能发不能收」「企微需可信 IP」），逐条展示 */
  warnings?: string[];
  /** 配置问题（邮箱缺授权码、host 未填等），error 红 / warn 橙 */
  issues?: AccountIssue[];
  /** 人类可读的接入说明（例如「凭据齐全，auto → 真实接口」） */
  reason?: string;
  /** 邮箱平台的多账号明细 */
  accounts?: MailAccountInfo[];
  /**
   * 本人身份视图（仅飞书 / 钉钉）：谁在收、谁在发、登录状态与下一步；
   * 后端把状态都解析好了，前端只渲染，不自行猜测身份。
   */
  identity?: PlatformIdentityView;
}

export interface HealthInfo {
  received: number;
  deduped: number;
  sent: number;
  failed: number;
  dlq: number;
  /** Mock 模拟发送次数（真实接口发送不计入） */
  sentMock?: number;
  /** 后端进程启动时间（ISO）：页面据此判断「指标是本次启动以来」 */
  startedAt?: string;
  /**
   * 后端启动时读取的 .env 文件信息（只有路径与修改时间，绝不含内容）。
   * 不存在 .env 时为 null；后端版本较旧时字段缺失。
   */
  envFile?: { path: string; mtime: string | null } | null;
  /**
   * 后端启动时读取的本地配置文件（DATA_DIR/linkhub-config.json）信息：
   * 只有路径与修改时间，绝不包含内容；不存在 / 旧后端时缺失或 null。
   */
  settingsFile?: { path: string; mtime: string | null } | null;
}

export interface TraceResult {
  data: UnifiedMessage[];
  log: TraceEntry[];
}

// ---------------------------------------------------------------------------
// 平台应用凭据 / 运行配置（GET/PUT /api/app-config）
// 白号首次使用 P0：客户必须能在界面填写 App 凭据，而不是只能改 .env。
// 安全：secret 只下发「已配置」/脱敏值；保存后不回显明文。
// ---------------------------------------------------------------------------

/** 字段来源：env=.env 已配置（GUI 不可覆盖）；local=本地配置文件；none=未配置；unknown=旧后端未标注 */
export type AppConfigSource = 'env' | 'local' | 'none' | 'unknown';

export interface AppConfigField {
  configured: boolean;
  /** 脱敏后的展示值（secret 通常只显示「已配置」或末 4 位） */
  display?: string;
  source: AppConfigSource;
  /** 对应环境变量名（后端可给，便于提示「也可写 .env」） */
  key?: string;
  /** 非 secret 的布尔/枚举字段（如 stream 开关）后端会回传真实值 */
  value?: string | boolean;
}

export type AppConfigFieldMap = Record<string, AppConfigField>;

export type AppConfigPlatformId = 'feishu' | 'dingtalk' | 'wecom';

export interface AppConfigPlatformView {
  fields: AppConfigFieldMap;
  /** 还缺的环境变量 / 配置键名（来自 /api/onboarding detail.missing 或 app-config） */
  missing: string[];
}

export interface AppConfigView {
  /** 身份策略：如 {dingtalk:'user'|'auto'|'bot', feishu:...} */
  identity: Record<string, string | boolean | undefined>;
  /** 身份策略来源（来自 .env 时 GUI 不可覆盖） */
  identitySources?: Record<string, 'env' | 'local' | 'none'>;
  platforms: Record<AppConfigPlatformId, AppConfigPlatformView>;
  llm: AppConfigFieldMap;
  modes?: Record<string, string>;
  /** true = 配置文件比进程启动新，保存后需要重启 LinkHub 才生效 */
  restartRequired: boolean;
  envFile?: { path: string; mtime: string | null } | null;
  settingsFile?: { path: string; mtime: string | null } | null;
}

/** PUT /api/app-config 请求体：只传要修改的字段（省略=不改） */
export interface AppConfigUpdate {
  identity?: Record<string, string | undefined>;
  platforms?: Partial<Record<AppConfigPlatformId, Record<string, string | boolean | undefined>>>;
  llm?: Record<string, string | undefined>;
  modes?: Record<string, string | undefined>;
}

export interface AppConfigSaveResult {
  saved: boolean;
  /** true = 需要重启 LinkHub 才生效（应用凭据类配置） */
  restartRequired: boolean;
  /** true = 已热应用，无需重启（如 identity.dingtalk 切「仅本人身份」） */
  hotApplied?: boolean;
  /** 本次实际热应用成功的键（identity.*），便于前端精确提示 */
  hotAppliedKeys?: string[];
  /** 静态键（需要重启才生效）列表 */
  staticKeys?: string[];
  /** 因 .env 显式优先而被忽略的键（GUI 不覆盖运维已写的环境变量） */
  ignoredByEnv?: string[];
  /** 后端保存提示（中文；可直接展示） */
  message?: string;
  warnings?: string[];
  changedKeys: string[];
}

/** 各平台应用凭据字段（PUT 只提交有值的字段；GET 归一化时保证这些键总是存在） */
export const APP_CONFIG_PLATFORM_FIELD_KEYS: Record<AppConfigPlatformId, string[]> = {
  feishu: ['appId', 'appSecret', 'verifyToken', 'encryptKey', 'stream'],
  dingtalk: ['clientId', 'clientSecret', 'robotCode', 'aesToken', 'aesKey', 'stream'],
  wecom: ['corpId', 'agentId', 'secret', 'token', 'aesKey'],
};

/** AI 模型（可选）字段 */
export const APP_CONFIG_LLM_FIELD_KEYS = ['provider', 'apiKey', 'baseUrl', 'model'];

// ---------------------------------------------------------------------------
// 授权中心 / 首次使用向导（个人版）
// 后端契约见 GET /api/onboarding；接口未就绪时页面给出「后端版本较旧」提示。
// ---------------------------------------------------------------------------

/** 平台连接状态（后端聚合，前端只渲染） */
export type OnboardingState =
  | 'ready'
  | 'needs_user_auth'
  | 'needs_install'
  | 'needs_admin'
  | 'mock'
  | 'error';

/** 动作类型：api=调接口/登录，form=展开邮箱表单，link=打开官方后台，copy=复制清单，command=展示可复制命令 */
export type OnboardingActionKind = 'api' | 'form' | 'link' | 'copy' | 'command';

export interface OnboardingAction {
  id: string;
  kind: OnboardingActionKind;
  label: string;
  /** kind=api 时后端建议的接口路径（前端只识别已知动作，不做任意请求） */
  path?: string;
  method?: string;
  /** kind=api 且 path=/api/app-config 时的请求体（后端新 schema） */
  payload?: Record<string, unknown>;
  /** 主调用完成后按顺序继续调（例如先 PUT 身份模式，再 POST 拉起登录） */
  then?: Array<{ path: string; method?: string; payload?: Record<string, unknown> }>;
  /** kind=link：官方后台 / 文档深链 */
  url?: string;
  /** kind=copy：要复制的管理员清单 / 说明文本 */
  text?: string;
  /** kind=command：要展示并可复制的命令（如 pnpm run fetch:dws） */
  command?: string;
}

export interface OnboardingStep {
  id: 'mail' | 'dingtalk' | 'feishu' | 'wecom';
  label: string;
  state: OnboardingState;
  summary: string;
  hints: string[];
  actions: OnboardingAction[];
  /** 平台明细（脱敏）：identity / 邮箱账号列表 / 缺失配置项等，后端结构因平台而异 */
  detail?: Record<string, unknown>;
}

/** dws 可执行文件来源：内置 tools / 显式 .env / 用户目录 / PATH / 未找到 */
export type DwsSource = 'env' | 'tools' | 'user_profile' | 'path' | 'missing';

export interface OnboardingDwsInfo {
  available: boolean;
  version?: string;
  source: DwsSource;
  pathHint?: string;
}

export interface OnboardingView {
  generatedAt?: string;
  /** 后端判定是否「首次使用」：环境仍是模板 / 没有可用账号 */
  firstRun: boolean;
  startedAt?: string;
  envFile?: { path: string; mtime: string | null } | null;
  dws: OnboardingDwsInfo;
  overall: { ready: number; total: number; needsAction: number };
  /** 平台卡片；前端按邮箱 → 钉钉 → 飞书 → 企微 排序 */
  steps: OnboardingStep[];
}

/** 运行时邮箱账号（GET /api/mail/accounts）：地址脱敏，授权码永不下发 */
export interface MailAccountView {
  key: string;
  label?: string;
  /** 后端可能直接给脱敏地址（address 已打码），也可能另给 maskedAddress */
  address?: string;
  maskedAddress?: string;
  addressMasked?: string;
  provider?: string;
  /** env=.env 配置；file=LinkHub 本地账号文件（可删除） */
  source: 'env' | 'file';
  /** 后端标记是否可在本地删除（file=true；旧后端可能缺失，页面按 source 兜底） */
  removable?: boolean;
  /** 是否已通过「测试连接」验证（未验证账号不算邮箱平台 ready） */
  verified?: boolean;
  verifiedAt?: string;
  folders?: string[];
  mode?: DeliveryMode;
}

/** 邮箱测试 / 保存请求体（POST /api/mail/accounts*） */
export interface MailAccountInput {
  provider: string;
  address: string;
  /** 邮箱授权码（不是登录密码）；只随请求发送，前端不回显、不落 localStorage */
  authCode: string;
  label?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  /** 先真实连接测试通过才保存（后端 verify:true；失败不会保存半成品账号） */
  verify?: boolean;
}

/** 邮箱连接测试结果（IMAP + SMTP 登录自检） */
export interface MailAccountTestResult {
  ok: boolean;
  /** 中文结论（失败时可操作） */
  message?: string;
  /** 逐项明细（可选；后端不提供时页面只显示 message） */
  details?: string[];
}

export interface MessageApi {
  list(filter?: MessageFilter): Promise<UnifiedMessage[]>;
  get(id: string): Promise<UnifiedMessage | undefined>;
  /** 文本与附件可同时发送（赛题 A 功能需求 3） */
  reply(id: string, text: string, attachments?: OutboundAttachment[]): Promise<ReplyAck>;
  /** 从统一入口主动向指定平台/会话发送，不依赖先收到消息 */
  compose(req: ComposeRequest): Promise<ComposeAck>;
  /** 用当前 AI 配置重新分析这条消息（真实后端会调模型，Mock 走本地规则） */
  reanalyze(id: string): Promise<ReanalyzeResult>;
  /** 各平台发送能力与体积上限，供新建发送表单渲染 */
  capabilities(): Promise<SendCapabilities[]>;
  /** 发起飞书用户身份授权，返回需要打开的飞书授权页 URL */
  feishuOAuthStart(): Promise<FeishuOAuthStart>;
  /**
   * 拉起钉钉本人身份登录（本机 dws CLI）。接口立即返回操作指引，
   * 完成后端登录后由前端轮询 dingtalkPersonalStatus() 判断。
   * `mode=auto` 由后端决定（优先浏览器 loopback，失败回退设备码）：
   * 本机有浏览器时推荐 browser，远程 / 无浏览器用 device。
   */
  dingtalkPersonalLogin(options?: DingtalkLoginOptions): Promise<DingtalkLoginStart>;
  /** 轮询钉钉本人身份登录状态（后端有缓存，2s 轮询安全） */
  dingtalkPersonalStatus(): Promise<DingtalkPersonalStatus>;
  /** 注销钉钉本人身份（退回机器人 / Mock 通道） */
  dingtalkPersonalLogout(): Promise<void>;
  /** 授权中心聚合状态（个人版首启向导；均不含 token / 授权码） */
  onboarding(): Promise<OnboardingView>;
  /** 运行时邮箱账号（脱敏列表，含 env / file 来源） */
  mailAccounts(): Promise<MailAccountView[]>;
  /** 测试邮箱 IMAP / SMTP 登录（只读自检，不落盘） */
  mailAccountTest(input: MailAccountInput): Promise<MailAccountTestResult>;
  /** 保存邮箱账号（服务端落盘并热加载，不需要重启） */
  mailAccountCreate(input: MailAccountInput): Promise<void>;
  /** 删除本地保存的邮箱账号（.env 来源不可删） */
  mailAccountDelete(key: string): Promise<void>;
  /** 对已保存的本地邮箱账号跑一次真实 IMAP/SMTP 自检（成功后标记「已验证」） */
  mailAccountVerify(key: string): Promise<MailAccountTestResult>;
  /** 读取平台应用凭据 / 运行配置（脱敏，不含 secret 明文） */
  getAppConfig(): Promise<AppConfigView>;
  /** 保存平台应用凭据 / 身份模式（部分更新；返回是否需要重启） */
  updateAppConfig(patch: AppConfigUpdate): Promise<AppConfigSaveResult>;
  markDone(id: string): Promise<UnifiedMessage>;
/** 把任意消息手动加入待办（不改闭环状态、不触发平台回写） */
  markTodo(id: string): Promise<UnifiedMessage>;
  /** 标记已读 / 未读（阅读状态独立于业务状态） */
  markRead(id: string, read: boolean): Promise<UnifiedMessage>;
  /** 全部标为已读（可只标当前筛选范围），返回实际改动条数 */
  markAllRead(ids?: string[]): Promise<number>;
  trace(id: string): Promise<TraceResult>;
  accounts(): Promise<AccountInfo[]>;
  health(): Promise<HealthInfo>;
}

/** 演示用能力：仅 Mock 实现，真实后端接入后按钮自动隐藏 */
export interface DemoApi extends MessageApi {
  simulateIncoming(): Promise<UnifiedMessage>;
  armNextSendFailure(): void;
}

export function isDemoApi(api: MessageApi): api is DemoApi {
  return typeof (api as Partial<DemoApi>).simulateIncoming === 'function';
}