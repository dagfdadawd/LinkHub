import { describe, expect, it } from 'vitest';
import type { OnboardingStep, OnboardingView } from '../services/api';
import {
  CONNECT_STEP_ORDER,
  ONBOARDED_KEY,
  ONBOARDING_STATE_META,
  displayMailAddress,
  dwsSourceLabel,
  isOnboarded,
  markOnboarded,
  maskMailAddress,
  overallProgress,
  resetOnboarded,
  shouldShowOnboardingBanner,
  sortOnboardingSteps,
} from './onboarding';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

function step(id: OnboardingStep['id'], state: OnboardingStep['state']): OnboardingStep {
  return { id, label: id, state, summary: '', hints: [], actions: [] };
}

function view(patch: Partial<OnboardingView> = {}): OnboardingView {
  return {
    firstRun: true,
    dws: { available: false, source: 'missing' },
    overall: { ready: 1, total: 4, needsAction: 3 },
    steps: [step('mail', 'ready'), step('dingtalk', 'needs_install'), step('feishu', 'needs_admin'), step('wecom', 'mock')],
    ...patch,
  };
}

describe('首启标记（localStorage）', () => {
  it('默认未完成；mark 后可读；reset 后重新提示', () => {
    const storage = memoryStorage();
    expect(isOnboarded(storage)).toBe(false);
    markOnboarded(storage);
    expect(storage.data.get(ONBOARDED_KEY)).toBe('1');
    expect(isOnboarded(storage)).toBe(true);
    resetOnboarded(storage);
    expect(isOnboarded(storage)).toBe(false);
  });

  it('storage 不可用时静默降级，不抛错', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(isOnboarded(throwing)).toBe(false);
    expect(() => markOnboarded(throwing)).not.toThrow();
    expect(() => resetOnboarded(throwing)).not.toThrow();
  });
});

describe('shouldShowOnboardingBanner（首启横幅判定）', () => {
  it('未 onboarding 且真实模式：显示', () => {
    expect(shouldShowOnboardingBanner({ demoMode: false, onboarded: false })).toBe(true);
  });

  it('演示模式不打扰（没有真实账号可连）', () => {
    expect(shouldShowOnboardingBanner({ demoMode: true, onboarded: false, firstRun: true })).toBe(false);
  });

  it('点过「稍后 / 去连接」后不再出现', () => {
    expect(shouldShowOnboardingBanner({ demoMode: false, onboarded: true, firstRun: false })).toBe(false);
  });

  it('本地点过「去连接 / 稍后」优先：即使后端 firstRun=true 也不再出现（P1-6）', () => {
    expect(shouldShowOnboardingBanner({ demoMode: false, onboarded: true, firstRun: true })).toBe(false);
    expect(shouldShowOnboardingBanner({ demoMode: false, onboarded: false, firstRun: true })).toBe(true);
  });

  it('全部平台已就绪时不再打扰', () => {
    expect(
      shouldShowOnboardingBanner({ demoMode: false, onboarded: false, firstRun: true, ready: 4, total: 4 }),
    ).toBe(false);
    expect(
      shouldShowOnboardingBanner({ demoMode: false, onboarded: false, firstRun: true, ready: 3, total: 4 }),
    ).toBe(true);
  });
});

describe('状态 Tag / 推荐顺序 / 总进度', () => {
  it('五种状态都有中文 Tag 文案', () => {
    expect(ONBOARDING_STATE_META.ready.label).toBe('已就绪');
    expect(ONBOARDING_STATE_META.needs_user_auth.label).toBe('需本人授权');
    expect(ONBOARDING_STATE_META.needs_install.label).toBe('需安装');
    expect(ONBOARDING_STATE_META.needs_admin.label).toBe('需管理员');
    expect(ONBOARDING_STATE_META.mock.label).toBe('演示模式');
    expect(ONBOARDING_STATE_META.error.label).toBe('异常');
  });

  it('按 邮箱 → 钉钉 → 飞书 → 企微 排序，未知平台放最后', () => {
    const shuffled = [
      { ...step('wecom', 'mock') },
      { ...step('feishu', 'needs_admin') },
      { ...step('mail', 'ready') },
      { ...step('dingtalk', 'needs_install') },
    ];
    expect(sortOnboardingSteps(shuffled).map((s) => s.id)).toEqual(CONNECT_STEP_ORDER);
  });

  it('overallProgress 用后端 overall；缺字段时按 steps 现算', () => {
    expect(overallProgress(view()).label).toBe('已就绪 1 / 4');
    expect(overallProgress(view()).percent).toBe(25);

    const fallback = overallProgress(view({ overall: undefined as unknown as OnboardingView['overall'] }));
    expect(fallback.ready).toBe(1);
    expect(fallback.total).toBe(4);
    expect(fallback.percent).toBe(25);
    expect(overallProgress(null).label).toBe('已就绪 0 / 4');
  });

  it('dws 来源有中文说明', () => {
    expect(dwsSourceLabel('tools')).toContain('内置');
    expect(dwsSourceLabel('missing')).toBe('未找到 dws');
    expect(dwsSourceLabel('anything')).toBe('来源未知');
  });
});

describe('邮箱地址脱敏', () => {
  it('按常见规则打码', () => {
    expect(maskMailAddress('zhangsan@qq.com')).toBe('z***n@qq.com');
    expect(maskMailAddress('ab@qq.com')).toBe('a***@qq.com');
    expect(maskMailAddress('a@qq.com')).toBe('***@qq.com');
    expect(maskMailAddress('not-an-email')).toBe('n***l');
  });

  it('展示时优先用后端脱敏字段，其次再打码；已含 * 的不重复打码', () => {
    expect(displayMailAddress({ maskedAddress: 'z***n@qq.com' })).toBe('z***n@qq.com');
    expect(displayMailAddress({ addressMasked: 'a***b@163.com' })).toBe('a***b@163.com');
    expect(displayMailAddress({ address: 'zhangsan@qq.com' })).toBe('z***n@qq.com');
    expect(displayMailAddress({ address: 'z***n@qq.com' })).toBe('z***n@qq.com');
    expect(displayMailAddress({})).toBe('（地址未返回）');
  });
});
