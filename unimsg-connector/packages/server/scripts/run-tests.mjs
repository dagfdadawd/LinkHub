/**
 * 跨平台测试入口（Node 内置 test runner + tsx）。
 *
 * 为什么需要它：`tsx` 自己会在 `os.tmpdir()` 下建 IPC 目录，测试里的 `mkdtemp`
 * 也默认落在系统临时目录。受管 Windows 机器上 `%TEMP%` 可能是 `C:\WINDOWS\temp`
 * 这种不可写位置，结果是**一条用例都跑不起来**（`EPERM: mkdir ... tsx-1234`），
 * 看起来像"测试全挂了"，实际是环境问题。这里在拉起 tsx **之前**把
 * `TMP/TEMP/TMPDIR` 固定到工作区内一个可写目录，和 packages/web 的 scripts/test.mjs 一致。
 *
 * 用法：
 *   node scripts/run-tests.mjs              → 跑全部 *.test.ts
 *   node scripts/run-tests.mjs src/app.test.ts → 只跑指定文件（其余参数透传给 node --test）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url))); // packages/server
const workspaceRoot = join(pkgRoot, '..', '..'); // unimsg-connector

/** 候选临时目录：LINKHUB_TMP_DIR → 系统临时目录 → 工作区 node_modules/.tmp */
function pickWritableTmp() {
  const candidates = [];
  if (process.env.LINKHUB_TMP_DIR) candidates.push(process.env.LINKHUB_TMP_DIR);
  try {
    const os = require('node:os');
    candidates.push(os.tmpdir());
  } catch {
    // 忽略
  }
  candidates.push(join(workspaceRoot, 'node_modules', '.tmp'));
  candidates.push(join(workspaceRoot, '.tmp'));

  for (const dir of candidates) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.probe-${process.pid}`);
      writeFileSync(probe, 'ok');
      rmSync(probe, { force: true });
      return dir;
    } catch {
      // 试下一个
    }
  }
  throw new Error('找不到可写的临时目录：请设置 LINKHUB_TMP_DIR 指向一个可写目录');
}

const tmpDir = pickWritableTmp();
// 关键：在子进程启动前固定，tsx / node:test / 用例里的 mkdtemp 都会继承
process.env.TMP = tmpDir;
process.env.TEMP = tmpDir;
process.env.TMPDIR = tmpDir;

/** 自己展开 glob：不同 shell / Node 版本对 `src/**\/*.test.ts` 的处理不一致 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.test.ts')) out.push(relative(pkgRoot, full));
  }
  return out;
}

const forwarded = process.argv.slice(2);
const files = forwarded.length ? forwarded : walk(join(pkgRoot, 'src')).sort();
if (files.length === 0) {
  console.error('[test] 没有找到任何 *.test.ts');
  process.exit(1);
}

// 直接解析 tsx 的 bin，不依赖 pnpm/.cmd shim（Windows/Linux/macOS 通用）
const tsxPkgPath = require.resolve('tsx/package.json');
const { bin } = require('tsx/package.json');
const binRelative = typeof bin === 'string' ? bin : bin.tsx;
const tsxEntry = join(dirname(tsxPkgPath), binRelative);

const child = spawn(process.execPath, [tsxEntry, '--test', ...files], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});