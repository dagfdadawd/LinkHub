/**
 * A 形态（后端与微信桌面端同机）的微信 RPA 桥管理接口。
 * 只允许本机回环；启动参数由服务端固定，前端不能传命令。
 */
import { Router, type Request, type Response } from 'express';
import {
  wechatBridgeManager,
  type WechatBridgeManager,
} from '../services/wechatBridgeProcess';

function fail(res: Response, e: unknown): void {
  res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
}

export function wechatBridgeRouter(manager: WechatBridgeManager = wechatBridgeManager()): Router {
  const r = Router();

  r.get('/wechat/bridge/status', async (_req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, data: await manager.status() });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/wechat/bridge/start', async (_req: Request, res: Response) => {
    try {
      const data = await manager.start();
      res.status(data.started || data.alreadyRunning ? 200 : 409).json({
        ok: Boolean(data.started || data.alreadyRunning),
        data,
        ...(data.error ? { error: data.error } : {}),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/wechat/bridge/stop', async (_req: Request, res: Response) => {
    try {
      const data = await manager.stop();
      res.status(data.stopped ? 200 : 409).json({
        ok: data.stopped,
        data,
        ...(data.error ? { error: data.error } : {}),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  return r;
}
