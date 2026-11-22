import { PRIORITY_RANK } from '../types';
import type { UnifiedMessage } from '../types';

/**
 * 待办的截止时间：格式化 + 分组。
 *
 * 只做展示层面的判断，不编造时间：
 *  - 没有 dueAt 的归入「未设置截止」，不假装有期限；
 *  - 已过期的单独成组，用危险色标出来；
 *  - 分组顺序固定：**紧急 → 已逾期 → 今天 → 本周内 → 更晚 → 未设置**。
 *
 * 「紧急」单独成组而不是只做组内排序：优先级是「先处理哪条」，标了紧急的待办
 * 就该浮到最上面，而不是被埋在一个更靠后的截止分组里。
 */

export interface TodoGroup {
  key: 'urgent' | 'overdue' | 'today' | 'week' | 'later' | 'none';
  label: string;
  items: UnifiedMessage[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function clockOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 截止时间的展示文案与语义色调。
 * 今天之前 = 逾期；今天 = 紧急；其余按"今天/明天/周X/M月D日 + 时刻"。
 */
export function formatDue(
  dueAt?: string,
  now: Date = new Date(),
): { text: string; tone: 'overdue' | 'soon' | 'normal' } | null {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;

  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  const days = Math.round((dueDay.getTime() - today.getTime()) / DAY_MS);
  const time = clockOf(due);

  if (due.getTime() < now.getTime() && days < 0) {
    return { text: `已逾期 · ${due.getMonth() + 1}/${due.getDate()} ${time}`, tone: 'overdue' };
  }
  if (days < 0) return { text: `已逾期 · ${due.getMonth() + 1}/${due.getDate()} ${time}`, tone: 'overdue' };
  if (days === 0) {
    const expired = due.getTime() < now.getTime();
    return {
      text: expired ? `今天 ${time} · 已过点` : `今天 ${time}`,
      tone: expired ? 'overdue' : 'soon',
    };
  }
  if (days === 1) return { text: `明天 ${time}`, tone: 'soon' };
  if (days < 7) return { text: `周${'日一二三四五六'[due.getDay()]} ${time}`, tone: 'normal' };
  return { text: `${due.getMonth() + 1}月${due.getDate()}日 ${time}`, tone: 'normal' };
}

/** 优先级排序号：紧急（0）→ 普通/未判定（1）→ 不急（2） */
function priorityRankOf(item: UnifiedMessage): number {
  return item.priority ? PRIORITY_RANK[item.priority] : PRIORITY_RANK.normal;
}

/** 待办按截止时间分组；组内先按优先级，再按截止/创建时间 */
export function groupTodos(items: UnifiedMessage[], now: Date = new Date()): TodoGroup[] {
  const today = startOfDay(now).getTime();
  const endOfToday = today + DAY_MS;
  const endOfWeek = today + 7 * DAY_MS;

  /** 紧急的先单独拎出来：它们是「先处理哪条」的答案，不该被截止分组埋掉 */
  const urgent: UnifiedMessage[] = [];
  const buckets: Record<Exclude<TodoGroup['key'], 'urgent'>, UnifiedMessage[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
    none: [],
  };

  for (const item of items) {
    if (item.priority === 'urgent') {
      urgent.push(item);
      continue;
    }
    if (!item.dueAt) {
      buckets.none.push(item);
      continue;
    }
    const at = new Date(item.dueAt).getTime();
    if (Number.isNaN(at)) {
      buckets.none.push(item);
    } else if (at < today) {
      buckets.overdue.push(item);
    } else if (at < endOfToday) {
      buckets.today.push(item);
    } else if (at < endOfWeek) {
      buckets.week.push(item);
    } else {
      buckets.later.push(item);
    }
  }

  const byDueTime = (a: UnifiedMessage, b: UnifiedMessage) =>
    new Date(a.dueAt ?? 0).getTime() - new Date(b.dueAt ?? 0).getTime();
  const byCreatedDesc = (a: UnifiedMessage, b: UnifiedMessage) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

  /** 组内：先按优先级（紧急优先、不急最后），再按各自的时间轴 */
  const withPriority =
    (fallback: (a: UnifiedMessage, b: UnifiedMessage) => number) =>
    (a: UnifiedMessage, b: UnifiedMessage) =>
      priorityRankOf(a) - priorityRankOf(b) || fallback(a, b);

  const byDue = withPriority(byDueTime);
  const byCreated = withPriority(byCreatedDesc);

  /** 紧急组：全部同档，按截止时间升序（没截止的排最后），再按创建时间倒序 */
  urgent.sort((a, b) => {
    const da = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
    const db = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
    if (Number.isFinite(da) && Number.isFinite(db) && da !== db) return da - db;
    if (Number.isFinite(da) !== Number.isFinite(db)) return Number.isFinite(da) ? -1 : 1;
    return byCreatedDesc(a, b);
  });

  buckets.overdue.sort(byDue);
  buckets.today.sort(byDue);
  buckets.week.sort(byDue);
  buckets.later.sort(byDue);
  buckets.none.sort(byCreated);

  const groups: TodoGroup[] = [
    { key: 'urgent', label: '紧急', items: urgent },
    { key: 'overdue', label: '已逾期', items: buckets.overdue },
    { key: 'today', label: '今天', items: buckets.today },
    { key: 'week', label: '本周内', items: buckets.week },
    { key: 'later', label: '更晚', items: buckets.later },
    { key: 'none', label: '未设置截止', items: buckets.none },
  ];

  return groups.filter((group) => group.items.length > 0);
}
