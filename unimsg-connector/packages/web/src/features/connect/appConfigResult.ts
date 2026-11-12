/**
 * 保存 `/api/app-config` 后的结果判定（白号二轮审计 P1-2）。
 *
 * 后端契约（task-17/20）：
 *  - saved：是否有配置真的写入；
 *  - hotApplied：身份策略等可热应用的键是否已生效；
 *  - restartRequired：静态键（凭据/模式/stream）是否需重启；
 *  - ignoredByEnv：被 .env 显式配置锁定、本页不能覆盖的键。
 *
 * 红线：**绝不把「没生效」提示成「已切换/已生效」**。
 * 该函数是 ConnectPage 与 AppConfigModal 共用的唯一判定入口，避免两处逻辑漂移。
 */
import type { AppConfigSaveResult } from '../../services/api';
import { humanizeMissingKey } from './appConfigFields';

export type AppConfigSaveStatus = 'applied' | 'restart' | 'ignored' | 'failed';

export interface AppConfigSaveOutcome {
  status: AppConfigSaveStatus;
  /** 直接展示给用户的中文提示 */
  message: string;
  /** 被 .env 锁定、本次未覆盖的键（供页面/弹窗列表展示与测试断言） */
  ignoredByEnv: string[];
}

/** 统一的 .env 锁定提示：列出客户可读的配置名（原始键名保留在 ignoredByEnv 供技术详情） */
export function formatIgnoredByEnv(keys: string[]): string {
  const list = keys
    .filter((key) => key.trim().length > 0)
    .map((key) => humanizeMissingKey(key.trim()));
  if (list.length === 0) {
    return '该配置未能生效：请检查后端配置；如果由 .env 显式指定，请修改 .env 并重启 LinkHub。';
  }
  return `以下配置来自 .env，页面不能覆盖：${list.join('、')}；请修改 .env 并重启 LinkHub 后再试。`;
}

function successMessage(result: AppConfigSaveResult): string {
  return result.message && result.message.trim().length > 0
    ? result.message
    : '已保存并生效';
}

/**
 * 判定保存结果。
 *
 * `identityOnly=true` 表示本次 PUT 只改身份策略（identity.*）：后端承诺热应用，
 * 因此 hotApplied 必须为 true 才算成功；若被 .env 锁定（hotApplied:false）绝不能提示成功。
 * 凭据类保存（restartRequired:true）属于「保存成功但需重启」，仍走重启提示。
 */
export function interpretAppConfigSave(
  result: AppConfigSaveResult,
  opts: { identityOnly?: boolean } = {},
): AppConfigSaveOutcome {
  const ignoredByEnv = result.ignoredByEnv?.filter((key) => key.trim().length > 0) ?? [];
  const identityOnly = opts.identityOnly
    ?? (result.changedKeys.length > 0
      ? result.changedKeys.every((key) => key.startsWith('identity.'))
      : (result.hotAppliedKeys?.length ?? 0) > 0
        && result.hotAppliedKeys!.every((key) => key.startsWith('identity.')));

  // 1) 完全没保存：不得有任何成功口吻
  if (result.saved === false) {
    return {
      status: ignoredByEnv.length > 0 ? 'ignored' : 'failed',
      message: ignoredByEnv.length > 0
        ? formatIgnoredByEnv(ignoredByEnv)
        : (result.message?.trim() || '保存失败：配置未生效，请稍后重试。'),
      ignoredByEnv,
    };
  }

  // 2) 部分键被 .env 锁定：即使其余键保存成功，也必须明确告知「这些没生效」
  if (ignoredByEnv.length > 0) {
    return {
      status: 'ignored',
      message: formatIgnoredByEnv(ignoredByEnv),
      ignoredByEnv,
    };
  }

  // 3) 身份策略：后端承诺热应用；hotApplied 不为 true 就是没生效
  if (identityOnly) {
    if (result.hotApplied === true) {
      return { status: 'applied', message: '已立即生效（无需重启）', ignoredByEnv };
    }
    return {
      status: 'ignored',
      message: result.message?.trim()
        || '身份模式未生效：该配置可能来自 .env，请修改 .env 并重启 LinkHub 后再试。',
      ignoredByEnv,
    };
  }

  // 4) 凭据/模式等静态键：保存成功但需重启（现有重启提示继续展示）
  if (result.restartRequired) {
    return { status: 'restart', message: successMessage(result), ignoredByEnv };
  }

  // 5) 其余情况：只有 saved 为 true 才允许成功；hotApplied 明确 false 时不得声称已生效
  if (result.hotApplied === false) {
    return {
      status: 'ignored',
      message: result.message?.trim()
        || '已保存，但配置未应用：可能由 .env 显式指定，请修改 .env 并重启 LinkHub。',
      ignoredByEnv,
    };
  }

  return { status: 'applied', message: successMessage(result), ignoredByEnv };
}