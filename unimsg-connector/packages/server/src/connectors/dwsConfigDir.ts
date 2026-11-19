/**
 * dws 配置目录自动发现。
 *
 * 背景：这台机器的 `%USERPROFILE%\.dws` 写不进去（进程权限被限），
 * dws 登录态只能放在别的目录（例如 `D:\LinkHub-push\dws-data`）。
 * 如果后端进程没拿到 `DWS_CONFIG_DIR`，它读默认目录 → 永远"未登录" →
 * 收件箱拿不到会话名、钉钉也发不出消息，而且用户很难自己定位。
 *
 * 这里做一件事：**启动时如果环境变量没设，就自动探测本机已存在的 dws 配置目录**
 * （仓库内 `.dws-data`、仓库同级 `dws-data`、以及环境变量显式指定），
 * 找到有登录痕迹的就写回 `process.env.DWS_CONFIG_DIR`，后面所有 dws 子进程自动继承。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 判断一个目录像不像"已经登录过"的 dws 配置目录 */
function looksLoggedIn(dir: string): boolean {
  if (!existsSync(dir)) return false;
  // profiles.json / token.json / identity.json 任意一个存在，就值得试一把
  const marks = ['profiles.json', 'token.json', 'identity.json'];
  if (marks.some((m) => existsSync(join(dir, m)))) return true;
  try {
    return readdirSync(dir).some((f) => marks.includes(f));
  } catch {
    return false;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 候选目录（按优先级）：
 *  1. 环境变量（用户显式指定，最高优先级，不动它）
 *  2. 仓库内 `unimsg-connector/.dws-data`
 *  3. 仓库同级 `dws-data`（当前机器实际登录的位置）
 */
export function resolveDwsConfigDir(): { dir?: string; source: string } {
  const fromEnv = (process.env.DWS_CONFIG_DIR ?? '').trim();
  if (fromEnv) return { dir: fromEnv, source: 'env' };

  const repoRoot = resolve(here, '../../../..'); // src/connectors -> 仓库根 unimsg-connector
  const candidates: Array<{ dir: string; source: string }> = [
    { dir: join(repoRoot, '.dws-data'), source: 'repo/.dws-data' },
    { dir: resolve(repoRoot, '..', 'dws-data'), source: 'workspace/dws-data' },
  ];
  for (const c of candidates) {
    if (looksLoggedIn(c.dir)) return c;
  }
  return { source: 'default(~/.dws)' };
}

/**
 * 启动时调用：没设 `DWS_CONFIG_DIR` 时自动补上，并打印一行日志说明用了哪个目录。
 * 返回最终生效的目录（可能在 ~/.dws 默认位置时为空）。
 */
export function ensureDwsConfigDir(log: (line: string) => void = console.log): string | undefined {
  const { dir, source } = resolveDwsConfigDir();
  if (dir && source !== 'env') {
    process.env.DWS_CONFIG_DIR = dir;
    log(`[dws] 自动使用配置目录 ${dir}（来源: ${source}）`);
  } else if (dir) {
    log(`[dws] 使用配置目录 ${dir}（来源: 环境变量）`);
  } else {
    log('[dws] 未找到可用的 dws 配置目录，使用默认 ~/.dws（若未登录，请先完成 dws auth login）');
  }
  return dir;
}