/**
 * `GET /api/contacts?platform=feishu`：给「发送给」选择器提供可读目标名录。
 *
 * 只读、带缓存（60s）；不返回任何令牌。飞书走本人 user_access_token 的会话列表
 * （单聊也带名字），其它平台如实返回「不可用 + 原因」，不假装有通讯录。
 */
import { Router, type Request, type Response } from 'express';
import { Platform } from '@unimsg/shared';
import { listDirectory } from '../services/contactDirectory';

const PLATFORMS = new Set<string>(Object.values(Platform));

export function contactsRouter(): Router {
  const router = Router();

  router.get('/contacts', async (req: Request, res: Response) => {
    const raw = String(req.query.platform ?? '').trim();
    if (!PLATFORMS.has(raw)) {
      res.status(400).json({ ok: false, error: `platform 不合法：${raw || '(空)'}` });
      return;
    }
    try {
      const result = await listDirectory(raw as Platform);
      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : '读取名录失败' });
    }
  });

  return router;
}