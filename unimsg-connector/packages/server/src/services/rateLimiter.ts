/**
 * 限流 + 指数退避重试。
 *
 * 每个平台一个令牌桶（默认容量 60、每秒补 30），发送前取令牌；
 * 发送失败最多重试 SEND_MAX_RETRY 次，间隔 1s/2s/4s（可配 base）；
 * 仍失败则抛错，由消息中枢置 failed、写 DLQ。
 *
 * 按平台配额（第 5 个可选参数 quotas）：
 *  - 传入 `Partial<Record<Platform, { capacity, refillPerSec }>>` 后，acquire 时
 *    优先使用 quotas[platform] 的容量与补充速率；未配置的平台用构造函数的全局默认；
 *  - DEFAULT_PLATFORM_QUOTAS 是按各平台官方频控换算好的推荐表
 *    （容量 = 分钟额度，允许突发；补充速率 = 每秒额度 = 分钟额度 / 60，约束持续速率），
 *    由装配方按需传入：`new RateLimiter(3, 1000, 60, 30, DEFAULT_PLATFORM_QUOTAS)`；
 *  - 前四个构造参数保持原语义不变（既有测试与调用点不感知）。
 */
import { Platform } from '@unimsg/shared';

/** 单个平台的令牌桶配额 */
export interface PlatformQuota {
  /** 桶容量（建议 = 每分钟额度，即允许的突发上限） */
  capacity: number;
  /** 每秒补充令牌数（建议 = 每分钟额度 / 60，即持续速率上限） */
  refillPerSec: number;
}

/**
 * 各平台官方频控换算成的默认配额表：
 *  - 飞书 900 条/分钟 → { capacity: 900, refillPerSec: 15 }
 *  - 钉钉 20 条/分钟  → { capacity: 20,  refillPerSec: 20/60 }
 *  - 企微 600 条/分钟 → { capacity: 600, refillPerSec: 10 }
 *  - 邮箱 60 封/分钟  → { capacity: 60,  refillPerSec: 1 }
 */
export const DEFAULT_PLATFORM_QUOTAS: Record<Platform, PlatformQuota> = {
  [Platform.FEISHU]: { capacity: 900, refillPerSec: 15 },
  [Platform.DINGTALK]: { capacity: 20, refillPerSec: 20 / 60 },
  [Platform.WECHAT]: { capacity: 600, refillPerSec: 10 },
  [Platform.MAIL]: { capacity: 60, refillPerSec: 1 },
};

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Bucket { tokens: number; last: number; }

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private maxRetry = 3,
    private baseDelayMs = 1000,
    private capacity = 60,
    private refillPerSec = 30,
    private quotas?: Partial<Record<Platform, PlatformQuota>>,
  ) {
    // 配置错误尽早暴露：refillPerSec=0 会让等待时间变成 Infinity（永远发不出去）
    if (quotas) {
      for (const [platform, quota] of Object.entries(quotas)) {
        if (!quota) continue;
        if (!Number.isFinite(quota.capacity) || quota.capacity <= 0) {
          throw new Error(`平台配额 capacity 必须为正数（${platform} 收到 ${quota.capacity}）`);
        }
        if (!Number.isFinite(quota.refillPerSec) || quota.refillPerSec <= 0) {
          throw new Error(`平台配额 refillPerSec 必须为正数（${platform} 收到 ${quota.refillPerSec}）`);
        }
      }
    }
  }

  async send<T>(platform: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    for (;;) {
      try {
        await this.acquire(platform);
        return await fn();
      } catch (e) {
        lastErr = e;
        // 明确的用户操作类错误（如「本人身份未登录」）不重试：重试只会延迟可读失败原因
        if ((e as { noRetry?: boolean } | undefined)?.noRetry) break;
        if (attempt >= this.maxRetry) break;
        attempt += 1;
        await delay(this.baseDelayMs * Math.pow(2, attempt - 1));
      }
    }
    throw lastErr;
  }

  /**
   * 单次尝试：取一个令牌、调用一次、失败不重试。
   *
   * 用于「尽力而为」的旁路通知（状态回执）：业务回写走 send() 的退避重试，
   * 回执不该把调用方挂在与业务发送同样的最坏时长上（限流等待 + 1/2/4s 退避）。
   */
  async sendOnce<T>(platform: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(platform);
    return fn();
  }

  /** 该平台的桶参数：显式配额优先，未配置的平台用构造函数的全局默认 */
  private settingsFor(platform: string): PlatformQuota {
    const quota = this.quotas?.[platform as Platform];
    return quota ?? { capacity: this.capacity, refillPerSec: this.refillPerSec };
  }

  /**
   * 取一个令牌；桶空时按补充速率等待后**重新计算**，而不是等完直接置 1。
   *
   * 旧实现里 N 个并发 acquire 各自按同一份过期快照算 delay、醒来都把 tokens 置 1，
   * 结果是「每 3 秒同时放行一波」，钉钉 20/min 的持续速率在突发下被击穿。
   * Node 单线程下「读桶→扣减」是同步段，循环重算即天然排队。
   */
  private async acquire(platform: string): Promise<void> {
    const { capacity, refillPerSec } = this.settingsFor(platform);
    for (;;) {
      const now = Date.now();
      const b = this.buckets.get(platform) ?? { tokens: capacity, last: now };
      const elapsed = (now - b.last) / 1000;
      const tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
      if (tokens >= 1) {
        this.buckets.set(platform, { tokens: tokens - 1, last: now });
        return;
      }
      // 桶空：把补了一半的量写回（保留累计进度），等到够 1 个再竞争
      this.buckets.set(platform, { tokens, last: now });
      await delay(((1 - tokens) / refillPerSec) * 1000);
    }
  }
}
