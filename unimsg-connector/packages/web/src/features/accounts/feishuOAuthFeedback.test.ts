import { describe, expect, it } from 'vitest';
import {
  FEISHU_OAUTH_COMMON_REASONS,
  FEISHU_OAUTH_PENDING_KEY,
  FEISHU_OAUTH_REDIRECT_GUIDE,
  FEISHU_OAUTH_REDIRECT_URI_FALLBACK,
  FEISHU_OAUTH_UNFINISHED_TITLE,
  FEISHU_OPEN_PLATFORM_URL,
  clearFeishuOAuthPending,
  markFeishuOAuthPending,
  readFeishuOAuthPending,
  saveFeishuOAuthRedirectUri,
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

  it('记住本次真实回调地址：重新发起会清掉上一次，刷新后仍可读回', () => {
    const { storage } = memoryStorage();
    markFeishuOAuthPending(storage, 1_000);
    saveFeishuOAuthRedirectUri(storage, 'http://localhost:3901/api/feishu/oauth/callback', 2_000);
    expect(readFeishuOAuthPending(storage, 3_000)).toEqual({
      startedAt: 1_000,
      redirectUri: 'http://localhost:3901/api/feishu/oauth/callback',
    });

    // 再点一次「重新授权」：旧地址必须清掉，避免展示上一次的端口
    markFeishuOAuthPending(storage, 4_000);
    expect(readFeishuOAuthPending(storage, 5_000)).toEqual({ startedAt: 4_000 });
  });

  it('回调地址只接受 http(s)；标记被人为清掉时补一个', () => {
    const { storage } = memoryStorage();
    saveFeishuOAuthRedirectUri(storage, 'javascript:alert(1)', 1_000);
    expect(readFeishuOAuthPending(storage, 2_000)).toBeUndefined();

    saveFeishuOAuthRedirectUri(storage, '  http://localhost:3901/api/feishu/oauth/callback  ', 3_000);
    expect(readFeishuOAuthPending(storage, 4_000)).toEqual({
      startedAt: 3_000,
      redirectUri: 'http://localhost:3901/api/feishu/oauth/callback',
    });
  });

  it('过期 / 损坏 / 负数标记：清掉且不提示', () => {
    const { storage } = memoryStorage();
    markFeishuOAuthPending(storage, 1_000);
    saveFeishuOAuthRedirectUri(storage, 'http://localhost:3901/api/feishu/oauth/callback');
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
    saveFeishuOAuthRedirectUri(storage, 'http://localhost:3901/api/feishu/oauth/callback');
    clearFeishuOAuthPending(storage);
    expect(readFeishuOAuthPending(storage, 2_000)).toBeUndefined();
  });

  it('storage 不可用 / 抛错时静默降级（授权主流程不受影响）', () => {
    expect(readFeishuOAuthPending(undefined)).toBeUndefined();
    markFeishuOAuthPending(undefined);
    saveFeishuOAuthRedirectUri(undefined, 'http://localhost:3901/api/feishu/oauth/callback');
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
    expect(() => saveFeishuOAuthRedirectUri(throwing, 'http://localhost:3901/api/feishu/oauth/callback')).not.toThrow();
    expect(readFeishuOAuthPending(throwing)).toBeUndefined();
    expect(() => clearFeishuOAuthPending(throwing)).not.toThrow();
  });
});

describe('飞书 20029 自解释文案', () => {
  it('标题直接点出 20029；正文说清「把哪个地址填到哪里」', () => {
    expect(FEISHU_OAUTH_UNFINISHED_TITLE).toContain('飞书授权未完成');
    expect(FEISHU_OAUTH_UNFINISHED_TITLE).toContain('20029');
    expect(FEISHU_OAUTH_UNFINISHED_TITLE).toContain('重定向 URL 有误');

    expect(FEISHU_OAUTH_REDIRECT_GUIDE).toContain('飞书开放平台只认已登记的回调地址');
    expect(FEISHU_OAUTH_REDIRECT_GUIDE).toContain('安全设置 → 重定向 URL');
    expect(FEISHU_OAUTH_REDIRECT_GUIDE).toContain('原样添加');
    expect(FEISHU_OAUTH_REDIRECT_GUIDE).toContain('含端口、路径，不加结尾斜杠');
    expect(FEISHU_OAUTH_REDIRECT_GUIDE).toContain('测试应用保存即生效');
  });

  it('拿不到回调地址时只给兜底指引，不编造地址', () => {
    expect(FEISHU_OAUTH_REDIRECT_URI_FALLBACK).toContain('点「重新授权」');
    expect(FEISHU_OAUTH_REDIRECT_URI_FALLBACK).toContain('本次的真实回调地址');
    expect(FEISHU_OAUTH_REDIRECT_URI_FALLBACK).not.toMatch(/localhost|3001|3901/);
  });

  it('其余常见原因：每条都有一句话原因 + 可操作动作', () => {
    const joined = FEISHU_OAUTH_COMMON_REASONS.map((item) => `${item.code ?? ''}${item.title}${item.reason}${item.action}`).join('｜');
    expect(joined).toContain('20027');
    expect(joined).toContain('offline_access');
    expect(joined).toContain('im:resource');
    expect(joined).toContain('20010');
    expect(joined).toContain('可用范围');
    expect(joined).toContain('未发布');
    for (const reason of FEISHU_OAUTH_COMMON_REASONS) {
      expect(reason.reason.length).toBeGreaterThan(0);
      expect(reason.action.length).toBeGreaterThan(0);
    }
  });

  it('飞书开放平台入口是通用应用列表（不编造 appId deep link）', () => {
    expect(FEISHU_OPEN_PLATFORM_URL).toBe('https://open.feishu.cn/app');
  });
});
