import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '@unimsg/shared';
import { parseCliArgs } from './cli';

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
