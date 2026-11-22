/**
 * 自动回复规则 HTTP 接口（赛题 A 官方闭环：规则的增删改查给前端管理页用）。
 *
 *  - GET    /api/auto-rules      → 200 { ok:true, data: AutoRule[] }
 *  - POST   /api/auto-rules      → 201 { ok:true, data: AutoRule }
 *  - PATCH  /api/auto-rules/:id  → 200 { ok:true, data }；不存在 → 404 { ok:false, error:'规则不存在' }
 *  - DELETE /api/auto-rules/:id  → 200 { ok:true }；不存在 → 404
 *
 * 错误风格对齐 routes/messages.ts：res.status(n).json({ ok:false, error:'中文' })。
 * 字段校验（platform 枚举 / replyText 非空 / priority 范围）由仓库统一负责，
 * 路由层只把仓库抛出的中文 Error 转成 400，保证「直接用仓库」与「走 HTTP」行为一致。
 */
import { Router, type Request, type Response } from 'express';
import type { AutoRuleInput } from '@unimsg/shared';
import { AutoRuleStore } from '../services/autoReply';

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

/**
 * 从 JSON body 里取出规则字段（PATCH 与 POST 共用）。
 * 只拷贝「客户端显式提供了」的键：PATCH 单改 priority 时绝不能把没传的
 * replyText 当成 undefined 送去校验（那会把部分更新误判成“清空回复内容”）。
 */
function ruleInputOf(req: Request): AutoRuleInput {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const input: Partial<AutoRuleInput> = {};
  if ('replyText' in body) input.replyText = body.replyText as string;
  if ('platform' in body) input.platform = body.platform as AutoRuleInput['platform'];
  if ('keyword' in body) input.keyword = body.keyword as string;
  if ('priority' in body) input.priority = body.priority as number;
  if ('enabled' in body) input.enabled = body.enabled as boolean;
  return input as AutoRuleInput;
}

export function autoRulesRouter(store: AutoRuleStore): Router {
  const r = Router();

  r.get('/auto-rules', (_req: Request, res: Response) => {
    res.json({ ok: true, data: store.list() });
  });

  r.post('/auto-rules', (req: Request, res: Response) => {
    try {
      const rule = store.create(ruleInputOf(req));
      res.status(201).json({ ok: true, data: rule });
    } catch (e) {
      sendError(res, 400, e instanceof Error ? e.message : '创建规则失败');
    }
  });

  r.patch('/auto-rules/:id', (req: Request, res: Response) => {
    try {
      const rule = store.update(req.params.id, ruleInputOf(req));
      if (!rule) {
        sendError(res, 404, '规则不存在');
        return;
      }
      res.json({ ok: true, data: rule });
    } catch (e) {
      sendError(res, 400, e instanceof Error ? e.message : '更新规则失败');
    }
  });

  r.delete('/auto-rules/:id', (req: Request, res: Response) => {
    if (!store.remove(req.params.id)) {
      sendError(res, 404, '规则不存在');
      return;
    }
    res.json({ ok: true });
  });

  return r;
}
