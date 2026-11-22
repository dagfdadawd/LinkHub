/**
 * 前端登录态（会话令牌 + 当前用户）· **支持一台机器上多开账号**。
 *
 * 设计：
 *  - 本机可以同时记着好几个账号（家人、工作号、测试号），侧栏账号菜单里
 *    点一下就换人，不用退出再登录；
 *  - 「账号列表 + 当前是谁」都存 localStorage，刷新页面不掉线；
 *  - 当前账号决定请求用的 Bearer 令牌；切换后实时通道必须重连、数据要重拉，
 *    这两步由调用方（AppShell / 登录页）负责，session 层只管状态；
 *  - 只存「令牌 + 用户公开信息」，不存任何密码。
 *
 * 数据隔离沿用后端语义：每条消息都有 ownerId，各账号只看自己的。
 */
import { useSyncExternalStore } from 'react';
import type { PublicUser } from './api';

/** 多账号列表；旧版本是单账号的 `linkhub.session`，读到时自动迁移过来 */
const STORAGE_KEY = 'linkhub.sessions';
const LEGACY_KEY = 'linkhub.session';

export interface Session {
  token: string;
  user: PublicUser;
}

type Listener = () => void;

const listeners = new Set<Listener>();

/** 名单本身即快照：只在变更时整体替换，别原地改（否则 useSyncExternalStore 认不出变化） */
let accounts: Session[] = [];
let activeToken: string | null = null;
let current: Session | null = null;

/**
 * 「登录已经失效」标记（401 触发）。
 *
 * 为什么不能只靠「session 变 null」判断：本机账号库被重置/清空后，后端会认为
 * 这台机器根本不要求登录，登录守卫按原规则会把用户放行——用户停在一个
 * 只会弹「数据加载异常」的空页面上，既没数据也不知道该去登录。带上这个标记后，
 * 守卫会明确把人送回登录页，并在登录页说明「登录已过期」。
 * 重新登录成功（setSession）时自动清除。
 */
let authExpired = false;

function isSession(value: unknown): value is Session {
  const s = value as Partial<Session> | null;
  return Boolean(s && typeof s.token === 'string' && s.token && s.user && typeof s.user.username === 'string');
}

/** 同一用户只留一条：旧版本重复登录可能写进两条，切换菜单里会重复出现 */
function dedupe(list: Session[]): Session[] {
  const seen = new Set<string>();
  const out: Session[] = [];
  for (const item of list) {
    if (seen.has(item.user.id)) continue;
    seen.add(item.user.id);
    out.push(item);
  }
  return out;
}

function emit(): void {
  for (const fn of listeners) fn();
}

function persist(): void {
  if (typeof window === 'undefined') return;
  try {
    if (accounts.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: activeToken, accounts }));
    // 旧的单账号键不再维护，避免设备上同时存在两处真相
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // 隐私模式 / 存储禁用：仅内存生效，不影响本次会话
  }
}

/**
 * 唯一的状态写入口：算好「现在是谁」，落盘，再通知订阅者。
 * 传入的 active 若已不在名单里（比如刚被退出），自动回落到最后一个账号。
 */
function commit(nextAccounts: Session[], nextActive: string | null): void {
  accounts = nextAccounts;
  const fallback = nextAccounts.length > 0 ? nextAccounts[nextAccounts.length - 1].token : null;
  activeToken =
    nextActive && nextAccounts.some((s) => s.token === nextActive) ? nextActive : fallback;
  current = nextAccounts.find((s) => s.token === activeToken) ?? null;
  persist();
  emit();
}

function readFromStorage(): void {
  if (typeof window === 'undefined') return;
  let loaded: Session[] = [];
  let active: string | null = null;
  /** 读到旧格式或重复项时要立刻按新格式写回，避免设备上长期留着两套数据结构 */
  let needsRewrite = false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { active?: unknown; accounts?: unknown };
      const list = Array.isArray(parsed?.accounts) ? parsed.accounts.filter(isSession) : [];
      loaded = dedupe(list);
      needsRewrite = loaded.length !== list.length;
      active = typeof parsed?.active === 'string' ? parsed.active : null;
    } else {
      const legacy = window.localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const one: unknown = JSON.parse(legacy);
        if (isSession(one)) {
          loaded = [one];
          active = one.token;
          needsRewrite = true;
        }
      }
    }
  } catch {
    loaded = [];
  }
  accounts = loaded;
  activeToken = active && loaded.some((s) => s.token === active) ? active : (loaded[0]?.token ?? null);
  current = loaded.find((s) => s.token === activeToken) ?? null;
  if (needsRewrite) persist();
}

readFromStorage();

/** 当前账号（未登录 = null） */
export function getSession(): Session | null {
  return current;
}

/** 本机记着的所有账号，按加入顺序 */
export function listSessions(): Session[] {
  return accounts;
}

/** 当前应该用的 Bearer 令牌：优先会话令牌，否则回退部署令牌 */
export function currentToken(fallback: string): string {
  return current?.token ?? fallback;
}

/**
 * 登录成功：并入账号列表并切到它。
 * 同一用户再登一次只保留最新令牌（位置不变），不会在菜单里出现两行同名账号。
 */
export function setSession(session: Session): void {
  authExpired = false;
  const index = accounts.findIndex((s) => s.user.id === session.user.id);
  const next = accounts.filter((s) => s.user.id !== session.user.id);
  if (index >= 0) next.splice(Math.min(index, next.length), 0, session);
  else next.push(session);
  commit(next, session.token);
}

/** 切换到已登录的某个账号；成功返回 true（同账号重复点击返回 false） */
export function switchSession(token: string): boolean {
  if (!accounts.some((s) => s.token === token)) return false;
  if (token === activeToken) return false;
  commit(accounts, token);
  return true;
}

/**
 * 退出「当前」账号。
 * 还留着别的账号时自动切过去（多开场景下不该把整台机器一起登出），
 * 一个都不剩时才真正变成未登录。
 */
export function clearSession(): void {
  if (!activeToken) {
    commit([], null);
    return;
  }
  commit(
    accounts.filter((s) => s.token !== activeToken),
    null,
  );
}

/** 只清掉某一个账号（指定退出 / 令牌失效） */
export function removeSession(token: string): void {
  commit(
    accounts.filter((s) => s.token !== token),
    token === activeToken ? null : activeToken,
  );
}

/** 退出全部账号（改密码、退出所有设备） */
export function clearAllSessions(): void {
  authExpired = false;
  commit([], null);
}

/**
 * 标记「登录已失效」：httpApi 收到 401 且本地确有会话时调用（与用户主动退出区分开）。
 * 只打标记，不清名单——由调用方紧接着 `clearSession()`，两者都会通知订阅者。
 */
export function markAuthExpired(): void {
  if (authExpired) return;
  authExpired = true;
  emit();
}

/** 当前是否处于「登录已失效、等待重新登录」状态 */
export function isAuthExpired(): boolean {
  return authExpired;
}

/** React 订阅：登录过期后守卫/页面会自动刷新 */
export function useAuthExpired(): boolean {
  return useSyncExternalStore(subscribeSession, isAuthExpired, isAuthExpired);
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 单测用：重置成"未登录、没有任何账号" */
export function resetSessionForTest(): void {
  accounts = [];
  activeToken = null;
  current = null;
  authExpired = false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // 忽略
  }
  emit();
}

/** React 订阅入口：登录/退出/切换后所有用到它的组件自动刷新 */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

/** 账号列表（侧栏切换菜单用） */
export function useSessions(): Session[] {
  return useSyncExternalStore(subscribeSession, listSessions, listSessions);
}
