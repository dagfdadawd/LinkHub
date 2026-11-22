/**
 * 统计看板：把「闭环有没有真的跑起来」量化成数字。
 *
 * 口径与后端 services/stats.ts 一致：
 *  - 平均处理时长 = 闭环日志里「收到/composed」到「sent」的秒差均值；
 *  - 真实 / Mock 分开展示，绝不把模拟发送算成真实送达；
 *  - 没有样本时显示「暂无样本」，不伪造 0。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Segmented, Space, Statistic, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined, FileTextOutlined, ReloadOutlined } from '@ant-design/icons';
import { platformMeta } from '../../utils/format';
import { saveBlobAsFile } from '../../utils/download';
import { dailyTrend, messagesToCsv, statsExportFilename, statsToMarkdown } from '../../utils/export';
import type { DailyTrendPoint } from '../../utils/export';
import type { Platform, StatsOverview } from '../../types';
import { useAppState } from '../../hooks/useAppState';
import { store } from '../../store';

type PlatformRow = StatsOverview['byPlatform'][number];

/** 趋势图的画布尺寸（viewBox 内部单位，与 CSS 像素无关，svg 等比缩放） */
const TREND_W = 560;
const TREND_H = 160;
/** 轴标签区高度（MM-DD 文字） */
const TREND_AXIS_H = 20;
/** 顶部留白：柱顶不顶着画布边缘 */
const TREND_PAD_TOP = 6;

/**
 * 近 N 天趋势条形图（内联 SVG，评审 P1-7）。
 *
 * 数据形状很简单（每天入站/出站两个数），与其背上第三方图表库不如几十行画完；
 * 每天一组「入站 / 出站」柱，用原生 <title> 当 tooltip——零依赖且屏幕阅读器也能读。
 */
function TrendChart({ points, days }: { points: DailyTrendPoint[]; days: 7 | 30 }) {
  const hasTraffic = points.some((p) => p.inbound > 0 || p.outbound > 0);
  // 空数据给占位文案：让用户分清「没数据」和「图挂了」
  if (!hasTraffic) {
    return <p className="stats-trend__empty">近 {days} 天暂无消息，产生收发后这里会出现按天趋势。</p>;
  }
  const plotH = TREND_H - TREND_AXIS_H - TREND_PAD_TOP;
  const baseline = TREND_H - TREND_AXIS_H;
  // max 至少为 1：全零已经被占位文案拦住，但防御性兜底避免除以 0
  const max = Math.max(1, ...points.map((p) => Math.max(p.inbound, p.outbound)));
  const slot = TREND_W / points.length;
  const barW = Math.min(12, Math.max(3, slot * 0.26));
  const hOf = (v: number) => (v / max) * plotH;
  // 轴标签密度：7 天每天标，30 天每 5 天标一个，避免文字互相叠
  const labelStep = days === 7 ? 1 : 5;
  return (
    <div>
      <div className="stats-trend__legend">
        <span><i aria-hidden="true" className="stats-trend__dot stats-trend__dot--in" />入站</span>
        <span><i aria-hidden="true" className="stats-trend__dot stats-trend__dot--out" />出站</span>
        <span className="stats-trend__peak">峰值 {max} 条 / 天</span>
      </div>
      <svg
        className="stats-trend__chart"
        viewBox={`0 0 ${TREND_W} ${TREND_H}`}
        role="img"
        aria-label={`近 ${days} 天入站 / 出站条数趋势，峰值每天 ${max} 条`}
      >
        <line x1={0} y1={baseline} x2={TREND_W} y2={baseline} className="stats-trend__baseline" />
        {points.map((p, i) => {
          const cx = i * slot + slot / 2;
          const hIn = hOf(p.inbound);
          const hOut = hOf(p.outbound);
          return (
            <g key={p.date}>
              {/* 原生 title = 零依赖 tooltip：悬停即读「哪天、入站几条、出站几条」 */}
              <title>{`${p.label}：入站 ${p.inbound} · 出站 ${p.outbound}`}</title>
              {p.inbound > 0 && (
                <rect
                  x={cx - barW - 1}
                  y={baseline - hIn}
                  width={barW}
                  height={hIn}
                  className="stats-trend__bar stats-trend__bar--in"
                />
              )}
              {p.outbound > 0 && (
                <rect
                  x={cx + 1}
                  y={baseline - hOut}
                  width={barW}
                  height={hOut}
                  className="stats-trend__bar stats-trend__bar--out"
                />
              )}
              {i % labelStep === 0 && (
                <text x={cx} y={TREND_H - 6} textAnchor="middle" className="stats-trend__axis">
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function StatsPage() {
  const [data, setData] = useState<StatsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 趋势与导出都吃 store 里的消息列表：看板不再只依赖 stats 接口的聚合数
  const { messages } = useAppState();
  const [trendDays, setTrendDays] = useState<7 | 30>(7);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await store.loadStats());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '统计加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trend = useMemo(() => dailyTrend(messages, trendDays), [messages, trendDays]);

  /**
   * 导出 CSV（消息级明细）。
   * \uFEFF BOM 必须在 Blob 层加：Excel 只认「文件开头带 BOM 的 UTF-8」，少了它中文全是乱码。
   */
  const exportCsv = () => {
    saveBlobAsFile(
      new Blob(['\uFEFF' + messagesToCsv(messages)], { type: 'text/csv;charset=utf-8' }),
      statsExportFilename('csv'),
    );
  };

  /** 导出 Markdown（看板汇总 + 按平台分组的要点）；聚合数还没加载出来时禁用 */
  const exportMarkdown = () => {
    if (!data) return;
    saveBlobAsFile(
      new Blob([statsToMarkdown(data)], { type: 'text/markdown;charset=utf-8' }),
      statsExportFilename('md'),
    );
  };

  const columns: ColumnsType<PlatformRow> = [
    {
      title: '平台',
      dataIndex: 'platform',
      render: (p: Platform) => <Tag>{platformMeta(p).name}</Tag>,
    },
    { title: '消息总数', dataIndex: 'total', sorter: (a, b) => a.total - b.total },
    { title: '已回复', dataIndex: 'replied' },
    { title: '待处理', dataIndex: 'pending' },
    { title: '失败', dataIndex: 'failed' },
  ];

  const totals = data?.totals;

  return (
    <div className="page stats-page">
      <header className="page__head page__head--row">
        <div>
          <h1 className="page__title">看板</h1>
          <p className="auto-reply-page__sub">
            数据来自收件箱与闭环日志本身；平均处理时长只统计「收到 → 已发出」都留痕的样本。
          </p>
        </div>
        <Space wrap>
          <Button icon={<DownloadOutlined />} onClick={exportCsv}>
            导出 CSV
          </Button>
          <Button icon={<FileTextOutlined />} onClick={exportMarkdown} disabled={!data}>
            导出 Markdown
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      </header>

      {error && <Alert type="warning" showIcon message={error} />}

      {totals && (
        <div className="stats-grid">
          <Card size="small"><Statistic title="消息总数" value={totals.messages} /></Card>
          <Card size="small"><Statistic title="已回复" value={totals.replied} /></Card>
          <Card size="small"><Statistic title="待处理" value={totals.pending} /></Card>
          <Card size="small"><Statistic title="失败" value={totals.failed} valueStyle={{ color: 'var(--danger)' }} /></Card>
          <Card size="small">
            <Statistic title="待办 / 已完成" value={`${totals.todos} / ${totals.done}`} />
          </Card>
          <Card size="small">
            <Statistic
              title="平均处理时长"
              value={data.avgHandleSeconds === null ? '暂无样本' : data.avgHandleSeconds}
              {...(data.avgHandleSeconds === null ? {} : { suffix: '秒' })}
            />
          </Card>
        </div>
      )}

      <Card
        size="small"
        title="趋势"
        className="stats-trend-card"
        extra={
          <Segmented
            value={trendDays}
            onChange={(v) => setTrendDays(v as 7 | 30)}
            options={[
              { label: '近 7 天', value: 7 },
              { label: '近 30 天', value: 30 },
            ]}
          />
        }
      >
        <TrendChart points={trend} days={trendDays} />
      </Card>

      <Card size="small" title="平台分布" className="stats-platform-card">
        <Table<PlatformRow>
          rowKey="platform"
          loading={loading}
          columns={columns}
          dataSource={data?.byPlatform ?? []}
          pagination={false}
          size="small"
        />
      </Card>

      {data && (
        <p className="auto-reply-page__hint">
          生成时间 {new Date(data.generatedAt).toLocaleString()}；状态分布：
          {Object.entries(data.byStatus).map(([k, v]) => ` ${k}=${v}`).join(' · ') || ' 暂无'}
        </p>
      )}
    </div>
  );
}
