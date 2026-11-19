/**
 * 浏览器侧附件下载工具。
 *
 * 后端以 `Content-Disposition: attachment; filename*=UTF-8''…` 返回真实文件名，
 * 但 fetch 只能拿到 header 字符串，所以这里解析后自己触发一次 <a download>；
 * 不能直接把下载地址交给 <a href>，因为接口需要 Bearer 鉴权，裸链接会 401。
 */
import type { AttachmentInfo } from '../types';

/** 该附件是否值得显示下载按钮（与后端 isAttachmentDownloadable 保持同一口径） */
export function canDownloadAttachment(
  attachment: Pick<AttachmentInfo, 'mediaId' | 'fileId' | 'fileKey' | 'fileToken' | 'localPath' | 'preview'> | undefined,
): boolean {
  return Boolean(
    attachment?.mediaId
    || attachment?.fileId
    || attachment?.fileKey
    // 微信：新版桥的不透明 token；localPath 只兼容旧消息
    || attachment?.fileToken
    || attachment?.localPath
    || attachment?.preview?.startsWith('data:'),
  );
}

/**
 * 解析 Content-Disposition 里的文件名。
 * 优先 RFC 5987 的 `filename*=UTF-8''…`（中文名），退化到普通 `filename="…"`。
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // 编码损坏时继续尝试普通 filename
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  return plain?.[1]?.trim().replace(/^"|"$/g, '') || undefined;
}

/** 去路径 / 控制字符，避免浏览器把文件名当相对路径 */
export function safeDownloadFilename(raw: string | undefined, fallback = '附件'): string {
  const base = String(raw ?? '').trim().split(/[\\/]/).pop() || fallback;
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return (cleaned || fallback).slice(0, 160);
}

/**
 * 触发浏览器保存。
 *
 * 用一次性 object URL：不把 Bearer token 拼进 href，也不会在页面里留下长期可访问的链接。
 * 30s 后 revoke；下载已经开始，不影响文件。
 */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return;
  const name = safeDownloadFilename(filename);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
