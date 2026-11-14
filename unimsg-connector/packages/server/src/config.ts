/**
 * 配置中心（服务端私有）。
 *
 * 关键安全约定：下方所有 *Secret / *Key / *Token 都是【后端独占】凭据。
 * 它们只在这里被读取，永远不以 VITE_ 前缀注入前端构建产物，
 * 因此评审/部署时即使前端代码被反编译也拿不到真实密钥。
 *
 * 可替换性（本项目的核心诉求）：
 *  - 每个平台用 `<PLATFORM>_MODE = auto | real | mock` 独立决定走真实接口还是本地 Mock，
 *    默认 auto（凭据够就真实、不够就 Mock），换账号只改 .env，不改代码；
 *  - 旧全局 `MOCK` 已废弃，仅作为"未显式配置 *_MODE 时的默认策略"，并会打印迁移警告；
 *  - 邮箱账号数量/服务商不限（`MAIL_ACCOUNTS` 或自动发现 `MAIL_<KEY>_ADDRESS`）；
 *  - 解析结果在 `config.runtime` 里，`/api/accounts`、启动日志、doctor 全部复用。
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform, type DeliveryMode } from '@unimsg/shared';
import { resolveDwsBin } from './connectors/dwsBin';
import { applyLocalConfigToEnv, captureRestartBaseline, readLocalConfig } from './services/localConfig';
import {
  buildPlatformRuntime,
  DEFAULT_FEISHU_ACCOUNTS_BASE_URL,
  MODE_ENV_KEYS,
  parseMailAccounts,
  readPlatformCredentials,
  resolveFeishuScopes,
  resolveIdentityConfig,
  resolveLlmRuntime,
  resolveModePolicies,
  type FeishuSendAs,
  type IdentityRuntimeConfig,
  type LlmRuntime,
  type MailAccount,
  type MailAccountIssue,
  type ModePolicy,
  type PlatformCredentials,
  type PlatformRuntime,
} from './config/runtime';

// pnpm --filter 会把 cwd 切到 packages/server，这里显式补加载 monorepo 根目录的 .env
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });

/** monorepo 根（unimsg-connector/）：.env、水位、doctor 工作目录等统一按它定位 */
export const monorepoRoot = resolve(here, '../../..');
/** 进程启动时间（近似，用于「配置文件已保存，需重启」提示与 restartRequired 判定） */
export const processStartedAtMs = Date.now() - Math.floor(process.uptime() * 1000);

// ---------------------------------------------------------------------------
// 本地应用配置（白号 P0）：GUI 保存的凭据/模式先补进 env，再由下面统一解析。
// 安全规则：显式 .env 值优先，本地文件只补空（绝不用 GUI 覆盖运维已写的 env）。
// ---------------------------------------------------------------------------
// 单测（NODE_TEST_CONTEXT）下忽略本机真实配置：避免开发机上的 DATA_DIR/linkhub-config.json 污染测试；
// 生产/正常启动仍按「.env 优先 + 本地补空」合并。
const underTestConfig = Boolean(process.env.NODE_TEST_CONTEXT);
const realLocalConfig = readLocalConfig(monorepoRoot);
const localConfigLoaded = underTestConfig
  ? { ...realLocalConfig, config: { version: 1 } as const, exists: false }
  : realLocalConfig;
if (!underTestConfig && localConfigLoaded.error) console.warn("[unimsg] " + localConfigLoaded.error);
const localConfigApplied = underTestConfig
  ? { applied: [] as string[] }
  : applyLocalConfigToEnv(localConfigLoaded.config);
// P1-1：拍「静态键」启动基线；之后只有静态键变化才要求重启（identity.* 热应用不算）
captureRestartBaseline(localConfigLoaded.config);


/**
 * dws 可执行文件统一解析（个人版内置/自动发现）：
 * DWS_BIN → LINKHUB_TOOLS_DIR → 仓库 tools/ → ~/.local/bin → PATH。
 * 解析只定位、不探测登录态；身份探测/启动直接用 config.identity.dingtalk.bin。
 */
const dwsResolution = resolveDwsBin(process.env, { monorepoRoot });

/**
 * 磁盘上 .env 的快照（只返回路径与修改时间，绝不返回内容）：
 * 前端用它和服务启动时间对比，提示「.env 已修改，需重启后端生效」（P1-5）。
 */
export function envFileSnapshot(): { path: string; mtime: string } | null {
  const path = resolve(monorepoRoot, '.env');
  try {
    return { path, mtime: statSync(path).mtime.toISOString() };
  } catch {
    return null;
  }
}

export type LlmProvider = LlmRuntime['policy'];
export type OcrProvider = 'mock' | 'tencent';
export type { IdentityRuntimeConfig, LlmRuntime, MailAccount, MailAccountIssue, ModePolicy, PlatformRuntime };
export { MODE_ENV_KEYS };

function bool(v: string | undefined, def = false): boolean {
  return v ? v === 'true' || v === '1' : def;
}

/**
 * Node 测试运行器会给子进程注入 NODE_TEST_CONTEXT：
 * 单测里默认把所有平台锁成 mock（绝不外呼、不打真实接口），
 * 需要真实路径的用例显式 `forceMode(platform, 'real')`。
 */
const underTest = Boolean(process.env.NODE_TEST_CONTEXT);

const platforms: PlatformCredentials = readPlatformCredentials(process.env);
const mailParsed = parseMailAccounts(process.env);
// 老变量 MAIL_ENABLED 仍兼容：显式 false 关轮询；不写时"有账号就开"
const mailEnabled = process.env.MAIL_ENABLED !== undefined
  ? bool(process.env.MAIL_ENABLED, false)
  : mailParsed.accounts.length > 0;

const runtime = buildPlatformRuntime({
  env: process.env,
  platforms,
  mailAccounts: mailParsed.accounts,
  mailIssues: mailParsed.issues,
  mailEnabled,
  underTest,
});

// 模式相关的全局警告（旧 MOCK 变量、非法 *_MODE 值等），启动日志与 doctor 会打印
const modeWarnings = resolveModePolicies(process.env, { underTest }).warnings;

// 身份能力配置（本人 / 机器人）：解析结果同时供账号页、启动日志、doctor、发送分流共用
const identityConfig: IdentityRuntimeConfig = resolveIdentityConfig(process.env, modeWarnings);

const port = Number(process.env.SERVER_PORT ?? 3001);
// 飞书发送身份沿用旧字段名（FeishuSendAs 与 IdentityPolicy 同构），由统一身份配置解析
const feishuSendAs: FeishuSendAs = identityConfig.feishu.policy;

const dataDir = (process.env.DATA_DIR ?? '').trim();

// 用户身份令牌默认落在 unimsg-connector/.feishu-user-token.json（已 gitignore）。
// 设置了 DATA_DIR（Docker 固定为 /app/data）时默认放进去，容器重建后授权不丢。
// 相对路径按 unimsg-connector 根目录解析，避免 pnpm --filter 切 cwd 后写错位置。
const feishuTokenFileRaw = (process.env.FEISHU_USER_TOKEN_FILE ?? '').trim();
const feishuTokenFile = feishuTokenFileRaw
  ? (isAbsolute(feishuTokenFileRaw) ? feishuTokenFileRaw : resolve(here, '../../../', feishuTokenFileRaw))
  : dataDir
    ? join(dataDir, 'feishu-user-token.json')
    : resolve(here, '../../../.feishu-user-token.json');
const feishuRedirectUri = (process.env.FEISHU_REDIRECT_URI ?? '').trim()
  || `http://localhost:${port}/api/feishu/oauth/callback`;
if (!/^https?:\/\//i.test(feishuRedirectUri)) {
  modeWarnings.push(`FEISHU_REDIRECT_URI=${feishuRedirectUri} 不是 http(s) 地址；飞书 OAuth 回调必须与开放平台登记值完全一致`);
}

// 飞书本人身份接收的会话水位文件（已 gitignore）：默认 unimsg-connector/.feishu-user-receive.json，
// 设了 DATA_DIR 时放进数据目录（容器重建后不漏消息）。
const feishuUserStateRaw = (process.env.FEISHU_USER_STATE_FILE ?? '').trim();
const feishuUserStateFile = feishuUserStateRaw
  ? (isAbsolute(feishuUserStateRaw) ? feishuUserStateRaw : resolve(here, '../../../', feishuUserStateRaw))
  : dataDir
    ? join(dataDir, 'feishu-user-receive.json')
    : resolve(here, '../../../.feishu-user-receive.json');

// 入口令牌：空串不能当"未配置"处理——那会让鉴权中间件拿到空 token，
// 历史上可能被误判成"跳过鉴权"。这里统一归一化：空 → dev-token + 启动警告。
const rawApiToken = (process.env.API_TOKEN ?? '').trim();
const apiToken = rawApiToken || 'dev-token';
if (process.env.API_TOKEN !== undefined && !rawApiToken) {
  modeWarnings.push('API_TOKEN 被显式设置为空，已回退 dev-token；默认令牌仅适合本地演示，对外暴露前务必设置强令牌');
}

const explicitDataFile = (process.env.DATA_FILE ?? '').trim();

// 大模型按「凭据够就真实、不够就规则」解析；单测环境强制规则，绝不在测试里外呼
const llmRuntime = resolveLlmRuntime(underTest ? { ...process.env, LLM_PROVIDER: 'mock' } : process.env);
const llmApiKey = (process.env.LLM_API_KEY ?? '').trim();

export const config = {
  port,

  // 留空 → 后端自动使用内存存储（不依赖 Docker 即可本地验证）；
  // 填入真实连接串 → 自动切换 Postgres（部署评审环境时用）。
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',

  /**
   * 闭环数据快照文件（独立部署用）。
   * 设置 DATA_DIR 或 DATA_FILE 后，消息 / trace / 死信队列会落盘，
   * 容器重启后收件箱与「全链路回放」不丢，满足赛题 3.2「可追踪、可回放」。
   * 留空 = 纯内存（本地演示零副作用）。
   */
  dataFile: explicitDataFile || (dataDir ? join(dataDir, 'linkhub-state.json') : ''),

  /**
   * 请求体上限（MB）：base64 附件约为原始大小的 4/3。
   * 默认 64MB 对应「单文件 20MB / 总计 40MB」的 FILE_LIMITS，留足 JSON 包装余量。
   */
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 64),

  /** 前端构建产物目录：容器内同源部署时由 server 直接托管，单端口即可跑完整闭环 */
  webDist: (process.env.WEB_DIST ?? '').trim(),

  /** 是否运行在 node:test 子进程里（供 doctor/测试判断，业务代码不用关心） */
  underTest,

  // 入口鉴权令牌（服务端私有；前端登录后携带 Bearer）。未配置时用 dev-token 便于本地演示。
  apiToken,

  /** 钉钉 Stream 长连接（免公网回调），开启后额外订阅机器人消息 */
  dingtalkStream: platforms.dingtalk.stream,

  // 边界降级参数（全部走环境变量，评审现场可调）
  ocrThreshold: Number(process.env.OCR_CONFIDENCE_THRESHOLD ?? 0.7),
  sendMaxRetry: Number(process.env.SEND_MAX_RETRY ?? 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS ?? 1000),

  /** 平台 HTTP 调用超时（与 LLM 超时解耦：LLM 长尾 9s+，不能传染给平台接口） */
  platformTimeoutMs: Number(process.env.PLATFORM_TIMEOUT_MS ?? 8000),

  // 大模型（意图识别/摘要/回复草稿）。密钥仅服务端使用，解析规则见 config/runtime.ts。
  llm: {
    ...llmRuntime,
    apiKey: llmApiKey,
  },

  // OCR（图片/文件消息文字提取）。密钥仅服务端使用。
  ocr: {
    provider: (process.env.OCR_PROVIDER ?? 'mock') as OcrProvider,
    apiKey: process.env.OCR_API_KEY ?? '',
    secretId: process.env.OCR_SECRET_ID ?? '',
  },

  // 平台凭据（验签 / 真实发送用）。均为服务端私有。
  platforms: {
    feishu: {
      appId: platforms.feishu.appId,
      appSecret: platforms.feishu.appSecret,
      verifyToken: platforms.feishu.verifyToken,
      encryptKey: platforms.feishu.encryptKey,
      stream: platforms.feishu.stream,
      baseUrl: platforms.feishu.baseUrl,
    },
    dingtalk: {
      appKey: platforms.dingtalk.appKey,
      appSecret: platforms.dingtalk.appSecret,
      robotCode: platforms.dingtalk.robotCode,
      aesToken: platforms.dingtalk.aesToken,
      aesKey: platforms.dingtalk.aesKey,
      baseUrl: platforms.dingtalk.baseUrl,
    },
    wecom: {
      token: platforms.wecom.token,
      aesKey: platforms.wecom.aesKey,
      corpId: platforms.wecom.corpId,
      agentId: platforms.wecom.agentId,
      // 自建应用 Secret：换 access_token 用（后台"眼睛"图标查看，别点重置）
      secret: platforms.wecom.secret,
      baseUrl: platforms.wecom.baseUrl,
    },
  },

  /**
   * 身份能力（本人账号 收 / 发）：
   *  - policy：auto | bot | user（FEISHU_IDENTITY / DINGTALK_IDENTITY，飞书兼容旧 FEISHU_SEND_AS）；
   *  - receive：auto | true | false（本人身份接收开关）；
   *  - 飞书 stateFile：用户轮询的会话水位（重启不漏消息，已 gitignore）；
   *  - 钉钉 bin/profile/timeout：dws 子进程调用参数（DWS_BIN 可指向 scripts/fake-dws.mjs 离线演示）。
   */
  identity: {
    feishu: {
      ...identityConfig.feishu,
      stateFile: feishuUserStateFile,
      tokenFile: feishuTokenFile,
    },
    dingtalk: {
      ...identityConfig.dingtalk,
      // 覆盖 resolveIdentityConfig 里的「仅 env/PATH」默认值：统一自动发现（tools/ 内置优先）
      bin: dwsResolution.bin,
      binSource: dwsResolution.source,
      ...(dwsResolution.pathHint ? { binPathHint: dwsResolution.pathHint } : {}),
    },
  },

  /**
   * 飞书用户身份（user_access_token）授权配置。
   * 令牌文件只存服务端，绝不下发前端；status/account/doctor 只读过期时间与状态。
   */
  feishuAuth: {
    sendAs: feishuSendAs,
    redirectUri: feishuRedirectUri,
    tokenFile: feishuTokenFile,
    accountsBaseUrl: ((process.env.FEISHU_ACCOUNTS_BASE_URL ?? '').trim() || DEFAULT_FEISHU_ACCOUNTS_BASE_URL).replace(/\/+$/, ''),
    /** 用户身份权限 + offline_access（refresh_token 必需）；顺序固定，便于排错 */
    // scope 必须与身份配置联动：本人接收开启时一并申请用户身份读消息权限，
    // 否则授权后的 token 不带该权限，轮询会一直 99991672 且「重新授权」也修不好（契约 §0 平台事实）。
    scopes: resolveFeishuScopes(identityConfig.feishu),
  },

  // 邮箱数据源：IMAP 轮询收信 + SMTP 回写。授权码只存服务端。可配任意数量/任意服务商。
  mail: {
    enabled: mailEnabled,
    /** 用户是否显式设置了 MAIL_ENABLED（区分「用户关闭」与「没配账号」，避免误导日志） */
    enabledExplicit: process.env.MAIL_ENABLED !== undefined,
    pollMs: Math.max(5, Number(process.env.MAIL_POLL_SECONDS ?? 45)) * 1000,
    accounts: mailParsed.accounts,
    issues: mailParsed.issues,
  },

  /** 每个平台解析后的真实运行画像（policy/mode/canSend/canReceive/missing/warnings/reason） */
  runtime,

  /** 全局模式配置警告（旧 MOCK、非法值等），启动时打印一次 */
  modeWarnings,
};

// ---------------------------------------------------------------------------
// 运行模式访问器
// ---------------------------------------------------------------------------

/** 该平台本次实际走哪条通道（real / mock） */
export function modeOf(platform: Platform): DeliveryMode {
  return config.runtime[platform].mode;
}

/** 该平台的完整运行画像（只读语义） */
export function runtimeOf(platform: Platform): PlatformRuntime {
  return config.runtime[platform];
}

/**
 * 显式强制某平台通道（单测 / doctor 模拟用）。
 * real 时同步补足能力标记，避免"能力守卫"把测试挡在门外。
 */
export function forceMode(platform: Platform, mode: DeliveryMode): void {
  const r = config.runtime[platform];
  r.mode = mode;
  r.policy = mode;
  if (mode === 'real') {
    r.canSend = true;
    r.canReceive = true;
  }
}

/** 全部平台强制同一通道（单测 before/after 用） */
export function forceAllModes(mode: DeliveryMode): void {
  for (const platform of Object.values(Platform)) forceMode(platform, mode);
}

/** 从当前凭据重新计算运行时画像（测试里改完 config.platforms 后可刷新） */
export function refreshRuntime(): void {
  const built = buildPlatformRuntime({
    env: process.env,
    platforms: {
      feishu: config.platforms.feishu,
      dingtalk: { ...config.platforms.dingtalk, stream: config.dingtalkStream },
      wecom: config.platforms.wecom,
    },
    mailAccounts: config.mail.accounts,
    mailIssues: config.mail.issues,
    mailEnabled: config.mail.enabled,
    underTest,
  });
  Object.assign(config.runtime, built);
}

/** 启动/doctor 用的一行式模式摘要 */
export function modeSummary(): string {
  return Object.values(Platform)
    .map((p) => `${config.runtime[p].label}=${config.runtime[p].mode}${config.runtime[p].policy !== 'auto' ? `(${config.runtime[p].policy})` : ''}`)
    .join(' ');
}
