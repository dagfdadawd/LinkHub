/**
 * 统计看板路由（挂载在 /api 下，最终路径 GET /api/stats/overview）。
 *
 * 响应风格与 routes/messages.ts 对齐：{ ok: true, data }。
 * 计算逻辑全部在 services/stats.ts（纯函数），这里只做接线；
 * 数据源由调用方注入（主代理用 MessageService / Repository 适配 StatsSource）。
 */
import { Router } from 'express';
import { computeStats, type StatsSource } from '../services/stats';

export function statsRouter(src: StatsSource): Router {
  const r = Router();

  // GET /stats/overview → 200 { ok: true, data: StatsOverview }
  r.get('/stats/overview', (_req, res) => {
    res.json({ ok: true, data: computeStats(src) });
  });

  return r;
}
