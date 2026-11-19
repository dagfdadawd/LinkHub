import { Router, type Request } from 'express';
import { Platform, MsgStatus, type IdentityRole } from '@unimsg/shared';
import { MessageService, type Viewer } from '../services/message';
import { listAccounts } from '../services/account';
import { IdentityUnavailableError } from '../services/identity';
import { config } from '../config';
import type { AuthedRequest } from '../middlewares/auth';
import { machineOwnerId } from '../middlewares/auth';
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

  /**
   * 当前查看者：登录用户带 userId（service 层据此做归属校验）；
   * 部署令牌/无人登录 = undefined = 全量视图。
   * 所有带 `:id` 的接口都必须把 viewer 一路传下去——归属校验在 service 层，不在这里。
   */
  const viewerOf = (req: Request): Viewer | undefined => {
    const user = (req as AuthedRequest).user;
    return user ? { userId: user.id } : undefined;
  };

  r.get('/accounts', (_req, res) => {
    res.json({ ok: true, data: listAccounts() });
  });

  // 全链路回放：消息 + 闭环日志
  r.get('/messages/trace/:traceId', (req, res) => {
    const traceId = req.params.traceId;
    const viewer = viewerOf(req);
    res.json({ ok: true, data: svc.getTrace(traceId, viewer), log: svc.getLoopLog(traceId, viewer) });
  });

  // 各平台发送能力（文本/文件、大小上限、当前通道），前端据此渲染「新建发送」表单
  r.get('/capabilities', (_req, res) => {
    res.json({ ok: true, data: sendCapabilities() });
  });

  r.get('/messages', (req, res) => {
    const platform = typeof req.query.platform === 'string' ? (req.query.platform as Platform) : undefined;
    const status = typeof req.query.status === 'string' ? (req.query.status as MsgStatus) : undefined;
    // 登录用户只看到自己的消息（数据隔离）；部署令牌（无人登录）看到全部
    res.json({ ok: true, data: svc.list({ platform, status }, viewerOf(req)) });
  });

  /** 认领「未归属」的历史消息到当前账号：隔离演示的入口 */
  r.post('/messages/claim', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(400).json({ ok: false, error: '需要先登录：认领会把历史消息归属到你的账号' });
      return;
    }
    const claimed = svc.claimUnowned(user.id);
    res.json({ ok: true, data: { claimed } });
  });

  r.get('/messages/:id', (req, res) => {
    const m = svc.get(req.params.id, viewerOf(req));
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
      const outcome = await svc.reanalyze(req.params.id, viewerOf(req));
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
      // 归属校验在 service 内部完成：别人的消息直接 404，不再有「回复顺手改归属」的副作用
      // quoteTraceId：显式引用某条消息；不传 = 普通发送（不再默认引用上一条）
      const quoteTraceId = typeof req.body?.quoteTraceId === 'string' && req.body.quoteTraceId.trim()
        ? req.body.quoteTraceId.trim()
        : undefined;
      const ack = await svc.reply(req.params.id, text, attachments, identity, viewerOf(req), quoteTraceId);
      res.status(202).json({ ok: true, ...ack });
    } catch (e) {
      // 三种结果分开：身份不可用 → 400（可修复的入参问题）；别人的消息/不存在 → 404；
      // 其余（探测身份的请求失败等）→ 500，别把基础设施故障说成"消息不存在"。
      if (e instanceof IdentityUnavailableError) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      const reason = e instanceof Error ? e.message : String(e);
      if (/not found/i.test(reason)) {
        res.status(404).json({ ok: false, error: 'not found' });
        return;
      }
      res.status(500).json({ ok: false, error: `回写失败：${reason}` });
    }
  });

  /**
   * 从统一入口主动向指定平台发送（赛题 A 功能需求 3）。
   * POST /api/messages/compose  { platform, conversationId?, conversationType?, text, attachments? }
   * 与 reply 走同一套闭环状态机，返回 202 + traceId，sent/synced 经 WS 推送。
   */
  r.post('/messages/compose', async (req, res) => {
    // 机器级发送：主动发消息用的是本机已连接的真实账号，
    // 因此只允许机器主人调用（普通成员不能借主人的飞书/钉钉/邮箱发信）。
    const caller = (req as AuthedRequest).user;
    const ownerId = machineOwnerId(svc);
    if (caller && ownerId && caller.id !== ownerId) {
      res.status(403).json({ ok: false, error: '只有机器主人可以主动发起发送；请让主人账号操作' });
      return;
    }
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
      // 主动发送的消息同样归属当前账号
      const user = (req as AuthedRequest).user;
      if (user) svc.assignOwner(ack.taskId, user.id);
      res.status(202).json({ ok: true, ...ack });
    } catch (e) {
      // 缺少目标会话属于可修复的入参问题，回 400 并带可操作提示；其余按 500 处理
      const reason = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: reason });
    }
  });

  r.post('/messages/:id/done', async (req, res) => {
    try {
      await svc.markDone(req.params.id, viewerOf(req));
      res.json({ ok: true });
    } catch {
      res.status(404).json({ ok: false, error: 'not found' });
    }
  });

  // 手动加入待办：普通消息也可转成待办（幂等），不改业务状态、不触发平台回写
  r.post('/messages/:id/todo', async (req, res) => {
    try {
      const message = await svc.markTodo(req.params.id, viewerOf(req));
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
      const changed = await svc.markAllRead(ids, viewerOf(req));
      res.json({ ok: true, changed });
    } catch {
      res.status(500).json({ ok: false, error: 'mark all read failed' });
    }
  });

  r.post('/messages/:id/read', async (req, res) => {
    try {
      const message = await svc.markRead(req.params.id, true, viewerOf(req));
      res.json({ ok: true, data: message });
    } catch {
      res.status(404).json({ ok: false, error: 'not found' });
    }
  });

  r.post('/messages/:id/unread', async (req, res) => {
    try {
      const message = await svc.markRead(req.params.id, false, viewerOf(req));
      res.json({ ok: true, data: message });
    } catch {
      res.status(404).json({ ok: false, error: 'not found' });
    }
  });

  return r;
}
