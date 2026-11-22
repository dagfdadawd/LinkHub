/**
 * 多账号会话层：一台机器上记着若干个账号，随时切换。
 *
 * 这里的每条断言都对应一个真实使用场景（家人号 / 工作号 / 测试号）：
 *  - 再登一个账号不会把上一个顶掉；
 *  - 同一账号重复登录只留一条（菜单里不该出现两行同名）；
 *  - 切换只改「当前是谁」，名单不变；
 *  - 退出当前账号要落到别的账号上，而不是把整台机器登出；
 *  - 旧版本的单账号存储要能无损迁移。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllSessions,
  clearSession,
  currentToken,
  getSession,
  isAuthExpired,
  listSessions,
  markAuthExpired,
  removeSession,
  resetSessionForTest,
  setSession,
  subscribeSession,
  switchSession,
} from './session';

const user = (id: string, username: string, displayName = username) => ({
  id,
  username,
  displayName,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const alice = { token: 'token-a', user: user('u1', 'alice', '爱丽丝') };
const bob = { token: 'token-b', user: user('u2', 'bob', '鲍勃') };

beforeEach(() => {
  resetSessionForTest();
  window.localStorage.clear();
});

describe('多账号会话', () => {
  it('再登一个账号不会顶掉上一个，当前账号是最后登的那个', () => {
    setSession(alice);
    setSession(bob);

    expect(listSessions().map((s) => s.user.username)).toEqual(['alice', 'bob']);
    expect(getSession()?.user.username).toBe('bob');
    // 令牌跟着当前账号走，否则请求会拿错身份
    expect(currentToken('deploy-token')).toBe('token-b');
  });

  it('同一账号重复登录只保留一条，令牌换成最新的', () => {
    setSession(alice);
    setSession(bob);
    setSession({ token: 'token-a2', user: alice.user });

    expect(listSessions()).toHaveLength(2);
    expect(listSessions()[0].token).toBe('token-a2');
    expect(getSession()?.token).toBe('token-a2');
  });

  it('切换账号只改「当前是谁」，名单与令牌都不动', () => {
    setSession(alice);
    setSession(bob);

    expect(switchSession('token-a')).toBe(true);
    expect(getSession()?.user.username).toBe('alice');
    expect(currentToken('deploy-token')).toBe('token-a');
    expect(listSessions()).toHaveLength(2);

    // 切到当前账号 = 没变化
    expect(switchSession('token-a')).toBe(false);
    // 不认识令牌：拒绝，不抛错
    expect(switchSession('token-x')).toBe(false);
    expect(getSession()?.user.username).toBe('alice');
  });

  it('退出当前账号会落到剩下的账号上，而不是整台机器登出', () => {
    setSession(alice);
    setSession(bob);

    clearSession();
    expect(listSessions().map((s) => s.user.username)).toEqual(['alice']);
    expect(getSession()?.user.username).toBe('alice');

    clearSession();
    expect(listSessions()).toHaveLength(0);
    expect(getSession()).toBeNull();
    // 一个账号都不剩时才回退到部署令牌
    expect(currentToken('deploy-token')).toBe('deploy-token');
  });

  it('只退某个账号：退的是别人时当前账号不变', () => {
    setSession(alice);
    setSession(bob);

    removeSession('token-a');
    expect(getSession()?.user.username).toBe('bob');

    removeSession('token-b');
    expect(getSession()).toBeNull();
  });

  it('名单与当前账号都落盘，刷新页面还在', () => {
    setSession(alice);
    setSession(bob);
    switchSession('token-a');

    const raw = window.localStorage.getItem('linkhub.sessions');
    expect(raw).toBeTruthy();
    const stored = JSON.parse(String(raw)) as { active: string; accounts: Array<{ token: string }> };
    expect(stored.active).toBe('token-a');
    expect(stored.accounts.map((a) => a.token)).toEqual(['token-a', 'token-b']);
  });

  it('退出全部：名单清空、本地存储一并删掉', () => {
    setSession(alice);
    setSession(bob);
    clearAllSessions();

    expect(listSessions()).toHaveLength(0);
    expect(getSession()).toBeNull();
    expect(window.localStorage.getItem('linkhub.sessions')).toBeNull();
  });

  it('旧版单账号存储（linkhub.session）自动迁移成多账号列表', async () => {
    vi.resetModules();
    window.localStorage.setItem('linkhub.session', JSON.stringify(alice));

    const fresh = await import('./session');
    expect(fresh.getSession()?.token).toBe('token-a');
    expect(fresh.listSessions()).toHaveLength(1);
    // 迁移后立刻写回新键，旧键清掉，避免两处真相
    expect(window.localStorage.getItem('linkhub.sessions')).toContain('token-a');
    expect(window.localStorage.getItem('linkhub.session')).toBeNull();
  });

  it('存储里是坏数据时当作未登录，不抛错', async () => {
    vi.resetModules();
    window.localStorage.setItem('linkhub.sessions', '{ not json');

    const fresh = await import('./session');
    expect(fresh.getSession()).toBeNull();
    expect(fresh.listSessions()).toHaveLength(0);
  });
});

describe('登录失效标记（401 兜底）', () => {
  it('默认没有失效标记', () => {
    expect(isAuthExpired()).toBe(false);
  });

  it('标记失效后即使会话被清空，也能区分「过期」与「主动退出」', () => {
    setSession(alice);
    markAuthExpired();
    clearSession();
    expect(getSession()).toBeNull();
    expect(isAuthExpired()).toBe(true);
  });

  it('重新登录成功会清掉失效标记（否则登录页会一直提示已过期）', () => {
    markAuthExpired();
    setSession(bob);
    expect(isAuthExpired()).toBe(false);
  });

  it('主动退出全部账号不算「失效」，不需要提示重新登录', () => {
    setSession(alice);
    clearAllSessions();
    expect(isAuthExpired()).toBe(false);
  });

  it('标记变化会通知订阅者（登录守卫据此立即跳登录页）', () => {
    const listener = vi.fn();
    const off = subscribeSession(listener);
    markAuthExpired();
    expect(listener).toHaveBeenCalledTimes(1);
    // 重复标记不重复通知
    markAuthExpired();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
