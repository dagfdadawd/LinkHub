import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { InboxPage } from '../features/inbox/InboxPage';
import { TodosPage } from '../features/todos/TodosPage';
import { TracePage } from '../features/trace/TracePage';
import { AccountsPage } from '../features/accounts/AccountsPage';
import { ConnectPage } from '../features/connect/ConnectPage';
import { LoginPage } from '../features/auth/LoginPage';
import { GroupViewPreview } from '../features/preview/GroupViewPreview';
import { AuthGate } from '../features/auth/AuthGate';
import { AutoReplyPage } from '../features/automation/AutoReplyPage';
import { StatsPage } from '../features/stats/StatsPage';

export function App() {
  return (
    <Routes>
      {/* 登录/注册在壳外：没有账号时也能访问 */}
      <Route path="/login" element={<LoginPage />} />
      {/* 群消息展示方案原型：静态假数据，用于产品决策，不碰真实数据 */}
      <Route path="/preview/groups" element={<GroupViewPreview />} />
      {/* 服务端要求登录（或本机已建账号）时才挡到 /login；零账号演示照常放行 */}
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/:traceId" element={<InboxPage />} />
          <Route path="/todos" element={<TodosPage />} />
          <Route path="/auto-reply" element={<AutoReplyPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/trace" element={<TracePage />} />
          <Route path="/trace/:traceId" element={<TracePage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
