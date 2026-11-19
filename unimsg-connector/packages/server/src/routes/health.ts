import { Router } from 'express';
import { Platform } from '@unimsg/shared';
import { config, envFileSnapshot, monorepoRoot } from '../config';
import { snapshot } from '../core/metrics';
import { MessageService } from '../services/message';
import { identitySummary } from '../services/identity';
import { settingsFileSnapshot } from '../services/localConfig';
import {
  peekWechatBridgeStatus,
  shouldProbeWechatBridge,
  warmWechatBridge,
} from '../services/wechatBridge';

/** 进程启动时间：用 uptime 反推，避免依赖模块加载顺序 */
const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

export function healthRouter(svc: MessageService) {
  const r = Router();
  r.get('/health', (_req, res) => {
    const envFile = envFileSnapshot();
    const settingsFile = settingsFileSnapshot(monorepoRoot);
    // 微信桥只在 real 模式才需要：后台预热（不阻塞本次响应），有缓存就原样下发。
    // 没探测过时下发 null——绝不用"配置上有地址"冒充"桥已就绪"。
    if (shouldProbeWechatBridge()) warmWechatBridge();
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      // 前端用 startedAt 与 envFile.mtime 对比，提示「.env 已修改，需重启后端生效」（P1-5）。
      // envFile 只给路径与修改时间，绝不下发 .env 内容；文件不存在时 null。
      startedAt,
      // 公共接口不暴露本机绝对路径（P2-10）：只给文件名 + mtime，前端仍可判断「.env 已改需重启」
      envFile: envFile ? { path: '.env', mtime: envFile.mtime } : null,
      // 本地配置文件（GUI 保存的凭据/模式）；只给文件名 + 存在性 + mtime，不含内容
      settingsFile: {
        path: 'linkhub-config.json',
        present: settingsFile.present,
        mtime: settingsFile.mtime,
      },
      ...snapshot(),
      dlq: svc.listDlq().length,
      // 公开接口也带上每个平台的实际通道，评审 curl 一下就能知道现在是不是真的。
      // 注意：modes 描述的是「机器人/既有通道」（契约语义不变），本人身份另看 identities。
      modes: Object.fromEntries(Object.values(Platform).map((p) => [p, config.runtime[p].mode])),
      // 本人身份摘要（本人 / 机器人 / 模拟）：只读缓存，不触发慢调用。
      // 只包含飞书/钉钉：微信、邮箱没有本人/机器人身份之分，不在这里出现。
      identities: identitySummary(),
      // 微信 RPA 桥实测状态（null = 还没探测过 / 当前是 mock 模式，不值得探）
      wechatBridge: peekWechatBridgeStatus(),
    });
  });
  return r;
}
