import type { RealtimeStatus } from '../services/realtime';

const META: Record<RealtimeStatus, { label: string; color: string }> = {
  connected: { label: '服务已连接', color: '#52c41a' },
  reconnecting: { label: '服务重连中', color: '#faad14' },
  offline: { label: '服务未连接', color: '#ff4d4f' },
};

export function ConnectionDot({ status }: { status: RealtimeStatus }) {
  const meta = META[status];
  return (
    <span className={`connection-dot connection-dot--${status}`} title={meta.label}>
      <span className="connection-dot__dot" style={{ background: meta.color }} />
      <span className="connection-dot__label">{meta.label}</span>
    </span>
  );
}