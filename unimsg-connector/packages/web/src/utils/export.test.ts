import { describe, expect, it } from 'vitest';
import { MsgStatus, Platform } from '../types';
import type { StatsOverview, UnifiedMessage } from '../types';
import { dailyTrend, messagesToCsv, statsExportFilename, statsToMarkdown } from './export';

/** 测试夹具：只填必填字段，其余给合法默认值，用例里只覆盖关心的字段 */
function msg(partial: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    traceId: 'trace-1',
    platform: Platform.FEISHU,
    externalId: 'ext-1',
    sender: { name: '张三', id: 'u-1' },
    type: 'text',
    body: '你好',
    status: MsgStatus.RECEIVED,
    createdAt: '2026-11-22T10:00:00',
    updatedAt: '2026-11-22T10:00:00',
    ...partial,
  };
}

const overview: StatsOverview = {
  totals: { messages: 12, inbound: 8, outbound: 4, replied: 5, pending: 3, failed: 1, todos: 4, done: 2 },
  byPlatform: [
    { platform: Platform.FEISHU, total: 7, inbound: 5, outbound: 2, replied: 3, pending: 2, failed: 0 },
    { platform: Platform.DINGTALK, total: 5, inbound: 3, outbound: 2, replied: 2, pending: 1, failed: 1 },
  ],
  byStatus: { received: 12 },
  delivery: { real: 3, mock: 1 },
  dlq: 1,
  avgHandleSeconds: null,
  rules: { total: 2, hits: 9 },
  generatedAt: '2026-11-22T10:30:00',
};

describe('看板导出（CSV / Markdown）与趋势分桶', () => {
  describe('messagesToCsv', () => {
    it('逗号 / 引号 / 换行按 RFC 4180 转义：整体加引号、内部引号翻倍', () => {
      const csv = messagesToCsv([
        msg({ body: '含,逗号' }),
        msg({ traceId: 't-2', sender: { name: '他说"好"', id: 'u-2' }, body: '正文' }),
        // 换行会出现在单元格里（正文摘要会压平空白，但联系人等字段不清洗）：
        // 必须包进引号原样保留，否则 CSV 的行结构就被撑破了
        msg({ traceId: 't-3', sender: { name: '多行\n名字', id: 'u-3' }, body: '正文' }),
      ]);
      const rows = csv.split('\r\n');
      expect(rows).toHaveLength(4); // 表头 + 三条消息
      expect(rows[0]).toBe('时间,平台,方向,状态,联系人,正文摘要');
      expect(rows[1]).toContain('"含,逗号"');
      // 引号单元格：引号翻倍后再整体包裹（他说"好" → "他说""好"""）
      expect(rows[2]).toContain('"他说""好"""');
      // 换行在引号内原样保留，不会被当成新行
      expect(rows[3]).toContain('"多行\n名字"');
    });

    it('空数据只返回表头：导出的文件至少说明列结构，而不是空文件', () => {
      expect(messagesToCsv([])).toBe('时间,平台,方向,状态,联系人,正文摘要');
    });

    it('direction 缺省按入站（与契约一致）；时间用本地「YYYY-MM-DD HH:mm」；状态转中文标签', () => {
      const csv = messagesToCsv([msg({ status: MsgStatus.SENT, direction: 'out' })]);
      const cells = csv.split('\r\n')[1].split(',');
      expect(cells[0]).toBe('2026-11-22 10:00');
      expect(cells[1]).toBe('飞书');
      expect(cells[2]).toBe('出站');
      expect(cells[3]).toBe('已发送');
      expect(cells[4]).toBe('张三');
    });

    it('正文摘要压平空白并截断到 100 字 + 省略号', () => {
      const long = `首行\n${'啊'.repeat(120)}`;
      const csv = messagesToCsv([msg({ body: long })]);
      const cells = csv.split('\r\n')[1].split(',');
      // 压平后「首行 」占 3 字符，100 字上限内剩 97 个「啊」，再加省略号
      expect(cells[5]).toBe(`首行 ${'啊'.repeat(97)}…`);
    });

    it('联系人优先取会话标题（群名），没有再退回发送者名', () => {
      const csv = messagesToCsv([msg({ conversation: { id: 'c-1', type: 'group', title: '项目群' } })]);
      expect(csv.split('\r\n')[1]).toContain(',项目群,');
    });
  });

  describe('statsToMarkdown', () => {
    it('结构：一级标题 + 总览 + 平台要点，数字与 StatsOverview 一致', () => {
      const md = statsToMarkdown(overview);
      expect(md).toContain('# LinkHub 看板汇总');
      expect(md).toContain('## 总览');
      expect(md).toContain('- 消息总数：12（入站 8 / 出站 4）');
      expect(md).toContain('- 已回复 5 · 待处理 3 · 失败 1');
      expect(md).toContain('- 待办：已完成 2 / 共 4');
      expect(md).toContain('真实 3 · 模拟 1');
      expect(md).toContain('## 平台要点');
      expect(md).toContain('### 飞书');
      expect(md).toContain('- 总量 7：入站 5 / 出站 2');
      expect(md).toContain('### 钉钉');
    });

    it('平均时长没有样本时如实写「暂无样本」，不伪造 0', () => {
      expect(statsToMarkdown(overview)).toContain('平均处理时长：暂无样本');
      const withSample = statsToMarkdown({ ...overview, avgHandleSeconds: 42 });
      expect(withSample).toContain('平均处理时长：42 秒');
    });

    it('byPlatform 为空时给占位文案，不出空分组', () => {
      const md = statsToMarkdown({ ...overview, byPlatform: [] });
      expect(md).toContain('暂无平台数据');
      expect(md).not.toContain('###');
    });
  });

  describe('dailyTrend', () => {
    it('按本地日分桶、窗口补 0、方向缺省算入站、窗口外与非法时间跳过', () => {
      const now = new Date(2026, 10, 22, 18, 0, 0); // 2026-11-22 本地 18 点
      const points = dailyTrend(
        [
          msg({ traceId: 'a', createdAt: '2026-11-22T09:00:00' }),
          msg({ traceId: 'b', createdAt: '2026-11-22T21:00:00', direction: 'out' }),
          msg({ traceId: 'c', createdAt: '2026-11-16T08:00:00' }), // 7 天窗口的第一天
          msg({ traceId: 'd', createdAt: '2026-11-15T08:00:00' }), // 窗口外一天
          msg({ traceId: 'e', createdAt: '不是时间' }), // 非法时间
        ],
        7,
        now,
      );
      expect(points).toHaveLength(7);
      expect(points[0].date).toBe('2026-11-16');
      expect(points[0].label).toBe('11-16');
      expect(points[0]).toMatchObject({ inbound: 1, outbound: 0 });
      expect(points[1]).toMatchObject({ inbound: 0, outbound: 0 }); // 缺数据的天补 0
      expect(points[6].date).toBe('2026-11-22');
      expect(points[6]).toMatchObject({ inbound: 1, outbound: 1 });
    });

    it('30 天窗口：长度为 30，首日是 now 往前推 29 天', () => {
      const points = dailyTrend([], 30, new Date(2026, 10, 22));
      expect(points).toHaveLength(30);
      expect(points[0].date).toBe('2026-10-24');
      expect(points[29].date).toBe('2026-11-22');
    });
  });

  describe('statsExportFilename', () => {
    it('文件名带当天本地日期，月 / 日补零', () => {
      expect(statsExportFilename('csv', new Date(2026, 10, 22))).toBe('linkhub-stats-2026-11-22.csv');
      expect(statsExportFilename('md', new Date(2026, 0, 5))).toBe('linkhub-stats-2026-01-05.md');
    });
  });
});
