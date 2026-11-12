/**
 * 发送限流/退避的单元测试（不联网）：
 *  - 普通失败按 maxRetry 重试；
 *  - noRetry（用户操作类错误，如「钉钉本人身份未登录」）不重试，立即把可读原因上浮。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rateLimiter';

test('noRetry：用户操作类错误不重试，立即把可读原因上浮', async () => {
  const limiter = new RateLimiter(3, 1);
  let attempts = 0;
  const err = new Error('钉钉本人身份未登录：请先完成钉钉本人登录（连接账号 → 用钉钉本人账号登录）。') as Error & { noRetry?: boolean };
  err.noRetry = true;
  const start = Date.now();
  await assert.rejects(
    () => limiter.send('dingtalk', async () => {
      attempts += 1;
      throw err;
    }),
    /请先完成钉钉本人登录/,
  );
  assert.equal(attempts, 1, '不重试');
  assert.ok(Date.now() - start < 200, '不等待退避');
});

test('普通失败仍按 maxRetry 重试（最多 attempts=4）', async () => {
  const limiter = new RateLimiter(3, 1);
  let attempts = 0;
  await assert.rejects(
    () => limiter.send('dingtalk', async () => {
      attempts += 1;
      throw new Error('网络抖动');
    }),
    /网络抖动/,
  );
  assert.equal(attempts, 4);
});