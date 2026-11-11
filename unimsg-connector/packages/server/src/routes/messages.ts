import { Router } from 'express';
import { Platform, MsgStatus } from '@unimsg/shared';
import { MessageService } from '../services/message';
import { listAccounts } from '../services/account';
import {
  InvalidOutboundRequest,
  normalizeAttachments,
  normalizeCompose,
  sendCapabilities,
} from '../services/outbound';

export function messagesRouter(svc: MessageService) {
  const r = Router();

  r.get('/accounts', (_req, res) => {
    res.json({ ok: true, data: listAccounts() });
  });

  // 全链路回放：消息 + 闭环日志
  r.get('/messages/trace/:traceId', (req, res) => {
    const traceId = req.params.traceId;
    res.json({ ok: true, data: svc.getTrace(traceId), log: svc.getLoopLog(traceId) });
  });

  // 各平台发送能力（文本/文件、大小上限、当前通道），前端据此渲染「新建发送」表单
  r.get('/capabilities', (_req, res) => {
    res.json({ ok: true, data: sendCapabilities() });
  });

  r.get('/messages', (req, res) => {
    const platform = typeof req.query.platform === 'string' ? (req.query.platform as Platform) : undefined;
    const status = typeof req.query.status === 'string' ? (req.query.status as MsgStatus) : undefined;
    res.json({ ok: true, data: svc.list({ platform, status }) });
  });

  r.get('/messages/:id', (req, res) => {
    const m = svc.get(req.params.id);
    if (!m) {
      res.status(404).json({ ok: false, error: 'not found' });
      return;
    }
    res.json({ ok: true, data: m });
  });

  // 异步回写：202 + 入队即返回 processing，结果经 WS 推送。
  // 文本与附件可同时携带；只有附件（没有文本）也是合法的一次回写。
  r.post('/messages/:id/reply', async (req, res) => {
    let text: string;
    let attachments;
    try {
      const body = (req.body ?? {}) as { text?: unknown; attachments?: unknown };
      text = typeof body.text === 'string' ? body.text.trim() : '';
      attachments = normalizeAttachments(body.attachments);
    } catch (e) {
      const msg = e instanceof InvalidOutboundRequest ? e.message : '请求体不合法';
      res.status(400).json({ ok: false, error: msg });
      return;
    }
    if (!text && attachments.length === 0) {
      res.status(400).json({ ok: false, error: 'text 与 attachments 不能同时为空' });
      return;
    }
    try {
      const ack = await svc.reply(req.params.id, text, attachments);
      res.status(202).json({ ok: true, ...ack });
    } catch {
      res.status(404).json({ ok: false, error: 'not found' });
    }
  });

  /**
   * 从统一入口主动向指定平台发送（赛题 A 功能需求 3）。
   * POST /api/messages/compose  { platform, conversationId?, conversationType?, text, attachments? }
   * 与 reply 走同一套闭环状态机，返回 202 + traceId，sent/synced 经 WS 推送。
   */
  r.post('/messages/compose', async (req, res) => {
    let request;
    try {
      request = normalizeCompose(req.body);
    } catch (e) {
      const msg = e instanceof InvalidOutboundRequest ? e.message : '请求体不合法';
      res.status(400).json({ ok: false, error: msg });
      return;
    }
    try {
      const ack = await svc.compose(request);
      res.status(202).json({ ok: true, ...ack });
    } catch (e) {
      // 缺少目标会话属于可修复的入参问题，回 400 并带可操作提示；其余按 500 处理
      const reason = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: reason });
    }
  });

  r.post('/messages/:id/done', async (req, res) => {
    try {
      await svc.markDone(req.params.id);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ ok: false, error: 'not found' });
    }
  });

  return r;
}
