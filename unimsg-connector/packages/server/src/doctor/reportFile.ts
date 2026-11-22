/**
 * doctor 证据落盘（--out）。
 *
 * 把 doctor 的同一份报告 JSON 写进文件，便于留档与评审取证
 * （默认目录 docs/verification/，即「验证证据集中放这里」的项目约定）。
 *
 * 目录判定（defaultReportPath）：
 *  - 从 process.cwd() 向上逐级找「同时包含 docs/ 与 unimsg-connector/」的目录作为仓库根
 *    （LinkHub 布局：LinkHub/{docs, unimsg-connector}；从 packages/server 起跑也能命中根）；
 *  - 找不到（单独 checkout / 其他布局）就退回 `<cwd>/../docs/verification`——
 *    cwd 通常是 unimsg-connector，落点仍在 monorepo 的 docs/verification 下。
 *
 * 写文件是本模块唯一的 I/O；路径判定与 payload 组装都是纯函数，可单测。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 报告文件内容：JSON（2 空格缩进），评审可直接 diff */
export function buildReportPayload(report: unknown): string {
  return JSON.stringify(report, null, 2);
}

/** 本地时间戳：YYYYMMDD-HHmmss（文件名里不能带冒号，Windows 尤其如此） */
function timestampOf(now: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * 向上逐级找「同时包含 docs/ 与 unimsg-connector/」的目录（即 monorepo 根）。
 * 找不到返回 null，由调用方决定回退路径。
 */
function findRepoRoot(fromDir: string): string | null {
  let dir = resolve(fromDir);
  for (;;) {
    if (existsSync(join(dir, 'docs')) && existsSync(join(dir, 'unimsg-connector'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // 到达文件系统根
    dir = parent;
  }
}

/**
 * 默认报告路径：`<repoRoot>/docs/verification/doctor-<YYYYMMDD-HHmmss>.json`。
 * @param now     时间戳来源（默认当前时间；测试可传固定值）
 * @param fromDir 向上查找的起点（默认 process.cwd()；测试可注入，避免 chdir）
 */
export function defaultReportPath(now: Date = new Date(), fromDir: string = process.cwd()): string {
  const name = `doctor-${timestampOf(now)}.json`;
  const root = findRepoRoot(fromDir);
  if (root) return join(root, 'docs', 'verification', name);
  // 回退：cwd 通常是 unimsg-connector，`../docs/verification` 即 monorepo 的证据目录
  return resolve(fromDir, '..', 'docs', 'verification', name);
}

/**
 * 把报告写入指定文件（自动创建父目录），返回写入的绝对路径。
 * I/O 错误原样抛出，由调用方（doctor 入口）决定怎么提示与退出。
 */
export function writeReportFile(path: string, report: unknown): string {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buildReportPayload(report), 'utf8');
  return abs;
}
