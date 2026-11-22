/**
 * 运行时可替换性核心：把「环境变量 → 实际走哪条通道」变成可单测的纯函数。
 *
 * 设计目标（用户核心诉求）：把项目交给评审/同学时，他们换上自己的账号即可运行，
 * 不需要改代码、也不需要"猜"哪个平台现在是真接口、哪个是 Mock。
 *
 * 三条约定：
 *  1. 每个平台独立解析 `*_MODE` = auto | real | mock，默认 auto；
 *     auto = 凭据足够（能真实收或能真实发）就走真实接口，否则走本地 Mock。
 *  2. 解析结果带 `configured / canSend / canReceive / missing / warnings`，
 *     `/api/accounts`、启动日志、doctor 都直接消费它，绝不静默假装成功。
 *  3. 旧的全局 `MOCK` 降级为「未显式配置 *_MODE 时的默认策略」，并给出废弃警告。
 */
import { IdentityPolicy, Platform, type DeliveryMode } from '@unimsg/shared';

export type ModePolicy = 'auto' | 'real' | 'mock';

/** 一次运行里某个平台解析后的完整画像 */
export interface PlatformRuntime {
  platform: Platform;
  label: string;
  /** 用户请求的策略（auto / 强制 real / 强制 mock） */
  policy: ModePolicy;
  /** 实际生效的通道（真实接口 / 本地模拟） */
  mode: DeliveryMode;
  /** 凭据是否足以真实工作 */
  configured: boolean;
  /** 是否具备真实收消息能力（webhook / 长连接 / IMAP 轮询） */
  canReceive: boolean;
  /** 是否具备真实发消息能力 */
  canSend: boolean;
  /** 缺哪些环境变量（用于 doctor 与前端提示，绝不含密钥值） */
  missing: string[];
  /** 已配置但存在能力缺口时的警告（例如"只能发不能收"） */
  warnings: string[];
  /** 人类可读的解析理由（前端账号页直接展示） */
  reason: string;
}

// ---------------------------------------------------------------------------
// 平台凭据读取
// ---------------------------------------------------------------------------

export interface FeishuCreds {
  appId: string;
  appSecret: string;
  verifyToken: string;
  encryptKey: string;
  /** 长连接（WebSocket）收消息：true 时免公网回调，需飞书后台「使用长连接接收事件」 */
  stream: boolean;
  /** 开放平台基址，默认 https://open.feishu.cn（Lark 国际版/代理可覆盖） */
  baseUrl: string;
}

export interface DingtalkCreds {
  appKey: string;
  appSecret: string;
  robotCode: string;
  aesToken: string;
  aesKey: string;
  stream: boolean;
  baseUrl: string;
}

export interface PlatformCredentials {
  feishu: FeishuCreds;
  dingtalk: DingtalkCreds;
  wechat: WechatCreds;
}

/** 微信 RPA 桥：唯一配置是本地桥地址 */
export interface WechatCreds {
  bridgeUrl: string;
}

export const DEFAULT_WECHAT_BRIDGE_URL = 'http://127.0.0.1:8787';

export const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';
export const DEFAULT_FEISHU_ACCOUNTS_BASE_URL = 'https://accounts.feishu.cn';
export const DEFAULT_DINGTALK_BASE_URL = 'https://api.dingtalk.com';

/**
 * 飞书出站发送身份：
 *  - auto：未连接用户身份时走机器人；连接后自动切换为本人（默认，升级不破坏现有行为）
 *  - bot ：固定机器人，即使已授权用户身份
 *  - user：固定本人，未授权/授权失效时发送会显式失败
 */
export type FeishuSendAs = 'auto' | 'bot' | 'user';

export function parseFeishuSendAs(raw: string | undefined, warnings: string[] = []): FeishuSendAs {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'auto';
  if (v === 'auto' || v === 'bot' || v === 'user') return v;
  warnings.push(`FEISHU_SEND_AS=${raw} 不是合法值（auto/bot/user），已回退 auto`);
  return 'auto';
}

function trimBase(v: string | undefined, fallback: string): string {
  const raw = (v ?? '').trim();
  return (raw || fallback).replace(/\/+$/, '');
}

/** 从环境变量读出三平台凭据（config.ts 与 doctor 共用同一套规则） */
export function readPlatformCredentials(env: NodeJS.ProcessEnv): PlatformCredentials {
  const dingAppKey = env.DINGTALK_CLIENT_ID ?? env.DINGTALK_APP_KEY ?? '';
  return {
    feishu: {
      appId: env.FEISHU_APP_ID ?? '',
      appSecret: env.FEISHU_APP_SECRET ?? '',
      verifyToken: env.FEISHU_VERIFY_TOKEN ?? '',
      encryptKey: env.FEISHU_ENCRYPT_KEY ?? '',
      // P2-6：长连接是默认接收方式（未显式 FEISHU_STREAM 时默认 true）；
      // 只有 HTTP 回调部署才需要显式 FEISHU_STREAM=false + FEISHU_VERIFY_TOKEN
      stream: env.FEISHU_STREAM === undefined || env.FEISHU_STREAM.trim() === ''
        ? true
        : truthy(env.FEISHU_STREAM),
      baseUrl: trimBase(env.FEISHU_BASE_URL, DEFAULT_FEISHU_BASE_URL),
    },
    dingtalk: {
      // 新版后台叫 Client ID / Client Secret，旧版叫 AppKey / AppSecret
      appKey: dingAppKey,
      appSecret: env.DINGTALK_CLIENT_SECRET ?? env.DINGTALK_APP_SECRET ?? '',
      // 机器人编码：企业内部应用通常与 Client ID 相同
      robotCode: env.DINGTALK_ROBOT_CODE ?? dingAppKey,
      aesToken: env.DINGTALK_AES_TOKEN ?? '',
      aesKey: env.DINGTALK_AES_KEY ?? '',
      stream: truthy(env.DINGTALK_STREAM),
      baseUrl: trimBase(env.DINGTALK_BASE_URL, DEFAULT_DINGTALK_BASE_URL),
    },
    wechat: {
      bridgeUrl: trimBase(env.WECHAT_BRIDGE_URL, DEFAULT_WECHAT_BRIDGE_URL),
    },
  };
}

// ---------------------------------------------------------------------------
// 邮箱多账号：任意服务商、任意数量
// ---------------------------------------------------------------------------

/** 一个邮箱账号 = 一个可收可发的数据源（IMAP 收 + SMTP 发） */
export interface MailAccount {
  /** 环境变量段名，如 qq / 163 / work（externalId 前缀也用它） */
  key: string;
  label: string;
  address: string;
  /** 授权码（不是网页登录密码） */
  authCode: string;
  /** 服务商标识：qq / 163 / 126 / yeah / gmail / outlook / icloud / custom */
  provider: string;
  imapHost: string;
  imapPort: number;
  /** true=993 隐式 TLS；false=143 明文 + STARTTLS */
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  /** true=465 隐式 TLS；false=587/25 明文 + STARTTLS */
  smtpSecure: boolean;
  /** 监听的邮箱目录，默认只有 INBOX（反垃圾回收站可加 Junk） */
  folders: string[];
}

export interface MailAccountIssue {
  /** 对应的环境变量段（如果能判断出来） */
  key?: string;
  env?: string;
  level: 'error' | 'warn';
  message: string;
}

interface ProviderPreset {
  label: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

/**
 * 常见服务商预设。换成列表里没有的邮箱也不用改代码：
 * 显式填 `MAIL_<KEY>_IMAP_HOST` / `_SMTP_HOST` 即可（provider=custom）。
 */
export const MAIL_PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  qq: { label: 'QQ邮箱', imapHost: 'imap.qq.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true },
  foxmail: { label: 'Foxmail', imapHost: 'imap.qq.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true },
  '163': { label: '网易163邮箱', imapHost: 'imap.163.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: true },
  '126': { label: '网易126邮箱', imapHost: 'imap.126.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.126.com', smtpPort: 465, smtpSecure: true },
  yeah: { label: '网易Yeah邮箱', imapHost: 'imap.yeah.net', imapPort: 993, imapSecure: true, smtpHost: 'smtp.yeah.net', smtpPort: 465, smtpSecure: true },
  gmail: { label: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  outlook: { label: 'Outlook / Microsoft 365', imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false },
  icloud: { label: 'iCloud 邮箱', imapHost: 'imap.mail.me.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
  custom: { label: '自定义邮箱', imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 465, smtpSecure: true },
};

const PROVIDER_ALIASES: Record<string, string> = {
  'qq.com': 'qq',
  'foxmail.com': 'qq',
  '163.com': '163',
  '126.com': '126',
  'yeah.net': 'yeah',
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'office365.com': 'outlook',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
};

function normalizeProvider(raw: string): string {
  return raw.trim().toLowerCase().replace(/^mail\./, '').replace(/^(imap|smtp)\./, '');
}

/** 显式 provider 优先；否则按邮箱域名推断；未知域名 → custom（需显式 host） */
export function inferMailProvider(address: string, explicit?: string): string {
  const raw = (explicit ?? '').trim();
  if (raw) {
    const p = normalizeProvider(raw);
    return p; // 未知名字保留，用于提示"未识别"
  }
  const domain = address.includes('@') ? address.split('@').pop()!.trim().toLowerCase() : '';
  return PROVIDER_ALIASES[domain] ?? 'custom';
}

function envSegFor(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function num(v: string | undefined, fallback: number): number {
  const n = Number((v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function csv(v: string | undefined, fallback: string[]): string[] {
  const items = (v ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

export interface MailAccountsParseResult {
  accounts: MailAccount[];
  issues: MailAccountIssue[];
}

// ---------------------------------------------------------------------------
// 邮箱账号运行时导入（个人版在「连接账号」页填表，替代手改 .env）
// ---------------------------------------------------------------------------

/** 「连接账号」页提交的邮箱账号输入（字段名与本地账号文件一致） */
export interface MailAccountInput {
  /** 环境变量段名/本地 key（可选；不传按邮箱地址推导） */
  key?: string;
  address?: string;
  /** 授权码（不是网页登录密码）；只在服务端内存/本地文件，绝不下发 */
  authCode?: string;
  /** qq / 163 / 126 / yeah / gmail / outlook / icloud / custom（可省略，按域名推断） */
  provider?: string;
  label?: string;
  imapHost?: string;
  imapPort?: number | string;
  imapSecure?: boolean | string;
  smtpHost?: string;
  smtpPort?: number | string;
  smtpSecure?: boolean | string;
  folders?: string[] | string;
}

export interface MailAccountBuildResult {
  account?: MailAccount;
  /** 校验错误（中文，可直接展示） */
  errors: string[];
}

function boolish(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'off'].includes(t)) return false;
  }
  return undefined;
}

function portOf(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : fallback;
}

/**
 * 把表单/本地文件里的一条账号输入规范化+校验成 MailAccount。
 * 纯函数、不落盘、不联网；错误全部中文（供接口 400 直接展示）。
 */
export function createMailAccountFromInput(input: MailAccountInput): MailAccountBuildResult {
  const errors: string[] = [];
  const address = String(input.address ?? '').trim();
  if (!address) {
    errors.push('请填写邮箱地址');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    errors.push('邮箱地址格式不对（示例：you@qq.com）');
  }
  const authCode = String(input.authCode ?? '').trim();
  if (!authCode) {
    errors.push('请填写授权码（在邮箱网页版「设置 → POP3/SMTP/IMAP」里生成；不是网页登录密码）');
  } else if (authCode.length > 512) {
    errors.push('授权码过长（请确认复制正确，不要粘贴整段网页内容）');
  }

  const explicitKey = String(input.key ?? '').trim().toLowerCase();
  let key = explicitKey;
  if (key) {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(key)) {
      errors.push('账号 key 只能用小写字母/数字/._-（最长 32 位），例如 qq / work');
    }
  } else {
    const local = address.includes('@') ? address.split('@')[0]! : address;
    key = local.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'mail';
  }

  const provider = inferMailProvider(address, input.provider);
  const preset = MAIL_PROVIDER_PRESETS[provider] ?? MAIL_PROVIDER_PRESETS.custom!;
  const imapHost = String(input.imapHost ?? '').trim() || preset.imapHost;
  const smtpHost = String(input.smtpHost ?? '').trim() || preset.smtpHost;
  if (!imapHost) errors.push('未识别的邮箱服务商：请填写 IMAP 服务器地址（如 imap.company.com）');
  if (!smtpHost) errors.push('未识别的邮箱服务商：请填写 SMTP 服务器地址（如 smtp.company.com）');

  const imapPort = portOf(input.imapPort, preset.imapPort || 993);
  const smtpPort = portOf(input.smtpPort, preset.smtpPort || 465);
  // 显式端口优先按端口推导加密方式（143=STARTTLS、993=隐式 TLS；587/25=STARTTLS、465=隐式 TLS），
  // 未显式端口时用服务商预设，保证自定义邮箱/端口覆盖不会配错加密。
  const imapSecure = boolish(input.imapSecure)
    ?? (input.imapPort !== undefined ? imapPort === 993 : (preset.imapSecure ?? imapPort === 993));
  const smtpSecure = boolish(input.smtpSecure)
    ?? (input.smtpPort !== undefined ? smtpPort === 465 : (preset.smtpSecure ?? smtpPort === 465));

  const folderRaw = Array.isArray(input.folders)
    ? input.folders
    : String(input.folders ?? '').split(/[,;\s]+/);
  const folders = [...new Set(folderRaw.map((f) => String(f).trim()).filter(Boolean))].slice(0, 8);
  if (folders.length === 0) folders.push('INBOX');

  const label = String(input.label ?? '').trim() || preset.label || provider;

  if (errors.length > 0) return { errors };
  return {
    errors,
    account: {
      key,
      label,
      address,
      authCode,
      provider,
      imapHost,
      imapPort,
      imapSecure,
      smtpHost,
      smtpPort,
      smtpSecure,
      folders,
    },
  };
}

/**
 * 解析邮箱账号（可单测，不依赖模块级 process.env）：
 *  - `MAIL_ACCOUNTS=qq,163,work` 显式列出账号与环境变量段；
 *  - 不写则自动发现所有 `MAIL_<KEY>_ADDRESS`，所以老配置（MAIL_QQ_* / MAIL_163_*）零改动可用；
 *  - provider 可显式指定，也可按邮箱域名推断；端口/加密方式可单独覆盖。
 */
export function parseMailAccounts(env: NodeJS.ProcessEnv): MailAccountsParseResult {
  const issues: MailAccountIssue[] = [];
  const explicit = csv(env.MAIL_ACCOUNTS, []).filter((s) => s.toLowerCase() !== 'auto');

  let keys: string[];
  if (explicit.length > 0) {
    keys = [...new Set(explicit.map((k) => k.toLowerCase()))];
  } else {
    const found = new Set<string>();
    for (const name of Object.keys(env)) {
      const m = name.match(/^MAIL_([A-Z0-9]+)_(ADDRESS|AUTH_CODE)$/);
      if (m) found.add(m[1].toLowerCase());
    }
    // 稳定顺序：按 key 字母序，避免不同 shell 环境变量顺序导致日志抖动
    keys = [...found].sort();
  }

  const accounts: MailAccount[] = [];
  for (const key of keys) {
    const seg = envSegFor(key);
    const prefix = `MAIL_${seg}`;
    const address = (env[`${prefix}_ADDRESS`] ?? '').trim();
    const authCode = (env[`${prefix}_AUTH_CODE`] ?? '').trim();

    if (!address && !authCode) {
      // 显式列在 MAIL_ACCOUNTS 里却什么都没填：值得报出来
      if (explicit.length > 0) {
        issues.push({
          key,
          env: `${prefix}_ADDRESS`,
          level: 'warn',
          message: `MAIL_ACCOUNTS 列出了 ${key}，但 ${prefix}_ADDRESS / ${prefix}_AUTH_CODE 都没有填写，已跳过`,
        });
      }
      continue;
    }
    if (!address) {
      issues.push({ key, env: `${prefix}_ADDRESS`, level: 'error', message: `${prefix}_AUTH_CODE 已填写，但缺少 ${prefix}_ADDRESS` });
      continue;
    }
    if (!authCode) {
      issues.push({
        key,
        env: `${prefix}_AUTH_CODE`,
        level: 'error',
        message: `邮箱 ${address} 缺少 ${prefix}_AUTH_CODE（需要网页端开启 IMAP/SMTP 后生成的授权码，不是登录密码）`,
      });
      continue;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      issues.push({ key, env: `${prefix}_ADDRESS`, level: 'error', message: `${prefix}_ADDRESS 不是合法邮箱地址：${address}` });
      continue;
    }

    const provider = inferMailProvider(address, env[`${prefix}_PROVIDER`]);
    const preset = MAIL_PROVIDER_PRESETS[provider];
    if (!preset) {
      issues.push({
        key,
        env: `${prefix}_PROVIDER`,
        level: 'warn',
        message: `未识别的邮箱服务商 "${provider}"，请改用 ${Object.keys(MAIL_PROVIDER_PRESETS).join(' / ')}，或直接填写 ${prefix}_IMAP_HOST / ${prefix}_SMTP_HOST`,
      });
    }
    const fallback = preset ?? MAIL_PROVIDER_PRESETS.custom;

    const imapHost = (env[`${prefix}_IMAP_HOST`] ?? fallback.imapHost).trim();
    const smtpHost = (env[`${prefix}_SMTP_HOST`] ?? fallback.smtpHost).trim();
    if (!imapHost || !smtpHost) {
      issues.push({
        key,
        env: `${prefix}_IMAP_HOST`,
        level: 'error',
        message: `邮箱 ${address} 的服务商 ${provider} 没有内置预设，必须填写 ${prefix}_IMAP_HOST 与 ${prefix}_SMTP_HOST`,
      });
      continue;
    }

    const imapPort = num(env[`${prefix}_IMAP_PORT`], fallback.imapPort);
    const smtpPort = num(env[`${prefix}_SMTP_PORT`], fallback.smtpPort);
    const imapSecureRaw = env[`${prefix}_IMAP_SECURE`];
    const smtpSecureRaw = env[`${prefix}_SMTP_SECURE`];
    // 端口能表达意图时就按端口推断（993→TLS，143→STARTTLS；465→TLS，587/25→STARTTLS）
    const imapSecure = imapSecureRaw !== undefined ? truthy(imapSecureRaw) : imapPort === 993 ? true : fallback.imapSecure && imapPort !== 143;
    const smtpSecure = smtpSecureRaw !== undefined ? truthy(smtpSecureRaw) : smtpPort === 465 ? true : smtpPort === 587 || smtpPort === 25 ? false : fallback.smtpSecure;

    accounts.push({
      key,
      label: (env[`${prefix}_LABEL`] ?? '').trim() || fallback.label,
      address,
      authCode,
      provider,
      imapHost,
      imapPort,
      imapSecure,
      smtpHost,
      smtpPort,
      smtpSecure,
      folders: csv(env[`${prefix}_FOLDERS`], ['INBOX']),
    });
  }

  return { accounts, issues };
}

/** 给前端/医生看的邮箱账号摘要（不含授权码） */
export function mailAccountSummary(a: MailAccount): {
  key: string;
  label: string;
  address: string;
  provider: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  folders: string[];
} {
  return {
    key: a.key,
    label: a.label,
    address: a.address,
    provider: a.provider,
    imapHost: a.imapHost,
    imapPort: a.imapPort,
    imapSecure: a.imapSecure,
    smtpHost: a.smtpHost,
    smtpPort: a.smtpPort,
    smtpSecure: a.smtpSecure,
    folders: a.folders,
  };
}

// ---------------------------------------------------------------------------
// 平台模式解析
// ---------------------------------------------------------------------------

export const MODE_ENV_KEYS: Record<Platform, string> = {
  [Platform.FEISHU]: 'FEISHU_MODE',
  [Platform.DINGTALK]: 'DINGTALK_MODE',
  [Platform.MAIL]: 'MAIL_MODE',
  [Platform.WECHAT]: 'WECHAT_MODE',
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  [Platform.FEISHU]: '飞书',
  [Platform.DINGTALK]: '钉钉',
  [Platform.MAIL]: '邮箱',
  [Platform.WECHAT]: '微信',
};

export interface ModePolicyResult {
  policies: Record<Platform, ModePolicy>;
  warnings: string[];
}

export interface ModePolicyOptions {
  /** 单元测试环境：默认全部 mock，需要真实的用例自行 forceMode */
  underTest?: boolean;
}

function parsePolicy(raw: string | undefined): ModePolicy | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'auto' || v === 'real' || v === 'mock') return v;
  return undefined;
}

/**
 * 解析每个平台请求的策略。
 * 优先级：`<PLATFORM>_MODE` > 旧全局 `MOCK` > auto（未配置 = auto）。
 */
export function resolveModePolicies(env: NodeJS.ProcessEnv, opts: ModePolicyOptions = {}): ModePolicyResult {
  const warnings: string[] = [];
  const underTest = opts.underTest ?? false;

  let legacy: ModePolicy | undefined;
  const mockRaw = (env.MOCK ?? '').trim();
  if (mockRaw) {
    if (truthy(mockRaw)) legacy = 'mock';
    else if (['false', '0', 'no', 'off'].includes(mockRaw.toLowerCase())) legacy = 'real';
    else warnings.push(`MOCK=${mockRaw} 不是合法值（true/false），已忽略`);
    warnings.push('MOCK 已废弃：建议删除该变量，改用 FEISHU_MODE / DINGTALK_MODE / MAIL_MODE=auto|real|mock');
  }

  const policies = {} as Record<Platform, ModePolicy>;
  for (const platform of Object.values(Platform)) {
    const envKey = MODE_ENV_KEYS[platform];
    const raw = env[envKey];
    const parsed = parsePolicy(raw);
    if (raw && raw.trim() && !parsed) {
      warnings.push(`${envKey}=${raw} 不是合法值（auto/real/mock），已回退默认策略`);
    }
    let policy: ModePolicy = parsed ?? legacy ?? 'auto';
    if (underTest) policy = 'mock'; // 单测默认不外呼，需要真实的用例显式 forceMode
    policies[platform] = policy;
  }
  return { policies, warnings };
}

export interface RuntimeBuildInput {
  env: NodeJS.ProcessEnv;
  platforms: PlatformCredentials;
  mailAccounts: MailAccount[];
  mailIssues: MailAccountIssue[];
  mailEnabled: boolean;
  /** 用户是否显式设置了 MAIL_ENABLED（区分「用户关闭」与「没配账号」的文案） */
  mailEnabledExplicit?: boolean;
  underTest?: boolean;
}

interface CapabilityResult {
  configured: boolean;
  canReceive: boolean;
  canSend: boolean;
  missing: string[];
  warnings: string[];
}

function capability(platform: Platform, input: RuntimeBuildInput): CapabilityResult {
  const { platforms: p } = input;
  const missing: string[] = [];
  const warnings: string[] = [];

  if (platform === Platform.FEISHU) {
    if (!p.feishu.appId) missing.push('FEISHU_APP_ID');
    if (!p.feishu.appSecret) missing.push('FEISHU_APP_SECRET');
    // 长连接模式免 Webhook 验签；HTTP 回调模式才需要 Verification Token
    if (!p.feishu.stream && !p.feishu.verifyToken) missing.push('FEISHU_VERIFY_TOKEN');
    const canSend = Boolean(p.feishu.appId && p.feishu.appSecret);
    // 收：HTTP 回调需 Verification Token；长连接只需 appId/appSecret
    const canReceive = Boolean(p.feishu.appId && p.feishu.appSecret && (p.feishu.verifyToken || p.feishu.stream));
    if (canSend && !canReceive) warnings.push('只能发不能收：缺少 FEISHU_VERIFY_TOKEN（HTTP 回调验签），或开启 FEISHU_STREAM 长连接');
    if (canSend && !p.feishu.stream && !p.feishu.encryptKey) warnings.push('未配置 FEISHU_ENCRYPT_KEY：仅支持未加密回调（若后台开了加密策略会解密失败）');
    if (p.feishu.stream) warnings.push('已开启飞书长连接（FEISHU_STREAM）：本机无需公网回调即可收消息');
    return { configured: canSend, canSend, canReceive, missing, warnings };
  }

  if (platform === Platform.DINGTALK) {
    if (!p.dingtalk.appKey) missing.push('DINGTALK_CLIENT_ID');
    if (!p.dingtalk.appSecret) missing.push('DINGTALK_CLIENT_SECRET');
    // 仅本人身份部署：机器人接收通道有意关闭，HTTP 回调用 AES Token/Key 根本不需要，
    // 既不能算「缺失」，也不能说「暂时收不到消息」（收信由 dws 本人事件流承担）。
    // canReceive 仍如实表示「机器人凭据能否收信」，绝不因为策略切换就假装能收。
    const personalOnly = (input.env.DINGTALK_IDENTITY ?? '').trim().toLowerCase() === 'user';
    // AES Token/Key 仅在 HTTP 回调模式需要；开了 Stream 长连接就不算缺失（否则启动日志会误报）
    if (!p.dingtalk.stream && !personalOnly) {
      if (!p.dingtalk.aesToken) missing.push('DINGTALK_AES_TOKEN');
      if (!p.dingtalk.aesKey) missing.push('DINGTALK_AES_KEY');
    }
    const canSend = Boolean(p.dingtalk.appKey && p.dingtalk.appSecret && p.dingtalk.robotCode);
    // 收：Stream 长连接只需 Client ID/Secret；HTTP 回调需要 AES Token/Key
    const canReceive = Boolean(p.dingtalk.appKey && p.dingtalk.appSecret && (p.dingtalk.stream || (p.dingtalk.aesToken && p.dingtalk.aesKey)));
    if (canSend && !p.dingtalk.robotCode) warnings.push('缺少 DINGTALK_ROBOT_CODE，无法真实发送');
    if (!p.dingtalk.stream && !(p.dingtalk.aesToken && p.dingtalk.aesKey)) {
      warnings.push(personalOnly
        ? '已按「仅本人身份」关闭机器人收信（DINGTALK_STREAM=false）：收信由 dws 本人事件流承担，避免与机器人 Stream 重复入库；模式表「收信」列只统计机器人通道，真实收信以 doctor 的本人身份探针为准'
        : '未开启 DINGTALK_STREAM，且没有配 HTTP 回调的 Token/AES Key：暂时收不到消息');
    }
    if (p.dingtalk.stream) warnings.push('已开启 Stream 长连接（本机无需公网回调）');
    return { configured: Boolean(p.dingtalk.appKey && p.dingtalk.appSecret), canSend, canReceive, missing, warnings };
  }

  if (platform === Platform.WECHAT) {
    // 微信 RPA：唯一凭据是本地 RPA 桥的地址。桥地址有默认值（http://127.0.0.1:8787）。
    // 注意：这里只说"配置齐全"，不代表桥活着、更不代表桥在 rpa 模式——
    // 真实能力由 services/wechatBridge 实际探测后判定（onboarding / doctor / health 共用）。
    const bridgeUrl = (input.env.WECHAT_BRIDGE_URL || DEFAULT_WECHAT_BRIDGE_URL).trim();
    const configured = Boolean(bridgeUrl);
    warnings.push(
      '微信个人版无官方 API，采用 RPA 方式：依赖本机微信桌面端 + 本地 RPA 桥；'
      + '稳定性受窗口布局/分辨率影响，有账号风控风险，仅作补充通道。',
    );
    if (!configured) missing.push('WECHAT_BRIDGE_URL（本地 RPA 桥地址，默认演示可用 mock 模式）');
    return {
      configured,
      canSend: configured,
      canReceive: configured,
      missing,
      warnings,
    };
  }

  // 邮箱：每个账号独立，但模式按整体解析
  const accounts = input.mailAccounts;
  const canSend = accounts.length > 0;
  const canReceive = input.mailEnabled && accounts.length > 0;
  for (const issue of input.mailIssues) {
    if (issue.level === 'error') missing.push(issue.env ?? `${issue.key ?? 'MAIL'}_...`);
    warnings.push(issue.message);
  }
  if (!accounts.length) {
    missing.push('MAIL_ACCOUNTS（或 MAIL_<KEY>_ADDRESS / MAIL_<KEY>_AUTH_CODE）');
    warnings.push('未配置任何邮箱账号');
  }
  if (accounts.length > 0 && !input.mailEnabled) warnings.push('MAIL_ENABLED=false：邮箱轮询已关闭，仅能发送');
  return { configured: canSend, canSend, canReceive, missing, warnings };
}

function reasonFor(
  platform: Platform,
  policy: ModePolicy,
  mode: DeliveryMode,
  cap: CapabilityResult,
  mailEnabled: boolean,
  mailEnabledExplicit = false,
): string {
  const label = PLATFORM_LABELS[platform];
  if (platform === Platform.MAIL && policy === 'auto' && !mailEnabled && cap.configured) {
    return mailEnabledExplicit
      ? 'MAIL_ENABLED=false：邮箱轮询已关闭 → 回退本地模拟（回写会标注"模拟发送"）'
      : '邮箱轮询未启用（未配置任何账号 / 未显式开启 MAIL_ENABLED）→ 回退本地模拟（回写会标注"模拟发送"）';
  }
  if (mode === 'real') {
    if (policy === 'real') return `已明确设为「真实模式」：强制走真实接口`;
    return `${label}凭据可用 → auto 解析为真实接口`;
  }
  if (policy === 'mock') return `已明确设为「演示模式」：不会连接真实平台`;
  if (!cap.configured) return `${label}还没填好凭据 → 先用本地模拟（发送会标注「模拟发送」）`;
  return `${label}还有配置没生效 → 先用本地模拟（发送会标注「模拟发送」）`;
}

/** 由凭据 + 策略解析出每平台运行时画像（纯函数，供 config / 测试 / doctor 使用） */
/**
 * Mock 模式下把「已开启长连接」改成如实口径：配置了但当前不会真的连接。
 * 否则账号页会同时显示「Mock 模拟」+「已开启长连接」，误导小白（frontend 联调反馈）。
 */
function mockModeWarnings(warnings: string[]): string[] {
  return warnings.map((w) => {
    if (!/已开启.*长连接/.test(w)) return w;
    const channel = w.includes('飞书') ? '飞书长连接（FEISHU_STREAM）' : '钉钉 Stream 长连接（DINGTALK_STREAM）';
    return `已配置${channel}，但当前为 Mock 模拟、不会实际连接`;
  });
}

export function buildPlatformRuntime(input: RuntimeBuildInput): Record<Platform, PlatformRuntime> {
  const { policies } = resolveModePolicies(input.env, { underTest: input.underTest });
  const out = {} as Record<Platform, PlatformRuntime>;
  for (const platform of Object.values(Platform)) {
    const cap = capability(platform, input);
    const policy = policies[platform];
    let mode: DeliveryMode = policy === 'mock'
      ? 'mock'
      : policy === 'real'
        ? 'real'
        : cap.canSend || cap.canReceive
          ? 'real'
          : 'mock';
    // 邮箱轮询被显式关闭时，auto 下不可能"真实收到邮件"，回写也应如实标为模拟
    if (platform === Platform.MAIL && policy === 'auto' && !input.mailEnabled) mode = 'mock';
    // 微信 RPA：默认走 mock，必须显式 WECHAT_MODE=real 才会操作真实微信桌面端。
    // 桥地址有默认值，若按普通 auto 逻辑会因"凭据齐全"误判成真实通道。
    if (platform === Platform.WECHAT && policy === 'auto') mode = 'mock';
    if (platform === Platform.WECHAT && mode === 'mock') {
      // P0：mock 不采集真实微信消息（入站靠手动 /mock/inject 或 /ingest），
      // 以前 canReceive 跟着"桥地址有默认值"恒为 true，等于谎报能收。
      // 真实接收是否可用由 wechatBridge 探针按桥上报的 receive 能力决定。
      cap.canReceive = false;
      cap.warnings = [
        ...cap.warnings,
        'Mock 模式下不采集真实微信消息：入站仅用于演示（手动注入）；要真实收发请设 WECHAT_MODE=real 并启动 RPA 桥',
      ];
    } else if (platform === Platform.WECHAT) {
      cap.warnings = [
        ...cap.warnings,
        '真实收发取决于本机 RPA 桥的运行态：发送时会核对桥是否真的以 --mode rpa 运行；接收能力由桥上报，连接页/doctor 会实测',
      ];
    }
    out[platform] = {
      platform,
      label: PLATFORM_LABELS[platform],
      policy,
      mode,
      configured: cap.configured,
      canReceive: cap.canReceive,
      canSend: cap.canSend,
      missing: cap.missing,
      // Mock 模式下「已开启长连接」是假话（实际不会连接），改成如实口径
      warnings: mode === 'mock' ? mockModeWarnings(cap.warnings) : cap.warnings,
      reason: reasonFor(platform, policy, mode, cap, input.mailEnabled, input.mailEnabledExplicit),
    };
  }
  return out;
}

/** 模式是否显式强制（诊断输出用） */
export function isForcedPolicy(policy: ModePolicy): boolean {
  return policy !== 'auto';
}

// ---------------------------------------------------------------------------
// 大模型运行模式
// ---------------------------------------------------------------------------
//
// 与平台连接器同一套原则：凭据够就走真实接口，不够就走规则 Mock，并在
// doctor / 启动日志 / 消息标注里说清楚本次是哪条通道，绝不静默假装成功。

/** provider 只区分「规则」与「OpenAI 兼容协议」；MiMo / 通义 / DeepSeek / 智谱 共用后者 */
export type LlmProviderPolicy = 'mock' | 'openai';
export type LlmMode = 'mock' | 'real';

export const DEFAULT_LLM_ENDPOINT = 'https://api.xiaomimimo.com/v1';
export const DEFAULT_LLM_MODEL = 'mimo-v2.6-flash';
/** 实测 MiMo flash 单次 2.9–9.3s，8s 会把长尾全部打成降级 */
export const DEFAULT_LLM_TIMEOUT_MS = 15000;
/** 精度分档线：低于它标 low（仍采用模型结果），高于等于标 high；不再决定是否回退规则 */
export const DEFAULT_LLM_MIN_CONFIDENCE = 0.6;

/**
 * GUI 里「AI 模型服务商」常被填成厂商显示名（火山引擎 / DeepSeek / 智谱…），
 * 但代码只需区分「规则」与「OpenAI 兼容协议」。这里把厂商名归一到协议，
 * 避免用户填对厂商却因为不叫 `openai` 被静默降级成规则识别。
 * 文心等**非** OpenAI 兼容的服务故意不收，仍按「不支持」显式降级。
 */
const LLM_PROVIDER_ALIASES: Readonly<Record<string, LlmProviderPolicy>> = {
  mock: 'mock', rules: 'mock', rule: 'mock', off: 'mock', none: 'mock', disabled: 'mock',
  '规则': 'mock', '内置规则': 'mock', '不使用': 'mock',
  openai: 'openai', openaicompatible: 'openai', azure: 'openai', azureopenai: 'openai',
  custom: 'openai', '自定义': 'openai', '兼容': 'openai',
  mimo: 'openai', xiaomi: 'openai', xiaomimimo: 'openai', '小米': 'openai', '小米mimo': 'openai',
  deepseek: 'openai', '深度求索': 'openai',
  qwen: 'openai', tongyi: 'openai', dashscope: 'openai', aliyun: 'openai',
  '通义': 'openai', '通义千问': 'openai', '阿里云': 'openai',
  zhipu: 'openai', glm: 'openai', bigmodel: 'openai', '智谱': 'openai', '智谱清言': 'openai',
  volcengine: 'openai', volces: 'openai', ark: 'openai', doubao: 'openai',
  '火山': 'openai', '火山引擎': 'openai', '火山方舟': 'openai', '豆包': 'openai', '豆包大模型': 'openai',
  moonshot: 'openai', kimi: 'openai', '月之暗面': 'openai',
  siliconflow: 'openai', '硅基流动': 'openai', baichuan: 'openai', '百川': 'openai',
  minimax: 'openai', stepfun: 'openai', '阶跃星辰': 'openai',
};

/** 把用户填的 provider 归一为协议类型；空 = 规则识别，未知 = 显式不支持 */
export function normalizeLlmProvider(raw: string | undefined): LlmProviderPolicy | 'unsupported' {
  const text = (raw ?? '').trim();
  if (!text) return 'mock';
  const lower = text.toLowerCase();
  const compact = lower.replace(/[\s._-]+/g, '');
  return LLM_PROVIDER_ALIASES[lower] ?? LLM_PROVIDER_ALIASES[compact] ?? 'unsupported';
}

/** 按 endpoint 推断真实厂商，写进 trace / 前端来源标签，绝不固定写「MiMo」冒充 */
export function inferLlmProvider(endpoint: string): { provider: string; label: string } {
  let host = '';
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    host = endpoint.toLowerCase();
  }
  if (host.includes('xiaomimimo')) return { provider: 'mimo', label: 'MiMo' };
  if (/volces|volcengine|ark\./.test(host)) return { provider: 'volcengine', label: '火山方舟' };
  if (host.includes('deepseek')) return { provider: 'deepseek', label: 'DeepSeek' };
  if (/dashscope|aliyuncs/.test(host)) return { provider: 'qwen', label: '通义千问' };
  if (/bigmodel|zhipu/.test(host)) return { provider: 'zhipu', label: '智谱' };
  if (/moonshot|kimi/.test(host)) return { provider: 'moonshot', label: 'Moonshot' };
  if (host.includes('api.openai.com')) return { provider: 'openai', label: 'OpenAI' };
  if (/siliconflow/.test(host)) return { provider: 'siliconflow', label: '硅基流动' };
  return { provider: 'openai-compatible', label: host ? `OpenAI 兼容（${host}）` : 'OpenAI 兼容' };
}

export interface LlmRuntime {
  /** 配置意图（用户填的 LLM_PROVIDER） */
  policy: LlmProviderPolicy;
  /** 实际生效通道 */
  mode: LlmMode;
  /** 真实 provider 标识（写进 trace / doctor，便于回放时辨认） */
  provider: string;
  /** 面向用户的厂商显示名（前端 AI 来源标签用；绝不固定写 MiMo） */
  providerLabel: string;
  model: string;
  endpoint: string;
  /** endpoint 实际来自哪个变量，doctor 排障时用 */
  endpointFrom: 'LLM_ENDPOINT' | 'LLM_BASE_URL' | 'default';
  timeoutMs: number;
  /** 精度分档线（不是「是否采用模型结果」的开关） */
  minConfidence: number;
  ready: boolean;
  /** 缺哪些环境变量（只含键名，绝不含密钥值） */
  missing: string[];
  reason: string;
}

function positiveInt(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function unitFloat(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : def;
}

export function resolveLlmRuntime(env: NodeJS.ProcessEnv): LlmRuntime {
  const rawPolicy = (env.LLM_PROVIDER ?? '').trim();
  const policy = normalizeLlmProvider(rawPolicy);
  const apiKey = (env.LLM_API_KEY ?? '').trim();
  const model = (env.LLM_MODEL ?? '').trim() || DEFAULT_LLM_MODEL;

  // GUI / 旧版 .env 写的是 LLM_BASE_URL，服务端历史上只读 LLM_ENDPOINT。
  // 两个键都收，显式 LLM_ENDPOINT 优先；都不填才回默认 MiMo 端点。
  const explicitEndpoint = (env.LLM_ENDPOINT ?? '').trim();
  const legacyEndpoint = (env.LLM_BASE_URL ?? '').trim();
  const endpointFrom: LlmRuntime['endpointFrom'] = explicitEndpoint
    ? 'LLM_ENDPOINT'
    : legacyEndpoint ? 'LLM_BASE_URL' : 'default';
  const endpoint = (explicitEndpoint || legacyEndpoint || DEFAULT_LLM_ENDPOINT).replace(/\/+$/, '');

  const timeoutMs = positiveInt(env.LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS);
  const minConfidence = unitFloat(env.LLM_MIN_CONFIDENCE, DEFAULT_LLM_MIN_CONFIDENCE);
  const inferred = inferLlmProvider(endpoint);

  const base = {
    provider: inferred.provider,
    providerLabel: inferred.label,
    model,
    endpoint,
    endpointFrom,
    timeoutMs,
    minConfidence,
  } as const;

  if (policy === 'mock') {
    return {
      ...base,
      policy: 'mock',
      mode: 'mock',
      ready: false,
      missing: [],
      reason: rawPolicy
        ? `LLM_PROVIDER=${rawPolicy}：走内置规则识别（零密钥可演示）`
        : '未配置 LLM_PROVIDER（等价 mock）：走内置规则识别（零密钥可演示）',
    };
  }

  if (policy === 'unsupported') {
    return {
      ...base,
      policy: 'mock',
      mode: 'mock',
      ready: false,
      missing: [],
      reason: `不支持的 LLM_PROVIDER=${rawPolicy}，已降级为规则识别。该字段填的是「协议类型」而非厂商名：火山方舟 / DeepSeek / 通义 / 智谱等 OpenAI 兼容服务一律填 openai，厂商靠 LLM_ENDPOINT 区分`,
    };
  }

  if (!apiKey) {
    return {
      ...base,
      policy: 'openai',
      mode: 'mock',
      ready: false,
      missing: ['LLM_API_KEY'],
      reason: 'LLM_PROVIDER=openai 但缺少 LLM_API_KEY，已降级为规则识别',
    };
  }

  return {
    ...base,
    policy: 'openai',
    mode: 'real',
    ready: true,
    missing: [],
    reason: `真实大模型已就绪：${model} @ ${endpoint}（${inferred.label}${endpointFrom === 'LLM_BASE_URL' ? '，端点来自兼容键 LLM_BASE_URL' : ''}）`,
  };
}

// ---------------------------------------------------------------------------
// 身份能力配置（本人账号 收 / 发，机器人保留兜底）
// ---------------------------------------------------------------------------
//
// 设计原则与平台模式一致：纯函数解析，启动日志 / 账号页 / doctor / 发送路径
// 共用同一份解析结果（单一事实来源），绝不各自读 env 各猜一套。
//
// 状态语义（任何情况下都如实标注，见 docs/personal-identity.md）：
//  - policy=auto：已连接本人身份就用本人，否则机器人（升级不破坏现有行为）；
//  - policy=bot ：固定机器人；
//  - policy=user：固定本人，未连接/失效时显式报错，绝不悄悄回退。

/** 本人身份接收开关：auto = 身份解析为本人时自动开启；true/false 强制开关 */
export type ReceiveToggle = 'auto' | boolean;

export const FEISHU_IDENTITY_ENV = 'FEISHU_IDENTITY';
/** 旧变量（飞书发送身份），保留为别名：未写 FEISHU_IDENTITY 时继承并给废弃提示 */
export const FEISHU_IDENTITY_ALIAS_ENV = 'FEISHU_SEND_AS';
export const DINGTALK_IDENTITY_ENV = 'DINGTALK_IDENTITY';

export const DEFAULT_FEISHU_USER_RECEIVE_SECONDS = 20;
/** 轮询间隔下限：飞书按会话轮询，太快会撞平台限频，也毫无意义（无推送事件） */
export const MIN_FEISHU_USER_RECEIVE_SECONDS = 5;
export const DEFAULT_FEISHU_USER_CHAT_LIMIT = 20;
export const MAX_FEISHU_USER_CHAT_LIMIT = 100;
export const DEFAULT_FEISHU_USER_BACKFILL_HOURS = 0;
export const MAX_FEISHU_USER_BACKFILL_HOURS = 720;
export const DEFAULT_DWS_AUTH_TIMEOUT_MS = 15_000;
export const DEFAULT_DWS_SEND_TIMEOUT_MS = 30_000;

/**
 * dws 个人事件监听意图（与 `dws event +listen-im --kind` 取值一致）。
 * 说明：all-direct=全部单聊、at-me=@我、all-group=全部群消息。
 * group（指定群）/ sender（指定发送人）需要额外目标参数（--chat-id / --user），
 * LinkHub 目前不提供这些目标配置，因此**配置了也会被忽略并告警**，避免子进程反复失败重启。
 */
export const DINGTALK_EVENT_KINDS = ['at-me', 'sender', 'group', 'all-direct', 'all-group'] as const;
export type DingtalkEventKind = (typeof DINGTALK_EVENT_KINDS)[number];
/** LinkHub 实际能独立启动（不需要额外目标参数）的范围 */
export const SUPPORTED_DINGTALK_EVENT_KINDS = ['at-me', 'all-direct', 'all-group'] as const;
export const DEFAULT_DINGTALK_EVENT_KINDS: string[] = ['all-direct', 'at-me'];

export interface FeishuIdentityConfig {
  policy: IdentityPolicy;
  /** FEISHU_USER_RECEIVE */
  receive: ReceiveToggle;
  /** 轮询间隔（毫秒，最小 5s） */
  pollMs: number;
  /** 每轮最多检查的会话数 */
  chatLimit: number;
  /** 首轮回溯小时数：0 = 只立基线不灌历史 */
  backfillHours: number;
}

export interface DingtalkIdentityConfig {
  policy: IdentityPolicy;
  /** DINGTALK_USER_RECEIVE */
  receive: ReceiveToggle;
  /** 个人事件订阅范围（已归一化，顺序保留） */
  eventKinds: string[];
  /**
   * dws 可执行文件（可带参数，如 `node scripts/fake-dws.mjs`）。
   * 由 connectors/dwsBin.ts 统一解析：DWS_BIN → LINKHUB_TOOLS_DIR → 仓库 tools/ → ~/.local/bin → PATH。
   */
  bin: string;
  /** dws 来源（env/tools/user_profile/path/missing，onboarding 如实展示） */
  binSource?: 'env' | 'tools' | 'user_profile' | 'path' | 'missing';
  /** 来源人话说明（例如「仓库 tools/（pnpm run fetch:dws 下载位置）」） */
  binPathHint?: string;
  /** DWS_PROFILE */
  profile: string;
  authTimeoutMs: number;
  sendTimeoutMs: number;
}

export interface IdentityRuntimeConfig {
  feishu: FeishuIdentityConfig;
  dingtalk: DingtalkIdentityConfig;
}

// ---------------------------------------------------------------------------
// 飞书 OAuth scope（必须与「本人身份接收」能力联动，否则授权后仍读不到消息）
// ---------------------------------------------------------------------------
//
// 血泪教训（verifier 静态发现）：读消息权限只在错误 hint 里提示、授权时没申请，
// 用户 token 永远不带读消息权限 → 轮询一直 99991672 → hint 让"重新授权" → 授权 scope 不变 → 死循环。
// 因此 scope 必须由身份配置动态生成：本人接收开启时一并申请读消息权限。

/** 飞书发送/资源基础权限（本人身份发送用） */
export const FEISHU_BASE_SCOPES = ['im:message', 'im:message.send_as_user', 'im:resource'] as const;
/**
 * 飞书「本人身份接收」额外权限（用户身份读消息 + 列会话）。
 *
 * `im:chat:read`（查看群信息）是**列会话的硬前提**：`GET /open-apis/im/v1/chats` 用
 * user_access_token 调用时缺它直接返回 `99991679`
 * （required one of [im:chat:readonly, im:chat, im:chat.group_info:readonly, im:chat:read]），
 * 一条会话都列不出来，轮询等于空转 —— 2026-11-12 用真实令牌实测确认。
 * 它和读消息权限是两码事（只申请读消息权限不够），所以必须一起申请。
 */
export const FEISHU_USER_RECEIVE_SCOPES = [
  'im:message.p2p_msg:get_as_user',
  'im:message.group_msg:get_as_user',
  'im:chat:read',
] as const;
/** refresh_token 必需 */
export const FEISHU_OFFLINE_SCOPE = 'offline_access';

/**
 * 生成本次授权要申请的完整 scope（空格分隔由 authorizeUrl 负责）。
 *  - policy=bot 或 receive=false：只申请发送权限；
 *  - 其它（auto/true 且非固定机器人）：额外申请用户身份读消息权限。
 */
export function resolveFeishuScopes(conf: Pick<FeishuIdentityConfig, 'policy' | 'receive'>): string[] {
  const receive = conf.receive === true || (conf.receive === 'auto' && conf.policy !== 'bot');
  return [
    ...FEISHU_BASE_SCOPES,
    ...(receive ? FEISHU_USER_RECEIVE_SCOPES : []),
    FEISHU_OFFLINE_SCOPE,
  ];
}

function identityPolicyValue(raw: string | undefined): IdentityPolicy | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'auto' || v === 'bot' || v === 'user') return v;
  return undefined;
}

/**
 * 身份策略解析（含旧变量别名）。
 * 优先级：FEISHU_IDENTITY > FEISHU_SEND_AS（别名，给废弃提示）> auto。
 */
export function parseIdentityPolicy(
  raw: string | undefined,
  envKey: string,
  warnings: string[] = [],
): IdentityPolicy {
  const parsed = identityPolicyValue(raw);
  if (parsed) return parsed;
  if (raw !== undefined && raw.trim() !== '') {
    warnings.push(`${envKey}=${raw} 不是合法值（auto/bot/user），已回退 auto`);
  }
  return 'auto';
}

/** 飞书身份策略：主变量优先，旧别名兜底（并明确提示已废弃） */
export function parseFeishuIdentityPolicy(env: NodeJS.ProcessEnv, warnings: string[] = []): IdentityPolicy {
  const rawMain = env[FEISHU_IDENTITY_ENV];
  if (rawMain !== undefined && rawMain.trim() !== '') {
    return parseIdentityPolicy(rawMain, FEISHU_IDENTITY_ENV, warnings);
  }
  const rawAlias = env[FEISHU_IDENTITY_ALIAS_ENV];
  if (rawAlias !== undefined && rawAlias.trim() !== '') {
    warnings.push(
      `${FEISHU_IDENTITY_ALIAS_ENV} 已废弃：请改用 ${FEISHU_IDENTITY_ENV}=auto|bot|user（本次已按别名生效：${rawAlias.trim()}）`,
    );
    return parseIdentityPolicy(rawAlias, FEISHU_IDENTITY_ALIAS_ENV, warnings);
  }
  return 'auto';
}

/** 接收开关解析：auto（默认）/ true / false（兼容 1/0/yes/no/on/off） */
export function parseReceiveToggle(
  raw: string | undefined,
  envKey: string,
  warnings: string[] = [],
): ReceiveToggle {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'auto') return 'auto';
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  warnings.push(`${envKey}=${raw} 不是合法值（auto/true/false），已回退 auto`);
  return 'auto';
}

/**
 * 事件范围解析：逗号/分号/空白分隔，去重保序；非法值警告并忽略；
 * group / sender 需要 dws 目标参数，当前不支持 → 警告并忽略（否则子进程会反复退出重启）；
 * 全部不可用时回退默认（all-direct,at-me），绝不因为配置写错就静默不收消息。
 */
export function parseDingtalkEventKinds(
  raw: string | undefined,
  warnings: string[] = [],
): string[] {
  const items = (raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) return [...DEFAULT_DINGTALK_EVENT_KINDS];
  const out: string[] = [];
  for (const item of items) {
    if (!(DINGTALK_EVENT_KINDS as readonly string[]).includes(item)) {
      warnings.push(`DINGTALK_USER_EVENT_KINDS 含未知范围 "${item}"（可选：${SUPPORTED_DINGTALK_EVENT_KINDS.join(' / ')}），已忽略`);
      continue;
    }
    if (item === 'group' || item === 'sender') {
      warnings.push(
        `DINGTALK_USER_EVENT_KINDS 的 "${item}" 需要 dws 目标参数（--chat-id / --user），LinkHub 暂不支持，已忽略；`
        + `请改用 ${SUPPORTED_DINGTALK_EVENT_KINDS.join(' / ')}`,
      );
      continue;
    }
    if (!out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out : [...DEFAULT_DINGTALK_EVENT_KINDS];
}

/**
 * 解析整数并夹到 [min, max]。
 * 关键：**空串/未设置必须回退 fallback** —— Number('') === 0 是有限数，
 * 旧实现会把「没配」当成「配了 0」再夹到 min（轮询间隔变 5s、dws 超时变 1s），
 * 在「无 .env / 只配本人身份」的最小配置场景直接让功能异常（verifier P0）。
 * 显式的 '0' 是真实值，仍按 min 夹取。
 */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = (raw ?? '').trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 解析身份能力全部配置（纯函数，供 config.ts / 测试共用） */
export function resolveIdentityConfig(
  env: NodeJS.ProcessEnv,
  warnings: string[] = [],
): IdentityRuntimeConfig {
  const feishuPolicy = parseFeishuIdentityPolicy(env, warnings);
  const dingtalkPolicy = parseIdentityPolicy(env[DINGTALK_IDENTITY_ENV], DINGTALK_IDENTITY_ENV, warnings);

  const receiveSeconds = clampInt(
    env.FEISHU_USER_RECEIVE_SECONDS,
    DEFAULT_FEISHU_USER_RECEIVE_SECONDS,
    MIN_FEISHU_USER_RECEIVE_SECONDS,
    // 1 天：再大就没有"轮询"的意义了，用户应改用机器人通道
    86_400,
  );
  if (env.FEISHU_USER_RECEIVE_SECONDS !== undefined) {
    const raw = Number(env.FEISHU_USER_RECEIVE_SECONDS);
    if (Number.isFinite(raw) && raw < MIN_FEISHU_USER_RECEIVE_SECONDS) {
      warnings.push(
        `FEISHU_USER_RECEIVE_SECONDS=${env.FEISHU_USER_RECEIVE_SECONDS} 过小，已按最小值 ${MIN_FEISHU_USER_RECEIVE_SECONDS}s 生效（飞书轮询过快会撞限频）`,
      );
    }
  }

  const bin = (env.DWS_BIN ?? '').trim() || 'dws';
  const profile = (env.DWS_PROFILE ?? '').trim();

  return {
    feishu: {
      policy: feishuPolicy,
      receive: parseReceiveToggle(env.FEISHU_USER_RECEIVE, 'FEISHU_USER_RECEIVE', warnings),
      pollMs: receiveSeconds * 1000,
      chatLimit: clampInt(
        env.FEISHU_USER_CHAT_LIMIT,
        DEFAULT_FEISHU_USER_CHAT_LIMIT,
        1,
        MAX_FEISHU_USER_CHAT_LIMIT,
      ),
      backfillHours: clampInt(
        env.FEISHU_USER_BACKFILL_HOURS,
        DEFAULT_FEISHU_USER_BACKFILL_HOURS,
        0,
        MAX_FEISHU_USER_BACKFILL_HOURS,
      ),
    },
    dingtalk: {
      policy: dingtalkPolicy,
      receive: parseReceiveToggle(env.DINGTALK_USER_RECEIVE, 'DINGTALK_USER_RECEIVE', warnings),
      eventKinds: parseDingtalkEventKinds(env.DINGTALK_USER_EVENT_KINDS, warnings),
      bin,
      profile,
      authTimeoutMs: clampInt(env.DWS_AUTH_TIMEOUT_MS, DEFAULT_DWS_AUTH_TIMEOUT_MS, 1_000, 120_000),
      sendTimeoutMs: clampInt(env.DWS_SEND_TIMEOUT_MS, DEFAULT_DWS_SEND_TIMEOUT_MS, 1_000, 600_000),
    },
  };
}

// ---------------------------------------------------------------------------
// 邮箱运行态重算（P0-3）：本地导入账号是运行期才出现的，启动时按 .env 算好的
// config.runtime[MAIL] 会一直是 mock/configured=false，导致「界面添加账号后永远收不到信」。
// 这里按「当前账号」重算一次，由 mailAccounts store 在合并/增删/验证后调用。
// ---------------------------------------------------------------------------
export function computeMailRuntimeAfterAccounts(args: {
  policy: ModePolicy;
  envAccounts: MailAccount[];
  verifiedFileKeys: string[];
}): { mode: 'real' | 'mock'; configured: boolean; canSend: boolean; canReceive: boolean; reason: string } {
  if (args.policy === 'mock') {
    return { mode: 'mock', configured: false, canSend: false, canReceive: false, reason: '邮箱被设为演示模式：不会真的收信/发信' };
  }
  const usable = args.envAccounts.length + args.verifiedFileKeys.length;
  if (usable === 0) {
    return {
      mode: 'mock', configured: false, canSend: false, canReceive: false,
      reason: '没有可用的邮箱账号（在「连接账号」页添加并验证后自动启用真实邮箱）',
    };
  }
  return {
    mode: 'real', configured: true, canSend: true, canReceive: true,
    reason: '有 ' + usable + ' 个可用邮箱账号（部署配置 ' + args.envAccounts.length + ' 个 / 页面添加并验证 ' + args.verifiedFileKeys.length + ' 个）',
  };
}
