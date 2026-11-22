/**
 * 待办到期提醒：到点（或提前 N 分钟）提示音 +（页面不在前台时）桌面通知，点击直达待办页。
 * 评审 P0-2——「明天 10:00 评审会」到了 10:00 LinkHub 得叫你，待办不能只是个被动清单。
 *
 * 数据模型：待办就是一条 `type='todo'` 的消息（dueAt / todoTitle / done），所以提醒只依赖
 * 消息流：服务端 / Mock 增删改待办，这里自动跟随，不需要独立的提醒存储。
 *
 * 规则：
 *  - 提前量 `todoReminderLeadMin`（0 = 到点才提醒）；
 *  - 每条待办只提醒一次（traceId 登记）；`todoReminder` 关闭时同样登记——之后打开开关
 *    不把积压的逾期待办补响一串（与消息提醒同一原则：设置只影响之后的变化）；
 *  - 首轮加载（ready 后第一轮）只登记不提醒：历史逾期在待办页有「已逾期」分组常驻可见，
 *    开个页面就响一串是骚扰；
 *  - 30s 心跳：没有新消息进来、纯时间流逝也要能触发到期瞬间；
 *  - 复用新消息提醒的管线（playUrgentChime / showSystemNotification）与通道开关
 *    （urgentSound / urgentDesktop），不另造一套声音；
 *  - 刻意**不受免打扰时段影响**：免打扰挡的是「别人来的消息」，待办是你自己定的
 *    约会，静音掉就违背「不漏事」——设置页的免打扰描述同步写明了这条边界。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UnifiedMessage } from '../types';
import { usePreferences } from '../features/settings/preferences';
import { platformMeta } from '../utils/format';
import { playUrgentChime, primeUrgentAudio, showSystemNotification } from '../utils/urgentAlert';

/** 心跳周期：到期瞬间的最大提醒延迟（不用 1s 是避免无谓的重渲染） */
const TICK_MS = 30_000;

/** dueAt 解析：缺失 / 非法（不伪造时间）返回 null，不参与提醒 */
function dueAtMs(todo: UnifiedMessage): number | null {
  if (!todo.dueAt) return null;
  const t = Date.parse(todo.dueAt);
  return Number.isNaN(t) ? null : t;
}

export function useTodoReminders(todos: UnifiedMessage[], ready: boolean): void {
  const prefs = usePreferences();
  const navigate = useNavigate();

  /** 已登记的 traceId；null = 尚未完成首轮登记 */
  const notified = useRef<Set<string> | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // 心跳：ready 后每 30s 推一次「现在」，让纯时间流逝也能触发到期
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [ready]);

  // 浏览器自动播放策略：与消息提醒一致，首个用户手势解锁音频
  useEffect(() => {
    const unlock = (): void => {
      primeUrgentAudio();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    // 首轮登记：只登记「已过提醒点的」待办为历史（含无截止的），开页不补提醒；
    // 未来才到期的**不登记**——留给心跳在到点瞬间触发，否则加载时就存在的待办永远不响。
    if (notified.current === null) {
      const fireBeforeMs = prefsRef.current.todoReminderLeadMin * 60_000;
      const nowMs = now.getTime();
      notified.current = new Set(
        todos
          .filter((t) => {
            if (t.done) return false; // 完成的不登记：撤销完成后若已过点仍应提醒一次
            const due = dueAtMs(t);
            if (due === null) return true; // 无截止：登记掉，主循环不再反复扫它
            return nowMs >= due - fireBeforeMs;
          })
          .map((t) => t.traceId),
      );
      return;
    }

    const seen = notified.current;
    const { todoReminder, todoReminderLeadMin, urgentSound, urgentDesktop } = prefsRef.current;
    const fireBeforeMs = todoReminderLeadMin * 60_000;

    for (const todo of todos) {
      if (seen.has(todo.traceId)) continue;
      if (todo.done) continue;
      const due = dueAtMs(todo);
      if (due === null) continue;
      if (now.getTime() < due - fireBeforeMs) continue; // 还没到提前量：不登记，到点再提醒

      // 到点（或关闭开关时过点）：一律登记为已见，避免之后改设置补响积压
      seen.add(todo.traceId);
      if (!todoReminder) continue;

      if (urgentSound) playUrgentChime();
      const watching =
        document.visibilityState === 'visible' && document.hasFocus?.() !== false;
      if (urgentDesktop && !watching) {
        const title = todo.todoTitle?.trim() || todo.body;
        showSystemNotification(
          `待办到期 · ${platformMeta(todo.platform).name}`,
          `${title}${todo.dueAt ? `（${formatClock(todo.dueAt)}）` : ''}`,
          () => navigateRef.current('/todos'),
        );
      }
    }
  }, [todos, now, ready]);
}

/** 通知里展示的到期时刻：本地时区 HH:mm（展示层兜底，解析失败不显示） */
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
