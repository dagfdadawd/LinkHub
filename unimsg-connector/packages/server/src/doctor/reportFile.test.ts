/**
 * doctor 证据落盘单测：
 *  - buildReportPayload：2 空格 JSON、可被 JSON.parse 还原；
 *  - defaultReportPath：向上找 repoRoot（含 docs/ 与 unimsg-connector/）、
 *    找不到时回退 <cwd>/../docs/verification、文件名时间戳格式固定；
 *  - writeReportFile：自动建父目录、内容与返回的绝对路径一致。
 * 全部使用 makeTempDir 下的临时目录，不污染真实 docs/。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildReportPayload, defaultReportPath, writeReportFile } from './reportFile';
import { makeTempDir } from '../utils/tempDir';

const dirs: string[] = [];
function tempDir(): string {
  const dir = makeTempDir('linkhub-doctor-report-');
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('buildReportPayload：2 空格缩进 JSON，可被 JSON.parse 还原', () => {
  const report = { tool: 'linkhub-doctor', nested: { ok: true, items: [1, 2] } };
  const payload = buildReportPayload(report);
  assert.equal(payload, JSON.stringify(report, null, 2), '与 JSON.stringify(…, null, 2) 一致');
  assert.ok(payload.includes('\n  "tool"'), '顶层键缩进 2 空格');
  assert.ok(payload.includes('\n    "ok"'), '嵌套键缩进 4 空格');
  assert.deepEqual(JSON.parse(payload), report);
});

test('defaultReportPath：向上找到同时含 docs/ 与 unimsg-connector/ 的目录作为仓库根', () => {
  const root = tempDir();
  // 模拟 LinkHub 布局：<root>/{docs, unimsg-connector/packages/server}
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'unimsg-connector', 'packages', 'server'), { recursive: true });

  const fixed = new Date(2026, 2, 1, 9, 5, 3); // 本地时间 2026-03-01 09:05:03
  const path = defaultReportPath(fixed, join(root, 'unimsg-connector', 'packages', 'server'));

  assert.equal(dirname(dirname(path)), join(root, 'docs'), '倒数两级是 docs/verification');
  assert.equal(basename(dirname(path)), 'verification');
  assert.equal(basename(path), 'doctor-20260301-090503.json');
});

test('defaultReportPath：找不到仓库根时回退 <fromDir>/../docs/verification', () => {
  // 用一个不存在的探针路径：其所有祖先（直到盘符根）都不可能同时含 docs/ 与 unimsg-connector/，
  // 因此必然走回退分支（不依赖测试临时目录落在哪里、也不做任何写盘）。
  // 注意 fromDir 语义与真实运行一致：cwd 通常是 unimsg-connector，回退 = 上一级的 docs/verification。
  const probeRoot = process.platform === 'win32'
    ? 'C:\\nonexistent-linkhub-report-probe'
    : '/nonexistent-linkhub-report-probe';
  const fromDir = join(probeRoot, 'unimsg-connector', 'packages', 'server');

  const path = defaultReportPath(new Date(2026, 10, 22, 23, 59, 9), fromDir);
  const expectedDir = join(fromDir, '..', 'docs', 'verification');
  assert.equal(dirname(path), expectedDir);
  assert.match(basename(path), /^doctor-\d{8}-\d{6}\.json$/);
  assert.equal(basename(path), 'doctor-20261122-235909.json');
});

test('defaultReportPath：文件名时间戳为本地时间 YYYYMMDD-HHmmss（补零）', () => {
  const root = tempDir();
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'unimsg-connector'), { recursive: true });
  // 单位数月/日/时/分/秒都要补成两位
  const path = defaultReportPath(new Date(2026, 0, 2, 3, 4, 5), root);
  assert.equal(basename(path), 'doctor-20260102-030405.json');
});

test('writeReportFile：自动创建父目录并写入，返回绝对路径，内容与 payload 一致', () => {
  const base = tempDir();
  const target = join(base, 'a', 'b', 'doctor-out.json');
  const report = { tool: 'linkhub-doctor', summary: { pass: 3, fail: 0, skip: 1 } };

  const returned = writeReportFile(target, report);
  assert.ok(existsSync(target), '文件已写入');
  assert.equal(returned, target, '返回写入的绝对路径（相对路径会被 resolve）');

  const reread = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(reread, report);
  assert.equal(readFileSync(target, 'utf8'), buildReportPayload(report));
});

test('writeReportFile：返回 resolve 规范化后的绝对路径（冗余 .. 被消解）', () => {
  const base = tempDir();
  const messy = join(base, 'x', '..', 'y', 'doctor-messy.json');
  const expected = join(base, 'y', 'doctor-messy.json');
  const returned = writeReportFile(messy, { ok: true });
  assert.equal(returned, expected, 'resolve 会消解 x/.. 冗余段');
  assert.ok(existsSync(expected));
});
