/**
 * dws 统一解析（个人版内置/自动发现）单测：候选顺序与 source 如实标注，全部注入不碰真实文件系统/PATH。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveDwsBin, defaultMonorepoRoot, defaultToolsDir } from './dwsBin';

const IS_WIN = process.platform === 'win32';
// 路径要跟测试运行平台一致：CI 是 Linux，硬编码 Windows 盘符会被 path.resolve 当成相对路径展开。
const ROOT = IS_WIN ? 'C:\\repo\\unimsg-connector' : '/repo/unimsg-connector';
const HOME = IS_WIN ? 'C:\\Users\\tester' : '/home/tester';

function resolver(opts: {
  env?: NodeJS.ProcessEnv;
  files?: string[];
  pathHasDws?: boolean;
  platform?: NodeJS.Platform;
} = {}) {
  const files = new Set(opts.files ?? []);
  return resolveDwsBin(opts.env ?? {}, {
    monorepoRoot: ROOT,
    homeDir: HOME,
    platform: opts.platform ?? 'win32',
    existsImpl: (p) => files.has(p),
    pathCheckImpl: () => opts.pathHasDws ?? false,
  });
}

test('dws 解析：DWS_BIN 显式优先（原样保留，可带参数）', () => {
  const r = resolver({ env: { DWS_BIN: 'node scripts/fake-dws.mjs' } });
  assert.equal(r.source, 'env');
  assert.equal(r.bin, 'node scripts/fake-dws.mjs');
  assert.match(r.pathHint ?? '', /DWS_BIN/);
});

test('dws 解析：LINKHUB_TOOLS_DIR → 仓库 tools/ → ~/.local/bin 顺序，source 如实标注', () => {
  const toolsEnv = join(ROOT, 'custom-tools');
  const r1 = resolver({
    env: { LINKHUB_TOOLS_DIR: toolsEnv },
    files: [join(toolsEnv, 'dws.exe'), join(ROOT, 'tools', 'dws.exe')],
  });
  assert.equal(r1.source, 'tools');
  assert.equal(r1.bin, join(toolsEnv, 'dws.exe'));
  assert.match(r1.pathHint ?? '', /LINKHUB_TOOLS_DIR/);

  // 无 LINKHUB_TOOLS_DIR：仓库 tools/ 命中
  const r2 = resolver({ files: [join(ROOT, 'tools', 'dws.exe')] });
  assert.equal(r2.source, 'tools');
  assert.equal(r2.bin, join(ROOT, 'tools', 'dws.exe'));

  // tools 没有 → ~/.local/bin
  const r3 = resolver({ files: [join(HOME, '.local', 'bin', 'dws.exe')] });
  assert.equal(r3.source, 'user_profile');
  assert.equal(r3.bin, join(HOME, '.local', 'bin', 'dws.exe'));
});

test('dws 解析：固定目录都没有 → PATH；PATH 也没有 → source=missing（bin 仍是 dws）', () => {
  const onPath = resolver({ pathHasDws: true });
  assert.equal(onPath.source, 'path');
  assert.equal(onPath.bin, 'dws');

  const missing = resolver({ pathHasDws: false });
  assert.equal(missing.source, 'missing');
  assert.equal(missing.bin, 'dws');
  assert.match(missing.pathHint ?? '', /fetch:dws/);
});

test('dws 解析：非 Windows 候选名为 dws（无 .exe），tools 目录按仓库根计算', () => {
  const posixRoot = '/repo/unimsg-connector';
  const toolsDir = join(posixRoot, 'tools');
  const r = resolveDwsBin({}, {
    monorepoRoot: posixRoot,
    homeDir: '/home/tester',
    platform: 'linux',
    existsImpl: (p) => p === join(toolsDir, 'dws'),
    pathCheckImpl: () => false,
  });
  assert.equal(r.source, 'tools');
  assert.equal(r.bin, join(toolsDir, 'dws'), '非 Windows 不找 dws.exe');
  assert.equal(defaultToolsDir(posixRoot), toolsDir);
});

test('dws 解析：defaultMonorepoRoot 指向 unimsg-connector（本文件位置推导）', () => {
  assert.match(defaultMonorepoRoot().replace(/\\/g, '/'), /unimsg-connector\/?$/);
});