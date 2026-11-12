/**
 * 「.env 改了但后端没重启」提示（P1-5，小白最常踩的坑之一）。
 *
 * 后端运行中只在启动时读 .env：用户改完保存、刷新页面，看到的还是旧配置，
 * 然后开始怀疑自己填错了。`/api/health` 会下发 `startedAt` 与 `envFile.mtime`，
 * 这里只做纯判断：envFile 比进程启动时间新 → 必须提示重启。
 */
import type { HealthInfo } from '../services/api';

export interface EnvRestartCheck {
  needed: boolean;
  /** .env 修改时间（毫秒），可解析时才有 */
  envMtime?: number;
  /** 后端启动时间（毫秒），可解析时才有 */
  startedAt?: number;
}

/**
 * 容差 2s：同一秒内启动与写入文件的时钟抖动不该误报；
 * 字段缺失 / 时间无法解析（旧后端）时一律不提示，避免误伤。
 */
export const ENV_RESTART_TOLERANCE_MS = 2_000;

export function checkEnvRestart(
  health: Pick<HealthInfo, 'startedAt' | 'envFile'> | null | undefined,
): EnvRestartCheck {
  if (!health?.startedAt || !health.envFile?.mtime) return { needed: false };
  const startedAt = new Date(health.startedAt).getTime();
  const envMtime = new Date(health.envFile.mtime).getTime();
  if (Number.isNaN(startedAt) || Number.isNaN(envMtime)) return { needed: false };
  return {
    needed: envMtime > startedAt + ENV_RESTART_TOLERANCE_MS,
    envMtime,
    startedAt,
  };
}