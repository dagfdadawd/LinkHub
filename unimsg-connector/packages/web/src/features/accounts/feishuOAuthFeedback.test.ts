import { describe, expect, it } from 'vitest';
import {
  FEISHU_OAUTH_CHECKLIST,
  FEISHU_OAUTH_PENDING_KEY,
  FEISHU_OAUTH_UNFINISHED_HINT,
  clearFeishuOAuthPending,
  markFeishuOAuthPending,
  readFeishuOAuthPending,
} from './feishuOAuthFeedback';
import type { OAuthStorage } from './feishuOAuthFeedback';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage: OAuthStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { storage, map };
}

describe('飞书 OAuth 回跳反馈', () => {
  it('发起授权写 pending，10 分钟内可读回', () => {
    const { storage, map } = memoryStorage();
    markFeishuOAuthPending(storage, 1_000);
    expect(map.has(FEISHU_OAUTH_PENDING_KEY)).toBe(true);
    expect(readFeishuOAuthPending(storage, 2_000)).toEqual({ startedAt: 1_000 });
  });

  it('过期 / 损坏 / 负数标记：清掉且不提示', () => {
    const { storage } = memoryStorage();
    markFeishuOAuthPending(storage, 1_000);
    expect(readFeishuOAuthPending(storage, 20 * 60_000)).toBeUndefined();
    expect(readFeishuOAuthPending(storage, 2_000)).toBeUndefined(); // 已被清理

    const broken = memoryStorage({ [FEISHU_OAUTH_PENDING_KEY]: '{not-json' });
    expect(readFeishuOAuthPending(broken.storage, 2_000)).toBeUndefined();

    const negative = memoryStorage({ [FEISHU_OAUTH_PENDING_KEY]: '{"startedAt":-1}' });
    expect(readFeishuOAuthPending(negative.storage, 2_000)).toBeUndefined();
  });

  it('clear 后可再发起下一次授权', () => {
    const { storage } = memoryStorage();
    markFeishuOAuthPending(storage, 1_000);
    clearFeishuOAuthPending(storage);
    expect(readFeishuOAuthPending(storage, 2_000)).toBeUndefined();
  });

  it('storage 不可用 / 抛错时静默降级（授权主流程不受影响）', () => {
    expect(readFeishuOAuthPending(undefined)).toBeUndefined();
    markFeishuOAuthPending(undefined);
    clearFeishuOAuthPending(undefined);

    const throwing: OAuthStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => markFeishuOAuthPending(throwing)).not.toThrow();
    expect(readFeishuOAuthPending(throwing)).toBeUndefined();
    expect(() => clearFeishuOAuthPending(throwing)).not.toThrow();
  });

  it('提示文案不甩英文栈：给常见原因与配置步骤', () => {
    expect(FEISHU_OAUTH_UNFINISHED_HINT).toContain('重定向 URL');
    expect(FEISHU_OAUTH_UNFINISHED_HINT).toContain('20028');
    expect(FEISHU_OAUTH_CHECKLIST.length).toBeGreaterThanOrEqual(3);
    expect(FEISHU_OAUTH_CHECKLIST.join('｜')).toContain('personal-identity.md');
  });
});