/**
 * 授权中心 / 首次使用向导的前端纯函数与常量（无 React 依赖，便于单测）。
 *
 * 设计原则：
 *  - 首启提示只用 localStorage 记「别再打扰我」，后端 onboarding.firstRun 作为补充信号；
 *  - 状态文案与颜色集中在这里，页面只渲染，避免同一状态出现两种叫法；
 *  - 邮箱地址脱敏是兜底：后端已脱敏时直接用后端的，后端未脱敏时前端再打一次码。
 */
import type {
  MailAccountView,
  OnboardingState,
  OnboardingStep,
  OnboardingView,
} from '../services/api';

/** 「已在向导里点过连接/稍后」的本地标记；清掉它即可让首启提示重新出现 */
export const ONBOARDED_KEY = 'linkhub.onboarded';

export interface OnboardingFlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage 在隐私模式 / 非浏览器环境可能不可用：失败时静默降级为「不记忆」 */
export function defaultOnboardingStorage(): OnboardingFlagStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isOnboarded(storage: OnboardingFlagStorage | null = defaultOnboardingStorage()): boolean {
  try {
    return storage?.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markOnboarded(storage: OnboardingFlagStorage | null = defaultOnboardingStorage()): void {
  try {
    storage?.setItem(ONBOARDED_KEY, '1');
  } catch {
    // 存不了就下次再提示，不影响当前操作
  }
}

/** 手动重新打开首启提示（设置页/账号页可用） */
export function resetOnboarded(storage: OnboardingFlagStorage | null = defaultOnboardingStorage()): void {
  try {
    storage?.setItem(ONBOARDED_KEY, '0');
  } catch {
    // ignore
  }
}

/**
 * 收件箱顶部首启提示是否出现：
 *  - 纯前端演示模式不打扰（没有真实账号可连，引导只会添乱）；
 *  - 四个平台都已就绪时不再打扰；
 *  - 点过「去连接 / 稍后再说」（localStorage 标记）后不再出现；
 *  - 后端 firstRun 明确为 true 时，即使本地有旧标记也重新提示（换环境/换账号后引导仍然有用）。
 */
export function shouldShowOnboardingBanner(opts: {
  demoMode: boolean;
  onboarded: boolean;
  firstRun?: boolean;
  ready?: number;
  total?: number;
}): boolean {
  if (opts.demoMode) return false;
  if (opts.total !== undefined && opts.total > 0 && (opts.ready ?? 0) >= opts.total) return false;
  if (opts.onboarded && opts.firstRun !== true) return false;
  return true;
}

/** 平台状态 Tag 文案 + 语义色（与页面 CSS 的 tone 对应） */
export interface OnboardingStateMeta {
  label: string;
  tone: 'ok' | 'auth' | 'install' | 'admin' | 'mock' | 'error';
  /** AntD Tag 可直接用的颜色名 */
  tagColor: string;
}

export const ONBOARDING_STATE_META: Record<OnboardingState, OnboardingStateMeta> = {
  ready: { label: '已就绪', tone: 'ok', tagColor: 'success' },
  needs_user_auth: { label: '需本人授权', tone: 'auth', tagColor: 'processing' },
  needs_install: { label: '需安装', tone: 'install', tagColor: 'warning' },
  needs_admin: { label: '需管理员', tone: 'admin', tagColor: 'gold' },
  mock: { label: '演示模式', tone: 'mock', tagColor: 'default' },
  error: { label: '异常', tone: 'error', tagColor: 'error' },
};

/** 推荐连接顺序：邮箱 → 钉钉 → 飞书 → 企微（个人版从最容易见效的邮箱开始） */
export const CONNECT_STEP_ORDER: OnboardingStep['id'][] = ['mail', 'dingtalk', 'feishu', 'wecom'];

export function stepOrder(id: string): number {
  const index = CONNECT_STEP_ORDER.indexOf(id as OnboardingStep['id']);
  return index === -1 ? CONNECT_STEP_ORDER.length : index;
}

/** 后端 steps 顺序可能不同：按推荐顺序稳定排序，未知平台排最后 */
export function sortOnboardingSteps(steps: OnboardingStep[]): OnboardingStep[] {
  return [...steps].sort((a, b) => stepOrder(a.id) - stepOrder(b.id));
}

export interface OnboardingProgress {
  ready: number;
  total: number;
  needsAction: number;
  percent: number;
  label: string;
}

/** 顶部总进度：以后端 overall 为准，缺失时按 steps 现算，避免出现「0 / 0」 */
export function overallProgress(view?: OnboardingView | null): OnboardingProgress {
  const fallbackTotal = view?.steps?.length ?? 4;
  const fallbackReady = view?.steps?.filter((s) => s.state === 'ready').length ?? 0;
  const total = Math.max(0, view?.overall?.total ?? fallbackTotal);
  const ready = Math.min(total, Math.max(0, view?.overall?.ready ?? fallbackReady));
  const needsAction = Math.max(0, view?.overall?.needsAction ?? total - ready);
  const percent = total > 0 ? Math.round((ready / total) * 100) : 0;
  return { ready, total, needsAction, percent, label: `已就绪 ${ready} / ${total}` };
}

/** dws 来源的人类可读说明（页面用来解释「为什么本机能/不能登录钉钉」） */
export function dwsSourceLabel(source: string | undefined): string {
  switch (source) {
    case 'env':
      return '来自 .env 的 DWS_BIN';
    case 'tools':
      return '内置 tools 目录（无需手动安装）';
    case 'user_profile':
      return '用户目录 ~/.local/bin';
    case 'path':
      return '系统 PATH';
    case 'missing':
      return '未找到 dws';
    default:
      return '来源未知';
  }
}

/**
 * 邮箱地址脱敏：`zhangsan@qq.com` → `zh***n@qq.com`。
 * 后端已给 maskedAddress/addressMasked 时页面优先用后端的，这里只做兜底。
 */
export function maskMailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return address.length > 2 ? `${address[0]}***${address[address.length - 1]}` : '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length <= 1) return `***@${domain}`;
  if (local.length === 2) return `${local[0]}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/** 列表里展示的邮箱地址：优先后端脱敏字段，其次对 address 打码 */
export function displayMailAddress(account: Pick<MailAccountView, 'address' | 'maskedAddress' | 'addressMasked'>): string {
  if (account.maskedAddress) return account.maskedAddress;
  if (account.addressMasked) return account.addressMasked;
  if (!account.address) return '（地址未返回）';
  // 后端可能已经返 · 或 * 的脱敏地址：再打一次码会把 · 也吃掉，直接展示
  if (/[*·]/.test(account.address)) return account.address;
  return maskMailAddress(account.address);
}