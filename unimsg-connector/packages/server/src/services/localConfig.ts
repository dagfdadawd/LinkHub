/**
 * 本地应用配置（白号 P0：不手改 .env 也能填平台凭据 / 切身份模式 / 切运行模式）。
 *
 * 存储：`DATA_DIR/linkhub-config.json`；无 DATA_DIR → `unimsg-connector/.linkhub-config.json`
 * （已 gitignore；原子写；非 Windows chmod 600；其中含 App Secret，绝不下发明文）。
 *
 * 生效规则（安全第一）：
 *  - 启动时把本地配置合并进 `process.env`，由 config.ts 正常解析——**显式 .env 值优先，本地只补空**；
 *  - 因此保存后需重启进程（restartRequired），绝不热改正在运行的凭据/模式；
 *  - GUI 无法覆盖运维在 .env 里写死的值（PUT 会把这些键列入 ignoredByEnv）。
 *
 * 本模块只依赖 Node 内置模块，便于 config.ts 在解析前调用（不反向依赖 config）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** 身份策略/运行模式口径（与 config/runtime 保持一致，避免循环依赖用字面量） */
export type LocalIdentityPolicy = 'auto' | 'bot' | 'user';
export type LocalModePolicy = 'auto' | 'real' | 'mock';

export interface LocalConfig {
  version: 1;
  identity?: {
    feishu?: LocalIdentityPolicy;
    dingtalk?: LocalIdentityPolicy;
    /** 本人身份接收开关（同时作用于飞书/钉钉） */
    userReceive?: boolean;
    /**
     * 内部标记：identity.dingtalk='user' 是「dws 登录成功后自动热应用」的，不是用户手写的。
     * dws 注销后据此自动回退 auto；用户显式 PUT identity 时会清掉此标记（sanitize 会保留它）。
     */
    dingtalkAutoApplied?: boolean;
  };
  platforms?: {
    feishu?: {
      appId?: string;
      appSecret?: string;
      verifyToken?: string;
      encryptKey?: string;
      stream?: boolean;
    };
    dingtalk?: {
      clientId?: string;
      clientSecret?: string;
      robotCode?: string;
      stream?: boolean;
      aesToken?: string;
      aesKey?: string;
    };
    wechat?: {
      bridgeUrl?: string;
    };
  };
  llm?: {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  modes?: {
    feishu?: LocalModePolicy;
    dingtalk?: LocalModePolicy;
    wechat?: LocalModePolicy;
    mail?: LocalModePolicy;
  };
  updatedAt?: string;
}

/** PUT 部分更新：值传 null/'' 表示清除本地配置项 */
export interface LocalConfigPatch {
  identity?: {
    feishu?: LocalIdentityPolicy | null;
    dingtalk?: LocalIdentityPolicy | null;
    userReceive?: boolean | null;
  };
  platforms?: {
    feishu?: Partial<Record<keyof NonNullable<LocalConfig['platforms']>['feishu'], string | boolean | null>>;
    dingtalk?: Partial<Record<keyof NonNullable<LocalConfig['platforms']>['dingtalk'], string | boolean | null>>;
    wechat?: Partial<Record<keyof NonNullable<LocalConfig['platforms']>['wechat'], string | boolean | null>>;
  };
  llm?: Partial<Record<keyof NonNullable<LocalConfig['llm']>, string | null>>;
  modes?: {
    feishu?: LocalModePolicy | null;
    dingtalk?: LocalModePolicy | null;
    wechat?: LocalModePolicy | null;
    mail?: LocalModePolicy | null;
  };
}

/** 本地配置文件名（DATA_DIR 下） */
export const LOCAL_CONFIG_FILE_NAME = 'linkhub-config.json';
/** 无 DATA_DIR 时的仓库根文件名（gitignore） */
export const LOCAL_CONFIG_FALLBACK_NAME = '.linkhub-config.json';

/** 字段规格：本地配置路径 ↔ 环境变量 */
type FieldKind = 'string' | 'secret' | 'bool' | 'identity' | 'mode';
interface FieldSpec {
  path: string;
  env: string | string[];
  kind: FieldKind;
  /** 字符串/密钥最大长度 */
  maxLength?: number;
  /** 展示名（缺配置时给前端看） */
  label: string;
}

const IDENTITY_VALUES: readonly string[] = ['auto', 'bot', 'user'];
const MODE_VALUES: readonly string[] = ['auto', 'real', 'mock'];

/** 全部可配置字段（顺序即 GET 展示顺序） */
export const FIELD_SPECS: readonly FieldSpec[] = [
  // 飞书应用凭据
  { path: 'platforms.feishu.appId', env: 'FEISHU_APP_ID', kind: 'string', maxLength: 128, label: '飞书 App ID' },
  { path: 'platforms.feishu.appSecret', env: 'FEISHU_APP_SECRET', kind: 'secret', maxLength: 512, label: '飞书 App Secret' },
  { path: 'platforms.feishu.verifyToken', env: 'FEISHU_VERIFY_TOKEN', kind: 'secret', maxLength: 512, label: '飞书 Verification Token' },
  { path: 'platforms.feishu.encryptKey', env: 'FEISHU_ENCRYPT_KEY', kind: 'secret', maxLength: 512, label: '飞书 Encrypt Key' },
  { path: 'platforms.feishu.stream', env: 'FEISHU_STREAM', kind: 'bool', label: '飞书长连接' },
  // 钉钉应用凭据
  { path: 'platforms.dingtalk.clientId', env: 'DINGTALK_CLIENT_ID', kind: 'string', maxLength: 128, label: '钉钉 Client ID（AppKey）' },
  { path: 'platforms.dingtalk.clientSecret', env: 'DINGTALK_CLIENT_SECRET', kind: 'secret', maxLength: 512, label: '钉钉 Client Secret（AppSecret）' },
  { path: 'platforms.dingtalk.robotCode', env: 'DINGTALK_ROBOT_CODE', kind: 'string', maxLength: 128, label: '钉钉 Robot Code' },
  { path: 'platforms.dingtalk.stream', env: 'DINGTALK_STREAM', kind: 'bool', label: '钉钉 Stream 长连接' },
  { path: 'platforms.dingtalk.aesToken', env: 'DINGTALK_AES_TOKEN', kind: 'secret', maxLength: 512, label: '钉钉 AES Token' },
  { path: 'platforms.dingtalk.aesKey', env: 'DINGTALK_AES_KEY', kind: 'secret', maxLength: 512, label: '钉钉 AES Key' },
  // 微信（RPA 本地桥）
  { path: 'platforms.wechat.bridgeUrl', env: 'WECHAT_BRIDGE_URL', kind: 'string', maxLength: 256, label: '微信 RPA 桥地址' },
  // 身份策略
  { path: 'identity.feishu', env: 'FEISHU_IDENTITY', kind: 'identity', label: '飞书收发身份策略' },
  { path: 'identity.dingtalk', env: 'DINGTALK_IDENTITY', kind: 'identity', label: '钉钉收发身份策略' },
  {
    path: 'identity.userReceive',
    env: ['FEISHU_USER_RECEIVE', 'DINGTALK_USER_RECEIVE'],
    kind: 'bool',
    label: '本人身份接收开关',
  },
  // 运行模式
  { path: 'modes.feishu', env: 'FEISHU_MODE', kind: 'mode', label: '飞书运行模式' },
  { path: 'modes.dingtalk', env: 'DINGTALK_MODE', kind: 'mode', label: '钉钉运行模式' },
  { path: 'modes.wechat', env: 'WECHAT_MODE', kind: 'mode', label: '微信运行模式' },
  { path: 'modes.mail', env: 'MAIL_MODE', kind: 'mode', label: '邮箱运行模式' },
  // LLM（可选）
  { path: 'llm.provider', env: 'LLM_PROVIDER', kind: 'string', maxLength: 64, label: 'AI 模型服务商' },
  { path: 'llm.apiKey', env: 'LLM_API_KEY', kind: 'secret', maxLength: 512, label: 'AI 模型 API Key' },
  // 服务端真实读取 LLM_ENDPOINT；LLM_BASE_URL 是 GUI / 旧版 .env 用过的兼容别名，
  // 两者都登记，避免 doctor 报「写了但不会被读取」，也保证显式 .env 值仍优先。
  { path: 'llm.baseUrl', env: ['LLM_ENDPOINT', 'LLM_BASE_URL'], kind: 'string', maxLength: 512, label: 'AI 模型 Base URL' },
  { path: 'llm.model', env: 'LLM_MODEL', kind: 'string', maxLength: 128, label: 'AI 模型名称' },
] as const;

const SPEC_BY_PATH = new Map(FIELD_SPECS.map((s) => [s.path, s]));

/** 本地配置文件路径：DATA_DIR 优先，否则仓库根 `.linkhub-config.json` */
export function localConfigFilePath(monorepoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = (env.DATA_DIR ?? '').trim();
  return dataDir ? join(dataDir, LOCAL_CONFIG_FILE_NAME) : join(monorepoRoot, LOCAL_CONFIG_FALLBACK_NAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 规整已知字段（未知键忽略，用于启动 merge；PUT 另做严格校验） */
/** 字段路径拆解：identity.x / modes.x / llm.x（两级）与 platforms.<组>.<字段>（三级） */
function parseFieldPath(path: string): { section: string; group?: string; key: string } {
  const parts = path.split('.');
  if (parts.length === 3) return { section: parts[0]!, group: parts[1]!, key: parts[2]! };
  return { section: parts[0]!, key: parts[1]! };
}
export function sanitizeLocalConfig(raw: unknown): LocalConfig {
  const config: LocalConfig = { version: 1 };
  if (!isPlainObject(raw)) return config;
  // 内部标记（不通过 FIELD_SPECS，避免被 PUT 用户写入）
  const rawIdentity = isPlainObject(raw.identity) ? raw.identity : undefined;
  if (rawIdentity && typeof rawIdentity.dingtalkAutoApplied === 'boolean') {
    config.identity = { ...(config.identity ?? {}), dingtalkAutoApplied: rawIdentity.dingtalkAutoApplied };
  }
  for (const spec of FIELD_SPECS) {
    const { section, group, key } = parseFieldPath(spec.path);
    const sectionRaw = raw[section];
    if (!isPlainObject(sectionRaw)) continue;
    const holder = group ? sectionRaw[group] : sectionRaw;
    if (!isPlainObject(holder)) continue;
    const value = holder[key];
    if (value === undefined || value === null) continue;
    if (spec.kind === 'bool') {
      if (typeof value === 'boolean') setPathValue(config, spec.path, value);
      continue;
    }
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text) continue;
    if (spec.kind === 'identity' && !IDENTITY_VALUES.includes(text)) continue;
    if (spec.kind === 'mode' && !MODE_VALUES.includes(text)) continue;
    setPathValue(config, spec.path, text);
  }
  return config;
}

export interface LocalConfigReadResult {
  config: LocalConfig;
  file: string;
  exists: boolean;
  error?: string;
  mtime?: string;
}

/** 读取本地配置（缺失=空；损坏带回 error，不阻断启动） */
export function readLocalConfig(monorepoRoot: string, env: NodeJS.ProcessEnv = process.env): LocalConfigReadResult {
  const file = localConfigFilePath(monorepoRoot, env);
  if (!existsSync(file)) return { config: { version: 1 }, file, exists: false };
  try {
    const mtime = statSync(file).mtime.toISOString();
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return { config: sanitizeLocalConfig(parsed), file, exists: true, mtime };
  } catch (e) {
    return {
      config: { version: 1 },
      file,
      exists: true,
      error: `本地配置文件读取失败（${file}）：${e instanceof Error ? e.message : String(e)}；已忽略`,
    };
  }
}

function getPathValue(config: LocalConfig, path: string): string | boolean | undefined {
  const { section, group, key } = parseFieldPath(path);
  const sectionHolder = (config as unknown as Record<string, unknown>)[section];
  if (!sectionHolder || typeof sectionHolder !== 'object') return undefined;
  const holder = group
    ? (sectionHolder as Record<string, unknown>)[group]
    : sectionHolder;
  if (!holder || typeof holder !== 'object') return undefined;
  const value = (holder as Record<string, unknown>)[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function setPathValue(config: LocalConfig, path: string, value: string | boolean | undefined): void {
  const { section, group, key } = parseFieldPath(path);
  const obj = config as unknown as Record<string, Record<string, unknown>>;
  if (group) {
    const groupHolder = (obj[section] ?? {}) as Record<string, Record<string, unknown>>;
    const fieldHolder = (groupHolder[group] ?? {}) as Record<string, unknown>;
    if (value === undefined) delete fieldHolder[key];
    else fieldHolder[key] = value;
    groupHolder[group] = fieldHolder;
    obj[section] = groupHolder as unknown as Record<string, unknown>;
    return;
  }
  const holder = (obj[section] ?? {}) as Record<string, unknown>;
  if (value === undefined) delete holder[key];
  else holder[key] = value;
  obj[section] = holder;
}


function envValue(env: NodeJS.ProcessEnv, keys: string | string[]): string {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    const value = (env[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function boolText(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = (env[key] ?? '').trim();
  if (!raw) return undefined;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase()) ? 'true' : 'false';
}


/** 启动 merge 时由本地配置补进 process.env 的键→值：GET 视图据此把 source 标成 local（而不是 env） */
const LOCAL_APPLIED_ENV_VALUES = new Map<string, string>();

/** 某 env 键的当前值是否就是本地配置 merge 进来的值（重启后 GUI 保存的值仍应显示 source=local） */
export function isLocalAppliedEnvValue(key: string, value: string): boolean {
  return LOCAL_APPLIED_ENV_VALUES.get(key) === value;
}

/** 单测用：清空「本地补 env」记录 */
export function resetLocalAppliedEnvKeysForTests(): void {
  LOCAL_APPLIED_ENV_VALUES.clear();
}
/**
 * 启动时把本地配置补进 process.env（**只在 env 为空时补**，绝不覆盖显式 .env 值）。
 * 返回实际补进去的字段路径，便于启动日志。
 */
export function applyLocalConfigToEnv(
  config: LocalConfig,
  env: NodeJS.ProcessEnv = process.env,
): { applied: string[] } {
  const applied: string[] = [];
  for (const spec of FIELD_SPECS) {
    const keys = Array.isArray(spec.env) ? spec.env : [spec.env];
    const value = getPathValue(config, spec.path);
    if (value === undefined) continue;
    const text = typeof value === 'boolean' ? String(value) : value;
    // 每个 env 键单独判断：显式 .env 值优先，本地只补空（userReceive 同时作用于飞书/钉钉）
    let filled = false;
    for (const key of keys) {
      if ((env[key] ?? '').trim() !== '') continue;
      env[key] = text;
      LOCAL_APPLIED_ENV_VALUES.set(key, text);
      filled = true;
    }
    if (filled) applied.push(spec.path);
  }
  return { applied };
}

/** 原子写本地配置（含密钥 → chmod 600；绝不打印内容） */
export function writeLocalConfigFile(file: string, config: LocalConfig): { mtime: string } {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const next: LocalConfig = {
    ...config,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    if (process.platform !== 'win32') {
      try {
        chmodSync(file, 0o600);
      } catch {
        // 权限收紧失败不影响主流程
      }
    }
    return { mtime: statSync(file).mtime.toISOString() };
  } catch (e) {
    throw new Error(`保存本地配置失败（${file}）：${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface MaskedFieldView {
  /** 该字段最高优先来源：.env / 本地配置 / 都没有 */
  source: 'env' | 'local' | 'none';
  configured: boolean;
  /** 已配置时只给末 4 位（密钥/ID 一视同仁，避免整串泄露） */
  masked?: string;
  /** bool/enum 才给可用值（不含任何密钥） */
  value?: string | boolean;
  /** 环境变量名（缺配置时前端可展示"需要 FEISHU_APP_ID"） */
  envKey: string;
  label: string;
}

function maskValue(value: string): string {
  const text = value.trim();
  if (text.length <= 4) return '****';
  return `****${text.slice(-4)}`;
}

/** 构造单个字段的脱敏视图（env 优先） */
function fieldView(spec: FieldSpec, config: LocalConfig, env: NodeJS.ProcessEnv): MaskedFieldView {
  const envKeys = Array.isArray(spec.env) ? spec.env : [spec.env];
  const envKey = envKeys[0]!;
  const envRaw = envValue(env, spec.env);
  const localValue = getPathValue(config, spec.path);
  // 重启后本地配置会 merge 进 process.env：这些键仍如实显示 source=local（否则用户以为来自 .env）
  const envFromLocal = envKeys.some((key) => {
    const raw = (env[key] ?? '').trim();
    return raw !== '' && isLocalAppliedEnvValue(key, raw);
  });
  const source: MaskedFieldView['source'] = envRaw ? (envFromLocal ? 'local' : 'env') : localValue !== undefined ? 'local' : 'none';
  const effective = envRaw || (typeof localValue === 'boolean' ? String(localValue) : localValue) || '';
  const base = { source, configured: Boolean(effective), envKey, label: spec.label };
  if (!effective) return base;
  if (spec.kind === 'bool') return { ...base, value: effective === 'true' };
  if (spec.kind === 'identity' || spec.kind === 'mode') return { ...base, value: String(effective) };
  return { ...base, masked: maskValue(String(effective)) };
}

export interface MaskedPlatformView {
  fields: Record<string, MaskedFieldView>;
  /** 缺哪些环境变量名（前端展示「需要 FEISHU_APP_ID」） */
  missing: string[];
  /** 是否已配置到「可以真正调接口」的程度（仅看凭据，不含 token 授权） */
  configured: boolean;
}

function platformView(
  prefix: 'platforms.feishu' | 'platforms.dingtalk' | 'platforms.wechat',
  required: string[],
  config: LocalConfig,
  env: NodeJS.ProcessEnv,
): MaskedPlatformView {
  const fields: Record<string, MaskedFieldView> = {};
  const missing: string[] = [];
  let configured = true;
  for (const spec of FIELD_SPECS) {
    if (!spec.path.startsWith(`${prefix}.`)) continue;
    const key = spec.path.slice(prefix.length + 1);
    const view = fieldView(spec, config, env);
    fields[key] = view;
    if (required.includes(key) && !view.configured) {
      missing.push(view.envKey);
      configured = false;
    }
  }
  return { fields, missing, configured };
}

export interface AppConfigView {
  version: 1;
  identity: Record<string, MaskedFieldView>;
  modes: Record<string, MaskedFieldView>;
  llm: Record<string, MaskedFieldView>;
  platforms: {
    feishu: MaskedPlatformView & { redirectHint?: string };
    dingtalk: MaskedPlatformView;
    wechat: MaskedPlatformView;
  };
  /** 本地配置文件存在的时间（用于「已保存，需重启」提示） */
  updatedAt?: string;
  /** settings 文件 mtime 晚于进程启动 → 需要重启 */
  restartRequired: boolean;
  envFile: { path: string; mtime: string } | null;
  settingsFile: { path: string; present: boolean; mtime: string | null };
}

export interface BuildAppConfigViewArgs {
  monorepoRoot: string;
  env?: NodeJS.ProcessEnv;
  /** @deprecated restartRequired 已改为「静态键 vs 启动基线」，不再使用进程启动时间 */
  startedAtMs?: number;
  envFile?: { path: string; mtime: string } | null;
  /** 单测注入文件读取（默认 readLocalConfig） */
  localConfig?: LocalConfigReadResult;
  /** 单测注入 restartRequired（不传则按静态键基线计算） */
  restartRequired?: boolean;
}

/** 构造 GET /api/app-config 的脱敏视图（绝不含任何密钥明文） */
export function buildAppConfigView(args: BuildAppConfigViewArgs): AppConfigView {
  const env = args.env ?? process.env;
  const local = args.localConfig ?? readLocalConfig(args.monorepoRoot, env);
  const config = local.config;
  const identity: Record<string, MaskedFieldView> = {};
  const modes: Record<string, MaskedFieldView> = {};
  const llm: Record<string, MaskedFieldView> = {};
  for (const spec of FIELD_SPECS) {
    const view = fieldView(spec, config, env);
    if (spec.path.startsWith('identity.')) identity[spec.path.slice('identity.'.length)] = view;
    else if (spec.path.startsWith('modes.')) modes[spec.path.slice('modes.'.length)] = view;
    else if (spec.path.startsWith('llm.')) llm[spec.path.slice('llm.'.length)] = view;
  }
  let settingsMtime: string | null = null;
  try {
    settingsMtime = existsSync(local.file) ? statSync(local.file).mtime.toISOString() : null;
  } catch {
    settingsMtime = local.mtime ?? null;
  }
  // P1-1：只比较「静态键相对启动基线」是否变化；identity.* 热应用不触发重启
  const restartRequired = args.restartRequired ?? computeRestartRequired(args.monorepoRoot, env, config);
  return {
    version: 1,
    identity,
    modes,
    llm,
    platforms: {
      feishu: platformView('platforms.feishu', ['appId', 'appSecret'], config, env),
      dingtalk: platformView('platforms.dingtalk', ['clientId', 'clientSecret'], config, env),
      wechat: platformView('platforms.wechat', ['bridgeUrl'], config, env),
    },
    ...(config.updatedAt ? { updatedAt: config.updatedAt } : {}),
    restartRequired,
    envFile: args.envFile ?? null,
    settingsFile: {
      // P3：认证接口只给 basename，不暴露本机绝对路径
      path: basename(local.file),
      present: existsSync(local.file),
      mtime: settingsMtime,
    },
  };
}

export interface ApplyPatchResult {
  config: LocalConfig;
  changedKeys: string[];
  /** 因显式 .env 已设置而无法由 GUI 覆盖、被忽略的键 */
  ignoredByEnv: string[];
  /** 未知/非法键 → 400 中文 */
  errors: string[];
}

/** 严格校验并合并 PUT 补丁（未知键 / 类型 / 长度 → errors） */
export function applyConfigPatch(
  base: LocalConfig,
  patch: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ApplyPatchResult {
  const errors: string[] = [];
  const changedKeys: string[] = [];
  const ignoredByEnv: string[] = [];
  const next: LocalConfig = JSON.parse(JSON.stringify(base)) as LocalConfig;
  if (!isPlainObject(patch)) {
    return { config: base, changedKeys, ignoredByEnv, errors: ['请求体必须是 JSON 对象'] };
  }
  const allowedSections = new Set(['identity', 'platforms', 'llm', 'modes']);
  const flat: Array<[string, unknown]> = [];
  for (const [section, rawSection] of Object.entries(patch)) {
    if (!allowedSections.has(section)) {
      errors.push(`未知配置分组「${section}」：只支持 identity / platforms / llm / modes`);
      continue;
    }
    if (rawSection === null || rawSection === undefined) continue;
    if (!isPlainObject(rawSection)) {
      errors.push(`配置分组「${section}」必须是对象`);
      continue;
    }
    if (section === 'platforms') {
      for (const [group, rawGroup] of Object.entries(rawSection)) {
        if (!isPlainObject(rawGroup)) {
          errors.push(`配置分组「platforms.${group}」必须是对象`);
          continue;
        }
        for (const [field, value] of Object.entries(rawGroup)) flat.push([`platforms.${group}.${field}`, value]);
      }
    } else {
      for (const [key, value] of Object.entries(rawSection)) flat.push([`${section}.${key}`, value]);
    }
  }
  if (errors.length > 0) return { config: base, changedKeys, ignoredByEnv, errors };

  for (const [path, rawValue] of flat) {
    const spec = SPEC_BY_PATH.get(path);
    if (!spec) {
      errors.push(`未知配置项「${path}」：请检查字段名（可用 GET /api/app-config 查看支持的字段）`);
      continue;
    }
    // 值为 null/空串 → 清除本地项
    if (rawValue === null || rawValue === '') {
      setPathValue(next, path, undefined);
      changedKeys.push(path);
      continue;
    }
    let value: string | boolean;
    if (spec.kind === 'bool') {
      if (typeof rawValue !== 'boolean') {
        errors.push(`「${spec.label}」必须是 true/false`);
        continue;
      }
      value = rawValue;
    } else {
      if (typeof rawValue !== 'string') {
        errors.push(`「${spec.label}」必须是字符串`);
        continue;
      }
      const text = rawValue.trim();
      if (!text) {
        setPathValue(next, path, undefined);
        changedKeys.push(path);
        continue;
      }
      if (spec.kind === 'identity' && !IDENTITY_VALUES.includes(text)) {
        errors.push(`「${spec.label}」只能是 auto / bot / user`);
        continue;
      }
      if (spec.kind === 'mode' && !MODE_VALUES.includes(text)) {
        errors.push(`「${spec.label}」只能是 auto / real / mock`);
        continue;
      }
      if (spec.maxLength && text.length > spec.maxLength) {
        errors.push(`「${spec.label}」过长（最多 ${spec.maxLength} 字符）`);
        continue;
      }
      value = text;
    }
    const envKeys = Array.isArray(spec.env) ? spec.env : [spec.env];
    // 启动时本地配置会「只补空」写进 process.env；这些值不是运维显式 .env，
    // 不能算占用，否则 GUI 保存过一次、重启后就再也无法修改自己保存的配置。
    const occupied = envKeys.filter((key) => {
      const raw = (env[key] ?? '').trim();
      return raw !== '' && !isLocalAppliedEnvValue(key, raw);
    });
    if (occupied.length > 0) {
      ignoredByEnv.push(...occupied);
      // 身份策略仍保存到本地（供以后删掉 env 后生效）；凭据/模式直接跳过（避免误以为已覆盖）
      if (spec.kind === 'identity') {
        setPathValue(next, path, value);
        changedKeys.push(path);
      }
      continue;
    }
    setPathValue(next, path, value);
    changedKeys.push(path);
  }

  next.version = 1;
  return { config: next, changedKeys, ignoredByEnv, errors };
}

/**
 * 构造默认本地配置视图的辅助：把布尔/枚举值转成 env 文本（前端预览用）。
 * （当前未在主流程使用，保留给后续 doctor/迁移脚本，避免逻辑重复。）
 */
export function localConfigToEnvMap(config: LocalConfig): Record<string, string> {
  const env: NodeJS.ProcessEnv = {};
  applyLocalConfigToEnv(config, env);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
// ---------------------------------------------------------------------------
// restartRequired 语义（二轮审计 P1-1）：
// 只有「静态键（凭据/模式/stream 等）」相对进程启动基线发生变化才需要重启；
// identity.* 是热应用键，永不触发 restartRequired。
// ---------------------------------------------------------------------------

/** 静态键快照：路径 → 值（identity.* 已排除） */
export function flattenStaticConfig(config: LocalConfig): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const spec of FIELD_SPECS) {
    if (spec.path.startsWith('identity.')) continue;
    const value = getPathValue(config, spec.path);
    if (value !== undefined) out[spec.path] = value;
  }
  return out;
}

let restartStaticBaseline: Record<string, string | boolean> | null = null;

/** 进程启动时拍摄静态键基线（config.ts 在合并本地配置后调用） */
export function captureRestartBaseline(config: LocalConfig): void {
  restartStaticBaseline = flattenStaticConfig(config);
}

/** 单测用：清空重启基线 */
export function resetRestartBaselineForTests(): void {
  restartStaticBaseline = null;
}

function sameStaticSnapshot(a: Record<string, string | boolean>, b: Record<string, string | boolean>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * 当前静态配置相对启动基线是否变化（变化 → 需要重启）。
 * identity.* 不参与比较（热应用立即生效）。
 */
export function computeRestartRequired(
  monorepoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  current?: LocalConfig,
): boolean {
  if (!restartStaticBaseline) return false;
  const config = current ?? readLocalConfig(monorepoRoot, env).config;
  return !sameStaticSnapshot(restartStaticBaseline, flattenStaticConfig(config));
}
/** settings 文件快照（只给路径/存在性/mtime，不含内容；health/onboarding 使用） */
export function settingsFileSnapshot(
  monorepoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; present: boolean; mtime: string | null } {
  const file = localConfigFilePath(monorepoRoot, env);
  if (!existsSync(file)) return { path: file, present: false, mtime: null };
  try {
    return { path: file, present: true, mtime: statSync(file).mtime.toISOString() };
  } catch {
    return { path: file, present: false, mtime: null };
  }
}
