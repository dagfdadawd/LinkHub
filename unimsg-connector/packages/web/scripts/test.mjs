/**
 * 跨平台测试入口（Vitest）。
 *
 * 为什么需要它：Vitest 会把模块转换缓存写到系统临时目录，在受限 / CI /
 * 沙箱环境下该目录可能不可写（EPERM），从而抛 unhandled error 并让进程
 * 以非 0 退出——即使所有用例都通过。中间件式地改 process.env 太晚，
 * 必须在 vitest 进程启动前把 TEMP/TMP/TMPDIR 固定到工作区内。
 *
 * 用法：
 *   node scripts/test.mjs            → vitest run（CI/单次）
 *   node scripts/test.mjs --watch    → vitest --watch（本地）
 *   node scripts/test.mjs <任意参数> → 原样透传给 vitest
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url))); // packages/web
const workspaceRoot = join(pkgRoot, '..', '..'); // unimsg-connector
const tmpDir = join(workspaceRoot, 'node_modules', '.tmp');
mkdirSync(tmpDir, { recursive: true });

// 直接解析 vitest 的 bin 入口，不依赖 pnpm/.cmd shim，Windows/Linux/macOS 通用
const vitestPkgPath = require.resolve('vitest/package.json');
const { bin } = require('vitest/package.json');
const binRelative = typeof bin === 'string' ? bin : bin.vitest;
const vitestEntry = join(dirname(vitestPkgPath), binRelative);

const forwarded = process.argv.slice(2);
const args = forwarded.length ? forwarded : ['run'];
// 历史问题：Windows 下 Vitest 默认的 fork 池会让多个子进程并发写 node_modules/.tmp
// 里的转换缓存，触发 EPERM，实测会退化成 33 文件 / 300 用例（静默漏测）+ 退出码 1。
// 当年用「固定单 worker」绕过，代价是全量单测从 ~100s 涨到 ~330s。
// 现在改用 worker 线程池（同进程、无子进程缓存竞争），实测 371 用例全过、约 98s。
// 用户显式传了并发/池参数时尊重其选择。
const hasConcurrencyFlag = args.some((a) =>
  /--maxWorkers|--minWorkers|--pool|--no-file-parallelism|--fileParallelism/.test(a));
const finalArgs = process.platform === 'win32' && !hasConcurrencyFlag
  ? [...args, '--pool=threads']
  : args;
const child = spawn(process.execPath, [vitestEntry, ...finalArgs], {
  stdio: 'inherit',
  env: { ...process.env, TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
