/**
 * 登录守卫（放在 AppShell 外层）。
 *
 * 规则刻意保守，避免把「零账号演示」挡死：
 *  - 有本地会话 → 直接放行，不发无意义的请求；
 *  - 没会话 → 问一次后端 `GET /api/auth/status`：
 *      · `requireLogin=true`（显式开启，或本机已经建过账号）→ 跳 /login；
 *      · 否则（纯前端 Mock / 旧后端 / 还没建账号）→ 直接放行，演示照旧可用。
 *
 * 会话过期也在这里兜底：httpApi 收到 401 会清掉本地会话，本组件订阅到 session 变化后
 * 重新求值，用户会立刻被送回登录页而不是停在一个永远空白的收件箱。
 */
import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { services } from '../../store';
import { useSession } from '../../services/session';

type GateState = 'checking' | 'open' | 'login';

export function AuthGate() {
  const session = useSession();
  const location = useLocation();
  const [gate, setGate] = useState<GateState>(session ? 'open' : 'checking');

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