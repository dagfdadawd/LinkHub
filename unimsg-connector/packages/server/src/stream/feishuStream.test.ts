import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '@unimsg/shared';
import { config } from '../config';
import { dispatchFeishuStreamEvent, startFeishuStream } from './feishuStream';

test('dispatchFeishuStreamEvent 把长连接事件送入 FEISHU 的 onPlatformEvent', async () => {
  const calls: Array<{ platform: Platform; data: unknown }> = [];
  const svc = {
    onPlatformEvent: async (platform: Platform, data: unknown) => {
      calls.push({ platform, data });
      return { duplicate: false };
    },
  } as any;

  // 飞书长连接推送的是明文事件，结构同 im.message.receive_v1
  const data = { message: { chat_id: 'oc_abc', content: '{"text":"你好"}' } };
  await dispatchFeishuStreamEvent(svc, data);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].platform, Platform.FEISHU);
  assert.deepEqual(calls[0].data, data);
});

test('startFeishuStream 缺少飞书凭据时返回 null（不建立长连接）', async () => {
  // 临时清空凭据以验证「跳过」分支，避免触发真实联网（随后还原，不影响其他用例）
  const savedId = config.platforms.feishu.appId;
  const savedSecret = config.platforms.feishu.appSecret;
  config.platforms.feishu.appId = '';
  config.platforms.feishu.appSecret = '';
  try {
    const svc = { onPlatformEvent: async () => ({ duplicate: false }) } as any;
    const handle = await startFeishuStream(svc);
    assert.equal(handle, null);
  } finally {
    config.platforms.feishu.appId = savedId;
    config.platforms.feishu.appSecret = savedSecret;
  }
});
