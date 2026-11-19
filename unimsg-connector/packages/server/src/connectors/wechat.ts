/**
 * 微信个人版连接器（RPA 通道）。
 *
 * 微信个人版不开放收发 API，因此这里不是"调用平台接口"，而是把统一消息
 * 交给本机运行的 RPA 桥（独立 Python 进程），由它模拟键鼠操作微信桌面端。
 *
 * 设计原则（与项目其它连接器完全一致）：
 * - 收：RPA 桥读到微信消息后 POST /api/webhook/wechat，走标准 webhook 链路
 *   （verify → receive → svc.ingestUnified），本文件的 verify/receive 负责验签与映射。
 * - 发：connector.send() 在 mock 模式走 mockSend（如实标注"模拟发送"）；
 *   real 模式把内容 POST 给本地 RPA 桥的 /send，**核对桥回执的 mode === 'rpa'** 才回
 *   mode='real'——桥若在 mock 模式（它也会回 ok:true），这里直接抛错，绝不把"没碰微信"
 *   写成真实送达。
 * - 桥不可达 / 返回失败时抛错，由中枢写入 failed，**绝不静默假装成功**。
 *
 * 注意：这里的 mode='real' 表示"真实操作了微信桌面端"（RPA 真发），
 * 不是"调用了官方 API"。前端在 delivery 上会标注微信走 RPA 通道。
 */
import { basename } from 'node:path';
import {
  Platform,
  MsgStatus,
  type AttachmentInfo,
  type UnifiedMessage,
  type OutboundAttachment,
  type SendResult,
} from '@unimsg/shared';
import { config } from '../config';
import { DEFAULT_WECHAT_BRIDGE_URL } from '../config/runtime';
import { genTraceId, inferType, isMock, mockSend, verifyMock } from './base';
import { postJson } from './real';

/**
 * RPA 覆盖的事件种类（写文档用）：
 * - message：读到的新消息（入站，桥 → webhook）
 * - send   ：回写发送（出站，connector → 桥 /send）
 */
export const WECHAT_EVENT_KINDS = ['message', 'send'] as const;

export function bridgeUrl(): string {
  return (config.platforms.wechat?.bridgeUrl || DEFAULT_WECHAT_BRIDGE_URL).replace(/\/+$/, '');
}

/**
 * 验签：RPA 桥是本机进程，用固定 `dev-rpa` 签名。
 * mock 模式仍允许 dev 前缀 / mock 方便演示；real 模式只认 dev-rpa，
 * 否则公共 webhook 会被任意 dev 前缀 / 缺省 mock 注入。
 */
export const RPA_WEBHOOK_SIGNATURE = 'dev-rpa';

export function verify(_payload: unknown, sig: string): boolean {
  // real 模式只认本机桥的固定签名。以前沿用 verifyMock（接受 mock / 任意 dev*），
  // 而 webhook 的 querySignature 在缺 header 时默认成 'mock'——等于把
  // /api/webhook/wechat 变成无签名可写入口，任何人可伪造微信消息。
  // mock 模式仍允许 dev* / mock，方便演示注入；真实模式必须收紧。
  if (config.runtime[Platform.WECHAT]?.mode === 'real') return sig === RPA_WEBHOOK_SIGNATURE;
  return verifyMock(sig);
}

/** RPA 桥上报的消息体（约定格式，见 rpa_bridge.py 的 /ingest 与 demo 注入） */
export interface WechatRawAttachment {
  name?: string;
  fileName?: string;
  /** 桥签发的不透明文件 token（新版桥；推荐，不暴露本机路径） */
  token?: string;
  /** 旧版桥的本机绝对路径；仅兼容旧消息 */
  path?: string;
  filePath?: string;
  size?: number;
  mimeType?: string;
}

export interface WechatRawEvent {
  /** 微信消息唯一 ID（桥可用 时间戳+发送方+内容 生成），作为幂等键 */
  externalId?: string;
  messageId?: string;
  /** 发送方显示名 */
  from?: string;
  senderName?: string;
  /** 发送方 ID（微信号 / 备注名），缺省用显示名 */
  senderId?: string;
  /** 会话/群名 */
  conversation?: string;
  conversationName?: string;
  conversationType?: 'p2p' | 'group';
  /** 消息正文 */
  text?: string;
  body?: string;
  /** 消息类型 */
  type?: 'text' | 'image' | 'file';
  /** 附件文件名（旧版桥只给名字，没有本地路径时无法下载） */
  fileName?: string;
  /** 结构化附件（新版桥；image/file 消息会带上本机落盘路径） */
  attachments?: WechatRawAttachment[];
  /** 时间戳（ISO 或毫秒） */
  at?: string | number;
}

/** 桥上报的附件 → 统一附件元数据（只保留有意义的字段，不把 undefined 塞进消息里） */
function toAttachments(src: WechatRawEvent): AttachmentInfo[] | undefined {
  const raws: WechatRawAttachment[] = Array.isArray(src.attachments) ? src.attachments : [];
  const list: AttachmentInfo[] = raws
    .map((a) => {
      const rawName = String(a?.name ?? a?.fileName ?? '').trim();
      const token = String(a?.token ?? '').trim();
      const path = String(a?.path ?? a?.filePath ?? '').trim();
      const name = basename(rawName || path || '').trim();
      if (!name) return undefined;
      const size = Number(a?.size);
      const item: AttachmentInfo = {
        name,
        mimeType: String(a?.mimeType ?? '').trim() || 'application/octet-stream',
        size: Number.isFinite(size) && size > 0 ? size : 0,
      };
      // 新版桥只给不透明 token；旧版桥的绝对路径只用于兼容，新消息不再写 localPath。
      if (token) item.fileToken = token;
      else if (path && (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))) item.localPath = path;
      return item;
    })
    .filter((a): a is AttachmentInfo => Boolean(a));

  if (list.length) return list;
  // 旧版桥只给 fileName：保留文件名展示，但不假装能下载
  const legacy = (src.fileName ?? '').trim();
  return legacy
    ? [{ name: basename(legacy), mimeType: 'application/octet-stream', size: 0 }]
    : undefined;
}

/** 外部事件 → 统一消息 */
export function receive(raw: unknown): UnifiedMessage {
  const e = (raw && typeof raw === 'object' ? raw : {}) as WechatRawEvent & { event?: WechatRawEvent };
  const src = e.event && typeof e.event === 'object' ? e.event : e;

  const externalId = (src.externalId || src.messageId || '').trim();
  const text = typeof src.text === 'string' ? src.text : typeof src.body === 'string' ? src.body : '';
  const name = (src.from || src.senderName || '微信好友').trim();
  const attachments = toAttachments(src);
  const type = src.type === 'image' || src.type === 'file' || attachments?.length ? 'file' : inferType(text);

  let body = text;
  for (const a of attachments ?? []) {
    // 拖选复制出来的正文本来就带 "[文件] 名字" / "[图片] 名字"，不要重复追加
    if (body.includes(a.name)) continue;
    body = body ? `${body}\n[文件] ${a.name}` : `[文件] ${a.name}`;
  }
  if (!body && src.fileName) body = `[文件] ${basename(src.fileName)}`;

  const convName = (src.conversation || src.conversationName || '').trim();
  const now = new Date().toISOString();
  // 「按需拉取」会把微信里显示的消息时间（拖选复制文本里的时间行）一起带上来；
  // 能解析就用它，否则退回收到时刻。不能让所有历史消息都显示成"刚刚"。
  const at = normalizeAt(src.at) ?? now;
  return {
    traceId: genTraceId(),
    platform: Platform.WECHAT,
    // 不臆造 ID：缺失时留空，交给 ingestUnified 按「缺 externalId」拒收（400），
    // 否则每条缺 ID 的事件都会拿到不同随机键，幂等去重形同虚设。
    externalId,
    sender: { name, id: (src.senderId || name).trim() },
    conversation: convName
      ? { id: convName, title: convName, type: src.conversationType === 'group' ? 'group' : 'p2p' }
      : undefined,
    type,
    body,
    // RPA 读到的是真人真实收发，标记为本人账号接收；mock 演示由 demoSamples 另走 mock
    receivedAs: 'user',
    direction: 'in',
    attachments,
    status: MsgStatus.RECEIVED,
    createdAt: at,
    updatedAt: now,
  };
}

/** 把桥上报的时间（毫秒号 / ISO / 无时区的本地时间串）统一成 ISO；认不出就返回 null */
function normalizeAt(value: string | number | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** 回写给 RPA 桥的载荷。附件以文件名+base64 交给桥落盘，避免正文塞爆日志。 */
export function convert(msg: UnifiedMessage, attachments: OutboundAttachment[] = []): Record<string, unknown> {
  return {
    text: msg.reply ?? msg.body,
    conversation: msg.conversation?.title || msg.conversation?.id || msg.sender.name,
    senderId: msg.sender.id,
    attachments: attachments.map((a) => ({
      name: a.name,
      mimeType: a.mimeType,
      contentBase64: a.contentBase64,
    })),
    traceId: msg.traceId,
  };
}

/** 统一消息 → 微信桌面端（经本地 RPA 桥） */
export async function send(msg: UnifiedMessage, attachments: OutboundAttachment[] = []): Promise<SendResult> {
  const payload = convert(msg, attachments);

  // Mock：本地模拟，绝不外呼，如实标注
  if (isMock(Platform.WECHAT)) {
    return mockSend(Platform.WECHAT, payload);
  }

  // real：交给本地 RPA 桥模拟键鼠。桥不可达/失败一律抛错，不伪装成功。
  let res: any;
  try {
    res = await postJson(`${bridgeUrl()}/send`, payload);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // RPA 不是幂等操作：重试可能把同一条文本/文件再发一遍。
    throw noRetry(new Error(`微信 RPA 发送失败（请确认 RPA 桥已启动、微信桌面端已登录）：${detail}`));
  }

  if (!res || res.ok !== true) {
    throw noRetry(new Error(`微信 RPA 桥拒绝发送：${res?.error || '未知原因'}`));
  }

  // P0：桥自报的运行态必须核对。
  // 桥在 mock 模式下同样返回 ok:true（它只是记了一条日志），如果这里不校验，
  // 后端就会把「桥根本没碰微信」写成 mode='real'——界面显示真实送达，实际没发出去。
  const bridgeMode = typeof res.mode === 'string' ? res.mode.trim() : '';
  if (bridgeMode !== 'rpa') {
    throw noRetry(new Error(
      `RPA 桥当前是 ${bridgeMode || '未知'} 模式，本次没有真实操作微信（消息未送达）。`
      + '请用 `python scripts/wechat-rpa/rpa_bridge.py --mode rpa` 重启桥并确认微信桌面端已登录；'
      + '如果只想演示，请把 WECHAT_MODE 设为 mock，界面会如实标为「模拟发送」。',
    ));
  }

  return {
    ok: true,
    // platformReply 带 rpa 前缀，明确这条是 RPA 真发而非 API
    platformReply: `rpa:${res.messageId || res.reply || 'sent'}`,
    mode: 'real',
    // 桥没上报 verified（旧版）按未核对处理，绝不默认 true。
    verified: res.verified === true,
  };
}

function noRetry<T extends Error>(e: T): T & { noRetry: true } {
  return Object.assign(e, { noRetry: true as const });
}

export const wechatConnector = {
  verify,
  receive,
  send,
  convert,
};
