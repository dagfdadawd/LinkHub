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

/** 通道策略：auto=按凭据自动选择（有凭据走真实，否则 Mock）；real / mock=强制指定 */
export type AccountPolicy = 'auto' | 'real' | 'mock';

/** 发起飞书用户授权的返回值 */
export interface FeishuOAuthStart {
  url: string;
  redirectUri?: string;
}

/**
 * 钉钉本人身份登录：POST /api/dingtalk/personal/login 的返回。
 * 后端只负责把本机 dws 登录流程拉起来并把操作指引返回给前端（接口立即返回，不阻塞）。
 *  - browser：dws 会打开浏览器做 OAuth 授权，前端轮询 /status 等结果；
 *  - device ：无浏览器 / 容器环境，展示 code + 终端命令，用户在手机或终端完成确认。
 */
export interface DingtalkLoginStart {
  started: boolean;
  mode: 'browser' | 'device';
  /** 实际执行的命令（可复制到终端） */
  command: string;
  /** 人话操作指引（中文） */
  instructions: string;
  /** device / browser 模式都可能返回的授权链接 */
  url?: string;
  /** device 模式的用户码（在浏览器打开 url 后输入） */
  code?: string;
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
  envFile?: { path: string; mtime: string } | null;
}

export interface TraceResult {
  data: UnifiedMessage[];
  log: TraceEntry[];
}

export interface MessageApi {
  list(filter?: MessageFilter): Promise<UnifiedMessage[]>;
  get(id: string): Promise<UnifiedMessage | undefined>;
  /** 文本与附件可同时发送（赛题 A 功能需求 3） */
  reply(id: string, text: string, attachments?: OutboundAttachment[]): Promise<ReplyAck>;
  /** 从统一入口主动向指定平台/会话发送，不依赖先收到消息 */
  compose(req: ComposeRequest): Promise<ComposeAck>;
  /** 各平台发送能力与体积上限，供新建发送表单渲染 */
  capabilities(): Promise<SendCapabilities[]>;
  /** 发起飞书用户身份授权，返回需要打开的飞书授权页 URL */
  feishuOAuthStart(): Promise<FeishuOAuthStart>;
  /**
   * 拉起钉钉本人身份登录（本机 dws CLI）。接口立即返回操作指引，
   * 完成后端登录后由前端轮询 dingtalkPersonalStatus() 判断。
   */
  dingtalkPersonalLogin(): Promise<DingtalkLoginStart>;
  /** 轮询钉钉本人身份登录状态（后端有缓存，2s 轮询安全） */
  dingtalkPersonalStatus(): Promise<DingtalkPersonalStatus>;
  /** 注销钉钉本人身份（退回机器人 / Mock 通道） */
  dingtalkPersonalLogout(): Promise<void>;
  markDone(id: string): Promise<UnifiedMessage>;
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