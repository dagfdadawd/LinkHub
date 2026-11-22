/**
 * 周期心跳「现在」：Snooze 到期（useSnoozeAlerts）、纯时间流逝类判定共用。
 * 默认 30s——到期瞬间的最大感知延迟，换来的不是每秒全树重渲染。
 */
import { useEffect, useState } from 'react';

export function useNowTick(intervalMs = 30_000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
