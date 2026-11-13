import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { InboxPage } from '../features/inbox/InboxPage';
import { TodosPage } from '../features/todos/TodosPage';
import { TracePage } from '../features/trace/TracePage';
import { AccountsPage } from '../features/accounts/AccountsPage';
import { ConnectPage } from '../features/connect/ConnectPage';
import { DesignLab } from '../features/design-lab/DesignLab';
import { FlowHome } from '../features/design-lab/FlowHome';

export function App() {
  return (
    <Routes>
      <Route path="/designs" element={<DesignLab />} />
      <Route path="/designs/:variant" element={<DesignLab />} />
      <Route path="/" element={<FlowHome />} />
      <Route path="/legacy" element={<Navigate to="/inbox" replace />} />
      <Route element={<AppShell />}>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/inbox/:traceId" element={<InboxPage />} />
        <Route path="/todos" element={<TodosPage />} />
        <Route path="/trace" element={<TracePage />} />
        <Route path="/trace/:traceId" element={<TracePage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/connect" element={<ConnectPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}