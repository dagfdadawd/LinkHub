/**
 * 钉钉「一登即用」身份自动启用（二轮复验后调整的时序）：
 *
 *  - 用户点「用钉钉本人账号登录（推荐，无需机器人应用）」时，**先不改任何配置**，只发起 dws 登录；
 *  - dws 登录成功（登录子进程成功退出 / status 探测到 authenticated）且满足条件时，才自动把
 *    `identity.dingtalk` 热应用为 `user` 并持久化到本地配置（标记 autoApplied）；
 *  - 未完成授权 → 配置完全不改变（避免「已启用本人身份但未登录」导致回复显式失败/进 DLQ）；
 *  - dws 注销后，若 identity 是「自动启用」而来，自动回退 `auto` 并持久化；
 *    显式写在 .env 或本地配置里的 user 不会被自动改。
 *
 * 条件（缺一不可）：`DINGTALK_IDENTITY` 解析结果为 auto（非显式 bot/user）、
 * 没有钉钉机器人凭据（configured=false）、dws 当前已登录。
 */
import { Platform } from '@unimsg/shared';
import { config, monorepoRoot } from '../config';
import { dingtalkPersonalClient } from '../connectors/dingtalkPersonal';
import { readLocalConfig, writeLocalConfigFile, type LocalConfig } from './localConfig';

export interface AutoEnableDeps {
  /** 已知登录态（不传则强制探测 dws auth status） */
  authenticated?: boolean;
  /** 单测注入：登录态探测（默认 authStatus force） */
  authStatus?: () => Promise<{ authenticated: boolean }>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface AutoEnableResult {
  applied: boolean;
  /** 未应用原因（applied=true 时是触发原因） */
  reason: string;
}

function persistIdentity(next: LocalConfig, file: string, warn: (line: string) => void): void {
  try {
    writeLocalConfigFile(file, next);
  } catch (e) {
    // 落盘失败不影响本次运行（已热应用），但重启后会丢；如实 warn，不假装已持久化
    warn(
      `[identity] 本地配置写入失败（本次热应用仍有效，但重启后会失效）：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * dws 登录成功后调用：满足条件则热应用「仅本人身份」并持久化。
 * 调用方负责之后触发接收通道 reconcile（本模块不 import 协调器，避免循环依赖）。
 */
export async function maybeAutoEnableDingtalkPersonalIdentity(
  trigger: string,
  deps: AutoEnableDeps = {},
): Promise<AutoEnableResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const conf = config.identity.dingtalk;
  if (conf.policy !== 'auto') return { applied: false, reason: 'identity-policy-not-auto' };
  if (config.runtime[Platform.DINGTALK].configured) return { applied: false, reason: 'bot-credentials-present' };

  let authenticated = deps.authenticated;
  if (authenticated === undefined) {
    try {
      const probe = deps.authStatus ?? (() => dingtalkPersonalClient().authStatus({ force: true }));
      authenticated = (await probe()).authenticated;
    } catch {
      authenticated = false;
    }
  }
  if (!authenticated) return { applied: false, reason: 'not-logged-in' };

  // 条件满足：热应用（运行中 config 立即生效）+ 持久化（重启后仍保留）
  conf.policy = 'user';
  const local = readLocalConfig(monorepoRoot);
  const next: LocalConfig = {
    ...local.config,
    identity: { ...(local.config.identity ?? {}), dingtalk: 'user', dingtalkAutoApplied: true },
  };
  persistIdentity(next, local.file, warn);
  log(`[identity] ${trigger}：已自动启用钉钉「仅本人身份」（无需重启），登录态持久化到本地配置`);
  return { applied: true, reason: trigger };
}

export interface AutoRevertResult {
  reverted: boolean;
  reason: string;
}

/**
 * dws 注销后调用：若 identity 来自「自动启用」（autoApplied 标记），回退 auto 并持久化。
 * 显式 .env 指定 DINGTALK_IDENTITY=bot/user 时不动（环境变量优先）。
 */
export function maybeRevertDingtalkPersonalIdentity(trigger = 'dws 注销', deps: Pick<AutoEnableDeps, 'log' | 'warn'> = {}): AutoRevertResult {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const explicitEnv = (process.env.DINGTALK_IDENTITY ?? '').trim();
  if (explicitEnv === 'bot' || explicitEnv === 'user') return { reverted: false, reason: 'explicit-env-identity' };

  const local = readLocalConfig(monorepoRoot);
  if (local.config.identity?.dingtalkAutoApplied !== true) {
    return { reverted: false, reason: 'not-auto-applied' };
  }
  config.identity.dingtalk.policy = 'auto';
  const identity = { ...(local.config.identity ?? {}), dingtalk: 'auto' as const };
  delete identity.dingtalkAutoApplied;
  const next: LocalConfig = { ...local.config, identity };
  persistIdentity(next, local.file, warn);
  log(`[identity] ${trigger}：已自动回退钉钉身份为 auto（避免「已启用本人身份但未登录」导致发送失败）`);
  return { reverted: true, reason: trigger };
}

/** 供测试/诊断：当前本地配置里的 autoApplied 标记 */
export function isDingtalkAutoApplied(): boolean {
  return readLocalConfig(monorepoRoot).config.identity?.dingtalkAutoApplied === true;
}

