#!/usr/bin/env node
/**
 * 交付打包脚本：用 `git archive` 从 HEAD 生成 zip。
 *
 * 为什么不用"右键压缩整个文件夹"：那样会把 .env（真实凭据）、.env.bak、日志、
 * 邮箱水位状态文件、node_modules 一起打进去 —— 等于把凭据发给评审。
 * git archive 只包含 git 已跟踪的文件，天然排除上述内容；脚本会先做两道校验：
 *   1) 工作区必须干净（否则打出来的包和当前代码不一致）；
 *   2) 已跟踪文件里不得出现 .env / 备份 / 日志 / 状态文件 / node_modules。
 * 任何一道不通过都直接退出，不生成交付包。
 *
 * 用法（在 unimsg-connector/ 下）：pnpm run deliver
 *   node scripts/deliver.mjs [--out <zip路径>] [--allow-dirty]
 * 默认输出：仓库上一级目录 `LinkHub-deliver-<YYYYMMDD-HHmm>.zip`
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// unimsg-connector/scripts -> unimsg-connector -> LinkHub-test（git 仓库根）
const monorepo = resolve(here, '..');
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: monorepo, encoding: 'utf8' }).trim();

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const allowDirty = args.includes('--allow-dirty');
// 用本机时区生成文件名（toISOString 是 UTC，中国用户会看到"昨天的日期"）
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const outZip = outArg >= 0 && args[outArg + 1]
  ? resolve(args[outArg + 1])
  : resolveDefaultOutput();

/**
 * 默认输出到仓库上一级目录（不污染仓库）。
 * 但某些机器上仓库就在盘符根（如 D:\\LinkHub），上一级 D:\\ 普通用户不可写，
 * 直接写会得到一个很隐晦的 `git archive ... Permission denied`。
 * 这里先探测可写性，不可写就退到用户主目录，并提示可用 --out 指定位置。
 */
function resolveDefaultOutput() {
  const name = `LinkHub-deliver-${stamp}.zip`;
  // 依次尝试：仓库上一级（不污染仓库）→ 仓库内 dist/（已被 .gitignore 忽略）→ 用户主目录
  const candidates = [
    { dir: resolve(repoRoot, '..'), why: '仓库上一级目录' },
    { dir: join(repoRoot, 'dist'), why: '仓库内 dist/（已被 gitignore）' },
    { dir: homedir(), why: '用户主目录' },
  ];
  for (const { dir } of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      continue;
    }
    if (canWriteDir(dir)) {
      if (dir !== candidates[0].dir) {
        console.warn(`[deliver] ⚠️ ${candidates[0].dir} 不可写（常见于仓库放在盘符根目录），改输出到${dir}。`);
        console.warn('[deliver] 如需指定位置：node scripts/deliver.mjs --out <zip路径>');
      }
      return join(dir, name);
    }
  }
  console.error('[deliver] ✖ 找不到可写的输出目录；请用 --out 指定一个可写路径，例如：');
  console.error(`[deliver]   node scripts/deliver.mjs --out "${join(monorepo, 'LinkHub-deliver.zip')}"`);
  process.exit(1);
}

function canWriteDir(dir) {
  try {
    const probe = join(dir, `.linkhub-deliver-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, cmdArgs, cwd = repoRoot) {
  return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8' }).trim();
}

console.log('[deliver] git 仓库根:', repoRoot);
console.log('[deliver] 提交:', run('git', ['log', '-1', '--format=%h %s']));
console.log('[deliver] 输出:', outZip);

// 1) 工作区必须干净：git archive 只打包 HEAD
const dirty = run('git', ['status', '--porcelain']);
if (dirty) {
  const shown = dirty.split('\n').slice(0, 12).map((l) => `  ${l}`).join('\n');
  if (!allowDirty) {
    console.error('[deliver] ✖ 工作区有未提交改动，交付包会和手上代码不一致。');
    console.error(shown);
    console.error('[deliver] 请先 git commit；仅本地试打包可加 --allow-dirty。');
    process.exit(1);
  }
  console.warn('[deliver] ⚠️ --allow-dirty：未提交改动不会进入交付包：');
  console.warn(shown);
}

// 2) 已跟踪文件黑名单校验
const tracked = run('git', ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
const banned = tracked.filter((f) => {
  const base = f.split('/').pop() ?? '';
  if (base === '.env.example' || base === '.env.sample') return false;
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base.endsWith('.log') ||
    base.endsWith('.log.err') ||
    base === '.mail-watermarks.json' ||
    // 运行期数据产物：消息快照 / 自动回复规则 / 邮箱账号（可能含消息正文与凭据密文）
    base === 'linkhub-state.json' ||
    base === 'auto-rules.json' ||
    base === '.linkhub-mail-accounts.json' ||
    // 运行期授权/水位产物：带上就等于把用户身份令牌或聊天进度发给评审
    base === '.feishu-user-token.json' ||
    base === '.feishu-user-receive.json' ||
    f.includes('node_modules/') ||
    f.endsWith('.zip')
  );
});
if (banned.length > 0) {
  console.error('[deliver] ✖ 已跟踪文件里发现不应交付的文件：');
  for (const f of banned) console.error('  -', f);
  console.error('[deliver] 请先从 git 索引移除（git rm --cached <file>）并加入 .gitignore。');
  process.exit(1);
}

// 3) 打包（git archive 只含已跟踪文件）
run('git', ['archive', '--format=zip', `--output=${outZip}`, 'HEAD']);
if (!existsSync(outZip) || statSync(outZip).size === 0) {
  console.error('[deliver] ✖ 打包失败：未生成有效 zip');
  process.exit(1);
}

console.log(`[deliver] ✔ 打包完成（${(statSync(outZip).size / 1024).toFixed(0)} KB，仅含 git 已跟踪文件）`);
console.log('[deliver] 包内已排除：.env / .env.bak* / 日志 / .mail-watermarks.json / .feishu-user-token.json / .feishu-user-receive.json / node_modules。');
console.log('[deliver] 交付前请再走一遍 docs/delivery-checklist.md：');
console.log('  1) pnpm typecheck && pnpm test && pnpm test:web && pnpm e2e');
console.log('  2) pnpm run doctor（凭据 / 网络 / 出口 IP）');
console.log('  3) 解压后的包：cd unimsg-connector && corepack pnpm install --frozen-lockfile && pnpm e2e');
