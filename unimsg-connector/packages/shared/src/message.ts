/**
 * 统一消息契约（前后端共享 · 评分强制契约，见文档 2.3）
 *
 * 这是整个系统的"宪法"：三平台适配器、中枢服务、REST 路由、前端
 * 全部围绕这些类型与接口编写。任何一端改动都必须保持强一致。
 */

/** 支持接入的平台（附加项要求 ≥3 平台） */
export enum Platform {
  FEISHU = 'feishu',
  DINGTALK = 'dingtalk',
  WECOM = 'wecom',
  /** 邮箱（QQ / 163 …）：IMAP 轮询收、SMTP 发，可挂多个账号 */
  MAIL = 'mail',
}

/** 闭环状态机（文档 1.3）：received→processing→replied→sent→synced，失败进 failed */
export enum MsgStatus {
  RECEIVED = 'received',
  PROCESSING = 'processing',
  REPLIED = 'replied',
  SENT = 'sent',
  SYNCED = 'synced',
  FAILED = 'failed',
}

/** 消息类型 */
export type MsgType = 'text' | 'image' | 'file' | 'todo';

/** 发送方 */
export interface Sender {
  name: string;
  id: string;
}

/**
 * 一次回写实际走的通道：真实平台接口（real）还是本地模拟（mock）。
 * 契约强制：任何"成功"都必须带上它，前端据此标注「模拟发送」，
 * 绝不把 Mock 的结果伪装成真实平台已收到。
 */
export type DeliveryMode = 'real' | 'mock';

/** 回写投递信息（成功发送后写入消息，前端与回放可见） */
export interface DeliveryInfo {
  mode: DeliveryMode;
  /** 真实平台返回的凭证（飞书 message_id / 钉钉 processQueryKey / 企微 msgid / SMTP 回执） */
  platformReply?: string;
  at: string;
  /** 本次真实发送实际使用的身份（本人 / 机器人）；Mock 模式不写（如实标注） */
  identity?: IdentityRole;
}

/** 连接器发送结果：mode 必须如实反映本次是真实接口还是本地模拟 */
export interface SendResult {
  ok: boolean;
  platformReply?: string;
  mode: DeliveryMode;
  /** 真实发送时实际使用的身份（机器人 / 用户本人）；Mock 不填 */
  identity?: IdentityRole;
}

/**
 * 出站附件体积上限（赛题 A 功能需求「发送文本消息、文件等」）。
 * 前后端共用同一份常量：前端在选文件时就拦截，服务端在解析前再拒一次，
 * 避免两层阈值漂移，也避免把超大 base64 打进请求体。
 */
export const FILE_LIMITS = {
  maxFiles: 5,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
} as const;

/**
 * 出站附件（统一入口 → 平台）。
 * `contentBase64` 只在一次请求的在途生命周期里存在：
 * 服务端校验并投递后立即丢弃，绝不写入消息、闭环日志、WS 广播或 sentBox 日志。
 */
export interface OutboundAttachment {
  /** 原始文件名（含扩展名） */
  name: string;
  /** MIME 类型，如 application/pdf */
  mimeType: string;
  /** 原始字节数；服务端会用解码后的实际长度复核，防伪造 */
  size: number;
  /** 文件内容的 base64（不含 data: 前缀） */
  contentBase64: string;
}

/**
 * 附件的「可展示元数据」：不含文件内容，安全入库 / 广播 / 回放。
 * 有附件的消息在收件箱、详情页与全链路回放里都能看到文件名与大小。
 */
export interface AttachmentInfo {
  name: string;
  mimeType: string;
  size: number;
}

/** 平台发送能力：前端据此放开/禁用文件按钮，并如实展示平台边界 */
export interface SendCapabilities {
  platform: Platform;
  /** 当前实际通道：真实接口 / 本地模拟 */
  mode: DeliveryMode;
  text: boolean;
  file: boolean;
  maxFiles: number;
  maxFileBytes: number;
  /** 平台限制说明（如钉钉机器人需媒体上传权限） */
  note?: string;
}

/**
 * 从统一入口「主动」向指定平台发送请求（赛题 A 功能需求 3）。
 * 与 reply 的区别：不依赖先收到某条消息，可指定平台 + 目标会话 + 文本 + 文件。
 */
export interface ComposeRequest {
  platform: Platform;
  /** 目标会话：飞书 chat_id / 钉钉 openConversationId / 企微 userid / 邮箱收件地址 */
  conversationId?: string;
  conversationType?: 'group' | 'p2p';
  /** 邮箱平台专用：从哪个邮箱账号发出（MAIL_<KEY> 的 key）；不填则用首个已配置账号 */
  mailAccount?: string;
  /**
   * 指定本次发送身份（本人 / 机器人）。不填 = 用该平台的 `effectiveSend`。
   * 服务端会校验：请求的身份当前不可用时回 400 中文错误，绝不悄悄换身份。
   */
  identity?: IdentityRole;
  text: string;
  attachments?: OutboundAttachment[];
}

/** 主动发送回执：与 reply 的 202 响应同构，便于前端复用同一套状态推进 */
export interface ComposeAck {
  message: UnifiedMessage;
  taskId: string;
}

// ---------------------------------------------------------------------------
// 身份能力（本人账号接收 / 本人账号发送）—— 见 docs/personal-identity.md
//
// 背景：机器人方案要求「每个人把自己的机器人拉进每个群」，不可接受。
// 本项目因此支持以员工【本人账号】收发；机器人身份保留为兼容/兜底，绝不删除。
// 任何状态下都必须如实标注当前是「本人 / 机器人 / Mock」，不允许含糊。
// ---------------------------------------------------------------------------

/** 一次收发实际使用的身份：机器人 / 用户本人 */
export type IdentityRole = 'bot' | 'user';

/**
 * 身份策略（每个平台独立配置）：
 *  - auto：已连接本人身份就用本人，否则用机器人；
 *  - bot ：固定机器人（即使已连接本人身份）；
 *  - user：固定本人，未连接/失效时显式报错，绝不悄悄回退机器人。
 */
export type IdentityPolicy = 'auto' | 'bot' | 'user';

/**
 * 本人身份连接状态（不含任何令牌值，可安全下发前端 / 写入日志）。
 *
 * 状态语义：
 *  - unavailable：本机/本环境不具备连接条件（飞书缺 App 凭据、钉钉没装 dws）；
 *  - not_linked ：具备条件但用户尚未授权；
 *  - linked     ：已连接且当前可用；
 *  - expired    ：授权过期（可用 refresh 自动续期，或需重新授权）；
 *  - error      ：探测/读取失败（令牌文件损坏、dws 异常等），hint 给修复方式。
 */
export interface UserIdentityStatus {
  state: 'unavailable' | 'not_linked' | 'linked' | 'expired' | 'error';
  /** 已连接且当前可用（state === 'linked'） */
  linked: boolean;
  /** 展示名：飞书授权用户名 / dws 档案显示名；可脱敏 */
  displayName?: string;
  /** 附加说明：dws 版本、档案 corp:user（脱敏）、令牌到期时间等 */
  detail?: string;
  /** 授权/令牌到期时间（ISO，仅本人身份通道有） */
  expiresAt?: string;
  /** 人类可读：当前状态 + 下一步怎么修（中文、可操作） */
  hint: string;
  /** 现在是否可以发起连接（飞书 App 凭据齐全 / dws 已安装） */
  canLink: boolean;
  /** 连接方式：飞书=oauth（浏览器授权页）；钉钉=cli（dws auth login） */
  linkMethod: 'oauth' | 'cli';
  /** 钉钉：用户需要在终端执行的命令（无浏览器/容器部署时展示） */
  loginCommand?: string;
}

/**
 * 一个平台的完整身份视图（`GET /api/accounts` 下发，前端直接渲染）。
 *
 * `effectiveSend/effectiveReceive` 是**本次实际生效**的身份：平台整体为 Mock 时
 * 统一给 'mock'，绝不把模拟通道说成本人或机器人。
 */
export interface PlatformIdentityView {
  /** 用户配置的策略（FEISHU_IDENTITY / DINGTALK_IDENTITY） */
  policy: IdentityPolicy;
  /** 本次发送实际身份；'mock' = 平台整体走本地模拟 */
  effectiveSend: IdentityRole | 'mock';
  /** 本次接收实际身份；'mock' = 平台整体走本地模拟 */
  effectiveReceive: IdentityRole | 'mock';
  user: UserIdentityStatus;
  /** 机器人通道是否可用（凭据齐全） */
  botAvailable: boolean;
  /** 机器人通道的人话说明（含不可用原因与修复方式） */
  botHint: string;
  /** 本次接收走什么通道的人话说明，例如「本人身份：飞书用户轮询（20s）」「机器人长连接」 */
  receiveHint: string;
  /** 本次发送走什么通道的人话说明 */
  sendHint: string;
}

/** 会话（真实回写必须知道发回哪里） */
export interface Conversation {
  id: string;
  type: 'group' | 'p2p';
  /** 群名称等展示用信息（平台返回才有，例如钉钉 conversationTitle；不参与发送） */
  title?: string;
}

/**
 * 统一消息标准格式：外部平台的事件无论长什么样，
 * 经适配器 convert 后都收敛成这一种结构，后端只认这一种。
 */
export interface UnifiedMessage {
  traceId: string; // 全链路追踪号，贯穿"接收→处理→发送→状态变更"
  platform: Platform;
  externalId: string; // 平台侧原始消息 ID
  sender: Sender;
  conversation?: Conversation; // 消息所属会话（群/单聊），真实回写使用
  type: MsgType;
  body: string;
  intent?: string; // 大模型识别的意图
  /**
   * 意图来自哪条通道：真实大模型（llm）还是内置规则（rules）。
   * 与 DeliveryMode 同一原则——前端如实标注，绝不把规则结果说成大模型。
   */
  intentSource?: 'llm' | 'rules';
  replyDraft?: string; // 大模型给出的可编辑回复草稿
  reply?: string; // 用户最终回写的文本（回写时发送此内容）
  done?: boolean; // 是否已标记完成（待办类）
  /**
   * 本条消息是通过哪种身份收到的：本人账号接收 / 机器人接收。
   * 真实接收通道必填；Mock 演示消息不写（如实标注，绝不冒充真实接收）。
   */
  receivedAs?: IdentityRole;
  /**
   * 阅读状态：用户第一次在统一入口打开这条消息的时间（ISO）。
   * 未设置 = 未读。与 status（业务流转）正交——「已同步」不代表「我看过」。
   */
  readAt?: string;
  /**
   * 消息方向：`in` = 对方发来的，`out` = 通过 LinkHub 或本人账号发出的。
   *
   * 为什么需要：钉钉个人事件会把「自己刚发出的消息」再推回来（回声），
   * 平台不提供 openDingTalkId 因而无法按身份过滤。识别为 out 之后，
   * 会话列表不再把它算成新消息、不产生未读，聊天区渲染在右侧。
   * 缺省（旧数据 / Mock）按 `in` 处理，保持向后兼容。
   */
  direction?: 'in' | 'out';
  /**
   * 待办截止时间（ISO）。演示环境由服务端从正文做启发式推断（"明天 18:00"/"周三"/"12月3日"），
   * 解析不出就是 undefined —— 前端归入"未设置截止"，不伪造时间。
   */
  dueAt?: string;
  needsReview?: boolean; // OCR 低置信/失败时标记“待人工确认”
  status: MsgStatus;
  createdAt: string;
  updatedAt: string;
  /** 仅后端内部使用：回写后平台返回的内容（不暴露敏感信息给前端） */
  platformReply?: string;
  /** 仅后端内部使用：邮箱回写需要的会话信息（账号 / 被回复的 Message-ID / 原主题） */
  mailMeta?: { account: string; inReplyTo: string; subject: string };
  /** 回写投递方式（成功后写入；Mock 模式也如实记录，便于前端标注"模拟发送"） */
  delivery?: DeliveryInfo;
  /**
   * 发送失败原因（人话摘要，最长约 300 字）：
   * 前端详情页 / toast 直接展示，用户不用去回放里翻。完整原因仍写入闭环日志与死信队列。
   */
  failureReason?: string;
  /**
   * 本次发送期望使用的身份（由统一入口显式指定时写入，随消息传给 connector.send）。
   * 不写 = 按平台的 `effectiveSend` 策略解析。connector 必须遵守：
   * 显式 user 时强制本人（不可用则中文报错），显式 bot 时强制机器人，绝不默默换身份。
   */
  sendIdentity?: IdentityRole;
  /**
   * 本次发送/接收携带的附件元数据（只有文件名、类型、大小，绝不含文件内容）。
   * 让「发送文件」这一步在统一入口与全链路回放里同样可追踪。
   */
  attachments?: AttachmentInfo[];
}

/**
 * 平台连接器统一接口：新增一个平台，只需要实现这一个接口。
 * 文档明确要求 verify/receive/send/convert 四件套，这是可扩展性加分点。
 */
export interface PlatformConnector {
  /** 回调验签：校验平台推过来的事件确实来自该平台（防伪造） */
  verify(payload: unknown, sig: string, headers?: Record<string, string | string[] | undefined>): boolean;
  /** 解密加密回调；不需要解密时返回原样 */
  decrypt?(payload: unknown): unknown;
  /** URL 验证握手：需要原样返回 challenge 时实现 */
  challenge?(payload: unknown): unknown | undefined;
  /** 外部事件 → 统一消息 */
  receive(raw: unknown): UnifiedMessage;
  /**
   * 统一消息 → 平台（真实发送 / Mock 模拟发送），结果必须带上是哪条通道。
   * `attachments` 为可选出站附件：文本与文件可同一笔发送，各平台适配器自行
   * 完成「上传媒体 → 发送文件消息」的格式转换；不支持时显式报错，绝不静默丢文件。
   */
  send(msg: UnifiedMessage, attachments?: OutboundAttachment[]): Promise<SendResult>;
  /**
   * 是否为「本进程刚发出的消息」被机器人作为入站事件收回。
   * 飞书用用户身份发送时，单聊里的消息会再次触发 im.message.receive_v1；
   * 中枢据此丢弃自环事件，避免自己给自己造一条新消息。
   */
  isSelfEcho?(raw: unknown): boolean;
  /** 统一消息 → 平台外部格式（回写前的格式转换） */
  convert(msg: UnifiedMessage): unknown;
}

/**
 * 消息服务接口（REST 暴露给前端）：
 * list 展示、reply 触发回写+状态机、markDone 标记完成、getTrace 全链路回放。
 */
export interface MessageService {
  list(filter?: { platform?: Platform; status?: MsgStatus }): UnifiedMessage[];
  reply(id: string, text: string, attachments?: OutboundAttachment[]): Promise<ComposeAck>;
  /** 从统一入口主动向指定平台发送文本 / 文件，并把全过程纳入同一条闭环 trace */
  compose(req: ComposeRequest): Promise<ComposeAck>;
  markDone(id: string): Promise<void>;
  getTrace(traceId: string): UnifiedMessage[];
}

/**
 * 闭环日志条目：每条消息的每次状态/事件变更都写一条，
 * 配合 traceId 即可"回放"任意一条消息的全链路（文档 1.3 持续优化/可回放）。
 */
export interface TraceEntry {
  traceId: string;
  platform: Platform;
  status: MsgStatus;
  event: string; // 例如 'receive' | 'reply' | 'send' | 'synced' | 'failed'
  detail?: string;
  at: string; // ISO 时间
}
