import { Router } from 'express';
import { Platform, MsgStatus, type IdentityRole } from '@unimsg/shared';
import { MessageService } from '../services/message';
import { listAccounts } from '../services/account';
import { IdentityUnavailableError } from '../services/identity';
import {
  InvalidOutboundRequest,
  normalizeAttachments,
  normalizeCompose,
  sendCapabilities,
} from '../services/outbound';

/** 从请求体里取可选的发送身份（bot | user）；非法值返回错误信息 */
function parseIdentity(raw: unknown): { value?: IdentityRole; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  if (raw === 'bot' || raw === 'user') return { value: raw };
  return { error: 'identity 只能是 bot（机器人）或 user（本人账号）；不传则按平台当前策略' };
}

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
  // body 可选 identity: 'bot' | 'user'，不可用时 400 中文错误（绝不悄悄换身份）。
  r.post('/messages/:id/reply', async (req, res) => {
    let text: string;
    let attachments;
    let identity: IdentityRole | undefined;
    try {
      const body = (req.body ?? {}) as { text?: unknown; attachments?: unknown; identity?: unknown };
      text = typeof body.text === 'string' ? body.text.trim() : '';
      attachments = normalizeAttachments(body.attachments);
      const parsed = parseIdentity(body.identity);
      if (parsed.error) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      identity = parsed.value;
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
      const ack = await svc.reply(req.params.id, text, attachments, identity);
      res.status(202).json({ ok: true, ...ack });
    } catch (e) {
      // 身份不可用是可修复的入参问题 → 400（中文可操作）；消息不存在 → 404
      if (e instanceof IdentityUnavailableError) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
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

  /**
   * 阅读状态：POST /api/messages/:id/read 与 /unread。
   * 返回完整消息，前端可直接 upsert（WS 也会广播同一条，幂等）。
   */
  r.post('/messages/read-all', async (req, res) => {
    try {
      // ids 可选：前端只想标记「当前筛选范围内」的未读时传入
      const raw = (req.body ?? {}) as { ids?: unknown };
      const ids = Array.isArray(raw.ids) ? raw.ids.filter((v): v is string => typeof v === 'string') : undefined;
      const changed = await svc.markAllRead(ids);
      res.json({ ok: true, changed });
    } catch {
      res.status(500).json({ ok: false, error: 'mark all read failed' });
    }
  });

  r.post('/messages/:id/read', async (req, res) => {
    try {
      const message = await svc.markRead(req.params.id, true);
      res.json({ ok: true, data: message });
    } catch {
      res.status(404).json({ ok: false, error: 'not found' });
    }
  });

  r.post('/messages/:id/unread', async (req, res) => {
    try {
      const message = await svc.markRead(req.params.id, false);
      res.json({ ok: true, data: message });
    } catch {
      res.status(404).json({ ok: false, error: 'not found' });
    }
  });

  return r;
}
