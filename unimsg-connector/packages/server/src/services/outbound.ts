/**
 * 出站消息公共层（赛题 A 功能需求 3「从统一入口向指定平台发送文本消息、文件等」）。
 *
 * 设计要点：
 *  1. 所有不可信请求体先在这里收敛：平台、目标会话、文本、附件都做白名单校验；
 *  2. 附件只允许 base64 在途传递，`contentBase64` 绝不入库 / 写日志 / WS 广播，
 *     对外只暴露 `AttachmentInfo`（文件名 + 类型 + 大小）；
 *  3. 声明的大小必须与解码后的实际字节数一致，防伪造、防超大 payload 打爆内存；
 *  4. 平台能力集中声明，前端据此决定文件按钮可用性，不靠前端硬编码平台差异。
 */
import {
  Platform, FILE_LIMITS, TODO_TITLE_MAX,
  type OutboundAttachment,
  type AttachmentInfo,
  type SendCapabilities,
  type ComposeRequest,
  type TodoDraft,
  type UnifiedMessage,
} from '@unimsg/shared';
import { modeOf } from '../config';

/** 附件/主动发送请求不合法：路由层据此回 400，而不是混进 500 或静默丢文件 */
export class InvalidOutboundRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboundRequest';
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SAFE_NAME_RE = /^[^\\/\x00-\x1f]{1,255}$/;
const PLATFORMS = new Set<string>(Object.values(Platform));

/** 解码并复核附件：返回文件内容 Buffer，仅供本次平台投递使用 */
export function decodeAttachment(a: OutboundAttachment): Buffer {
  const b64 = a.contentBase64;
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new InvalidOutboundRequest(`附件「${a.name}」的 base64 内容不合法`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength !== a.size) {
    throw new InvalidOutboundRequest(
      `附件「${a.name}」声明大小 ${a.size} 字节，实际解码为 ${buf.byteLength} 字节（拒绝伪造大小）`,
    );
  }
  return buf;
}

/** 请求体里的附件数组 → 合规附件数组（含解码复核） */
export function normalizeAttachments(raw: unknown): OutboundAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvalidOutboundRequest('attachments 必须是数组');
  if (raw.length > FILE_LIMITS.maxFiles) {
    throw new InvalidOutboundRequest(`最多只能带 ${FILE_LIMITS.maxFiles} 个附件，当前 ${raw.length} 个`);
  }

  let total = 0;
  const out = raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new InvalidOutboundRequest(`第 ${i + 1} 个附件不是合法对象`);
    }
    const v = item as Record<string, unknown>;
    const { name, mimeType, size, contentBase64 } = v;

    if (typeof name !== 'string' || !SAFE_NAME_RE.test(name.trim())) {
      throw new InvalidOutboundRequest(`第 ${i + 1} 个附件文件名非法（不能含路径分隔符/控制字符，最长 255 字符）`);
    }
    if (typeof mimeType !== 'string' || !mimeType.trim() || mimeType.length > 128) {
      throw new InvalidOutboundRequest(`附件「${name}」缺少合法的 MIME 类型`);
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
      throw new InvalidOutboundRequest(`附件「${name}」的 size 必须是正整数`);
    }
    if (size > FILE_LIMITS.maxFileBytes) {
      throw new InvalidOutboundRequest(
        `附件「${name}」超过单文件上限 ${Math.floor(FILE_LIMITS.maxFileBytes / 1024 / 1024)}MB`,
      );
    }
    total += size;
    if (total > FILE_LIMITS.maxTotalBytes) {
      throw new InvalidOutboundRequest(
        `附件总大小超过 ${Math.floor(FILE_LIMITS.maxTotalBytes / 1024 / 1024)}MB 上限`,
      );
    }

    const normalized: OutboundAttachment = {
      name: name.trim(),
      mimeType: mimeType.trim(),
      size,
      contentBase64: typeof contentBase64 === 'string' ? contentBase64 : '',
    };
    decodeAttachment(normalized);
    return normalized;
  });
  return out;
}

/** 只保留可安全持久化 / 广播的附件元数据 */
export function describeAttachments(list: OutboundAttachment[]): AttachmentInfo[] {
  return list.map(({ name, mimeType, size }) => ({ name, mimeType, size }));
}

/** 预览串上限：base64 超过这个长度就不带预览，避免消息列表接口被一张图撑爆 */
export const PREVIEW_MAX_BASE64 = 2_000_000;

/**
 * 在元数据基础上给**图片**附件带上 data URL 预览。
 *
 * 气泡里能直接看到缩略图、点开能放大；非图片或超阈值的附件只留元数据，
 * 前端仍按文件卡片渲染（不假装能预览）。
 */
export function describeAttachmentsWithPreview(list: OutboundAttachment[]): AttachmentInfo[] {
  return list.map(({ name, mimeType, size, contentBase64 }) => {
    const base: AttachmentInfo = { name, mimeType, size };
    if (!/^image\//i.test(mimeType ?? '')) return base;
    if (!contentBase64 || contentBase64.length > PREVIEW_MAX_BASE64) return base;
    return { ...base, preview: `data:${mimeType};base64,${contentBase64}` };
  });
}

/**
 * 「同时加为待办」请求体归一化：标题与截止时间都选填，但给了就必须合法。
 *
 * 返回 undefined = 本次不创建待办；返回对象（可能为空 {}）= 创建待办但用默认值。
 * 截止时间统一转成 ISO：后端与前端（formatDue / groupTodos）只认一种格式，
 * 避免把「明天下午」这类自然语言直接落库造成展示漂移。
 */
export function normalizeTodo(raw: unknown): TodoDraft | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidOutboundRequest('todo 必须是对象（{ title?, dueAt? }），或省略表示不加待办');
  }
  const v = raw as Record<string, unknown>;

  let title: string | undefined;
  if (v.title !== undefined && v.title !== null && v.title !== '') {
    if (typeof v.title !== 'string') throw new InvalidOutboundRequest('todo.title 必须是字符串');
    title = v.title.trim();
    if (!title) title = undefined;
    else if (title.length > TODO_TITLE_MAX) {
      throw new InvalidOutboundRequest(`待办标题最长 ${TODO_TITLE_MAX} 字符`);
    }
  }

  let dueAt: string | undefined;
  if (v.dueAt !== undefined && v.dueAt !== null && v.dueAt !== '') {
    if (typeof v.dueAt !== 'string') throw new InvalidOutboundRequest('todo.dueAt 必须是 ISO 时间字符串');
    const ms = Date.parse(v.dueAt);
    if (Number.isNaN(ms)) throw new InvalidOutboundRequest('todo.dueAt 不是合法时间（需要 ISO 8601，如 2026-11-20T18:00:00+08:00）');
    dueAt = new Date(ms).toISOString();
  }

  return { ...(title ? { title } : {}), ...(dueAt ? { dueAt } : {}) };
}

/**
 * 主动发送请求体归一化。
 * 允许「只有文本」「只有文件」「文本 + 文件」，但两者不能同时为空。
 */
export function normalizeCompose(raw: unknown): ComposeRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidOutboundRequest('请求体必须是对象');
  }
  const v = raw as Record<string, unknown>;
  const platform = v.platform;
  if (typeof platform !== 'string' || !PLATFORMS.has(platform)) {
    throw new InvalidOutboundRequest(`platform 必须是 ${[...PLATFORMS].join(' / ')} 之一`);
  }

  const text = typeof v.text === 'string' ? v.text.trim() : '';
  if (text.length > 4000) throw new InvalidOutboundRequest('文本消息最长 4000 字符');

  const attachments = normalizeAttachments(v.attachments);
  if (!text && attachments.length === 0) {
    throw new InvalidOutboundRequest('文本与附件不能同时为空');
  }

  const conversationId = typeof v.conversationId === 'string' ? v.conversationId.trim() : '';
  if (conversationId.length > 512) throw new InvalidOutboundRequest('conversationId 最长 512 字符');

  const conversationType = v.conversationType === 'p2p' || v.conversationType === 'group'
    ? v.conversationType
    : undefined;

  // 目标会话名（可选）：主动发送时后端拿不到名字，用前端选择器的显示名补齐
  const conversationTitle = typeof v.conversationTitle === 'string'
    ? v.conversationTitle.trim().slice(0, 64)
    : '';

  const mailAccount = typeof v.mailAccount === 'string' ? v.mailAccount.trim() : '';
  if (v.mailAccount !== undefined && v.mailAccount !== null && typeof v.mailAccount !== 'string') {
    throw new InvalidOutboundRequest('mailAccount 必须是字符串（邮箱账号 key）');
  }
  if (mailAccount) {
    if (platform !== Platform.MAIL) {
      throw new InvalidOutboundRequest('mailAccount 仅适用于邮箱平台');
    }
    // key 来自 MAIL_ACCOUNTS / MAIL_<KEY>_*，只允许常见的环境变量段字符
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(mailAccount)) {
      throw new InvalidOutboundRequest('mailAccount 只允许字母/数字/下划线/连字符，最长 64 字符');
    }
  }

  // 发送身份：只有飞书 / 钉钉有本人身份通道；取值只允许 bot | user
  let identity: 'bot' | 'user' | undefined;
  if (v.identity !== undefined && v.identity !== null && v.identity !== '') {
    if (v.identity !== 'bot' && v.identity !== 'user') {
      throw new InvalidOutboundRequest('identity 只能是 bot（机器人）或 user（本人账号）');
    }
    if (platform !== Platform.FEISHU && platform !== Platform.DINGTALK) {
      throw new InvalidOutboundRequest('identity 仅适用于飞书 / 钉钉：其它平台没有「本人身份」通道');
    }
    identity = v.identity;
  }

  // 手动待办：选填；给了就校验（标题长度 / 截止时间合法性），脏数据不进状态机
  const todo = normalizeTodo(v.todo);

  return {
    platform: platform as Platform,
    ...(conversationId ? { conversationId } : {}),
    ...(conversationType ? { conversationType } : {}),
    ...(conversationTitle ? { conversationTitle } : {}),
    ...(mailAccount ? { mailAccount } : {}),
    ...(identity ? { identity } : {}),
    ...(todo ? { todo } : {}),
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * 是否为「统一入口主动发起」的消息。
 * 入站消息的 sender.id 是发件人；主动发送时目标会话才是收件人，
 * 钉钉的适配器据此切换 userIds，避免把 'linkhub' 当收件人。
 */
export function isOutboundComposed(msg: UnifiedMessage): boolean {
  return msg.externalId.startsWith('compose:') || msg.externalId.includes(':compose:');
}

/** 平台文件通道说明：如实写出真实接口侧的边界，避免演示时被误读为「平台已支持」 */
const FILE_NOTES: Partial<Record<Platform, string>> = {
  [Platform.DINGTALK]: '钉钉机器人发送文件需要应用具备媒体上传权限；Mock 通道可完整演示文件闭环',
  [Platform.MAIL]: '邮箱文件以标准 MIME multipart/mixed 附件发送，大小受服务商限制',
};

/** 各平台当前发送能力（含本次实际通道，供前端展示与按钮禁用判断） */
export function sendCapabilities(): SendCapabilities[] {
  return Object.values(Platform).map((platform) => ({
    platform,
    mode: modeOf(platform),
    text: true,
    file: true,
    maxFiles: FILE_LIMITS.maxFiles,
    maxFileBytes: FILE_LIMITS.maxFileBytes,
    ...(FILE_NOTES[platform] ? { note: FILE_NOTES[platform] } : {}),
  }));
}
