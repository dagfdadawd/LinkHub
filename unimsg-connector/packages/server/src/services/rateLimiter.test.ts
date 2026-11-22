/**
 * 发送限流/退避的单元测试（不联网）：
 *  - 普通失败按 maxRetry 重试；
 *  - noRetry（用户操作类错误，如「钉钉本人身份未登录」）不重试，立即把可读原因上浮；
 *  - 按平台配额：指定配额的平台按配额节流、平台桶互不影响、未配置平台用全局默认。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '@unimsg/shared';
import { DEFAULT_PLATFORM_QUOTAS, RateLimiter } from './rateLimiter';

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

// ---------------------------------------------------------------------------
// 按平台配额（DEFAULT_PLATFORM_QUOTAS / 第 5 个构造参数）
// ---------------------------------------------------------------------------

test('DEFAULT_PLATFORM_QUOTAS：四平台配额与官方频控一致（容量=分钟额度，补充=每秒额度）', () => {
  assert.deepEqual(DEFAULT_PLATFORM_QUOTAS[Platform.FEISHU], { capacity: 900, refillPerSec: 15 });
  assert.equal(DEFAULT_PLATFORM_QUOTAS[Platform.DINGTALK].capacity, 20);
  assert.ok(
    Math.abs(DEFAULT_PLATFORM_QUOTAS[Platform.DINGTALK].refillPerSec - 20 / 60) < 1e-9,
    '钉钉 20 条/分钟 → 每秒补 20/60',
  );
  assert.deepEqual(DEFAULT_PLATFORM_QUOTAS[Platform.WECHAT], { capacity: 600, refillPerSec: 10 });
  assert.deepEqual(DEFAULT_PLATFORM_QUOTAS[Platform.MAIL], { capacity: 60, refillPerSec: 1 });
});

test('指定配额的平台按配额节流，未配置配额的平台用全局默认', async () => {
  // 全局桶又大又快（不会成为瓶颈）；钉钉单独配额：容量 1、每秒补 20（50ms 一个令牌）
  const limiter = new RateLimiter(3, 1000, 100, 1_000_000, {
    [Platform.DINGTALK]: { capacity: 1, refillPerSec: 20 },
  });
  const ok = async () => 'ok';

  await limiter.send(Platform.DINGTALK, ok); // 桶里唯一的令牌被取走
  const start = Date.now();
  await limiter.send(Platform.DINGTALK, ok); // 需要等补充，约 50ms
  const waited = Date.now() - start;
  assert.ok(waited >= 25, `第 2 次发送应被钉钉配额卡住等补充（实际 ${waited}ms）`);
  assert.ok(waited < 300, `等待不应超过 300ms（实际 ${waited}ms）`);

  // 未配置配额的企微走全局默认（又大又快）：连发 10 次都不应被钉钉的配额拖慢
  const t0 = Date.now();
  for (let i = 0; i < 10; i += 1) {
    await limiter.send(Platform.WECHAT, ok);
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 150, `未配额平台不应被钉钉配额影响（10 次发送实际 ${elapsed}ms）`);
});

test('不同平台桶互不影响：一个平台被抽干不影响另一个平台的额度', async () => {
  // 全局与 feishu 都是容量 1、每秒补 20（50ms 一个令牌），各自独立成桶
  const limiter = new RateLimiter(3, 1000, 1, 20, {
    [Platform.FEISHU]: { capacity: 1, refillPerSec: 20 },
  });
  const ok = async () => 'ok';

  await limiter.send(Platform.FEISHU, ok); // feishu 桶被抽干

  // 钉钉用全局桶（还是满的）→ 立即发出，不被 feishu 的空桶拖住
  const t0 = Date.now();
  await limiter.send(Platform.DINGTALK, ok);
  assert.ok(Date.now() - t0 < 100, `feishu 抽干不应影响 dingtalk（实际 ${Date.now() - t0}ms）`);

  // 反向：feishu 自己的桶确实空了，要按自己的配额等补充
  const t1 = Date.now();
  await limiter.send(Platform.FEISHU, ok);
  const waited = Date.now() - t1;
  assert.ok(waited >= 25, `feishu 应按自己的配额等待补充（实际 ${waited}ms）`);
  assert.ok(waited < 300, `等待不应超过 300ms（实际 ${waited}ms）`);
});

test('配额校验：capacity / refillPerSec 必须为正数，防止 delay(Infinity) 挂死', () => {
  assert.throws(
    () => new RateLimiter(3, 1000, 60, 30, { [Platform.FEISHU]: { capacity: 0, refillPerSec: 10 } }),
    /capacity 必须为正数/,
  );
  assert.throws(
    () => new RateLimiter(3, 1000, 60, 30, { [Platform.MAIL]: { capacity: 10, refillPerSec: 0 } }),
    /refillPerSec 必须为正数/,
  );
  assert.throws(
    () => new RateLimiter(3, 1000, 60, 30, { [Platform.WECHAT]: { capacity: -1, refillPerSec: Number.NaN } }),
    /capacity 必须为正数/,
  );
});