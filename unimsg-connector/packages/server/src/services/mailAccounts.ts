/**
 * 邮箱账号「运行时导入」存储（个人版核心）。
 *
 * 个人版用户不需要手改 .env：在「连接账号」页填邮箱 + 授权码 → 保存到本地文件 →
 * 邮箱轮询热加载（无需重启），重启后自动从文件恢复。
 *
 * 文件位置（安全约定）：
 *  - 有 DATA_DIR → `DATA_DIR/mail-accounts.json`；
 *  - 否则 → `unimsg-connector/.linkhub-mail-accounts.json`（已 gitignore）。
 *  - 文件含授权码，非 Windows 上写盘后 chmod 600；授权码永不下发前端/永不打日志。
 *
 * 与 .env 的关系：
 *  - 启动时把文件账号并入 `config.mail.accounts`；key 冲突时**文件覆盖 env** 并 warn（本地导入以用户最近操作为准）；
 *  - env 来源的账号不允许删（DELETE 返回 400 中文，提示去改 .env）；
 *  - MAIL_ENABLED 未显式设置时，合并后只要有任何账号就自动启用轮询。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import { Platform } from '@unimsg/shared';
import {
  computeMailRuntimeAfterAccounts,
  createMailAccountFromInput,
  type MailAccount,
  type MailAccountInput,
} from '../config/runtime';

/** 本地账号文件名 */
export const MAIL_ACCOUNTS_FILE_NAME = 'mail-accounts.json';
/** 无 DATA_DIR 时的默认文件（仓库根，已 gitignore） */
export const LOCAL_MAIL_ACCOUNTS_FILE = '.linkhub-mail-accounts.json';

/** 账号来源：.env 还是本地导入文件 */
export type MailAccountSource = 'env' | 'file';

/**
 * 本地文件里的账号 = MailAccount + 验证时间。
 * 验证语义：只有「测试连接（IMAP+SMTP 登录）」成功过的本地账号才算 verified；
 * .env 来源账号由运维配置，默认视为已验证（无需也不可能在 GUI 里验证）。
 */
export type StoredMailAccount = MailAccount & { verifiedAt?: string };

/** 脱敏后的账号视图（GET /api/mail/accounts 下发；绝不含授权码） */
export interface MaskedMailAccount {
  key: string;
  label: string;
  /** 脱敏地址：a***@qq.com */
  address: string;
  provider: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  folders: string[];
  source: MailAccountSource;
  /** 是否可删除（仅本地文件来源可删；env 来源要改 .env） */
  removable: boolean;
  /** 是否已验证（env 来源=true；本地导入需测试连接成功） */
  verified: boolean;
  verifiedAt?: string;
}

export interface MailAccountsSnapshot {
  accounts: MailAccount[];
  masked: MaskedMailAccount[];
  sources: Record<string, MailAccountSource>;
  filePath: string;
  issues: string[];
}

/** 账号操作错误（路由映射成 400/404 中文） */
export class MailAccountsError extends Error {
  constructor(message: string, readonly code: 'validation' | 'env-source' | 'not-found' | 'io') {
    super(message);
    this.name = 'MailAccountsError';
  }
}

/** 邮箱地址脱敏（保留首字母与域名） */
export function maskMailAddress(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return address;
  const name = address.slice(0, at);
  const domain = address.slice(at);
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, name.length - 1)))}${domain}`;
}

/** 本地账号文件路径：DATA_DIR 优先，否则仓库根 `.linkhub-mail-accounts.json` */
export function mailAccountsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = (env.DATA_DIR ?? '').trim();
  if (dataDir) return join(dataDir, MAIL_ACCOUNTS_FILE_NAME);
  return fileURLToPath(new URL(`../../../../${LOCAL_MAIL_ACCOUNTS_FILE}`, import.meta.url));
}

/** 读取本地文件（容错：缺失=空；损坏=带回 issue，不阻断启动） */
export function loadMailAccountsFile(file: string): { entries: StoredMailAccount[]; issues: string[] } {
  const issues: string[] = [];
  if (!existsSync(file)) return { entries: [], issues };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    issues.push(`本地邮箱账号文件解析失败（${file}）：${e instanceof Error ? e.message : String(e)}；已忽略`);
    return { entries: [], issues };
  }
  const rawList = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).accounts
      : undefined);
  if (!Array.isArray(rawList)) {
    issues.push(`本地邮箱账号文件结构不对（${file}）：应为 { "accounts": [...] } 或数组；已忽略`);
    return { entries: [], issues };
  }
  const entries: StoredMailAccount[] = [];
  rawList.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`本地邮箱账号文件第 ${index + 1} 条不是对象，已忽略`);
      return;
    }
    const built = createMailAccountFromInput(item as MailAccountInput);
    if (!built.account) {
      issues.push(`本地邮箱账号文件第 ${index + 1} 条无效：${built.errors.join('；')}`);
      return;
    }
    const rawVerifiedAt = (item as Record<string, unknown>).verifiedAt;
    const verifiedAt = typeof rawVerifiedAt === 'string' && Number.isFinite(Date.parse(rawVerifiedAt))
      ? new Date(Date.parse(rawVerifiedAt)).toISOString()
      : undefined;
    entries.push(verifiedAt ? { ...built.account, verifiedAt } : built.account);
  });
  return { entries, issues };
}

/** 写本地账号文件（原子写 + 非 Windows chmod 600；含授权码，绝不打印内容） */
export function saveMailAccountsFile(file: string, accounts: StoredMailAccount[]): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const payload = {
    version: 1,
    // 注意：authCode 存在本地文件里（个人版体验优先），因此文件必须 chmod 600 + gitignore
    accounts: [...accounts].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    if (process.platform !== 'win32') {
      try {
        chmodSync(file, 0o600);
      } catch {
        // 权限收紧失败不影响主流程（Windows 无此概念；某些文件系统不支持）
      }
    }
  } catch (e) {
    throw new MailAccountsError(
      `保存本地邮箱账号失败（${file}）：${e instanceof Error ? e.message : String(e)}。请检查目录权限/磁盘空间。`,
      'io',
    );
  }
}

export interface MailAccountsStoreOptions {
  /** 本地账号文件（默认按 DATA_DIR 解析；单测注入临时文件） */
  file?: string;
  /** 账号变化后回调（生产=邮箱轮询热加载；默认不做事） */
  onChange?: (reason: string) => void;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * 邮箱账号存储：env 账号（启动时快照） + 本地文件账号（可运行时增删）合并。
 * 所有变更都会同步到 `config.mail.accounts`（其它模块照旧读 config）。
 */
export class MailAccountsStore {
  readonly file: string;
  /** .env 来源账号（启动快照，运行期不可删） */
  private envAccounts: MailAccount[];
  private fileAccounts: StoredMailAccount[] = [];
  private issues: string[] = [];
  private initialized = false;
  private readonly onChange: (reason: string) => void;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;

  constructor(opts: MailAccountsStoreOptions = {}) {
    this.file = opts.file ?? mailAccountsFilePath();
    this.envAccounts = [...config.mail.accounts];
    this.onChange = opts.onChange ?? (() => undefined);
    this.log = opts.log ?? ((line) => console.log(line));
    this.warn = opts.warn ?? ((line) => console.warn(line));
  }

  /** 启动时调用：加载本地文件并合并进 config（幂等） */
  init(): MailAccountsSnapshot {
    if (!this.initialized) {
      this.initialized = true;
      const loaded = loadMailAccountsFile(this.file);
      this.fileAccounts = loaded.entries;
      this.issues = loaded.issues;
      for (const issue of this.issues) this.warn(`[mail] ${issue}`);
      this.applyMerged();
      this.logSummary();
    }
    return this.snapshot();
  }

  /** 当前快照（脱敏视图可直接下发） */
  snapshot(): MailAccountsSnapshot {
    const sources: Record<string, MailAccountSource> = {};
    for (const account of this.envAccounts) sources[account.key] = 'env';
    for (const account of this.fileAccounts) sources[account.key] = 'file';
    const accounts = [...config.mail.accounts];
    return {
      accounts,
      masked: accounts.map((account) => this.maskedOf(account, sources[account.key] ?? 'env')),
      sources,
      filePath: this.file,
      issues: [...this.issues],
    };
  }

  /** 脱敏单条 */
  maskedOf(account: MailAccount | StoredMailAccount, source: MailAccountSource): MaskedMailAccount {
    const verifiedAt = (account as StoredMailAccount).verifiedAt;
    return {
      key: account.key,
      label: account.label,
      address: maskMailAddress(account.address),
      provider: account.provider,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecure: account.imapSecure,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecure: account.smtpSecure,
      folders: account.folders,
      source,
      removable: source === 'file',
      verified: source === 'env' ? true : Boolean(verifiedAt),
      ...(source === 'file' && verifiedAt ? { verifiedAt } : {}),
    };
  }

  /** 账号来源（account.ts 展示用；未初始化时默认 env） */
  sourceOf(key: string): MailAccountSource {
    return this.fileAccounts.some((a) => a.key === key) ? 'file' : 'env';
  }

  /**
   * 新增/更新本地账号（同 key 覆盖；与 .env 同 key 时本地覆盖并 warn）。
   * 校验失败抛 MailAccountsError('validation')。
   */
  addOrUpdate(input: MailAccountInput): { account: MailAccount; warnings: string[]; snapshot: MailAccountsSnapshot } {
    const built = createMailAccountFromInput(input);
    if (!built.account) {
      throw new MailAccountsError(built.errors.join('；') || '邮箱账号校验失败', 'validation');
    }
    const account = built.account;
    const warnings: string[] = [];
    const envConflict = this.envAccounts.some((a) => a.key === account.key);
    if (envConflict) {
      warnings.push(`账号 key「${account.key}」也存在于 .env：本地导入的配置已覆盖 .env（如需统一请直接改 .env 并删除本地账号）`);
    }
    const index = this.fileAccounts.findIndex((a) => a.key === account.key);
    if (index >= 0) {
      // 重新保存视为「配置可能变了」：验证状态作废，需要重新测试连接（诚实：不拿旧验证冒充新配置）
      this.fileAccounts[index] = account;
      warnings.push('账号已更新，此前的验证状态已作废：请重新点「测试连接」验证。');
    } else {
      this.fileAccounts.push(account);
      warnings.push('账号已保存但未验证：请点「测试连接」验证后才会真实收信（未验证账号不会算「已就绪」）。');
    }
    // 先落盘再生效：写盘失败时不改变运行中的账号列表
    this.persist();
    this.applyMerged();
    for (const warning of warnings) this.warn(`[mail] ${warning}`);
    this.log(`[mail] 已保存邮箱账号「${account.label}」<${maskMailAddress(account.address)}>（本地文件，热加载）`);
    this.onChange('新增/更新邮箱账号');
    return { account, warnings, snapshot: this.snapshot() };
  }

  /** 按 key 取当前生效账号（env 或 file），供「验证」接口使用 */
  accountOf(key: string): StoredMailAccount | undefined {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return undefined;
    const merged = [...config.mail.accounts];
    const params = merged.find((a) => a.key === normalized);
    if (!params) return undefined;
    const stored = this.fileAccounts.find((a) => a.key === normalized);
    return stored ? { ...params, verifiedAt: stored.verifiedAt } : { ...params };
  }

  /** 标记本地账号已验证（持久化 + 热加载回调）；env 来源抛 env-source */
  markVerified(key: string): { account: StoredMailAccount; snapshot: MailAccountsSnapshot } {
    const normalized = key.trim().toLowerCase();
    if (!normalized) throw new MailAccountsError('缺少账号 key', 'validation');
    if (this.envAccounts.some((a) => a.key === normalized)) {
      throw new MailAccountsError(
        `邮箱账号「${normalized}」来自 .env：默认视为已验证，无需在页面验证（要改凭据请修改 .env 并重启）。`,
        'env-source',
      );
    }
    const index = this.fileAccounts.findIndex((a) => a.key === normalized);
    if (index < 0) throw new MailAccountsError(`本地没有找到邮箱账号「${normalized}」（可能已删除）`, 'not-found');
    const verifiedAt = new Date().toISOString();
    this.fileAccounts[index] = { ...this.fileAccounts[index]!, verifiedAt };
    this.persist();
    this.applyMerged();
    this.log(`[mail] 邮箱账号「${this.fileAccounts[index]!.label}」已验证（${verifiedAt}）`);
    this.onChange('验证邮箱账号');
    return { account: this.fileAccounts[index]!, snapshot: this.snapshot() };
  }

  /** 删除本地账号；env 来源的 key 抛 MailAccountsError('env-source') */
  remove(key: string): { removed: MailAccount; snapshot: MailAccountsSnapshot } {
    const normalized = key.trim().toLowerCase();
    if (!normalized) throw new MailAccountsError('缺少账号 key', 'validation');
    if (this.envAccounts.some((a) => a.key === normalized)) {
      throw new MailAccountsError(
        `邮箱账号「${normalized}」来自 .env：请修改 .env 里对应的 MAIL_${normalized.toUpperCase()}_* 变量并重启，而不是在本地删除。`,
        'env-source',
      );
    }
    const index = this.fileAccounts.findIndex((a) => a.key === normalized);
    if (index < 0) throw new MailAccountsError(`本地没有找到邮箱账号「${normalized}」（可能已删除）`, 'not-found');
    const [removed] = this.fileAccounts.splice(index, 1);
    this.persist();
    this.applyMerged();
    this.log(`[mail] 已删除本地邮箱账号「${removed!.label}」<${maskMailAddress(removed!.address)}>（热加载）`);
    this.onChange('删除邮箱账号');
    return { removed: removed!, snapshot: this.snapshot() };
  }

  /** 从磁盘重新加载（外部改了文件时用；启动/删除/新增已自动刷新） */
  reloadFromDisk(): MailAccountsSnapshot {
    const loaded = loadMailAccountsFile(this.file);
    this.fileAccounts = loaded.entries;
    this.issues = loaded.issues;
    this.applyMerged();
    this.logSummary();
    return this.snapshot();
  }

  private persist(): void {
    saveMailAccountsFile(this.file, this.fileAccounts);
  }

  /** env + file 合并（file 覆盖同 key env），并同步回 config.mail.accounts */
  private applyMerged(): void {
    const merged = new Map<string, MailAccount>();
    for (const account of this.envAccounts) merged.set(account.key, account);
    for (const account of this.fileAccounts) {
      if (merged.has(account.key)) {
        this.warn(`[mail] 本地账号覆盖 .env 中同名账号 key=${account.key}（以本地文件为准）`);
      }
      merged.set(account.key, account);
    }
    const list = [...merged.values()];
    config.mail.accounts.splice(0, config.mail.accounts.length, ...list);
    // 未显式 MAIL_ENABLED=false 时：有账号就自动启用轮询（个人版导入账号后无需再改 .env）
    if (!config.mail.enabledExplicit) config.mail.enabled = list.length > 0;
    // P0-3：按当前账号重算邮箱运行画像（否则启动时算好的 mock 永远不会变成 real）
    this.recomputeRuntime();
  }

  /** 按当前账号重算 config.runtime[MAIL]（P0-3：界面添加账号后真实收发立即成立） */
  private recomputeRuntime(): void {
    const rt = config.runtime[Platform.MAIL];
    const verifiedFileKeys = this.fileAccounts.filter((a) => a.verifiedAt).map((a) => a.key);
    const computed = computeMailRuntimeAfterAccounts({
      policy: rt.policy,
      envAccounts: this.envAccounts,
      verifiedFileKeys,
    });
    rt.mode = computed.mode;
    rt.configured = computed.configured;
    rt.canSend = computed.canSend;
    rt.canReceive = computed.canReceive;
    rt.reason = computed.reason;
    if (computed.mode === 'real') {
      this.log('[mail] 运行画像已重算：真实邮箱可用（' + computed.reason + '）');
    }
  }

  private logSummary(): void {
    if (this.fileAccounts.length === 0) {
      this.log(`[mail] 本地邮箱账号文件：${this.file}（暂无本地导入账号）`);
      return;
    }
    const list = this.fileAccounts
      .map((a) => `${a.label}<${maskMailAddress(a.address)}>`)
      .join(' / ');
    this.log(`[mail] 已从本地文件载入 ${this.fileAccounts.length} 个邮箱账号（${list}）：${this.file}`);
  }
}

// ---------------------------------------------------------------------------
// 生产单例（index.ts 初始化；路由/账号页读取）
// ---------------------------------------------------------------------------

let instance: MailAccountsStore | undefined;

/** 启动时初始化（加载本地文件并入 config）；可重复调用（幂等） */
export function initMailAccounts(opts: MailAccountsStoreOptions = {}): MailAccountsStore {
  if (!instance) instance = new MailAccountsStore(opts);
  instance.init();
  return instance;
}

/** 生产单例：路由使用；未初始化时惰性创建（不 init，避免测试/只读路径意外写盘） */
export function currentMailAccounts(): MailAccountsStore {
  if (!instance) instance = new MailAccountsStore();
  return instance;
}

/** 只读预览（account.ts 等不想触发创建时用） */
export function peekMailAccounts(): MailAccountsStore | undefined {
  return instance;
}

/** 单测用：清空单例 */
export function resetMailAccountsForTests(): void {
  instance = undefined;
}