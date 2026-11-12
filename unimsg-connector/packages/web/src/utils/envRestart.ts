/**
 * 「.env 改了但后端没重启」提示（P1-5，小白最常踩的坑之一）。
 *
 * 只检测 `.env`：本地 `linkhub-config.json` 是否需要重启以 `/api/app-config.restartRequired`
 * 为准（identity 热应用后该值为 false），不能再用 settingsFile.mtime 自行推断——
 * 否则热应用会被误报成「需要重启」（二轮审计 P1-1）。
 */
import type { HealthInfo } from '../services/api';

export interface EnvRestartCheck {
  needed: boolean;
  /** .env 修改时间（毫秒），可解析时才有 */
  envMtime?: number;
  /** 后端启动时间（毫秒），可解析时才有 */
  startedAt?: number;
  /** 固定为 env（不再用 settings mtime 推断重启） */
  source?: 'env';
}

/**
 * 容差 2s：同一秒内启动与写入文件的时钟抖动不该误报；
 * 字段缺失 / 时间无法解析（旧后端）时一律不提示，避免误伤。
 */
export const ENV_RESTART_TOLERANCE_MS = 2_000;

/** 解析 ISO 时间为毫秒；空值 / 非法返回 undefined */
function parseTime(value?: string | null): number | undefined {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}

export function checkEnvRestart(
  health: Pick<HealthInfo, 'startedAt' | 'envFile'> | null | undefined,
): EnvRestartCheck {
  const startedAt = parseTime(health?.startedAt);
  if (startedAt === undefined) return { needed: false };
  const envMtime = parseTime(health?.envFile?.mtime);
  if (envMtime === undefined) return { needed: false };
  if (envMtime <= startedAt + ENV_RESTART_TOLERANCE_MS) return { needed: false };
  return { needed: true, envMtime, startedAt, source: 'env' };
}