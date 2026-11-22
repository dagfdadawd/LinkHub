/**
 * 统计看板：把「闭环有没有真的跑起来」量化成数字。
 *
 * 口径与后端 services/stats.ts 一致：
 *  - 平均处理时长 = 闭环日志里「收到/composed」到「sent」的秒差均值；
 *  - 真实 / Mock 分开展示，绝不把模拟发送算成真实送达；
 *  - 没有样本时显示「暂无样本」，不伪造 0。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Statistic, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import { PLATFORM_META } from '../../utils/format';
import type { Platform, StatsOverview } from '../../types';
import { store } from '../../store';

type PlatformRow = StatsOverview['byPlatform'][number];

export function StatsPage() {
  const [data, setData] = useState<StatsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const columns: ColumnsType<PlatformRow> = [
    {
      title: '平台',
      dataIndex: 'platform',
      render: (p: Platform) => <Tag>{PLATFORM_META[p].name}</Tag>,
    },
    { title: '消息总数', dataIndex: 'total', sorter: (a, b) => a.total - b.total },
    { title: '来信', dataIndex: 'inbound' },
    { title: '发出', dataIndex: 'outbound' },
    { title: '已回复', dataIndex: 'replied' },
    { title: '待处理', dataIndex: 'pending' },
    { title: '失败', dataIndex: 'failed' },
  ];

  const totals = data?.totals;

  return (
    <div className="page stats-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">看板</h1>
          <p className="auto-reply-page__sub">
            数据来自收件箱与闭环日志本身；平均处理时长只统计「收到 → 已发出」都留痕的样本。
          </p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </header>

      {error && <Alert type="warning" showIcon message={error} />}

      {totals && (
        <div className="stats-grid">
          <Card size="small"><Statistic title="消息总数" value={totals.messages} /></Card>
          <Card size="small"><Statistic title="来信" value={totals.inbound} /></Card>
          <Card size="small"><Statistic title="已回复" value={totals.replied} /></Card>
          <Card size="small"><Statistic title="待处理" value={totals.pending} /></Card>
          <Card size="small"><Statistic title="失败" value={totals.failed} valueStyle={{ color: 'var(--danger)' }} /></Card>
          <Card size="small"><Statistic title="待办 / 已完成" value={`${totals.todos} / ${totals.done}`} /></Card>
          <Card size="small">
            <Statistic
              title="平均处理时长"
              value={data.avgHandleSeconds === null ? '暂无样本' : data.avgHandleSeconds}
              {...(data.avgHandleSeconds === null ? {} : { suffix: '秒' })}
            />
          </Card>
          <Card size="small"><Statistic title="死信" value={data.dlq} /></Card>
          <Card size="small">
            <Statistic
              title="真实 / 模拟发送"
              value={`${data.delivery.real} / ${data.delivery.mock}`}
            />
          </Card>
          <Card size="small">
            <Statistic title="自动回复规则 / 命中" value={`${data.rules.total} / ${data.rules.hits}`} />
          </Card>
        </div>
      )}

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
