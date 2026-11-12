import { Router } from 'express';
import { Platform } from '@unimsg/shared';
import { snapshot } from '../core/metrics';
import { config, envFileSnapshot } from '../config';
import { MessageService } from '../services/message';
import { identitySummary } from '../services/identity';

/** 进程启动时间：用 uptime 反推，避免依赖模块加载顺序 */
const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

export function healthRouter(svc: MessageService) {
  const r = Router();
  r.get('/health', (_req, res) => {
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      // 前端用 startedAt 与 envFile.mtime 对比，提示「.env 已修改，需重启后端生效」（P1-5）。
      // envFile 只给路径与修改时间，绝不下发 .env 内容；文件不存在时 null。
      startedAt,
      envFile: envFileSnapshot(),
      ...snapshot(),
      dlq: svc.listDlq().length,
      // 公开接口也带上每个平台的实际通道，评审 curl 一下就能知道现在是不是真的。
      // 注意：modes 描述的是「机器人/既有通道」（契约语义不变），本人身份另看 identities。
      modes: Object.fromEntries(Object.values(Platform).map((p) => [p, config.runtime[p].mode])),
      // 本人身份摘要（本人 / 机器人 / 模拟）：只读缓存，不触发慢调用
      identities: identitySummary(),
    });
  });
  return r;
}