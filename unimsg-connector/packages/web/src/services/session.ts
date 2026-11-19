/**
 * 前端登录态（会话令牌 + 当前用户）。
 *
 * 设计：
 *  - 登录后拿到的会话令牌存 localStorage，刷新页面不掉线；
 *  - 没登录时回退到部署令牌（VITE_API_TOKEN），保证单机演示/旧部署仍能直接用；
 *  - 用订阅模式让顶栏、路由守卫等组件同步刷新。
 *
 * 这里只存「令牌 + 用户公开信息」，不存任何口令。
 */
import { useSyncExternalStore } from 'react';
import type { PublicUser } from '../services/api';

const STORAGE_KEY = 'linkhub.session';

export interface Session {
  token: string;
  user: PublicUser;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let current: Session | null = readFromStorage();

function readFromStorage(): Session | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed?.token || !parsed?.user?.username) return null;
    return { token: parsed.token, user: parsed.user as PublicUser };
  } catch {
    return null;
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** 当前登录态（未登录 = null） */
export function getSession(): Session | null {
  return current;
}

/** 当前应该用的 Bearer 令牌：优先会话令牌，否则回退部署令牌 */
export function currentToken(fallback: string): string {
  return current?.token ?? fallback;
}

export function setSession(session: Session): void {
  current = session;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 隐私模式 / 存储禁用：仅内存生效，不影响本次会话
  }
  emit();
}

export function clearSession(): void {
  current = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
  emit();
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 单测用：重置成"未登录" */
export function resetSessionForTest(): void {
  current = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
  emit();
}

/** React 订阅入口：登录/退出后所有用到它的组件自动刷新 */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}