import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_SMOKE_BASE,
  FIRST_RUN_DISMISS_KEY,
  FirstRunGuide,
  isEmptyFirstRun,
  readFirstRunDismissed,
  shouldShowFirstRun,
  smokeBaseUrl,
} from './FirstRunGuide';
import type { FirstRunStorage } from './FirstRunGuide';
import { ACCOUNTS } from '../services/mock/fixtures';
import { Platform } from '../types';

const BASE_PROPS = {
  demoMode: false,
  messageCount: 0,
  received: 0,
  accounts: ACCOUNTS,
  connection: 'connected' as const,
};

/** 内存存储：测试不依赖 jsdom localStorage，断言写入值 */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage: FirstRunStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
  return { storage, map };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('FirstRunGuide 客户化（白号 P0-1/P1-5）', () => {
  it('首屏只给客户路径：去连接账号 / 先体验演示，不暴露开发者命令与 env 键名', () => {
    const { storage } = memoryStorage();
    render(
      <FirstRunGuide
        {...BASE_PROPS}
        storage={storage}
        needsAdminCount={2}
        needsAuthCount={2}
        onOpenConnect={() => {}}
        onDemo={() => {}}
      />,
    );

    expect(screen.getByTestId('first-run-guide')).toBeInTheDocument();
    expect(screen.getByText('后端已连上，但还没有消息')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /去连接账号/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /先体验演示（注入示例消息）/ })).toBeInTheDocument();

    // 四平台当前通道：Mock 统一叫「演示模式」，不再出现「Mock 模拟」混用
    for (const platform of [Platform.FEISHU, Platform.DINGTALK, Platform.WECHAT, Platform.MAIL]) {
      expect(screen.getByTestId(`first-run-mode-${platform}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('first-run-mode-feishu')).toHaveTextContent('飞书 · 真实接口');
    expect(screen.getByTestId('first-run-mode-dingtalk')).toHaveTextContent('钉钉 · 演示模式');
    expect(screen.getByTestId('first-run-mode-wechat')).toHaveTextContent('微信 · 演示模式');
    expect(screen.getByTestId('first-run-mode-mail')).toHaveTextContent('邮箱 · 真实接口');

    // 开发者命令默认折叠，不在首屏直接铺开（展开后才可见）
    const devDetails = screen.getByText('开发者：命令行方式（可选）').closest('details');
    expect(devDetails).not.toBeNull();
    expect(devDetails?.open).toBe(false);
    expect(devDetails?.textContent).toContain('python scripts/smoke.py');
    expect(devDetails?.textContent).toContain('pnpm run doctor');

    // 不再把内部变量名直接铺给客户（折叠进「需要管理员配置」）
    const visibleText = document.body.textContent ?? '';
    expect(visibleText).not.toContain('FEISHU_APP_ID');
    expect(visibleText).not.toContain('WECHAT_BRIDGE_URL');
    const adminDetails = screen.getByTestId('first-run-admin-config');
    expect(adminDetails.textContent).toContain('需要管理员配置（2 个平台）');
    expect(adminDetails.textContent).toContain('另有 2 项可自己登录/添加');
  });

  it('主 CTA：去连接账号；次 CTA：先体验演示', async () => {
    const user = userEvent.setup();
    const onOpenConnect = vi.fn();
    const onDemo = vi.fn();
    const { storage } = memoryStorage();
    render(
      <FirstRunGuide
        {...BASE_PROPS}
        storage={storage}
        onOpenConnect={onOpenConnect}
        onDemo={onDemo}
      />,
    );

    await user.click(screen.getByRole('button', { name: /去连接账号/ }));
    expect(onOpenConnect).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /先体验演示（注入示例消息）/ }));
    expect(onDemo).toHaveBeenCalledTimes(1);
  });

  it('第 3 步指向真实存在的「连接账号」入口，不再写「平台账号页点连接本人账号」', () => {
    render(<FirstRunGuide {...BASE_PROPS} onOpenConnect={() => {}} />);
    expect(screen.getByRole('button', { name: /去「连接账号」查看状态/ })).toBeInTheDocument();
    expect(screen.queryByText(/到「平台账号」页点「连接本人账号」/)).not.toBeInTheDocument();
  });

  it('已有消息时不显示', () => {
    const { storage } = memoryStorage();
    render(<FirstRunGuide {...BASE_PROPS} messageCount={1} storage={storage} />);
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
  });

  it('加载中不显示（数据未就绪时不误报空收件箱）', () => {
    const { storage } = memoryStorage();
    render(<FirstRunGuide {...BASE_PROPS} loading storage={storage} />);
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
  });

  it('加载失败（error）时不显示，绝不谎称「后端已连上」', () => {
    const { storage } = memoryStorage();
    render(<FirstRunGuide {...BASE_PROPS} error="无法连接后端服务，请确认服务已启动" storage={storage} />);
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
  });

  it('前端 Mock 演示模式不显示', () => {
    const { storage } = memoryStorage();
    render(<FirstRunGuide {...BASE_PROPS} demoMode storage={storage} />);
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
  });

  it('后端已经收到过消息（received > 0）不显示', () => {
    const { storage } = memoryStorage();
    render(<FirstRunGuide {...BASE_PROPS} received={3} storage={storage} />);
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
  });

  it('已点过「知道了」（localStorage 标记）不显示', () => {
    const { storage } = memoryStorage({ [FIRST_RUN_DISMISS_KEY]: '1' });
    render(<FirstRunGuide {...BASE_PROPS} storage={storage} />);
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
  });

  it('点「知道了」写入 linkhub.firstRunDismissed 并关闭引导', async () => {
    const user = userEvent.setup();
    render(<FirstRunGuide {...BASE_PROPS} />);

    expect(screen.getByTestId('first-run-guide')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '知道了' }));

    expect(window.localStorage.getItem(FIRST_RUN_DISMISS_KEY)).toBe('1');
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
  });

  it('账号状态未上报时四个平台仍展示为「通道未知」，不丢平台', () => {
    const { storage } = memoryStorage();
    render(<FirstRunGuide {...BASE_PROPS} accounts={[]} storage={storage} />);
    expect(screen.getByTestId('first-run-guide')).toBeInTheDocument();
    expect(screen.getAllByText(/通道未知/)).toHaveLength(4);
  });

  it('实时连接异常时如实展示连接质量（不影响显示条件）', () => {
    const { storage } = memoryStorage();
    render(<FirstRunGuide {...BASE_PROPS} connection="reconnecting" storage={storage} />);
    expect(screen.getByText('实时连接重连中')).toBeInTheDocument();
  });

  it('localStorage 读写抛错时不影响展示与关闭（隐私模式降级）', async () => {
    const user = userEvent.setup();
    const throwingStorage: FirstRunStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    render(<FirstRunGuide {...BASE_PROPS} storage={throwingStorage} />);

    expect(screen.getByTestId('first-run-guide')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByTestId('first-run-guide')).not.toBeInTheDocument();
  });
});

describe('FirstRunGuide 判定与命令工具函数', () => {
  it('shouldShowFirstRun 只在「真实后端 + 无消息 + 未关闭」时返回 true', () => {
    const base = { demoMode: false, messageCount: 0, received: 0, dismissed: false };
    expect(shouldShowFirstRun(base)).toBe(true);
    expect(shouldShowFirstRun({ ...base, demoMode: true })).toBe(false);
    expect(shouldShowFirstRun({ ...base, messageCount: 1 })).toBe(false);
    expect(shouldShowFirstRun({ ...base, received: 1 })).toBe(false);
    expect(shouldShowFirstRun({ ...base, dismissed: true })).toBe(false);
    // isEmptyFirstRun 与「知道了」无关：用于空收件箱时替换误导性的「没有匹配的消息」
    expect(isEmptyFirstRun({ demoMode: false, messageCount: 0, received: 0 })).toBe(true);
    expect(isEmptyFirstRun({ demoMode: true, messageCount: 0, received: 0 })).toBe(false);
  });

  it('readFirstRunDismissed 容错：无存储/标记缺失/抛错都按未关闭处理', () => {
    expect(readFirstRunDismissed(undefined)).toBe(false);
    expect(readFirstRunDismissed(memoryStorage().storage)).toBe(false);
    expect(readFirstRunDismissed(memoryStorage({ [FIRST_RUN_DISMISS_KEY]: '1' }).storage)).toBe(true);
    const throwingStorage: FirstRunStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
    };
    expect(readFirstRunDismissed(throwingStorage)).toBe(false);
  });

  it('smokeBaseUrl 跟随 VITE_API_BASE，相对路径回退默认端口', () => {
    expect(smokeBaseUrl(undefined)).toBe(DEFAULT_SMOKE_BASE);
    expect(smokeBaseUrl('')).toBe(DEFAULT_SMOKE_BASE);
    expect(smokeBaseUrl('http://127.0.0.1:4001/')).toBe('http://127.0.0.1:4001');
    expect(smokeBaseUrl('https://linkhub.example.com')).toBe('https://linkhub.example.com');
    // 同源部署（'/'）时冒烟脚本仍需要一个绝对地址
    expect(smokeBaseUrl('/')).toBe(DEFAULT_SMOKE_BASE);
  });
});
