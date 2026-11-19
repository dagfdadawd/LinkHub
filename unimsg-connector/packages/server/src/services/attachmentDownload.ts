/**
 * 附件下载（平台资源 → 浏览器）。
 *
 * 背景：消息里的附件以前只有「文件名 + 大小」元数据，界面只能展示卡片。
 * 对于「本人账号」收到的文件（钉钉 `fileId` / 飞书 `file_key`），
 * 平台其实提供了下载能力，只是入站映射时把资源 ID 丢掉了。
 *
 * 这一层负责把「消息 + 附件」还原成真实字节，并统一做：
 *  - 平台资源引用校验（没有引用的演示 / 主动发送文件 → 409，不假装能下）；
 *  - 身份选择（飞书本人 token vs 机器人 tenant token；钉钉 dws 当前登录用户）；
 *  - 临时文件清理、50MB 上限、文件名净化、MIME 兜底；
 *  - 平台错误 → 可读中文 + 合理 HTTP 状态（不把 token 带进错误）。
 *
 * 路由层只负责鉴权、取消息和设置 Content-Disposition。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  Platform,
  type AttachmentInfo,
  type UnifiedMessage,
} from '@unimsg/shared';
import { config, modeOf } from '../config';
import { DingtalkPersonalError, dingtalkPersonalClient } from '../connectors/dingtalkPersonal';
import { feishuUserAuth } from '../connectors/feishuUserAuth';
import { bridgeUrl } from '../connectors/wechat';
import {
  feishuTenantToken,
  getBinary,
  MAX_ATTACHMENT_BYTES,
  type BinaryResponse,
} from '../connectors/real';

export type AttachmentField = 'attachments' | 'replyAttachments';

export interface DownloadedAttachment {
  buffer: Buffer;
  /** 已净化、可直接写 Content-Disposition 的文件名 */
  filename: string;
  mimeType: string;
  /** 本次实际从哪个平台取回（排障 / 测试用，不下发前端） */
  source: Platform;
}

/** 附件不可下载 / 平台失败：带 HTTP 状态，路由直接转 JSON 错误 */
export class AttachmentDownloadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AttachmentDownloadError';
  }
}

export interface AttachmentDownloadDeps {
  dingtalk: {
    downloadMedia(input: {
      mediaId: string;
      messageId: string;
      conversationId: string;
      outputPath: string;
    }): Promise<void>;
    downloadDriveFile(input: { fileId: string; outputPath: string }): Promise<void>;
  };
  feishu: {
    baseUrl: string;
    userToken(): Promise<string>;
    tenantToken(): Promise<string>;
    getBinary(url: string, headers: Record<string, string>): Promise<BinaryResponse>;
  };
  /**
   * 微信：文件在微信客户端自己落盘，由本机 RPA 桥做白名单校验后回吐字节。
   * 后端不直接读 attachment.localPath（避免把"消息里的路径"当成本机任意读的凭据）。
   */
  wechat?: {
    /** kind=token 用新版不透明 token；path 仅兼容旧版桥消息 */
    fileUrl(value: string, kind: 'token' | 'path'): string;
    getBinary(url: string, headers: Record<string, string>, opts?: { timeoutMs?: number; label?: string }): Promise<BinaryResponse>;
  };
}

/** 生产默认依赖；单测通过参数注入假实现，绝不外呼 / 不启动 dws */
const realDeps: AttachmentDownloadDeps = {
  dingtalk: {
    downloadMedia: (input) => dingtalkPersonalClient().downloadMedia(input),
    downloadDriveFile: (input) => dingtalkPersonalClient().downloadDriveFile(input),
  },
  feishu: {
    baseUrl: config.platforms.feishu.baseUrl,
    userToken: () => feishuUserAuth().accessToken(),
    tenantToken: () => feishuTenantToken(),
    getBinary: (url, headers) => getBinary(url, headers, { label: '飞书附件', timeoutMs: 120_000 }),
  },
  wechat: {
    fileUrl: (value, kind) => `${bridgeUrl()}/file?${kind}=${encodeURIComponent(value)}`,
    getBinary: (url, headers, opts) => getBinary(url, headers, { label: '微信附件', timeoutMs: 30_000, ...opts }),
  },
};

/**
 * 是否可以尝试下载：前端按钮也按同一组字段显示。
 * 主动通过 LinkHub 发送的文件只有元数据（内容不落库），因此没有这些引用，不能下载。
 */
export function isAttachmentDownloadable(
  attachment: Pick<AttachmentInfo, 'mediaId' | 'fileId' | 'fileKey' | 'fileToken' | 'localPath' | 'preview'> | undefined,
): boolean {
  return Boolean(
    attachment?.mediaId
    || attachment?.fileId
    || attachment?.fileKey
    || attachment?.fileToken
    || attachment?.localPath
    || attachment?.preview?.startsWith('data:'),
  );
}

/** 文件名净化：去路径、控制字符、Windows 保留字符；保证浏览器保存时安全 */
export function safeDownloadFilename(raw: string | undefined, fallback = '附件'): string {
  const base = basename(String(raw ?? '').trim()) || fallback;
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '');
  return (cleaned || fallback).slice(0, 160);
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
};

export function mimeFromFilename(name: string): string | undefined {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return ext ? MIME_BY_EXT[ext] : undefined;
}

/** 文件头嗅探：平台经常回 application/octet-stream，靠它把图片/PDF 还原成能预览的类型 */
export function sniffMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'application/zip';
  return undefined;
}

function isSpecificMime(value: string | undefined): value is string {
  if (!value) return false;
  const v = value.toLowerCase();
  return v !== 'application/octet-stream' && !v.includes('*');
}

function finalMime(attachment: AttachmentInfo, name: string, res?: BinaryResponse, buffer?: Buffer): string {
  if (isSpecificMime(attachment.mimeType)) return attachment.mimeType;
  const fromResponse = res?.contentType?.split(';')[0]?.trim();
  if (isSpecificMime(fromResponse)) return fromResponse;
  const fromName = mimeFromFilename(name);
  if (fromName) return fromName;
  return (buffer && sniffMime(buffer)) || 'application/octet-stream';
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/plain': 'txt',
  'application/zip': 'zip',
};

/** 没有扩展名的平台附件（如钉钉图片占位名）补一个，浏览器保存后才认得文件类型 */
function withExtension(name: string, mimeType: string): string {
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
  const ext = EXT_BY_MIME[mimeType.split(';')[0]!.trim().toLowerCase()];
  return ext ? `${name}.${ext}` : name;
}

/**
 * 图片预览 data URL 本身就是文件内容（主动发送的图片、钉钉已水化的预览）：
 * 没有平台资源引用时，允许直接把它还原成下载文件，不白丢一张图。
 */
function decodePreviewDataUrl(url: string): { buffer: Buffer; mimeType: string } | undefined {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(url);
  if (!match) return undefined;
  const mimeType = match[1] || 'application/octet-stream';
  const data = match[3] ?? '';
  try {
    const buffer = match[2] ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ATTACHMENT_BYTES) return undefined;
    return { buffer, mimeType };
  } catch {
    return undefined;
  }
}

/** 钉钉 externalId 带 `dingtalk:` 前缀；飞书是裸 message_id */
function messageIdFor(message: UnifiedMessage): string {
  const raw = String(message.externalId ?? '').trim();
  if (message.platform === Platform.DINGTALK) return raw.replace(/^dingtalk:/, '');
  if (message.platform === Platform.FEISHU) return raw.replace(/^feishu:/, '');
  return raw;
}

function dingtalkError(e: unknown): AttachmentDownloadError {
  if (e instanceof AttachmentDownloadError) return e;
  if (e instanceof DingtalkPersonalError) {
    const status =
      e.kind === 'not-logged-in' || e.kind === 'not-installed'
        ? 409
        : e.kind === 'timeout'
          ? 504
          : e.kind === 'permission'
            ? 403
            : e.kind === 'validation'
              ? 400
              : 502;
    return new AttachmentDownloadError(`钉钉附件下载失败：${e.message}`, status);
  }
  return new AttachmentDownloadError(
    `钉钉附件下载失败：${e instanceof Error ? e.message : String(e)}`,
    502,
  );
}

function feishuError(e: unknown): AttachmentDownloadError {
  if (e instanceof AttachmentDownloadError) return e;
  const reason = e instanceof Error ? e.message : String(e);
  // 本人 token 未授权 / 过期是可修复的账号问题，不是服务端 5xx
  const authIssue = /授权|未连接|过期|token|refresh/i.test(reason);
  return new AttachmentDownloadError(`飞书附件下载失败：${reason}`, authIssue ? 409 : 502);
}

/** 钉钉下载到临时目录：dws 只接受本地路径，读成 Buffer 后立刻清理 */
async function withTempDownload(
  filename: string,
  run: (outputPath: string) => Promise<void>,
): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-attachment-'));
  const outputPath = join(dir, safeDownloadFilename(filename, 'attachment'));
  try {
    await run(outputPath);
    let size = 0;
    try {
      size = statSync(outputPath).size;
    } catch {
      throw new AttachmentDownloadError('平台没有返回文件内容（临时文件不存在）', 502);
    }
    if (size === 0) throw new AttachmentDownloadError('平台返回了空文件，无法下载', 502);
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentDownloadError(
        `文件过大（${Math.round(size / 1024 / 1024)}MB），超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 下载上限`,
        413,
      );
    }
    return readFileSync(outputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function downloadDingtalk(
  message: UnifiedMessage,
  attachment: AttachmentInfo,
  filename: string,
  deps: AttachmentDownloadDeps,
): Promise<DownloadedAttachment> {
  const { mediaId, fileId } = attachment;
  const messageId = messageIdFor(message);
  const conversationId = message.conversation?.id;

  try {
    let buffer: Buffer | undefined;
    if (fileId) {
      buffer = await withTempDownload(filename, (outputPath) =>
        deps.dingtalk.downloadDriveFile({ fileId, outputPath }),
      );
    } else if (mediaId) {
      if (!messageId || !conversationId) {
        throw new AttachmentDownloadError(
          '钉钉附件缺少消息/会话信息，无法按 mediaId 下载；请在会话里重新接收一条消息后重试',
          409,
        );
      }
      buffer = await withTempDownload(filename, (outputPath) =>
        deps.dingtalk.downloadMedia({ mediaId, messageId, conversationId, outputPath }),
      );
    } else {
      throw new AttachmentDownloadError('这条钉钉附件没有可下载的资源 ID', 409);
    }
    if (!buffer) throw new AttachmentDownloadError('平台没有返回文件内容', 502);
    return {
      buffer,
      filename,
      mimeType: finalMime(attachment, filename, undefined, buffer),
      source: Platform.DINGTALK,
    };
  } catch (e) {
    throw dingtalkError(e);
  }
}

async function downloadFeishu(
  message: UnifiedMessage,
  attachment: AttachmentInfo,
  filename: string,
  deps: AttachmentDownloadDeps,
): Promise<DownloadedAttachment> {
  const fileKey = attachment.fileKey;
  if (!fileKey) throw new AttachmentDownloadError('这条飞书附件没有可下载的 file_key', 409);
  const messageId = messageIdFor(message);
  if (!messageId) throw new AttachmentDownloadError('飞书附件缺少 message_id，无法下载', 409);

  const resourceType = attachment.resourceType
    ?? (/^image\//i.test(attachment.mimeType ?? '') ? 'image' : 'file');
  // 本人身份收到的 / 以本人身份发出的，必须用 user_access_token；
  // 机器人通道才用 tenant_access_token。绝不悄悄降级身份。
  const asUser = message.receivedAs === 'user'
    || message.sendIdentity === 'user'
    || message.delivery?.identity === 'user';

  try {
    const token = asUser ? await deps.feishu.userToken() : await deps.feishu.tenantToken();
    const url = `${deps.feishu.baseUrl.replace(/\/+$/, '')}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${resourceType}`;
    const res = await deps.feishu.getBinary(url, { Authorization: `Bearer ${token}` });
    return {
      buffer: res.buffer,
      filename,
      mimeType: finalMime(attachment, filename, res, res.buffer),
      source: Platform.FEISHU,
    };
  } catch (e) {
    throw feishuError(e);
  }
}

async function downloadWechat(
  attachment: AttachmentInfo,
  filename: string,
  deps: AttachmentDownloadDeps,
): Promise<DownloadedAttachment> {
  const fileToken = attachment.fileToken;
  const localPath = attachment.localPath;
  if (!fileToken && !localPath) {
    throw new AttachmentDownloadError(
      '这条微信附件没有可下载的文件引用（旧版桥只上报了文件名，或文件已被移动/删除），无法下载；请到微信客户端查看。',
      409,
    );
  }
  const client = deps.wechat ?? realDeps.wechat!;
  try {
    const res = await client.getBinary(
      fileToken ? client.fileUrl(fileToken, 'token') : client.fileUrl(localPath!, 'path'),
      {},
    );
    if (res.buffer.byteLength === 0) {
      throw new AttachmentDownloadError('微信 RPA 桥返回了空文件', 502);
    }
    return {
      buffer: res.buffer,
      filename,
      mimeType: finalMime(attachment, filename, res, res.buffer),
      source: Platform.WECHAT,
    };
  } catch (e) {
    if (e instanceof AttachmentDownloadError) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    const unreachable = /ECONNREFUSED|ECONNRESET|fetch failed|超时|timeout|不可达/i.test(reason);
    throw new AttachmentDownloadError(
      unreachable
        ? `微信附件下载失败：连不上本机 RPA 桥（请确认桥已启动，且后端与桥在同一台机器）`
        : `微信附件下载失败：${reason}`,
      unreachable ? 502 : 409,
    );
  }
}

/**
 * 下载一条消息里的附件。
 * 只读取已入库的元数据，不信任客户端传入的 URL / 文件名 / 路径。
 */
export async function downloadAttachment(
  message: UnifiedMessage,
  attachment: AttachmentInfo,
  deps: AttachmentDownloadDeps = realDeps,
): Promise<DownloadedAttachment> {
  if (!isAttachmentDownloadable(attachment)) {
    if (message.platform === Platform.MAIL) {
      throw new AttachmentDownloadError(
        '邮件附件暂不支持在 LinkHub 内下载：邮件的附件内容没有入库，请到邮箱客户端查看（正文与附件名已展示在消息里）。',
        409,
      );
    }
    if (message.platform === Platform.WECHAT) {
      throw new AttachmentDownloadError(
        '这条微信附件没有可下载的文件引用（旧版桥只上报了文件名，或文件已被移动/删除），无法下载；请到微信客户端查看。',
        409,
      );
    }
    throw new AttachmentDownloadError(
      '这条附件没有平台资源引用，无法下载（可能是 LinkHub 主动发送的文件、演示数据或旧版本消息）。',
      409,
    );
  }

  const filename = safeDownloadFilename(attachment.name);

  // 没有平台资源引用、但有预览 data URL：直接把预览还原成文件（图片/主动发送的图片）。
  if (!attachment.mediaId && !attachment.fileId && !attachment.fileKey && !attachment.fileToken && !attachment.localPath) {
    const preview = attachment.preview;
    const decoded = preview?.startsWith('data:') ? decodePreviewDataUrl(preview) : undefined;
    if (!decoded) {
      throw new AttachmentDownloadError('这条附件的预览数据损坏，无法还原文件', 409);
    }
    const mimeType = isSpecificMime(decoded.mimeType)
      ? decoded.mimeType
      : (mimeFromFilename(filename) ?? sniffMime(decoded.buffer) ?? 'application/octet-stream');
    return {
      buffer: decoded.buffer,
      filename: withExtension(filename, mimeType),
      mimeType,
      source: message.platform,
    };
  }

  const finish = (result: DownloadedAttachment): DownloadedAttachment => ({
    ...result,
    filename: withExtension(result.filename, result.mimeType),
  });
  switch (message.platform) {
    case Platform.DINGTALK:
      return finish(await downloadDingtalk(message, attachment, filename, deps));
    case Platform.FEISHU:
      return finish(await downloadFeishu(message, attachment, filename, deps));
    case Platform.MAIL:
      throw new AttachmentDownloadError('邮件附件暂不支持在 LinkHub 内下载', 409);
    case Platform.WECHAT:
      return finish(await downloadWechat(attachment, filename, deps));
    default:
      throw new AttachmentDownloadError(`平台 ${String(message.platform)} 不支持附件下载`, 409);
  }
}

/** 给测试/诊断用：不需要真实平台即可检查文件名与 MIME 推导 */
export const attachmentDownloadInternals = {
  messageIdFor,
  finalMime,
  isSpecificMime,
};
