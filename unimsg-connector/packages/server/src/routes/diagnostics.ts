/**
 * 只读诊断摘要：给「账号 / 连接」页面和答辩演示用。
 *
 * 与 CLI `pnpm run doctor` 的分工：
 *  - CLI 会真的换 token / 连 IMAP / 查出口 IP，慢但证据最硬，--out 落盘给初赛取证；
 *  - 这个接口只汇总**进程内已知状态**（平台通道、运行计数、配置边界），
 *    不发任何出站请求，因此可以随时点、不会误触平台限流。
 */
import { Router } from 'express';
import { config } from '../config';
import { snapshot } from '../core/metrics';
import { sendCapabilities } from '../services/outbound';
import { listAccounts } from '../services/account';

export function diagnosticsRouter(): Router {
  const r = Router();

  r.get('/doctor/summary', (_req, res) => {
    res.json({
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        node: process.version,
        tokenIsDefault: config.apiToken === 'dev-token',
        dataDir: (process.env.DATA_DIR ?? '').trim() || null,
        // 每个平台当前真实 / Mock 通道与缺什么：与界面上的「模拟」标注同源
        platforms: sendCapabilities(),
        accounts: listAccounts(),
        counters: snapshot(),
        // 死信计数单独给，前端可提示「有发送进死信」
        note: '本接口只读进程内状态，不发任何出站请求；完整体检请用 pnpm run doctor --json --out=<path>',
      },
    });
  });

  return r;
}
