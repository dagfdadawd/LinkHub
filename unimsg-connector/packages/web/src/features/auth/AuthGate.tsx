/**
 * 登录守卫（放在 AppShell 外层）。
 *
 * 规则刻意保守，避免把「零账号演示」挡死：
 *  - 有本地会话 → 直接放行，不发无意义的请求；
 *  - 没会话 → 问一次后端 `GET /api/auth/status`：
 *      · `requireLogin=true`（显式开启，或本机已经建过账号）→ 跳 /login；
 *      · 否则（纯前端 Mock / 旧后端 / 还没建账号）→ 直接放行，演示照旧可用。
 *
 * 会话失效（401）也在这里兜底：
 *  - httpApi 收到 401 会打上 `markAuthExpired()` 并清掉本地会话；
 *  - 本组件订阅会话与「已失效」标记，**只要标记在就强制去登录页**——
 *    不能只等 `requireLogin`：账号库被重置/清空时后端会说「不要求登录」，
 *    按旧逻辑会把用户放行到一个只会弹「数据加载异常」的空页面；
 *  - 登录成功后 setSession 会清掉标记，用户自然回到正常页面。
 */
import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { services, store } from '../../store';
import { useAuthExpired, useSession } from '../../services/session';

type GateState = 'checking' | 'open' | 'login';

export function AuthGate() {
  const session = useSession();
  const expired = useAuthExpired();
  const location = useLocation();
  const [gate, setGate] = useState<GateState>(session ? 'open' : 'checking');

  // 认证放行后才连 WS / 拉数据：登录前不拿 dev-token 去撞 401。
  // 登录、退出、切换账号都会让 token 变化，这里用同一个 effect 统一重连。
  useEffect(() => {
    if (gate !== 'open') return;
    void store.init();
    services.realtime.reconnectNow?.();
  }, [gate, session?.token]);

  useEffect(() => {
    if (session) {
      setGate('open');
      return;
    }
    let alive = true;
    setGate('checking');
    services.api
      .authStatus()
      .then((status) => {
        if (alive) setGate(status.requireLogin ? 'login' : 'open');
      })
      // 后端不可达 / 接口不存在：按「不要求登录」处理，宁可放行也不要卡在空白页
      .catch(() => {
        if (alive) setGate('open');
      });
    return () => {
      alive = false;
    };
  }, [session]);

  // 登录已失效：无论后端说要不要登录，都必须回登录页并说明原因
  if (expired && !session) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname, expired: true }}
      />
    );
  }

  if (gate === 'login') {
    // 记住来路：登录成功后可以回到原来想看的页面
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (gate === 'checking') {
    return (
      <div className="auth-gate" role="status" aria-live="polite">
        <Spin size="large" />
        <span className="auth-gate__text">正在检查登录状态…</span>
      </div>
    );
  }

  return <Outlet />;
}
