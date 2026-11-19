import { Router, type Response } from 'express';
import { Platform, MsgStatus, type IdentityRole } from '@unimsg/shared';
import { MessageService } from '../services/message';
import { listAccounts } from '../services/account';
import { IdentityUnavailableError } from '../services/identity';
import { AttachmentDownloadError, type DownloadedAttachment } from '../services/attachmentDownload';
import { config } from '../config';
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

/**
 * 附件下载的 Content-Disposition：
 * 同时给 ASCII fallback 与 RFC 5987 的 UTF-8 文件名，中文文件名在 Chrome/Edge/Firefox 都能正确落盘。
 */
export function attachmentDisposition(filename: string): string {
  const cleaned = filename.replace(/[\r\n"]/g, '_').trim() || '附件';
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_').replace(/\\/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 以附件形式输出二进制；禁止缓存，避免授权 token 变化后拿到旧文件 */
export function sendDownloadedAttachment(res: Response, file: DownloadedAttachment): void {
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.buffer.byteLength));
  res.setHeader('Content-Disposition', attachmentDisposition(file.filename));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.buffer);
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

  /**
   * 附件下载：GET /api/messages/:id/attachments/:index/download?field=replyAttachments
   *
   * - `:id` 传 traceId（与详情 / 回放一致）；
   * - `field=replyAttachments` 时下载回复附件，默认原消息附件；
   * - 只按索引取服务端已入库的附件元数据，不接受客户端 URL / 文件名。
   */
  r.get('/messages/:id/attachments/:index/download', async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ ok: false, error: '附件索引不合法' });
      return;
    }
    const field = req.query.field === 'replyAttachments' || req.query.field === 'reply'
      ? 'replyAttachments'
      : 'attachments';
    try {
      const file = await svc.downloadAttachment(req.params.id, index, field);
      sendDownloadedAttachment(res, file);
    } catch (e) {
      if (e instanceof AttachmentDownloadError) {
        res.status(e.status).json({ ok: false, error: e.message });
        return;
      }
      const reason = e instanceof Error ? e.message : String(e);
      res.status(502).json({ ok: false, error: `附件下载失败：${reason}` });
    }
  });

  r.get('/messages/:id', (req, res) => {
    const m = svc.get(req.params.id);
    if (!m) {
      res.status(404).json({ ok: false, error: 'not found' });
      return;
    }
    res.json({ ok: true, data: m });
  });

  /**
   * 重新生成 AI 建议：POST /api/messages/:id/reanalyze
   * 用「当前」LLM 配置重跑一次分析（历史消息也适用），返回完整消息 + 降级原因；
   * 同一条消息并发请求由 service 去重。密钥不出服务端。
   */
  r.post('/messages/:id/reanalyze', async (req, res) => {
    try {
      const outcome = await svc.reanalyze(req.params.id);
      const rawReason = outcome.fallbackReason?.slice(0, 180);
      const message = outcome.message;
      // 三种结论分开说，别让「输入太短」被误读成 API / Key 坏了：
      // ① 调用失败 → 回退规则；② 模型成功但信息量不足 → 仍采用，只是低精度；③ 正常高精度结果。
      const reason = rawReason
        ? `本次真实调用失败，已回退规则：${rawReason}`
        : message.intentSource === 'llm' && message.aiPrecision === 'low'
          ? `真实模型已生成建议，但信息量较少（把握 ${message.aiConfidence ?? '未知'}），草稿偏简短、精度较低，未回退规则`
          : config.llm.reason;
      res.json({
        ok: true,
        data: message,
        llm: {
          mode: config.llm.mode,
          reason,
          providerLabel: config.llm.providerLabel,
          precision: message.aiPrecision,
          confidence: message.aiConfidence,
        },
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (/not found/i.test(reason)) {
        res.status(404).json({ ok: false, error: 'not found' });
        return;
      }
      res.status(500).json({ ok: false, error: `重新生成失败：${reason}` });
    }
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

  // 手动加入待办：普通消息也可转成待办（幂等），不改业务状态、不触发平台回写
  r.post('/messages/:id/todo', async (req, res) => {
    try {
      const message = await svc.markTodo(req.params.id);
      res.json({ ok: true, data: message });
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
