/**
 * 可写的临时目录。
 *
 * 为什么需要它：`os.tmpdir()` 返回的目录**不一定可写**。受管 Windows 机器上
 * `%TEMP%` 常常存在但拒绝创建子目录（`mkdtemp` 直接 EPERM），一些容器/CI 也会
 * 清空 `TMP`/`TEMP` 让 `GetTempPath()` 返回空串。原来的测试与 dws 附件落盘都直接
 * 用 `join(tmpdir(), …)`，在这类机器上会出现「一跑测试 15 个全挂」「发文件直接抛错」。
 *
 * 这里按顺序挑一个能真的建出目录的候选位置：
 *   1. 显式指定的 `LINKHUB_TMP_DIR`（部署/CI 推荐）；
 *   2. 系统临时目录；
 *   3. 仓库内 `unimsg-connector/.tmp`（已 gitignore）。
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库内的兜底目录：packages/server/src/utils → 上四级 = unimsg-connector */
const REPO_TMP = join(dirname(fileURLToPath(import.meta.url)), '../../../../.tmp');

/** 依序尝试的候选根目录（已去重、已过滤空值） */
export function tempBaseCandidates(): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  const push = (v: string | undefined): void => {
    const dir = (v ?? '').trim();
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    list.push(dir);
  };
  push(process.env.LINKHUB_TMP_DIR);
  try {
    push(tmpdir());
  } catch {
    // 极端环境里连 tmpdir() 都可能抛错，忽略
  }
  push(REPO_TMP);
  return list;
}

/**
 * 在第一个可用的候选根目录下创建唯一临时目录，返回绝对路径。
 * 全部失败才抛错，并说明试过哪些位置（带原因），避免只看到一句 EPERM。
 */
export function makeTempDir(prefix: string): string {
  const failures: string[] = [];
  for (const base of tempBaseCandidates()) {
    try {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, prefix));
    } catch (e) {
      failures.push(`${base}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  throw new Error(
    `找不到可写的临时目录：${failures.join('；')}。`
    + '请设置 LINKHUB_TMP_DIR 指向一个可写目录后重试。',
  );
}

/** 只取根目录（需要自己拼文件名时用）；找不到可写位置时返回仓库 .tmp */
export function tempBaseDir(): string {
  for (const base of tempBaseCandidates()) {
    try {
      mkdirSync(base, { recursive: true });
      return base;
    } catch {
      // 试下一个
    }
  }
  return REPO_TMP;
}