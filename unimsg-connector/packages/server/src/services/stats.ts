/**
 * 统计看板计算（纯函数，不依赖存储实现）。
 *
 * 数据来源通过 StatsSource 注入：主代理把 MessageService / Repository 接进来即可，
 * 本模块只负责「给一批消息 + 闭环日志 → 一份 StatsOverview」的口径计算，
 * 便于单测覆盖每个统计口径而不需要起真实服务。
 *
 * 口径（与赛题「状态流转与数据反馈」看板对齐）：
 *  - inbound  = direction !== 'out'（缺省按入站处理，兼容旧数据 / Mock）
 *  - outbound = direction === 'out'
 *  - replied  = status ∈ {replied, sent, synced} 或 replies 非空（失败但回过一次也算"回过"）
 *  - pending  = status ∈ {received, processing}
 *  - failed   = status === 'failed'
 *  - todos    = type === 'todo'；done = done === true（两者独立：未完成的待办不计 done）
 *  - delivery = delivery.mode === 'real' / 'mock' 分别计数（与「绝不把 Mock 伪装成真实」同一原则）
 *  - avgHandleSeconds：每条消息从闭环日志取「最早的发起事件（received，兼容 compose(d) 主动发送）」
 *    到「最早的 sent」的时间差；只统计两端都存在且差值 ≥ 0 的样本，无样本返回 null（不伪造 0）。
 *
 * byPlatform 按 Platform 枚举补齐四个平台（没有数据的平台也出现、各项为 0），
 * 前端表格不需要做「缺行补零」；出现枚举之外的平台字符串时也保留（防御未知平台丢数据）。
 */
import { MsgStatus, Platform, type StatsOverview, type TraceEntry, type UnifiedMessage } from '@unimsg/shared';

/** 统计的数据源：主代理用 MessageService / Repository 适配出这个接口即可 */
export interface StatsSource {
  /** 全量消息（统计不看 viewer 视角，服务端看板用全量口径） */
  listMessages(): UnifiedMessage[];
  /** 一条消息的闭环日志（全链路回放同一份数据） */
  getLoopLog(traceId: string): TraceEntry[];
  /** 死信队列条数（投递彻底失败、待人工处理的消息数） */
  dlqCount(): number;
  /** 自动回复规则统计；未接入规则功能时可不提供（按 0/0 计） */
  rules?(): { total: number; hits: number };
}

/** replied 判定：终态里"已经回出去"的三个状态，或历史上至少有一条回复 */
const REPLIED_STATUSES: ReadonlySet<string> = new Set<string>([
  MsgStatus.REPLIED,
  MsgStatus.SENT,
  MsgStatus.SYNCED,
]);

/** pending 判定：还没走完闭环的两个中间态 */
const PENDING_STATUSES: ReadonlySet<string> = new Set<string>([
  MsgStatus.RECEIVED,
  MsgStatus.PROCESSING,
]);

function emptyPlatformRow(platform: Platform): StatsOverview['byPlatform'][number] {
  return { platform, total: 0, inbound: 0, outbound: 0, replied: 0, pending: 0, failed: 0 };
}

/**
 * 从一条闭环日志里算「收到 → 发出」的秒数：
 *  - 起点：最早的 received（主动发送兼容 composed —— 现网 writeTrace 用的就是 'composed'，
 *    同时兼容任务口径里的 'compose'，两个拼写都认）；
 *  - 终点：最早的 sent（重试成功时取第一次成功送达，不惩罚网络抖动）；
 *  - 任一端缺失 / 时间解析失败 / 差值为负（时钟回拨等脏数据）→ 不算样本。
 */
function handleSecondsOf(log: TraceEntry[]): number | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const e of log) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    if ((e.event === 'received' || e.event === 'compose' || e.event === 'composed') && (start === null || at < start)) {
      start = at;
    }
    if (e.event === 'sent' && (end === null || at < end)) {
      end = at;
    }
  }
  if (start === null || end === null) return null;
  const diffMs = end - start;
  return diffMs >= 0 ? diffMs / 1000 : null;
}

/** 按上述口径把一批消息 + 闭环日志汇总成看板数据 */
export function computeStats(src: StatsSource): StatsOverview {
  const totals = {
    messages: 0,
    inbound: 0,
    outbound: 0,
    replied: 0,
    pending: 0,
    failed: 0,
    todos: 0,
    done: 0,
  };
  const byStatus: Record<string, number> = {};
  const delivery = { real: 0, mock: 0 };

  // 四个平台先补齐占位（没有数据的平台也是看板的一行，前端不用自己补零）
  const rows = new Map<string, StatsOverview['byPlatform'][number]>();
  for (const p of Object.values(Platform)) rows.set(p, emptyPlatformRow(p));

  const handleSamples: number[] = [];

  for (const m of src.listMessages()) {
    totals.messages += 1;

    const inbound = m.direction !== 'out';
    if (inbound) totals.inbound += 1;
    else totals.outbound += 1;

    const replied = REPLIED_STATUSES.has(m.status) || (m.replies?.length ?? 0) > 0;
    if (replied) totals.replied += 1;

    const pending = PENDING_STATUSES.has(m.status);
    if (pending) totals.pending += 1;

    const failed = m.status === MsgStatus.FAILED;
    if (failed) totals.failed += 1;

    if (m.type === 'todo') totals.todos += 1;
    if (m.done === true) totals.done += 1;

    byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;

    if (m.delivery?.mode === 'real') delivery.real += 1;
    else if (m.delivery?.mode === 'mock') delivery.mock += 1;

    // 枚举之外的平台字符串也保留：宁可多一行也不静默丢数据
    const key = String(m.platform);
    let row = rows.get(key);
    if (!row) {
      row = emptyPlatformRow(key as Platform);
      rows.set(key, row);
    }
    row.total += 1;
    if (inbound) row.inbound += 1;
    else row.outbound += 1;
    if (replied) row.replied += 1;
    if (pending) row.pending += 1;
    if (failed) row.failed += 1;

    // 平均处理时长样本：只对有 traceId 且日志里两端齐全的消息统计
    if (m.traceId) {
      const seconds = handleSecondsOf(src.getLoopLog(m.traceId));
      if (seconds !== null) handleSamples.push(seconds);
    }
  }

  const avgHandleSeconds =
    handleSamples.length === 0
      ? null
      : handleSamples.reduce((sum, s) => sum + s, 0) / handleSamples.length;

  return {
    totals,
    byPlatform: [...rows.values()],
    byStatus,
    delivery,
    dlq: src.dlqCount(),
    avgHandleSeconds,
    rules: src.rules?.() ?? { total: 0, hits: 0 },
    generatedAt: new Date().toISOString(),
  };
}
