import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname } from 'node:path';
import { Platform } from '@unimsg/shared';
import { parseCliArgs } from './cli';
import { defaultReportPath } from './reportFile';

test('parseCliArgs：--platform=<列表> 解析为平台过滤', () => {
  const { options, error } = parseCliArgs(['--platform=feishu,mail']);
  assert.equal(error, undefined);
  assert.deepEqual(options.platformFilter, [Platform.FEISHU, Platform.MAIL]);
});

test('parseCliArgs：pnpm 透传的分隔符 -- 被忽略，不致参数错误', () => {
  for (const argv of [
    ['--', '--platform=feishu'],
    ['--platform=feishu', '--'],
    ['--'],
  ]) {
    const { options, error } = parseCliArgs(argv);
    assert.equal(error, undefined, `argv=${JSON.stringify(argv)}`);
    if (argv.includes('--platform=feishu')) {
      assert.deepEqual(options.platformFilter, [Platform.FEISHU]);
    }
  }
});

test('parseCliArgs：真正的未知参数仍然报错', () => {
  const { error } = parseCliArgs(['--unknown']);
  assert.match(error ?? '', /未知参数/);
});

test('parseCliArgs：--json 与 --help 均被识别', () => {
  assert.equal(parseCliArgs(['--json']).options.json, true);
  assert.equal(parseCliArgs(['--help']).options.help, true);
  assert.equal(parseCliArgs(['-h']).options.help, true);
});

test('parseCliArgs：平台列表容忍空格、大小写与重复项', () => {
  const spaced = parseCliArgs(['--platform=feishu mail']);
  assert.equal(spaced.error, undefined);
  assert.deepEqual(spaced.options.platformFilter, [Platform.FEISHU, Platform.MAIL]);

  const upper = parseCliArgs(['--platform=FEISHU,feishu']);
  assert.equal(upper.error, undefined);
  assert.deepEqual(upper.options.platformFilter, [Platform.FEISHU]);
});

test('parseCliArgs：非法平台 / 空列表 / 裸 --platform 都报错', () => {
  assert.match(parseCliArgs(['--platform=taobao']).error ?? '', /未知平台/);
  assert.match(parseCliArgs(['--platform=']).error ?? '', /需要一个平台列表/);
  assert.match(parseCliArgs(['--platform=']).error ?? '', /--platform=/);
  assert.match(parseCliArgs(['--platform']).error ?? '', /未知参数/);
});

test('parseCliArgs：重复指定 --platform 不再静默覆盖，明确报错', () => {
  const { error } = parseCliArgs(['--platform=feishu', '--platform=mail']);
  assert.match(error ?? '', /重复指定 --platform/);
  assert.match(error ?? '', /--platform=feishu,mail/);
});

// ---------------------------------------------------------------------------
// --out（证据落盘）
// ---------------------------------------------------------------------------

test('parseCliArgs：--out=<路径> 解析为报告落盘目标', () => {
  const { options, error } = parseCliArgs(['--out=docs/verification/doctor.json']);
  assert.equal(error, undefined);
  assert.equal(options.out, 'docs/verification/doctor.json');

  const absolute = parseCliArgs(['--out=C:\\tmp\\doctor-report.json']);
  assert.equal(absolute.error, undefined);
  assert.equal(absolute.options.out, 'C:\\tmp\\doctor-report.json');
});

test('parseCliArgs：--out= 空路径报错并给出示例', () => {
  const { options, error } = parseCliArgs(['--out=']);
  assert.match(error ?? '', /--out 需要一个文件路径/);
  assert.match(error ?? '', /--out=docs\/verification\/doctor\.json/);
  assert.equal(options.out, undefined);
});

test('parseCliArgs：重复指定 --out 明确报错', () => {
  const { error } = parseCliArgs(['--out=a.json', '--out=b.json']);
  assert.match(error ?? '', /重复指定 --out/);
});

test('parseCliArgs：裸 --out（无 =）按未知参数报错，与 --platform 行为一致', () => {
  const { error } = parseCliArgs(['--out']);
  assert.match(error ?? '', /未知参数/);
});

// ---------------------------------------------------------------------------
// --json（stdout 渲染通道）与文本输出
// ---------------------------------------------------------------------------

test('parseCliArgs：--json 与文本输出是二选一的 stdout 通道（默认文本，--json 切 JSON）', () => {
  // 不传 --json：json=false → doctor 按文本报告渲染 stdout
  assert.equal(parseCliArgs([]).options.json, false);
  assert.equal(parseCliArgs(['--platform=feishu']).options.json, false);
  // 传 --json：stdout 只输出 JSON（互斥语义由 doctor 入口按这个布尔决定）
  assert.equal(parseCliArgs(['--json']).options.json, true);
  assert.equal(parseCliArgs(['--json', '--platform=mail']).options.json, true);
});

test('parseCliArgs：--json 与 --out 可并存（JSON 走管道、同一份报告落盘）', () => {
  const { options, error } = parseCliArgs(['--json', '--out=docs/verification/doctor.json']);
  assert.equal(error, undefined);
  assert.equal(options.json, true);
  assert.equal(options.out, 'docs/verification/doctor.json');
});

test('parseCliArgs：不传 --json 时 --out 也保留文本输出（落盘不改 stdout 行为）', () => {
  const { options, error } = parseCliArgs(['--out=doctor.json']);
  assert.equal(error, undefined);
  assert.equal(options.json, false, 'stdout 仍是人类可读文本');
  assert.equal(options.out, 'doctor.json');
});

// ---------------------------------------------------------------------------
// 默认报告路径格式（defaultReportPath，doctor --out 未指定路径时使用）
// ---------------------------------------------------------------------------

test('默认报告路径：doctor-<YYYYMMDD-HHmmss>.json，落在 docs/verification 下', () => {
  const path = defaultReportPath(new Date(2026, 10, 22, 8, 7, 6));
  assert.equal(basename(path), 'doctor-20261122-080706.json');
  assert.equal(basename(dirname(path)), 'verification');
  assert.equal(basename(dirname(dirname(path))), 'docs');
});
