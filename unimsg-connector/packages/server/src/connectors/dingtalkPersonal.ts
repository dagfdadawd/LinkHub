/**
 * 钉钉「本人身份」通道：官方开源 CLI dws 的子进程封装。
 *
 * 为什么用子进程：钉钉个人身份（以员工本人账号收发）依赖官方 CLI 完成
 * OAuth device-flow 登录、token 刷新、个人 Stream 长连接。LinkHub 不重复实现这套
 * 协议，也不引入新的 npm 依赖，只把 dws 当成一个「可注入、可 Mock」的外部命令，
 * 满足项目铁律（可替换、可单测、可 Mock、绝不假成功）。
 *
 * 本文件所有 CLI 契约均来自 dws v1.0.68-beta.1 的**只读探测**（未登录状态实测）：
 *  - `dws version`            → `Version:        v1.0.68-beta.1`
 *  - `dws auth status --readonly --format json`
 *      → `{"success":true,"authenticated":false,"message":"未登录", "version_check":{...}}`
 *  - `dws profile list --format json` → `{"success":true,"profiles":[]}`
 *  - `dws event +listen-im --kind <at-me|sender|group|all-direct|all-group> --events message -f ndjson -y`
 *      默认输出 **transport envelope**：`{type:"event", event_type:"user_im_message_receive_o2o_all",
 *      event_id, data:<JSON 字符串>, headers, ...}`——注意 **data 是字符串**，需要再 JSON.parse。
 *      `--flatten` 只属于 event consume/schema，`+listen-im` 不支持（真实 dws 会 exit 3 unknown flag）。
 *      data 内业务字段：message_id / conversation_id / content / create_time / event_time / sender /
 *      sender_open_dingtalk_id / event_id；event_type 在 envelope 根或 data.type。
 *  - `dws chat message send --conversation-id <id> --content <text> --idempotency-key <key> -f json`
 *      成功 `{"ok":true,"outcome":"success","data":{...}}`
 *      失败 `{"ok":false,"outcome":"failure","error":{"type","subtype","exit_code","message","hint"}}`
 *      或   `{"error":{"category","code","message"}}`
 *      目标三选一：--conversation-id（群聊 openConversationId）/ --user（userId）/ --open-dingtalk-id
 *      **--ai-tag 默认 true**：以本人身份发出的消息会带平台 AI 角标。这是平台的透明标注，
 *      本项目不隐藏、不显式传 false（诚实标注原则），文档同步说明。
 *  - `dws chat message reply --group <openConversationId> --ref-msg-id <openMessageId>
 *      --ref-sender <openDingTalkId> --content <text> --uuid <幂等键>`
 *  - 未登录：exit code 5 + stderr `load access token: reading secure data file ...`（英文原始报错）
 *      → 本文件统一翻译成中文可操作提示，绝不把英文栈甩给用户。
 *
 * 设计要点：
 *  - 纯解析器全部导出（parseAuthStatusJson / parseEventLine / mapPersonalEventToMessage /
 *    buildSendArgs / mapSendResultJson ...），单测可注入假 runner，不启子进程；
 *  - 状态查询带 30s 缓存 + 单飞，避免 /api/accounts 首屏被 dws 网络检查拖慢（实测 auth status 1–3s）；
 *  - 登录：后台 spawn，接口立即返回操作指引，前端轮询 /status 判断登录完成；绝不阻塞 HTTP。
 *    默认 auto = **优先浏览器 loopback**（本机推荐，dws 自起 127.0.0.1 回调并打开浏览器，
 *    从 stderr 解析 OAuth URL 下发）；启动失败才回退设备码（远程/无浏览器，900s 有效期倒计时）。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MsgStatus, Platform, type AttachmentInfo, type UnifiedMessage,
} from '@unimsg/shared';
import { config } from '../config';
import { genTraceId } from './base';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 未登录：dws 在无凭证时的退出码（实测） */
export const DWS_EXIT_NOT_LOGGED_IN = 5;
/** 参数/文件校验失败（实测 `--file` 不存在时 exit=3） */
export const DWS_EXIT_VALIDATION = 3;
/** 本进程注入的超时退出码（与常见 EX_ 约定区分开，避免与 dws 自身冲突） */
export const DWS_EXIT_TIMEOUT = 124;

/** auth status 缓存时长：实测一次 1–3s（含网络检查 + 版本检查），缓存后首屏无感 */
export const DEFAULT_STATUS_CACHE_MS = 30_000;
/** 设备码模式：等多久去抓设备码/URL（拿不到就回退纯终端指引） */
export const LOGIN_HINT_WAIT_MS = 2_500;
/**
 * 浏览器 loopback 模式：dws 先起 127.0.0.1 本地回调服务、再把 OAuth URL 打到 stderr，
 * 比设备码多一步启动，等待窗口放宽到 6s（拿不到 URL 也不算失败：子进程仍存活，可轮询 status 恢复）。
 */
export const BROWSER_LOGIN_HINT_WAIT_MS = 6_000;
/**
 * 设备码有效期（秒）：dws 声称 15 分钟（900s）。实际可能更短/失效更快，
 * 所以界面用它做倒计时，过期后必须重新获取而不是继续输入旧码。
 * 能从 dws 输出解析到 expires 时以解析值为准。
 */
export const DEFAULT_DEVICE_EXPIRES_SEC = 900;
/**
 * 浏览器 loopback 模式的操作窗口（秒）：dws 侧没有显式过期时间，
 * 这里给用户 10 分钟完成扫码/登录并做倒计时；窗口过了由用户点「重新登录」。
 */
export const DEFAULT_BROWSER_EXPIRES_SEC = 600;

/** 登录方式：auto = 优先浏览器 loopback（本机推荐），失败回退设备码 */
export type LoginMode = 'auto' | 'browser' | 'device';
/** 本次实际使用的登录通道 */
export type LoginChannel = 'browser' | 'device';

/** 从 dws 输出里解析出的登录提示 */
export interface DwsLoginHint {
  /** 授权链接：browser = 钉钉 OAuth（127.0.0.1 回调）；device = 设备码验证页 */
  url?: string;
  /** device flow 的 user code */
  code?: string;
  /** 有效期（秒） */
  expiresInSec?: number;
}

export interface DwsRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 是否被我们的超时杀掉 */
  timedOut?: boolean;
  /** spawn 阶段的错误码（ENOENT = 没装 dws；EACCES = 没执行权限） */
  spawnError?: string;
}

export interface DwsRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 可注入的执行器：生产默认走 child_process.spawn，单测直接给假实现 */
export type DwsRunner = (args: string[], opts?: DwsRunOptions) => Promise<DwsRunResult>;

export type DwsFailureKind =
  | 'not-installed'
  | 'not-logged-in'
  | 'timeout'
  | 'permission'
  | 'validation'
  | 'unknown';

/** dws 调用错误：message 直接给用户看（中文 + 下一步），kind 供路由/doctor 分类 */
export class DingtalkPersonalError extends Error {
  readonly kind: DwsFailureKind;
  readonly code?: number;

  constructor(message: string, kind: DwsFailureKind = 'unknown', code?: number) {
    super(message);
    this.name = 'DingtalkPersonalError';
    this.kind = kind;
    this.code = code;
  }
}

export interface DwsAuthStatus {
  /** dws 可执行文件存在（false = 没装 / DWS_BIN 配错） */
  available: boolean;
  authenticated: boolean;
  /** dws 原始提示（例如「未登录」），仅用于日志/hint 参考 */
  message?: string;
  /** dws 自报版本（来自 version_check.current 或 version 命令） */
  version?: string;
  /** 探测时间（ms） */
  checkedAt: number;
  /** 探测失败原因（超时/JSON 解析失败等），authenticated=false 时一并给出 */
  error?: string;
  /** 访问令牌到期时间（ISO）；前端据此显示倒计时 */
  expiresAt?: string;
  /** 刷新令牌到期时间（ISO） */
  refreshExpiresAt?: string;
  /** 当前登录的钉钉用户名 / 企业名 */
  userName?: string;
  corpName?: string;
  /** 令牌是否仍然有效（dws 自报） */
  tokenValid?: boolean;
  refreshTokenValid?: boolean;
}

export interface DwsProfile {
  /** 展示名（字段以 dws 实际返回为准，容错取多个候选） */
  displayName?: string;
  corpId?: string;
  userId?: string;
  openDingtalkId?: string;
  raw: Record<string, unknown>;
}

export interface DwsLoginStart {
  /** 登录子进程是否在运行（false = 启动失败，instructions 说明原因/手动命令） */
  started: boolean;
  /** 本次实际使用的登录通道（auto 解析后） */
  mode: LoginChannel;
  /** 用户请求的方式（auto/browser/device），便于前端/日志诊断 */
  requestedMode?: LoginMode;
  /** 等价终端命令（用户可复制到本机终端执行） */
  command: string;
  /** 中文操作指引（含 URL / 设备码时一并写明） */
  instructions: string;
  /** 授权链接：browser=钉钉 OAuth 页（127.0.0.1 回调）；device=设备码验证页 */
  url?: string;
  /** device flow 的 user code */
  code?: string;
  /** 有效期（秒）：device 默认 900，browser 默认 600（界面倒计时用） */
  expiresInSec?: number;
  /** 过期时间（ISO）：= 发起时间 + expiresInSec */
  expiresAt?: string;
  /** 本次登录尝试的唯一 ID：前端据此判断「还是同一次登录流程」 */
  loginId?: string;
}

/** 客户端内部的一次登录会话（不含任何 token） */
interface LoginSession {
  loginId: string;
  requestedMode: LoginMode;
  mode: LoginChannel;
  startedAt: number;
  command: string;
  instructions: string;
  url?: string;
  code?: string;
  expiresInSec?: number;
  expiresAtMs?: number;
  output: { out: string; err: string };
  child?: any;
  finished: boolean;
  exitCode?: number | null;
  expiryTimer?: NodeJS.Timeout;
  /** 解析到 hint 时提前结束等待窗口 */
  hintResolve?: () => void;
}

export interface DwsSendTarget {
  /** 群聊 / 单聊 openConversationId（优先） */
  conversationId?: string;
  /** 单聊对端 openDingTalkId（个人事件里 sender_open_dingtalk_id 可直接用） */
  openDingtalkId?: string;
  /** 单聊对端 userId（dws 会自行解析 openDingTalkId，需要网络） */
  userId?: string;
}

export interface DwsSendOutcome {
  ok: boolean;
  /** 平台回执（openTaskId / openMessageId 等） */
  platformReply?: string;
}

// ---------------------------------------------------------------------------
// DWS_BIN 解析（支持带参数与引号，例如 `node scripts/fake-dws.mjs`）
// ---------------------------------------------------------------------------

/**
 * 按 shell 习惯切分命令字符串（只支持最基本的空格 + 引号，够 DWS_BIN 用）。
 * 例：`node "scripts/fake dws.mjs" --mock` → ['node','scripts/fake dws.mjs','--mock']
 */
export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        // 双引号内反斜杠转义（Windows 路径反斜杠不转义，只在 \" 时处理）
        const next = input[i + 1];
        if (next === '"' || next === '\\') {
          cur += next;
          i += 1;
        } else {
          cur += ch;
        }
      } else {
        cur += ch;
      }
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/**
 * monorepo 根（unimsg-connector/）：DWS_BIN 里的相对路径按它解析。
 *
 * 原因：`pnpm --filter @unimsg/server start` 的 cwd 是 packages/server/，
 * 而用户在 .env 里写 `DWS_BIN=node scripts/fake-dws.mjs` 时，脚本相对的是仓库根。
 * 只对「看起来像路径」的参数做解析（裸命令名如 dws / node 仍交给 PATH），
 * 真实 dws 的绝对路径、PATH 查找行为都不受影响。
 */
export const MONOREPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * 是否是「相对路径」（需要按仓库根解析）：
 *  - 以 . 开头、带路径分隔符 → 是；
 *  - 脚本文件（.mjs/.cjs/.js/.ts）即使不带目录也按仓库根解析（如 DWS_BIN=node fake-dws.mjs）；
 *  - 裸可执行名（dws / dws.exe / node）保持交给 PATH，绝不误解析。
 */
function looksLikeRelativePath(token: string): boolean {
  if (!token) return false;
  if (isAbsolute(token)) return false;
  if (token.startsWith('.')) return true;
  if (token.includes('/') || token.includes('\\')) return true;
  return /\.(mjs|cjs|js|ts)$/i.test(token);
}

/** 把 DWS_BIN 里的相对路径解析为仓库根下的绝对路径（其它原样返回） */
export function resolveDwsBinToken(token: string): string {
  return looksLikeRelativePath(token) ? resolve(MONOREPO_ROOT, token) : token;
}

/** 解析 DWS_BIN → 可执行文件 + 前置参数（空/非法时回退默认 `dws`） */
export function parseDwsBin(bin: string | undefined): { file: string; prefixArgs: string[] } {
  const parts = splitCommandLine((bin ?? '').trim() || 'dws');
  if (parts.length === 0) return { file: 'dws', prefixArgs: [] };
  return { file: resolveDwsBinToken(parts[0]), prefixArgs: parts.slice(1).map(resolveDwsBinToken) };
}

// ---------------------------------------------------------------------------
// 失败分类（把英文原始报文翻译成中文可操作提示）
// ---------------------------------------------------------------------------

/**
 * dws 未登录的典型报文（实测）：load access token / secure data file / 未登录。
 *
 * 这里**只认登录专属措辞**：曾经把 `401` / `unauthorized` 也算进来，结果
 * 「文件上传时接口返回 401」被翻译成「本人身份未登录」，用户跑去重新登录也没用。
 * 鉴权失败的其他形态会落到下面的「接口业务错误」分支，如实带出上游 code/message。
 */
const NOT_LOGGED_IN_RE = /load access token|secure data file|not logged in|未登录|invalid[_\s-]?token|token (?:has )?expired|please (?:re)?login|重新登录/i;
/** 权限不足（企业未开 CLI 访问 / 应用权限没批 / 用户不在范围） */
const PERMISSION_RE = /permission|forbidden|403\b|not authorized|无权限|权限不足|clawType|CLI 访问|not in scope|没有权限/i;

export interface DwsFailureInfo {
  kind: DwsFailureKind;
  /** 直接给用户看的中文提示 */
  message: string;
  /** 附带原始 stderr 摘要（截断，便于排错；不含 token） */
  raw?: string;
}

/**
 * 把一次 dws 执行结果翻译成中文失败信息。
 * 依据（实测）：exit=5 + stderr `load access token: reading secure data file`；
 * 参数校验 → stdout 里 `{"ok":false,...,"error":{"type":"validation",...}}` 或 exit=3。
 */
export function classifyDwsFailure(result: DwsRunResult, commandLabel = 'dws'): DwsFailureInfo {
  const rawText = `${result.stdout}\n${result.stderr}`.trim();
  const raw = rawText.length > 600 ? `${rawText.slice(0, 600)}…` : rawText;
  if (result.spawnError === 'ENOENT') {
    return {
      kind: 'not-installed',
      message: `未找到 dws 可执行文件（${commandLabel}）。请安装钉钉官方 CLI：`
        + 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli ，'
        + '安装后确认终端里 `dws version` 可用；或在 .env 把 DWS_BIN 指向 dws.exe 的完整路径'
        + '（纯离线演示可设 DWS_BIN=node scripts/fake-dws.mjs）。',
      ...(raw ? { raw } : {}),
    };
  }
  if (/MODULE_NOT_FOUND|Cannot find module|no such file or directory|ENOENT/i.test(rawText)) {
    return {
      kind: 'not-installed',
      message: `未找到 dws 可执行文件或脚本（DWS_BIN=${commandLabel}）：请检查 DWS_BIN 指向的路径是否存在。`
        + '纯离线演示可设 DWS_BIN=node scripts/fake-dws.mjs（相对路径按 unimsg-connector 仓库根解析），'
        + '真实使用需安装钉钉官方 CLI：https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli',
      ...(raw ? { raw } : {}),
    };
  }
  if (result.spawnError) {
    return {
      kind: 'unknown',
      message: `启动 dws 失败（${result.spawnError}）：请检查 DWS_BIN=${commandLabel} 是否指向可执行文件、当前用户是否有执行权限。`,
      ...(raw ? { raw } : {}),
    };
  }
  if (result.timedOut) {
    return {
      kind: 'timeout',
      message: `dws 命令超时（${commandLabel}）：可能网络不可达或 dws 正在检查版本。`
        + '可稍后重试；如长期超时请检查代理/网络，或调大 DWS_AUTH_TIMEOUT_MS / DWS_SEND_TIMEOUT_MS。',
      ...(raw ? { raw } : {}),
    };
  }
  if (result.code === DWS_EXIT_NOT_LOGGED_IN || NOT_LOGGED_IN_RE.test(rawText)) {
    return {
      kind: 'not-logged-in',
      message: '钉钉本人身份未登录：请先在终端执行 `dws auth login` 完成授权'
        + '（或到 LinkHub「平台账号」页点「连接本人账号」）。'
        + '登录会打开浏览器/给出设备码，需要你本人确认一次。',
      ...(raw ? { raw } : {}),
    };
  }
  if (result.code === DWS_EXIT_VALIDATION) {
    return {
      kind: 'validation',
      message: `dws 参数/目标校验失败（${commandLabel}）：${firstErrorMessage(rawText) ?? '请检查会话 ID、文件路径是否有效。'}`,
      ...(raw ? { raw } : {}),
    };
  }
  if (PERMISSION_RE.test(rawText)) {
    return {
      kind: 'permission',
      message: '钉钉本人身份权限不足：请联系企业管理员确认已开启「CLI 访问管理」'
        + '（或改用自有应用 Custom App 模式），并确认你的账号已授权相应 IM 权限。',
      ...(raw ? { raw } : {}),
    };
  }
  // 平台接口的业务错误（如 OPEN_CID_INVALID / 上传失败）：如实带出上游 code + message，
  // 不要归到「未登录」或只剩一句「未知错误」——否则用户永远查不到真正原因。
  const upstream = readUpstreamError(rawText);
  const detail = firstErrorMessage(rawText) ?? '未返回可读错误信息';
  return {
    kind: 'unknown',
    message: `dws 命令执行失败（${commandLabel}，exit=${result.code}）：${detail}`
      + (upstream.code ? `（上游错误码 ${upstream.code}）` : '')
      + '。可运行 `pnpm run doctor --platform=dingtalk` 自检。',
    ...(raw ? { raw } : {}),
  };
}

/** 读取 dws JSON 错误体里的上游错误码（仅用于诊断文案，不参与逻辑判断） */
function readUpstreamError(text: string): { code?: string } {
  const json = tryParseJson(text.trim()) as Record<string, any> | undefined;
  const err = json?.error;
  if (err && typeof err === 'object' && typeof err.upstream_code === 'string') {
    return { code: err.upstream_code };
  }
  return {};
}

/** 从 dws 的 JSON 错误体 / 纯文本里提取一句人类可读原因 */
export function firstErrorMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const json = tryParseJson(trimmed);
  if (json && typeof json === 'object') {
    const r = json as Record<string, any>;
    const candidates = [
      r?.error?.message,
      r?.error?.hint,
      r?.message,
      r?.msg,
      r?.error,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 300);
    }
  }
  // 非 JSON：取第一行有内容的（dws 诊断常带 `● Error: ...` 前缀）
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => !l.startsWith('WARN')) ?? lines[0];
  return first ? first.replace(/^●\s*Error:\s*/i, '').slice(0, 300) : undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 纯解析器
// ---------------------------------------------------------------------------

/** 从 `dws version` 输出里取版本号（实测 `Version:        v1.0.68-beta.1`） */
export function parseVersion(stdout: string, stderr = ''): string | undefined {
  const m = `${stdout}\n${stderr}`.match(/Version:\s*(v?[\w.\-+]+)/i)
    ?? `${stdout}\n${stderr}`.match(/"?current"?\s*:\s*"(v?[\w.\-+]+)"/i);
  return m ? m[1] : undefined;
}

/**
 * 解析 `dws auth status --readonly --format json`。
 * 实测结构：{ success: true, authenticated: false, message: '未登录', version_check?: { current } }
 * 容错：非 JSON 时按中英文关键词判断；任何异常都不抛，交给调用方显示不可用状态。
 */
export function parseAuthStatusJson(stdout: string, stderr = ''): {
  authenticated: boolean;
  message?: string;
  version?: string;
  /** 访问令牌到期时间（dws 的 expires_at） */
  expiresAt?: string;
  /** 刷新令牌到期时间（refresh_expires_at） */
  refreshExpiresAt?: string;
  userName?: string;
  corpName?: string;
  tokenValid?: boolean;
  refreshTokenValid?: boolean;
} {
  const text = stdout.trim();
  const json = tryParseJson(text);
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const r = json as Record<string, any>;
    const authenticated = r.authenticated === true;
    const versionCheck = r.version_check ?? r.versionCheck;
    const version = typeof versionCheck?.current === 'string' && versionCheck.current.trim()
      ? versionCheck.current.trim()
      : undefined;
    const message = typeof r.message === 'string' && r.message.trim() ? r.message.trim() : undefined;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const expiresAt = str(r.expires_at ?? r.expiresAt);
    const refreshExpiresAt = str(r.refresh_expires_at ?? r.refreshExpiresAt);
    const userName = str(r.user_name ?? r.userName);
    const corpName = str(r.corp_name ?? r.corpName);
    const tokenValid = bool(r.token_valid ?? r.tokenValid);
    const refreshTokenValid = bool(r.refresh_token_valid ?? r.refreshTokenValid);
    return {
      authenticated,
      ...(message ? { message } : {}),
      ...(version ? { version } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
      ...(userName ? { userName } : {}),
      ...(corpName ? { corpName } : {}),
      ...(tokenValid !== undefined ? { tokenValid } : {}),
      ...(refreshTokenValid !== undefined ? { refreshTokenValid } : {}),
    };
  }
  // 非 JSON 兜底：dws 某些子命令/版本会输出纯文本
  const authenticated = /已登录|logged in|authenticated:\s*true/i.test(text)
    && !/未登录|not logged in|authenticated:\s*false/i.test(text);
  const version = parseVersion(stdout, stderr);
  return {
    authenticated,
    ...(authenticated ? {} : { message: '未登录' }),
    ...(version ? { version } : {}),
  };
}

/**
 * 解析 `dws profile list --format json`（实测 `{"success":true,"profiles":[]}`）。
 * profiles 字段名在 dws 版本间可能变化，这里按多个候选容错，取不到就跳过。
 */
export function parseProfileListJson(stdout: string): DwsProfile[] {
  const json = tryParseJson(stdout.trim());
  if (!json || typeof json !== 'object') return [];
  const list = (json as Record<string, unknown>).profiles;
  if (!Array.isArray(list)) return [];
  const out: DwsProfile[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const str = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = r[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return undefined;
    };
    out.push({
      displayName: str('displayName', 'display_name', 'name', 'userName', 'nickName', 'nick', 'corpuser', 'label'),
      corpId: str('corpId', 'corp_id', 'orgId'),
      userId: str('userId', 'user_id', 'staffId'),
      openDingtalkId: str('openDingTalkId', 'openDingtalkId', 'open_dingtalk_id'),
      raw: r,
    });
  }
  return out;
}

/**
 * 解析 `dws contact user get-self -f json`（本人身份信息）。
 *
 * 真实 v1.0.68 输出（实测）：
 *   {"result":[{"isAdmin":true,"orgEmployeeModel":{"corpId":"...","orgUserName":"陈",
 *     "userId":"0415...","depts":[...]}}]}
 * **注意：真实 CLI 不返回 openDingTalkId**（只有 orgEmployeeModel/userId/userName）。
 * 因此「过滤自己发出的消息」最多 best-effort：拿不到 openDingTalkId 时不过滤，绝不阻断接收。
 * 字段名在 dws 版本间可能变化，这里按多个候选容错（含旧版 data.openDingTalkId 格式）。
 */
export function parseSelfProfileJson(stdout: string): { openDingtalkId?: string; displayName?: string; userId?: string } {
  const json = tryParseJson(stdout.trim());
  if (!json || typeof json !== 'object') return {};
  const root = json as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [];
  // 真实格式：{result:[{orgEmployeeModel:{...}}]}；旧版/模拟：{data:{openDingTalkId,...}}
  const result = root.result;
  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        if (obj.orgEmployeeModel && typeof obj.orgEmployeeModel === 'object') {
          candidates.push(obj.orgEmployeeModel as Record<string, unknown>);
        }
        candidates.push(obj);
      }
    }
  }
  if (root.data && typeof root.data === 'object') candidates.push(root.data as Record<string, unknown>);
  candidates.push(root);
  let openDingtalkId: string | undefined;
  let displayName: string | undefined;
  let userId: string | undefined;
  for (const obj of candidates) {
    openDingtalkId ??= pickString(obj, 'openDingTalkId', 'openDingtalkId', 'open_dingtalk_id', 'openId');
    displayName ??= pickString(obj, 'displayName', 'orgUserName', 'userName', 'name', 'nickName');
    userId ??= pickString(obj, 'userId', 'user_id', 'staffId');
  }
  return {
    ...(openDingtalkId ? { openDingtalkId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(userId ? { userId } : {}),
  };
}

/** 一个个人事件（已归一化的业务字段） */
export interface DingtalkPersonalEvent {
  /** event_key，例如 user_im_message_receive_o2o_all / user_im_message_receive_at */
  eventType?: string;
  eventId?: string;
  messageId: string;
  conversationId?: string;
  content: string;
  /** 毫秒时间戳（优先 event_time / create_time / timestamp） */
  createTimeMs?: number;
  senderName?: string;
  senderOpenDingtalkId?: string;
  /** 原始 payload（保留给排错/日志，不直接入库） */
  raw: Record<string, unknown>;
}

/** 把 envelope 的 data（可能是 JSON 字符串）解析成对象；解析失败返回 undefined */
function resolvePayloadObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    const parsed = tryParseJson(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

/**
 * 从一行事件里取出业务字段所在对象。兼容两种真实格式：
 *  1) transport envelope（默认，实测）：{type:"event", event_type, data:"<JSON 字符串>", headers}
 *     → 先 JSON.parse(data) 再取业务字段；
 *  2) --flatten / 旧版 fake 格式：业务字段直接在 payload / data 对象里。
 */
export function extractEventPayload(line: unknown): Record<string, unknown> | undefined {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return undefined;
  const root = line as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [];
  const push = (value: unknown): void => {
    const obj = resolvePayloadObject(value);
    if (obj && !candidates.includes(obj)) candidates.push(obj);
  };
  push(root.payload);                 // --flatten / 旧版 fake-dws 格式
  push(root.data);                    // 真实 envelope：data 是 JSON 字符串
  push((root.data as Record<string, unknown> | undefined)?.payload); // 对象型 data 里再套 payload
  push(root.body);
  push(root);                         // 最后兜底看根字段
  for (const obj of candidates) {
    if (pickString(obj, 'message_id', 'messageId', 'msgId', 'openMessageId') !== undefined) return obj;
  }
  // 没有 message_id 的事件（审批/待办/撤回等）：返回 data 解出的对象；解不出则返回根
  return candidates.find((obj) => obj !== root) ?? root;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.trim());
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return undefined;
}

/**
 * 取时间字段：优先毫秒数字/数字字符串（event_time），
 * 其次 create_time 的字符串时间（如 "2026-11-12 14:05:00" / ISO），最后 envelope 的接收时间。
 */
function pickTimeMs(
  payload: Record<string, unknown>,
  root: Record<string, unknown>,
): number | undefined {
  const direct = pickNumber(payload, 'event_time', 'timestamp', 'createTime');
  if (direct !== undefined) return direct;
  for (const key of ['create_time', 'createTime', 'msg_time', 'send_time']) {
    const v = payload[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
    if (typeof v === 'string' && v.trim()) {
      const text = v.trim();
      const n = Number(text);
      if (Number.isFinite(n) && n > 0) return Math.floor(text.length <= 10 ? n * 1000 : n);
      const parsed = Date.parse(text) || Date.parse(text.replace(' ', 'T'));
      if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    }
  }
  const envelope = pickNumber(root, 'received_at_unix_ms', 'event_born_time');
  if (envelope !== undefined) return envelope;
  const born = root.event_born_time;
  if (typeof born === 'string') {
    const parsed = Date.parse(born);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

/** content 在真实事件里是字符串；容错对象/数组（JSON.stringify），避免整条事件被丢弃 */
function pickContent(payload: Record<string, unknown>): string {
  const text = pickString(payload, 'content', 'text', 'body');
  if (text !== undefined) return text;
  const raw = payload.content ?? payload.text ?? payload.body;
  if (raw && typeof raw === 'object') {
    try { return JSON.stringify(raw); } catch { return ''; }
  }
  return '';
}

/** sender 可能是字符串，也可能是对象（{nick/name/sender}） */
function pickSenderName(payload: Record<string, unknown>): string | undefined {
  const direct = pickString(payload, 'sender', 'sender_nick', 'senderNick');
  if (direct !== undefined) return direct;
  const sender = payload.sender;
  if (sender && typeof sender === 'object' && !Array.isArray(sender)) {
    return pickString(sender as Record<string, unknown>, 'nick', 'name', 'sender', 'nickName');
  }
  return undefined;
}

/**
 * 解析一行 NDJSON → 归一化事件。
 * 容错要求（契约 §3.3）：多行 JSON / 非 JSON 日志行一律返回 null，由调用方计数，绝不崩溃。
 */
export function parseEventLine(line: string): DingtalkPersonalEvent | null {
  const text = line.trim();
  if (!text || !text.startsWith('{')) return null;
  const json = tryParseJson(text);
  if (!json) return null;
  const root = json as Record<string, unknown>;
  const payload = extractEventPayload(json);
  if (!payload) return null;

  const headers = (root.headers && typeof root.headers === 'object' && !Array.isArray(root.headers))
    ? root.headers as Record<string, unknown>
    : undefined;
  const messageId = pickString(payload, 'message_id', 'messageId', 'msgId', 'openMessageId');
  // event_type：envelope 根最可靠（type 根字段固定是 "event"，不能拿来当事件类型）
  const eventType = pickString(payload, 'event_type', 'eventType')
    ?? (typeof payload.type === 'string' && payload.type !== 'event' ? payload.type : undefined)
    ?? pickString(root, 'event_type', 'eventType')
    ?? (typeof root.type === 'string' && root.type !== 'event' ? root.type : undefined)
    ?? (headers ? pickString(headers, 'event_type', 'eventType', 'event_type_key') : undefined);
  const eventId = pickString(payload, 'event_id', 'eventId')
    ?? pickString(root, 'event_id', 'eventId');
  if (!messageId) {
    // 非消息事件（审批/待办/撤回/已读回执…）：带出类型即可，映射层会忽略
    return {
      ...(eventType ? { eventType } : {}),
      ...(eventId ? { eventId } : {}),
      messageId: '',
      content: '',
      raw: payload,
    };
  }
  const content = pickContent(payload);
  const createTimeMs = pickTimeMs(payload, root);
  const senderName = pickSenderName(payload);
  const senderOpenDingtalkId = pickString(payload, 'sender_open_dingtalk_id', 'senderOpenDingtalkId');
  const conversationId = pickString(payload, 'conversation_id', 'conversationId', 'openConversationId');

  return {
    ...(eventType ? { eventType } : {}),
    ...(eventId ? { eventId } : {}),
    messageId,
    ...(conversationId ? { conversationId } : {}),
    content,
    ...(createTimeMs ? { createTimeMs } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderOpenDingtalkId ? { senderOpenDingtalkId } : {}),
    raw: payload,
  };
}

/** 事件类型 → 会话类型（个人事件目录里 group/o2o/at/user 的语义不同，见 dws event list） */
export function inferConversationType(eventType: string | undefined): 'group' | 'p2p' {
  const t = (eventType ?? '').toLowerCase();
  if (t.includes('group')) return 'group';
  if (t.includes('o2o')) return 'p2p';
  // `at-me`（被 @）通常发生在群里；`sender`（指定发送人）多数是单聊
  if (t.includes('at')) return 'group';
  if (t.includes('sender') || t.includes('user')) return 'p2p';
  return 'p2p';
}

/**
 * 从消息正文里尽力分辨文件/图片（dws 个人事件的 content 为纯字符串，
 * 文件类消息没有独立字段；如正文是媒体 JSON 则提取元数据，否则按文本处理）。
 */
export function parseMediaContent(content: string): { type: 'file' | 'image'; body: string; attachment?: AttachmentInfo } | undefined {
  const text = content.trim();

  /**
   * 钉钉会把图文消息里的图片回推成「[图片消息] (mediaId=xxx)」这样的占位串。
   * 直接当正文显示就是一串乱码，这里剥掉占位符、把 mediaId 收进附件，
   * 正文只留用户真正写的那句话。
   */
  const placeholder = /\[(图片|文件)消息\]\s*\(\s*mediaId=([^)]+)\)/i.exec(text);
  if (placeholder) {
    const isImage = placeholder[1] === '图片';
    const rest = text.replace(placeholder[0], '').trim();
    return {
      type: isImage ? 'image' : 'file',
      body: rest || (isImage ? '[图片]' : '[文件]'),
      attachment: {
        name: isImage ? '图片' : '文件',
        mimeType: isImage ? 'image/*' : 'application/octet-stream',
        size: 0,
        mediaId: placeholder[2].trim(),
      },
    };
  }

  /**
   * 文件/图片回推的**另一种**模板（实测）：
   *   `[文件] 灰烬之城.docx fileId: 3NwLYZX… 注意：如需下载使用dws drive download命令下载`
   *
   * 与 `[文件消息](mediaId=…)` 是两套文案。不剥掉的话，正文就是这一整串
   * 「fileId + 注意：如需下载…」，正是用户看到的乱码。这里只保留「[文件] 文件名」。
   */
  const taggedFile = /^\[(文件|图片|视频|语音)\]\s*(.+?)\s*fileId\s*[:：]\s*(\S+)/i.exec(text);
  if (taggedFile) {
    const kind = taggedFile[1];
    const name = taggedFile[2].trim();
    const isImage = kind === '图片';
    return {
      type: isImage ? 'image' : 'file',
      body: `[${kind}]${name ? ` ${name}` : ''}`,
      ...(name
        ? { attachment: { name, mimeType: isImage ? 'image/*' : 'application/octet-stream', size: 0 } }
        : {}),
    };
  }

  if (!text.startsWith('{')) return undefined;
  const json = tryParseJson(text);
  if (!json || typeof json !== 'object') return undefined;
  const r = json as Record<string, any>;
  const name = typeof r.fileName === 'string' ? r.fileName : typeof r.name === 'string' ? r.name : '';
  const mediaId = typeof r.mediaId === 'string' ? r.mediaId : typeof r.media_id === 'string' ? r.media_id : '';
  const size = Number(r.fileSize ?? r.size ?? 0);
  const looksImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) || /image/i.test(String(r.msgType ?? r.type ?? ''));
  if (name || mediaId) {
    const label = looksImage ? '图片' : '文件';
    return {
      type: looksImage ? 'image' : 'file',
      body: `[${label}]${name ? ` ${name}` : ''}`,
      ...(name
        ? { attachment: { name, mimeType: 'application/octet-stream', size: Number.isFinite(size) && size > 0 ? size : 0 } }
        : {}),
    };
  }
  return undefined;
}

export interface MapPersonalEventOptions {
  /** 本人 openDingTalkId：已知时过滤自己发出的消息（避免自环） */
  selfOpenDingtalkId?: string;
  /** 单测注入时钟 */
  now?: () => number;
}

/**
 * 个人事件 → 统一消息。
 * 非消息事件（无 message_id）返回 null；自己发的消息（sender == self）返回 null。
 * 契约：externalId = `dingtalk:<openMessageId>`，receivedAs='user'。
 */
export function mapPersonalEventToMessage(
  evt: DingtalkPersonalEvent,
  opts: MapPersonalEventOptions = {},
): UnifiedMessage | null {
  if (!evt.messageId) return null;
  if (opts.selfOpenDingtalkId && evt.senderOpenDingtalkId === opts.selfOpenDingtalkId) return null;

  const now = opts.now ? opts.now() : Date.now();
  const createdAt = evt.createTimeMs ? new Date(evt.createTimeMs).toISOString() : new Date(now).toISOString();
  const media = parseMediaContent(evt.content);
  const senderId = evt.senderOpenDingtalkId || 'unknown';
  const conversationType = inferConversationType(evt.eventType);

  const msg: UnifiedMessage = {
    traceId: genTraceId(),
    platform: Platform.DINGTALK,
    externalId: `dingtalk:${evt.messageId}`,
    sender: { id: senderId, name: evt.senderName || senderId },
    ...(evt.conversationId
      ? { conversation: { id: evt.conversationId, type: conversationType } }
      : {}),
    type: media?.type ?? 'text',
    body: media?.body ?? evt.content,
    ...(media?.attachment ? { attachments: [media.attachment] } : {}),
    receivedAs: 'user',
    status: MsgStatus.RECEIVED,
    createdAt,
    updatedAt: createdAt,
  };
  // 会话标题：event schema 未提供（group_updated 事件才有），不臆造
  /**
   * 图片消息只有 mediaId、没有文件名，界面上显示成一个「图片」孤零零的卡片。
   * 用接收时间补一个有信息量的名字（图片-20261114-130803.jpg），
   * 至少能按时间对上手机里那张图。
   */
  if (msg.attachments?.length) {
    const t = new Date(createdAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
    msg.attachments = msg.attachments.map((a) =>
      a.mediaId && (a.name === '图片' || a.name === '文件')
        ? { ...a, name: `${a.name}-${stamp}` }
        : a,
    );
  }
  return msg;
}

// ---------------------------------------------------------------------------
// 发送参数构造 / 结果映射
// ---------------------------------------------------------------------------

/** 把发送目标转成 dws 的目标参数（三选一，按可靠性排序：conversation > openDingtalkId > userId） */
export function buildSendTargetArgs(target: DwsSendTarget): string[] {
  if (target.conversationId) return ['--conversation-id', target.conversationId];
  if (target.openDingtalkId) return ['--open-dingtalk-id', target.openDingtalkId];
  if (target.userId) return ['--user', target.userId];
  throw new DingtalkPersonalError(
    '钉钉本人身份发送缺少目标会话：请提供 conversationId（群聊）或 openDingtalkId（单聊对端）。',
    'validation',
  );
}

/**
 * 构造 `dws chat message send` 参数。
 * 注意：**不传 --title**（避免平台用标题覆盖正文展示，lead 要求）；
 * `--ai-tag` 保持 dws 默认 true —— 本人身份发出的消息带平台 AI 角标，是平台透明标注，不隐藏。
 */
export function buildSendArgs(input: {
  target: DwsSendTarget;
  text?: string;
  filePath?: string;
  idempotencyKey?: string;
}): string[] {
  const args = ['chat', 'message', 'send', ...buildSendTargetArgs(input.target)];
  if (input.filePath) {
    args.push('--msg-type', 'file', '--file', input.filePath);
    // 文件消息允许附带说明文本（平台限制：file 消息正文即文件名，故不追加 --content）
  } else {
    args.push('--content', input.text ?? '');
  }
  if (input.idempotencyKey) args.push('--idempotency-key', input.idempotencyKey);
  args.push('-f', 'json');
  return args;
}

/** 构造 `dws chat message reply` 参数（引用回复：需要原消息 ID + 原发送者 openDingTalkId） */
export function buildReplyArgs(input: {
  conversationId: string;
  refMessageId: string;
  refSenderOpenDingtalkId: string;
  text: string;
  idempotencyKey?: string;
}): string[] {
  const args = [
    'chat', 'message', 'reply',
    '--group', input.conversationId,
    '--ref-msg-id', input.refMessageId,
    '--ref-sender', input.refSenderOpenDingtalkId,
    '--content', input.text,
  ];
  if (input.idempotencyKey) args.push('--uuid', input.idempotencyKey);
  args.push('-f', 'json');
  return args;
}

/**
 * 解析 dws 发送结果。
 * 成功：`{ok:true,outcome:'success',data:{...}}`（dry-run 也是 ok:true，但 dry_run:true —— 绝不能当成功）；
 * 失败：`{ok:false,outcome:'failure',error:{...}}` 或 `{error:{category,code,message}}`。
 */
export function mapSendResultJson(result: DwsRunResult, commandLabel = 'chat message send'): DwsSendOutcome {
  const text = result.stdout.trim();
  const json = tryParseJson(text) as Record<string, any> | undefined;
  const jsonOk = json?.ok === true || json?.success === true || json?.outcome === 'success';
  const dryRun = json?.dry_run === true || json?.data?.dry_run === true;

  /**
   * 钉钉对 uuid 做 24h 去重：同一份内容再次提交时返回
   * `sendPersonalMessageByServerPush error: Request is repeated with uuid '...'`。
   * 这代表上一次请求已被平台接受，按幂等命中处理（返回成功、无新回执），
   * 否则用户会看到「假失败」，然后不断重试、每次都失败。
   */
  if (/Request is repeated with uuid/i.test(`${result.stdout}\n${result.stderr}`)) {
    return { ok: true };
  }

  if (result.code !== 0 || !jsonOk) {
    const info = classifyDwsFailure(
      { ...result, code: result.code === 0 ? 1 : result.code },
      commandLabel,
    );
    throw new DingtalkPersonalError(info.message, info.kind, result.code);
  }
  if (dryRun) {
    // 防御：真实发送路径绝不允许 dry-run 结果被当成已发送
    throw new DingtalkPersonalError(
      'dws 返回的是 dry-run 预览结果（未真实发送），已按失败处理，不会写入「已发送」。',
      'unknown',
      result.code,
    );
  }
  const data = json?.data ?? json;
  const receipt = findReceipt(data);
  return { ok: true, ...(receipt ? { platformReply: receipt } : {}) };
}

/** 在深层 JSON 里找平台回执（openTaskId / openMessageId / taskId / processQueryKey） */
export function findReceipt(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === 'object') {
    const r = value as Record<string, unknown>;
    for (const key of ['openTaskId', 'openMessageId', 'taskId', 'messageId', 'processQueryKey', 'id']) {
      const v = r[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    for (const v of Object.values(r)) {
      const found = findReceipt(v, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 默认执行器（child_process）
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 生产执行器：spawn 子进程并收集 stdout/stderr。
 * 超时：先 SIGTERM，2s 后 SIGKILL；Windows 上 SIGTERM 等价 TerminateProcess，够用。
 * 绝不把子进程输出写进日志（可能含敏感信息），只有调用方显式格式化日志时才用。
 */
export function createSpawnRunner(bin?: string): DwsRunner {
  const { file, prefixArgs } = parseDwsBin(bin);
  return (args, opts = {}) => new Promise<DwsRunResult>((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(file, [...prefixArgs, ...args], {
        cwd: MONOREPO_ROOT,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', spawnError: (e as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED' });
      return;
    }

    const finish = (result: DwsRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        stderr.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({ code: -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), spawnError: e.code ?? 'SPAWN_FAILED' });
    });
    const onAbort = (): void => {
      try { child.kill(); } catch { /* 已退出 */ }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code) => {
      finish({
        code: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(timedOut ? { timedOut: true, code: DWS_EXIT_TIMEOUT } : {}),
      });
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    }, timeoutMs);
    const hardTimer = setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }
    }, timeoutMs + 2_000);
    // 定时器不应阻止进程退出
    killTimer.unref?.();
    hardTimer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface DingtalkPersonalClientOptions {
  /** DWS_BIN 原样（可带参数）；默认取 config.identity.dingtalk.bin */
  bin?: string;
  /** DWS_PROFILE；空则不追加 --profile */
  profile?: string;
  authTimeoutMs?: number;
  sendTimeoutMs?: number;
  /** 单测注入执行器 */
  runner?: DwsRunner;
  /** 单测注入登录子进程 spawn（生产不传，走 child_process.spawn） */
  spawnImpl?: (file: string, args: string[], options: Record<string, unknown>) => any;
  /** 单测注入时钟 */
  now?: () => number;
  statusCacheMs?: number;
  /**
   * 单测/特殊环境：覆盖「等待登录 hint」的窗口时长（毫秒）。
   * 不传时按链路默认：device 2.5s、browser 6s。
   */
  loginHintWaitMs?: number;
}

export class DingtalkPersonalClient {
  private readonly bin: string;
  private readonly profile: string;
  private readonly authTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly runner: DwsRunner;
  private readonly spawnImpl?: (file: string, args: string[], options: Record<string, unknown>) => any;
  private readonly now: () => number;
  private readonly statusCacheMs: number;
  /** 覆盖等待登录 hint 的窗口（未设置时按 device/browser 默认值） */
  private readonly loginHintWaitMsOverride?: number;

  private versionCache?: { version?: string; error?: string; at: number };
  private statusCache?: DwsAuthStatus;
  private statusInflight?: Promise<DwsAuthStatus>;
  /**
   * dws 串行闸门。
   *
   * dws 的登录态与配置存档只允许一个进程同时读写：身份探测（每 30–60s 一次）
   * 与发送并发时，会读到 `load access token: reading secure data file`，
   * 进而被翻译成「本人身份未登录」——用户重新登录也没用。
   * 这里把同进程内所有 dws 调用排成队列；登录会话走独立 spawn，不受队列阻塞。
   */
  private queueTail: Promise<unknown> = Promise.resolve();
  /** 当前登录会话（同一时刻最多一个 login child） */
  private loginSession?: LoginSession;
  /** 本人 openDingTalkId 缓存（用于过滤自己发出的消息；取不到就不过滤） */
  private selfIdCache?: { id?: string; at: number };
  /** 登录会话结束回调（exit / 过期 / 失败），供接收通道协调器感知运行期登录完成 */
  private loginFinishedHandler?: (info: { mode: LoginChannel; loginId: string; exitCode?: number | null }) => void;

  constructor(opts: DingtalkPersonalClientOptions = {}) {
    this.bin = opts.bin ?? 'dws';
    this.profile = (opts.profile ?? '').trim();
    this.authTimeoutMs = opts.authTimeoutMs ?? 15_000;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 30_000;
    this.runner = opts.runner ?? createSpawnRunner(this.bin);
    this.spawnImpl = opts.spawnImpl;
    this.now = opts.now ?? Date.now;
    this.statusCacheMs = opts.statusCacheMs ?? DEFAULT_STATUS_CACHE_MS;
    this.loginHintWaitMsOverride = opts.loginHintWaitMs;
  }

  /** 可执行文件 + 前置参数（日志里只显示文件名，不显示敏感参数） */
  private command(): { file: string; prefixArgs: string[] } {
    return parseDwsBin(this.bin);
  }

  /**
   * 人类可读命令（用于 hint / 文档）：DWS_BIN 带参数时一并保留，
   * 例如 DWS_BIN=`node scripts/fake-dws.mjs` → `node <绝对路径>scripts/fake-dws.mjs`，
   * 否则登录提示会变成无意义的 `node auth login`。
   */
  commandLabel(): string {
    const { file, prefixArgs } = this.command();
    return [file, ...prefixArgs].join(' ');
  }

  /** 用户需要在本机终端执行的登录命令（含 profile 时一起给） */
  loginCommand(): string {
    const base = `${this.commandLabel()} auth login`;
    return this.profile ? `${base} --profile ${this.profile}` : base;
  }

  /** 追加全局参数：--profile（在子命令之后追加，cobra 全局 flag 接受任意位置） */
  private withGlobal(args: string[]): string[] {
    return this.profile ? [...args, '--profile', this.profile] : args;
  }

  /** 执行一次 dws（自动补 --profile；超时由调用方给；串行执行避免抢 token 存档） */
  async run(args: string[], opts: DwsRunOptions = {}): Promise<DwsRunResult> {
    return this.enqueue(() => this.runner(this.withGlobal(args), opts));
  }

  /** 串行执行：前一个失败不能阻塞后续任务 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queueTail.then(task, task);
    this.queueTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** `dws version`：进程内缓存（二进制不会中途变版本）；失败返回 undefined */
  async version(force = false): Promise<{ version?: string; error?: string }> {
    if (!force && this.versionCache && this.now() - this.versionCache.at < 10 * 60_000) {
      return { ...(this.versionCache.version ? { version: this.versionCache.version } : {}), ...(this.versionCache.error ? { error: this.versionCache.error } : {}) };
    }
    const r = await this.runStatic(['version'], this.authTimeoutMs);
    const version = parseVersion(r.stdout, r.stderr);
    const info = r.spawnError === 'ENOENT'
      ? { error: classifyDwsFailure(r, this.commandLabel()).message }
      : version
        ? { version }
        : { error: '无法从 dws version 输出中解析版本号' };
    this.versionCache = { ...info, at: this.now() };
    return info;
  }

  private async runStatic(args: string[], timeoutMs: number): Promise<DwsRunResult> {
    // 同样走队列：auth status / version 也是真实子进程，会和发送抢同一份 token 存档
    return this.enqueue(() => this.runner(this.withGlobal(args), { timeoutMs }));
  }

  /**
   * 只读探测 `dws auth status`（实测 1–3s，含网络与版本检查）。
   * 单飞 + 30s 缓存：账号页/健康检查并发请求只触发一次真实调用。
   */
  async authStatus(opts: { force?: boolean } = {}): Promise<DwsAuthStatus> {
    const cached = this.statusCache;
    if (!opts.force && cached && this.now() - cached.checkedAt < this.statusCacheMs) return cached;
    if (this.statusInflight) return this.statusInflight;
    this.statusInflight = this.probeAuthStatus().finally(() => {
      this.statusInflight = undefined;
    });
    return this.statusInflight;
  }

  /**
   * 同步读取上一次探测结果（identity 视图不阻塞请求用）。
   * 无缓存时返回 undefined，由调用方按「探测中/unavailable」展示并触发 warm()。
   */
  lastKnownStatus(): DwsAuthStatus | undefined {
    return this.statusCache;
  }

  /** 异步预热：没有缓存/已过期就后台探一次（不阻塞；不抛错） */
  warmStatus(): Promise<DwsAuthStatus> {
    return this.authStatus().catch((e: unknown) => ({
      available: false,
      authenticated: false,
      checkedAt: this.now(),
      error: e instanceof Error ? e.message : String(e),
    }));
  }

  /** 是否会话正在进行（登录子进程还活着且未过期） */
  loginInProgress(): boolean {
    const session = this.rawLoginSession();
    return Boolean(session && this.sessionAlive(session));
  }

  /**
   * 供 /status 恢复弹窗状态（绝不含 token）；无会话或已过期返回 undefined。
   * 前端打开弹窗时先读它，避免「重新生成设备码」把用户正在用的码作废。
   */
  currentLogin(): {
    loginId: string;
    mode: LoginChannel;
    requestedMode: LoginMode;
    url?: string;
    code?: string;
    expiresInSec?: number;
    expiresAt?: string;
    instructions: string;
    command: string;
    inProgress: boolean;
  } | undefined {
    const session = this.rawLoginSession();
    if (!session) return undefined;
    return {
      loginId: session.loginId,
      mode: session.mode,
      requestedMode: session.requestedMode,
      ...(session.url ? { url: session.url } : {}),
      ...(session.code ? { code: session.code } : {}),
      ...(session.expiresInSec ? { expiresInSec: session.expiresInSec } : {}),
      ...(session.expiresAtMs ? { expiresAt: new Date(session.expiresAtMs).toISOString() } : {}),
      instructions: session.instructions,
      command: session.command,
      inProgress: this.sessionAlive(session),
    };
  }

  /** 注册登录会话结束回调（成功退出/过期/失败都会触发）——接收通道协调器据此感知运行期登录完成 */
  setLoginFinishedHandler(handler: (info: { mode: LoginChannel; loginId: string; exitCode?: number | null }) => void): void {
    this.loginFinishedHandler = handler;
  }

  /** 当前有效会话（过期则顺手清理，避免旧设备码继续展示） */
  private rawLoginSession(): LoginSession | undefined {
    const session = this.loginSession;
    if (!session || session.finished) return undefined;
    if (session.expiresAtMs !== undefined && this.now() >= session.expiresAtMs) {
      this.finishLoginSession(session, '登录有效期已过');
      return undefined;
    }
    return session;
  }

  private sessionAlive(session: LoginSession): boolean {
    if (session.finished || !session.child) return false;
    if (session.exitCode !== undefined && session.exitCode !== null) return false;
    if (session.child.killed) return false;
    return true;
  }

  /** 结束并清理一个登录会话：清定时器、SIGTERM 子进程、清状态缓存、通知协调器 */
  private finishLoginSession(session: LoginSession, reason: string): void {
    if (session.finished) return;
    session.finished = true;
    session.hintResolve?.();
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
    }
    const child = session.child;
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    }
    if (this.loginSession === session) this.loginSession = undefined;
    // 登录进程结束后登录态一定变了：清缓存，下一次 /status 会重新探测
    this.invalidateStatus();
    console.log(`[dingtalk-login] 登录会话已清理（${reason}）`);
    try {
      this.loginFinishedHandler?.({ mode: session.mode, loginId: session.loginId, exitCode: session.exitCode });
    } catch { /* 回调异常不影响主流程 */ }
  }

  private killLoginSession(reason: string): void {
    if (this.loginSession) this.finishLoginSession(this.loginSession, reason);
  }

  /**
   * 启动登录（后台 spawn，接口立即返回操作指引，绝不阻塞 HTTP）。
   *
   *  - auto（默认）：**优先浏览器 loopback**——`dws auth login -f json -y`（不加 --no-browser，
   *    dws 会起 127.0.0.1 本地回调并自动打开浏览器，OAuth URL 同时打到 stderr 供 /status 下发）；
   *    启动失败则自动回退设备码（instructions 里如实说明）；
   *  - browser：只走浏览器 loopback；
   *  - device：只走设备码（远程/无浏览器；默认 900s 有效期倒计时）。
   *
   * 生命周期：同一时刻只保留一个 login child；重复调用且模式一致 → 返回现有指引；
   * 模式不同或 force=true → 杀掉旧会话再起新的。
   */
  async startLogin(mode: LoginMode = 'auto', opts: { force?: boolean } = {}): Promise<DwsLoginStart> {
    const version = await this.version();
    if (version.error && !version.version) {
      throw new DingtalkPersonalError(version.error, 'not-installed');
    }

    const existing = this.rawLoginSession();
    if (existing && !opts.force) {
      const sameMode = mode === 'auto' || existing.mode === mode;
      if (sameMode && this.sessionAlive(existing)) return this.toStartResult(existing);
    }
    this.killLoginSession(opts.force ? '用户强制重新发起登录' : '切换登录方式');
    this.invalidateStatus();

    if (mode === 'device') return this.spawnLoginSession('device', 'device');

    const browser = await this.spawnLoginSession('browser', mode);
    if (mode === 'browser' || browser.started || this.loginInProgress()) return browser;

    // auto：浏览器 loopback 未能启动 → 回退设备码（指引里如实说明，不假装浏览器可用）
    const fallback = await this.spawnLoginSession('device', 'auto');
    return {
      ...fallback,
      requestedMode: 'auto',
      instructions: `浏览器登录未能启动（${browser.instructions}）已自动改用设备码登录。${fallback.instructions}`,
    };
  }

  private loginArgs(mode: LoginChannel): string[] {
    // browser：不传 --no-browser，让 dws 自动打开本机浏览器；URL 同时打到 stderr 供 /status 下发
    return mode === 'device'
      ? ['auth', 'login', '--device', '--no-browser', '-f', 'json', '-y']
      : ['auth', 'login', '-f', 'json', '-y'];
  }

  /** 终端等价命令（含 profile） */
  private loginCommandFor(mode: LoginChannel): string {
    const device = mode === 'device' ? ' --device' : '';
    const profile = this.profile ? ` --profile ${this.profile}` : '';
    return `${this.commandLabel()} auth login${device}${profile}`;
  }

  private async spawnLoginSession(mode: LoginChannel, requestedMode: LoginMode): Promise<DwsLoginStart> {
    const startedAt = this.now();
    const session: LoginSession = {
      loginId: randomUUID(),
      requestedMode,
      mode,
      startedAt,
      command: this.loginCommandFor(mode),
      instructions: '',
      output: { out: '', err: '' },
      finished: false,
    };
    this.loginSession = session;

    const { file, prefixArgs } = this.command();
    const fullArgs = this.withGlobal([...prefixArgs, ...this.loginArgs(mode)]);
    const spawnImpl = this.spawnImpl ?? spawn;
    let child: any;
    try {
      child = spawnImpl(file, fullArgs, {
        cwd: MONOREPO_ROOT,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      session.finished = true;
      this.loginSession = undefined;
      throw new DingtalkPersonalError(
        `启动 dws 登录失败（${this.commandLabel()}）：${(e as Error).message}。可在本机终端手动执行 ${this.loginCommand()}。`,
        'unknown',
      );
    }
    session.child = child;

    // 窗口等待器：解析到 hint / 子进程退出 / 超时，三者任一先到
    let notifyWindow: (() => void) | undefined;
    const windowDone = new Promise<void>((resolve) => { notifyWindow = resolve; });
    session.hintResolve = () => notifyWindow?.();

    const consume = (which: 'out' | 'err', chunk: unknown): void => {
      if (session.finished) return;
      const text = String(chunk);
      session.output[which] = (session.output[which] + text).slice(-12000);
      const hint = extractLoginHint(session.output.out, session.output.err);
      if (hint) {
        if (hint.url && !session.url) session.url = hint.url;
        if (hint.code && !session.code) session.code = hint.code;
        if (hint.expiresInSec && !session.expiresInSec) session.expiresInSec = hint.expiresInSec;
        session.hintResolve?.();
      }
    };
    child.stdout?.on('data', (chunk: unknown) => consume('out', chunk));
    child.stderr?.on('data', (chunk: unknown) => consume('err', chunk));
    child.once?.('exit', (code: number | null) => {
      session.exitCode = typeof code === 'number' ? code : -1;
      session.hintResolve?.();
      if (!session.finished) {
        // 运行期退出（用户完成授权 / 失败 / 被外部杀）：清理会话 + 通知协调器自动启动接收通道
        const reason = session.exitCode === 0 ? '登录进程已退出（通常表示授权完成）' : `登录进程退出（code=${session.exitCode}）`;
        this.finishLoginSession(session, reason);
      }
    });
    child.once?.('error', (err: Error) => {
      session.exitCode = 1;
      session.hintResolve?.();
      if (!session.finished) this.finishLoginSession(session, `登录进程错误：${err?.message ?? 'unknown'}`);
    });

    const waitMs = this.loginHintWaitMsOverride
      ?? (mode === 'browser' ? BROWSER_LOGIN_HINT_WAIT_MS : LOGIN_HINT_WAIT_MS);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      void windowDone.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    const alive = this.sessionAlive(session);
    const exited = session.exitCode;

    // 启动失败：整理中文指引并清理会话（auto 会据此回退 device）
    if (!alive && exited !== undefined && exited !== 0) {
      const failure = this.loginFailureResult(session);
      this.finishLoginSession(session, `登录启动失败（code=${exited}）`);
      return failure;
    }

    // 有效期：能解析到 expires 用解析值；device 默认 900s、browser 默认 600s（界面倒计时用）
    session.expiresInSec = session.expiresInSec ?? (mode === 'device' ? DEFAULT_DEVICE_EXPIRES_SEC : DEFAULT_BROWSER_EXPIRES_SEC);
    session.expiresAtMs = startedAt + session.expiresInSec * 1000;
    session.instructions = this.buildLoginInstructions(session);
    this.armLoginExpiry(session);

    const result = this.toStartResult(session);
    if (!alive && exited === 0) {
      // 秒完成（例如已授权/测试桩）：清理会话，提示前端刷新状态
      this.finishLoginSession(session, '登录进程已正常退出');
      return {
        ...result,
        started: true,
        instructions: `登录进程已结束（通常表示授权完成）：请点「我已登录，刷新状态」确认。${result.instructions}`,
      };
    }
    return result;
  }

  /** 过期定时清理（unref 不阻塞进程退出）；实际过期也由 rawLoginSession 懒判定兜底 */
  private armLoginExpiry(session: LoginSession): void {
    if (session.expiresAtMs === undefined) return;
    const delay = Math.max(0, session.expiresAtMs - this.now());
    session.expiryTimer = setTimeout(() => {
      if (this.loginSession === session) this.finishLoginSession(session, '登录有效期已过');
    }, delay);
    session.expiryTimer.unref?.();
  }

  private buildLoginInstructions(session: LoginSession): string {
    const minutes = Math.max(1, Math.round((session.expiresInSec ?? 0) / 60));
    if (session.mode === 'device') {
      const target = session.code
        ? `授权码：${session.code}${session.url ? `；授权地址：${session.url}` : ''}。`
        : (session.url ? `授权地址：${session.url}。` : '');
      return `已启动钉钉设备码登录：${target}请打开授权地址输入设备码并确认（有效期约 ${minutes} 分钟，过期请点「重新获取授权码」）。`
        + '完成后回到本页点「我已登录，刷新状态」。'
        + (session.code || session.url ? '' : ` 若看不到授权码，请在本机终端执行 ${this.loginCommandFor('device')}。`);
    }
    return '已尝试打开浏览器（若未弹出请点下方授权链接）。请在运行 LinkHub 的这台机器上用钉钉扫码/账号登录并确认授权，'
      + `完成后回到本页点「我已登录，刷新状态」（约 ${minutes} 分钟内有效）。`
      + '注意：浏览器授权地址是 127.0.0.1 本机回调，必须在这台机器上打开；服务器/SSH/容器请改用设备码登录。';
  }

  private loginFailureResult(session: LoginSession): DwsLoginStart {
    const text = `${session.output.out}\n${session.output.err}`;
    const hints = {
      ...(session.url ? { url: session.url } : {}),
      ...(session.code ? { code: session.code } : {}),
      loginId: session.loginId,
      requestedMode: session.requestedMode,
    };
    if (/unknown flag|unknown shorthand|flag provided but not defined|invalid argument/i.test(text)) {
      return {
        started: false,
        mode: 'browser',
        command: this.loginCommand(),
        instructions: `当前 dws 版本不支持${session.mode === 'device' ? '设备码' : '该'}登录方式，请在本机终端执行 ${this.loginCommand()} 完成浏览器授权；`
          + '完成后回到本页点「我已登录，刷新状态」。',
        ...hints,
      };
    }
    const info = classifyDwsFailure(
      { code: session.exitCode ?? 1, stdout: session.output.out, stderr: session.output.err },
      `${this.commandLabel()} auth login`,
    );
    // dws 配置目录不可写（~/.dws/.data.lock 被拒）时给可执行的修复方向
    const lockHint = /data\.lock|Access is denied|permission denied/i.test(info.message)
      ? '（原因看起来是 dws 配置目录不可写：先删掉 %USERPROFILE%\.dws\.data.lock，'
        + '或在启动前设置 DWS_CONFIG_DIR 指向一个可写目录，再重试登录）'
      : '';

    return {
      started: false,
      mode: session.mode,
      command: session.command,
      instructions: `登录未能自动启动（${info.kind === 'not-logged-in' ? '需要你本人授权' : info.kind === 'permission' ? '企业侧未开启 CLI 访问' : 'dws 返回错误'}）：`
        + `${info.message}${lockHint} 也可在本机终端手动执行 ${this.loginCommand()}。`,
      ...hints,
    };
  }

  private toStartResult(session: LoginSession): DwsLoginStart {
    return {
      started: this.sessionAlive(session),
      mode: session.mode,
      requestedMode: session.requestedMode,
      command: session.command,
      instructions: session.instructions,
      loginId: session.loginId,
      ...(session.url ? { url: session.url } : {}),
      ...(session.code ? { code: session.code } : {}),
      ...(session.expiresInSec ? { expiresInSec: session.expiresInSec } : {}),
      ...(session.expiresAtMs ? { expiresAt: new Date(session.expiresAtMs).toISOString() } : {}),
    };
  }

  private async probeAuthStatus(): Promise<DwsAuthStatus> {
    const checkedAt = this.now();
    // 先判可执行文件存在性：ENOENT 时不显示「未登录」，而是「未安装」，提示完全不同
    const r = await this.runStatic(['auth', 'status', '--readonly', '--format', 'json'], this.authTimeoutMs);
    if (r.spawnError === 'ENOENT') {
      const status: DwsAuthStatus = {
        available: false,
        authenticated: false,
        checkedAt,
        error: classifyDwsFailure(r, this.commandLabel()).message,
      };
      this.statusCache = status;
      return status;
    }
    if (r.timedOut || r.spawnError) {
      const status: DwsAuthStatus = {
        available: true,
        authenticated: false,
        checkedAt,
        error: classifyDwsFailure(r, `${this.commandLabel()} auth status`).message,
      };
      this.statusCache = status;
      return status;
    }
    const parsed = parseAuthStatusJson(r.stdout, r.stderr);
    if (!parsed.authenticated && r.code !== 0) {
      // 非 0 退出且未登录：保留原始「未登录」语义 + 可操作提示
      const info = classifyDwsFailure(r, `${this.commandLabel()} auth status`);
      const status: DwsAuthStatus = {
        available: true,
        authenticated: false,
        checkedAt,
        ...(parsed.message ? { message: parsed.message } : {}),
        error: info.message,
      };
      this.statusCache = status;
      return status;
    }
    const version = parsed.version ?? (await this.version()).version;
    const status: DwsAuthStatus = {
      available: true,
      authenticated: parsed.authenticated,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
      ...(version ? { version } : {}),
      ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
      ...(parsed.refreshExpiresAt ? { refreshExpiresAt: parsed.refreshExpiresAt } : {}),
      ...(parsed.userName ? { userName: parsed.userName } : {}),
      ...(parsed.corpName ? { corpName: parsed.corpName } : {}),
      ...(parsed.tokenValid !== undefined ? { tokenValid: parsed.tokenValid } : {}),
      ...(parsed.refreshTokenValid !== undefined ? { refreshTokenValid: parsed.refreshTokenValid } : {}),
    };
    this.statusCache = status;
    return status;
  }

  /** 清缓存（login/logout 后调用，让账号页立刻反映新状态） */
  invalidateStatus(): void {
    this.statusCache = undefined;
    this.selfIdCache = undefined;
  }

  /** `dws profile list`：取展示名（失败返回空数组，不阻塞身份视图） */
  async profiles(): Promise<DwsProfile[]> {
    const r = await this.runStatic(['profile', 'list', '--format', 'json'], this.authTimeoutMs);
    if (r.code !== 0) return [];
    return parseProfileListJson(r.stdout);
  }

  /** 注销：dws auth logout；随后清缓存，账号页立刻显示未连接 */
  async logout(): Promise<void> {
    this.killLoginSession('用户注销，取消进行中的登录');
    const r = await this.runStatic(['auth', 'logout'], this.authTimeoutMs);
    this.invalidateStatus();
    if (r.code !== 0 && r.spawnError !== 'ENOENT' && !r.timedOut) {
      const info = classifyDwsFailure(r, `${this.commandLabel()} auth logout`);
      // 未登录时注销按成功处理（幂等语义），其余错误如实报
      if (info.kind !== 'not-logged-in') throw new DingtalkPersonalError(info.message, info.kind, r.code);
    }
    if (r.spawnError === 'ENOENT') {
      throw new DingtalkPersonalError(
        classifyDwsFailure(r, this.commandLabel()).message,
        'not-installed',
      );
    }
  }

  /** 以本人身份发文本（幂等键由消息中枢给，dws 侧 24h 内不重复发送） */
  async sendText(input: {
    target: DwsSendTarget;
    text: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<DwsSendOutcome> {
    const args = buildSendArgs({ target: input.target, text: input.text, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
    const r = await this.run(args, { timeoutMs: this.sendTimeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
    return mapSendResultJson(r, `${this.commandLabel()} chat message send`);
  }

  /** 以本人身份发本地文件（附件先落临时文件，发完由调用方删除） */
  async sendFile(input: {
    target: DwsSendTarget;
    filePath: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<DwsSendOutcome> {
    const args = buildSendArgs({
      target: input.target,
      filePath: input.filePath,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    const r = await this.run(args, { timeoutMs: this.sendTimeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
    return mapSendResultJson(r, `${this.commandLabel()} chat message send --msg-type file`);
  }

  /**
   * 下载消息里的媒体（图片/文件）到本地。
   * 钉钉个人事件只回推 mediaId，要真正显示成图片必须先换成本地文件。
   */
  async downloadMedia(input: {
    mediaId: string;
    messageId: string;
    conversationId: string;
    outputPath: string;
  }): Promise<void> {
    const r = await this.run([
      'chat', 'message', 'download-media',
      '--type', 'mediaId',
      '--resource-id', input.mediaId,
      '--message-id', input.messageId,
      '--open-conversation-id', input.conversationId,
      '--output', input.outputPath,
    ], { timeoutMs: 45_000 });
    if (r.code !== 0) {
      const info = classifyDwsFailure(r, `${this.commandLabel()} chat message download-media`);
      throw new DingtalkPersonalError(info.message, info.kind, r.code);
    }
  }

  /** 引用回复（事件里同时有 openMessageId + senderOpenDingTalkId 时用，语义更明确） */
  async reply(input: {
    conversationId: string;
    refMessageId: string;
    refSenderOpenDingtalkId: string;
    text: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<DwsSendOutcome> {
    const args = buildReplyArgs({
      conversationId: input.conversationId,
      refMessageId: input.refMessageId,
      refSenderOpenDingtalkId: input.refSenderOpenDingtalkId,
      text: input.text,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    const r = await this.run(args, { timeoutMs: this.sendTimeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
    return mapSendResultJson(r, `${this.commandLabel()} chat message reply`);
  }

  /**
   * 取本人 openDingTalkId（best-effort）：`dws contact user get-self -f json`。
   * 取不到返回 undefined（不阻断订阅，只是无法过滤自己发出的消息）。
   */
  async getSelfOpenDingtalkId(force = false): Promise<string | undefined> {
    const cached = this.selfIdCache;
    if (!force && cached && this.now() - cached.at < 10 * 60_000) return cached.id;
    const r = await this.runStatic(['contact', 'user', 'get-self', '-f', 'json'], this.authTimeoutMs);
    const id = r.code === 0 ? parseSelfProfileJson(r.stdout).openDingtalkId : undefined;
    this.selfIdCache = { ...(id ? { id } : {}), at: this.now() };
    return id;
  }

  /** 同步读取本人 openDingTalkId 缓存（事件子进程启动时用，不阻塞） */
  peekSelfOpenDingtalkId(): string | undefined {
    return this.selfIdCache?.id;
  }

  /** `dws event list` 可用性探测（doctor 用，只读） */
  async eventListAvailable(): Promise<{ ok: boolean; detail: string }> {
    const r = await this.runStatic(['event', 'list'], this.authTimeoutMs);
    if (r.spawnError) {
      return { ok: false, detail: classifyDwsFailure(r, this.commandLabel()).message };
    }
    const ok = r.code === 0 && /user_im_message_receive|EVENT_KEY/i.test(r.stdout);
    return {
      ok,
      detail: ok
        ? 'dws event list 可用：已看到本人 IM 事件目录'
        : `dws event list 未返回事件目录（exit=${r.code}）：${firstErrorMessage(r.stderr || r.stdout) ?? '请检查 dws 版本'}`,
    };
  }

  /** 停掉登录子进程（服务关闭时调用，避免残留） */
  dispose(): void {
    this.killLoginSession('服务关闭');
  }
}

/**
 * 选择「用户该打开哪个授权链接」：
 *  1) loopback OAuth（浏览器登录：URL 里含 /oauth2/auth 或 redirect_uri=127.0.0.1）；
 *  2) 设备码验证页（含 device/verify 且带 user_code/code 参数）；
 *  3) 兜底取第一个 http(s) 链接。
 * 同时从 URL query（user_code=）或文本里提取设备码。
 */
export function pickLoginUrl(text: string): { url?: string; code?: string } {
  const matches = (text.match(/https?:\/\/[^\s"'<>]+/g) ?? [])
    .map((u) => u.replace(/[.,;)\]}>"']+$/g, ''))
    .filter(Boolean);
  const isLoopbackOAuth = (u: string): boolean => /\/oauth2\/auth\b/i.test(u) || /redirect_uri=[^&]*127\.0\.0\.1/i.test(u);
  const isDeviceVerify = (u: string): boolean => /(device|verify)/i.test(u) && /[?&](user_code|code)=/i.test(u);
  const chosen = matches.find(isLoopbackOAuth) ?? matches.find(isDeviceVerify) ?? matches[0];
  let code: string | undefined;
  if (chosen) {
    const fromUrl = chosen.match(/[?&]user_code=([^&#\s]+)/i);
    if (fromUrl) {
      try { code = decodeURIComponent(fromUrl[1]!); } catch { code = fromUrl[1]; }
    }
  }
  return { ...(chosen ? { url: chosen } : {}), ...(code ? { code } : {}) };
}

/**
 * 解析登录有效期（秒）。dws 设备流常见文案：「授权码将在 900 秒后过期」；
 * 也兼容「N 分钟后过期」与 JSON 里的 expires_in / expiresIn。
 */
export function parseLoginExpirySec(text: string): number | undefined {
  const patterns: [RegExp, number][] = [
    [/授权码将在\s*(\d+)\s*秒后过期/, 1],
    [/授权码(?:将)?在?\s*(\d+)\s*秒(?:后)?(?:过期|失效)/, 1],
    [/(\d+)\s*秒后(?:过期|失效)/, 1],
    [/授权码将在\s*(\d+)\s*分钟后过期/, 60],
    [/(\d+)\s*分钟后(?:过期|失效)/, 60],
    [/"?expires?_in"?\s*[:=]\s*(\d+)/i, 1],
    [/"?expires?In"?\s*[:=]\s*(\d+)/i, 1],
  ];
  for (const [re, mult] of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n * mult);
    }
  }
  return undefined;
}

/** 从登录子进程输出里尽力提取设备码/授权 URL/有效期（dws 各版本输出格式不完全一致） */
export function extractLoginHint(stdout: string, stderr = ''): DwsLoginHint | undefined {
  const text = `${stdout}\n${stderr}`;
  const { url, code: urlCode } = pickLoginUrl(text);
  const code = urlCode
    ?? (text.match(/"?user[ _-]?code"?\s*[:=：]\s*"?([A-Za-z0-9][A-Za-z0-9-]{3,})"?/i)?.[1])
    ?? (text.match(/(?:设备码|验证码|授权码|code)[^\w]{0,8}([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/)?.[1]);
  const expiresInSec = parseLoginExpirySec(text);
  if (!url && !code && !expiresInSec) return undefined;
  return {
    ...(url ? { url } : {}),
    ...(code ? { code } : {}),
    ...(expiresInSec ? { expiresInSec } : {}),
  };
}

// ---------------------------------------------------------------------------
// 生产单例
// ---------------------------------------------------------------------------

let cached: { key: string; client: DingtalkPersonalClient } | undefined;

/** 生产单例：配置变化（单测直接改 config.identity）时自动重建 */
export function dingtalkPersonalClient(): DingtalkPersonalClient {
  const conf = config.identity.dingtalk;
  const key = JSON.stringify([conf.bin, conf.profile, conf.authTimeoutMs, conf.sendTimeoutMs]);
  if (!cached || cached.key !== key) {
    cached?.client.dispose();
    cached = {
      key,
      client: new DingtalkPersonalClient({
        bin: conf.bin,
        profile: conf.profile,
        authTimeoutMs: conf.authTimeoutMs,
        sendTimeoutMs: conf.sendTimeoutMs,
      }),
    };
  }
  return cached.client;
}

/** 单测/热更新用：清掉单例缓存（下次调用重建） */
export function resetDingtalkPersonalClientCache(): void {
  cached?.client.dispose();
  cached = undefined;
}