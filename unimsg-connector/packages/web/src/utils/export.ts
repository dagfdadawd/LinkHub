/**
 * 看板导出 + 趋势的纯函数层（评审 P1-7）。
 *
 * 刻意不碰 DOM / store：输入消息或 StatsOverview，输出字符串或分桶数组，
 * 这样 CSV 转义、Markdown 结构、按天分桶都能被单测逐字符验证，
 * StatsPage 只负责把它们变成 Blob 交给 download.saveBlobAsFile。
 */
import { platformMeta, STATUS_META } from './format';
import type { StatsOverview, UnifiedMessage } from '../types';

/** 消息级 CSV 的列顺序：时间 / 平台 / 方向 / 状态 / 联系人 / 正文摘要 */
const CSV_HEADER = '时间,平台,方向,状态,联系人,正文摘要';

/** 正文摘要上限：Excel 单元格里能一眼读完的长度，超出用省略号收尾 */
const DIGEST_MAX = 100;

/** 补两位数字（月 / 日 / 时 / 分共用） */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 本地时区的「YYYY-MM-DD HH:mm」。
 * 导出文件要给人存档、给 Excel 排序：相对时间（“3 分钟前”）和 UTC 时间戳都不合适；
 * 时间解析失败时原样输出原始字符串——导出是取证场景，宁可原样也不能静默丢数据。
 */
function formatMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 本地时区的日期键「YYYY-MM-DD」。
 * 不用 toISOString：它会跳到 UTC，凌晨 0–8 点的消息会被算进“昨天”，趋势就错位了。
 */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 正文摘要：压平所有空白（消息里的换行会撑破 CSV 行结构，也难在表格里读） */
function digest(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > DIGEST_MAX ? `${flat.slice(0, DIGEST_MAX)}…` : flat;
}

/** RFC 4180 转义：含逗号 / 引号 / 换行的单元格整体加引号，内部引号翻倍 */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 消息级明细 → CSV 文本。
 *
 * - 行尾用 \r\n：Excel（尤其 Windows）对裸 \n 的兼容性时好时坏，CRLF 是 RFC 4180 的标准；
 * - 空数据也返回表头：导出一个只有表头的文件好过让用户疑惑“是不是没导出来”；
 * - BOM（\uFEFF）不在这里加：由调用方在拼 Blob 时加，纯函数保持“内容干净”。
 */
export function messagesToCsv(messages: readonly UnifiedMessage[]): string {
  const rows = messages.map((m) => {
    const platform = platformMeta(m.platform).name;
    // direction 契约：缺省（旧数据 / Mock）按 in 处理，与收件箱 / AppShell 的口径一致
    const direction = m.direction === 'out' ? '出站' : '入站';
    const status = STATUS_META[m.status]?.label ?? String(m.status);
    // 联系人：会话标题（群名 / 对方名）优先，退化到发送者名 / ID
    const contact = m.conversation?.title?.trim() || m.sender?.name || m.sender?.id || '';
    return [formatMinute(m.createdAt), platform, direction, status, contact, digest(m.body)]
      .map(csvCell)
      .join(',');
  });
  return [CSV_HEADER, ...rows].join('\r\n');
}

/**
 * 看板汇总 → Markdown。
 *
 * 结构：一级标题 + 生成时间 + 「总览」+「平台要点」。
 * 与页面同一原则：Mock 送达如实写、平均时长没样本就写「暂无样本」，不伪造 0。
 */
export function statsToMarkdown(data: StatsOverview): string {
  const t = data.totals;
  const lines: string[] = [
    '# LinkHub 看板汇总',
    '',
    `> 生成时间：${formatMinute(data.generatedAt)} · 数据来自收件箱与闭环日志`,
    '',
    '## 总览',
    '',
    `- 消息总数：${t.messages}（入站 ${t.inbound} / 出站 ${t.outbound}）`,
    `- 已回复 ${t.replied} · 待处理 ${t.pending} · 失败 ${t.failed}`,
    `- 待办：已完成 ${t.done} / 共 ${t.todos}`,
    `- 平均处理时长：${data.avgHandleSeconds === null ? '暂无样本' : `${data.avgHandleSeconds} 秒`}`,
    `- 送达方式：真实 ${data.delivery.real} · 模拟 ${data.delivery.mock}（Mock 如实标注，不计入真实送达）`,
    `- 自动规则 ${data.rules.total} 条，累计命中 ${data.rules.hits} 次；死信 ${data.dlq} 条`,
    '',
    '## 平台要点',
    '',
  ];
  if (data.byPlatform.length === 0) {
    // 空数据给占位：Markdown 打开时读的人能分清“没数据”和“漏导出”
    lines.push('_暂无平台数据_');
    return lines.join('\n');
  }
  for (const row of data.byPlatform) {
    lines.push(`### ${platformMeta(row.platform).name}`);
    lines.push('');
    lines.push(`- 总量 ${row.total}：入站 ${row.inbound} / 出站 ${row.outbound}`);
    lines.push(`- 已回复 ${row.replied} · 待处理 ${row.pending} · 失败 ${row.failed}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 趋势图的单日样本：date 是本地日期键，label 是给轴用的「MM-DD」 */
export interface DailyTrendPoint {
  date: string;
  label: string;
  inbound: number;
  outbound: number;
}

/**
 * 近 N 天按天统计入站 / 出站条数（旧的在前）。
 *
 * 先生成 days 个连续的自然日桶再计数：缺数据的天补 0，
 * 图形才能对齐连续时间轴——只对「有消息的天」画点，会让人误读成波动。
 */
export function dailyTrend(
  messages: readonly UnifiedMessage[],
  days: 7 | 30,
  now: Date = new Date(),
): DailyTrendPoint[] {
  const buckets = new Map<string, DailyTrendPoint>();
  const ordered: DailyTrendPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const point: DailyTrendPoint = {
      date: dayKey(day),
      label: `${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`,
      inbound: 0,
      outbound: 0,
    };
    buckets.set(point.date, point);
    ordered.push(point);
  }
  for (const msg of messages) {
    const at = new Date(msg.createdAt);
    // 解析不了的时间不属于任何一天，跳过而不是硬塞进今天
    if (Number.isNaN(at.getTime())) continue;
    const point = buckets.get(dayKey(at));
    // 窗口外的消息（更早的存量 / 客户端时钟偏差带来的未来时间）不统计
    if (!point) continue;
    if (msg.direction === 'out') point.outbound += 1;
    else point.inbound += 1; // 缺省按入站：与 direction 字段契约一致
  }
  return ordered;
}

/**
 * 导出文件名：linkhub-stats-2026-11-22.csv / .md。
 * 日期取本地时区（与 CSV 里「时间」列同一口径），日期归档时按天排序才对。
 */
export function statsExportFilename(ext: 'csv' | 'md', now: Date = new Date()): string {
  return `linkhub-stats-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.${ext}`;
}
