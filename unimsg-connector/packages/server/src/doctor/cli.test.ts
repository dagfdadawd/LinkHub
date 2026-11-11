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
});
