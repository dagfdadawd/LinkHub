/**
 * 通用接入通道（赛题 A 附加项）：任何外部采集器按统一格式把消息推进来。
 *
 *  - POST /api/ingest，body 为 IngestRequest（platform / externalId / body 必填）
 *  - 校验通过后组装成 UnifiedMessage，交给 svc.ingestUnified() 走统一的
 *    幂等/入库/trace/广播链路——幂等判断完全在 ingestUnified（同 platform+externalId
 *    重推返回 duplicate=true），路由层绝不自己查重。
 *  - 返回 202 { ok:true, data:{ message, duplicate } }：已受理但不保证已回复。
 *
 * 校验失败回 400 中文错误；ingestUnified 抛出的 InvalidPlatformEvent（如 externalId
 * 兜底成 'unknown'）同样转 400，服务端意外才是 500。风格对齐 routes/webhook.ts。
 */
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  MsgStatus, Platform,
  type IngestRequest, type MsgType, type UnifiedMessage,
} from '@unimsg/shared';
import { InvalidPlatformEvent, MessageService } from '../services/message';

const EXTERNAL_ID_MAX = 256;
const BODY_MAX = 100000;
const CONVERSATION_ID_MAX = 256;
const TRACE_ID_MAX = 64;
/** traceId 以外的自由文本字段统一 256 上限：它们会入库、进快照、进 WS 广播与转发正文 */
const TEXT_FIELD_MAX = 256;

const ALL_PLATFORMS = Object.values(Platform) as string[];
const MSG_TYPES: readonly MsgType[] = ['text', 'image', 'file', 'todo'];

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

/** 校验并取出 platform；不合法返回错误文案 */
function parsePlatform(raw: unknown): { value?: Platform; error?: string } {
  if (typeof raw !== 'string' || !ALL_PLATFORMS.includes(raw)) {
    return { error: `platform 必须是 ${ALL_PLATFORMS.join(' / ')} 之一` };
  }
  return { value: raw as Platform };
}

/** 校验 externalId：非空字符串且 <=256（它是幂等键的唯一来源） */
function parseExternalId(raw: unknown): { value?: string; error?: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: 'externalId 不能为空：它是幂等去重的唯一来源' };
  }
  if (raw.length > EXTERNAL_ID_MAX) {
    return { error: `externalId 不能超过 ${EXTERNAL_ID_MAX} 字符` };
  }
  return { value: raw };
}

/** 校验正文：非空字符串且 <=100000 */
function parseBody(raw: unknown): { value?: string; error?: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: 'body 不能为空：消息正文是必填的字符串' };
  }
  if (raw.length > BODY_MAX) {
    return { error: `body 不能超过 ${BODY_MAX} 字符` };
  }
  return { value: raw };
}

export function ingestRouter(svc: MessageService): Router {
  const r = Router();

  r.post('/ingest', async (req: Request, res: Response) => {
    const payload = (req.body ?? {}) as Partial<IngestRequest>;

    const platform = parsePlatform(payload.platform);
    if (platform.error) {
      sendError(res, 400, platform.error);
      return;
    }
    const externalId = parseExternalId(payload.externalId);
    if (externalId.error) {
      sendError(res, 400, externalId.error);
      return;
    }
    const body = parseBody(payload.body);
    if (body.error) {
      sendError(res, 400, body.error);
      return;
    }

    // 会话：传了就用（id 必须 <=256 的字符串），没传（或没传 id）就不加该字段
    let conversation: UnifiedMessage['conversation'];
    const rawConversation = payload.conversation;
    if (rawConversation !== undefined && rawConversation !== null) {
      if (typeof rawConversation !== 'object') {
        sendError(res, 400, 'conversation 必须是对象（{ id, type?, title? }）');
        return;
      }
      const convId = rawConversation.id;
      if (convId !== undefined && convId !== null) {
        if (typeof convId !== 'string' || convId.length === 0) {
          sendError(res, 400, 'conversation.id 必须是非空字符串');
          return;
        }
        if (convId.length > CONVERSATION_ID_MAX) {
          sendError(res, 400, `conversation.id 不能超过 ${CONVERSATION_ID_MAX} 字符`);
          return;
        }
        conversation = {
          id: convId,
          // Conversation.type 是必填字段：没传按群聊处理（与 compose 的缺省一致）
          type: rawConversation.type === 'p2p' ? 'p2p' : 'group',
          ...(typeof rawConversation.title === 'string' && rawConversation.title
            ? { title: rawConversation.title.slice(0, TEXT_FIELD_MAX) }
            : {}),
        };
      }
    }

    // 时间：传了必须能被 Date 解析，否则 400（绝不把畸形时间静默改成现在）
    let createdAt: string;
    if (payload.createdAt === undefined || payload.createdAt === null) {
      createdAt = new Date().toISOString();
    } else {
      if (typeof payload.createdAt !== 'string' || Number.isNaN(Date.parse(payload.createdAt))) {
        sendError(res, 400, 'createdAt 必须是可被 Date 解析的 ISO 时间字符串');
        return;
      }
      createdAt = payload.createdAt;
    }

    // 消息类型：不传默认 text；显式传了非法值直接 400（避免畸形 type 污染下游 OCR/展示）
    if (payload.type !== undefined && payload.type !== null && !MSG_TYPES.includes(payload.type)) {
      sendError(res, 400, `type 必须是 ${MSG_TYPES.join(' / ')} 之一`);
      return;
    }
    const type: MsgType = payload.type ?? 'text';

    const sender = (typeof payload.sender === 'object' && payload.sender !== null ? payload.sender : {});
    const senderId = typeof sender.id === 'string' && sender.id.trim()
      ? sender.id.slice(0, TEXT_FIELD_MAX)
      : 'ingest';
    const senderName = typeof sender.name === 'string' && sender.name.trim()
      ? sender.name.slice(0, TEXT_FIELD_MAX)
      : '外部采集器';

    // traceId：调用方可自带（便于与自己系统的日志对齐），但 traceId 是消息主键，
    // repo.save 是无条件覆盖——必须拒绝「与既有消息撞键」的值，否则一条 ingest
    // 就能把别人的消息（含 replies/status/mailMeta）整体替换掉。
    let traceId: string = randomUUID();
    if (payload.traceId !== undefined && payload.traceId !== null) {
      if (typeof payload.traceId !== 'string' || payload.traceId.trim().length === 0) {
        sendError(res, 400, 'traceId 必须是非空字符串；不传由服务端生成');
        return;
      }
      if (payload.traceId.length > TRACE_ID_MAX) {
        sendError(res, 400, `traceId 不能超过 ${TRACE_ID_MAX} 字符`);
        return;
      }
      if (svc.get(payload.traceId)) {
        sendError(res, 400, `traceId 已被占用（${payload.traceId}）：请换一个或不传，由服务端生成`);
        return;
      }
      traceId = payload.traceId;
    }

    const now = new Date().toISOString();
    const msg: UnifiedMessage = {
      traceId,
      platform: platform.value!,
      externalId: externalId.value!,
      sender: { id: senderId, name: senderName },
      ...(conversation ? { conversation } : {}),
      type,
      body: body.value!,
      status: MsgStatus.RECEIVED,
      direction: 'in',
      createdAt,
      updatedAt: now,
    };

    try {
      const result = await svc.ingestUnified(platform.value!, msg);
      res.status(202).json({ ok: true, data: result });
    } catch (e) {
      // 畸形事件（externalId 兜底成 'unknown' 等）是调用方的问题 → 400；其余异常仍 500
      if (e instanceof InvalidPlatformEvent) {
        sendError(res, 400, e.message);
        return;
      }
      sendError(res, 500, `接入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return r;
}
