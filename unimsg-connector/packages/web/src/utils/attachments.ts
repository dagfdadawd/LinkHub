/**
 * 浏览器侧附件工具：File → 统一入口出站附件契约。
 *
 * 体积校验与服务端共用同一份 FILE_LIMITS，前端先拦一道，
 * 避免把 20MB 文件读成 base64 后才被服务端拒绝（也避免白等一次网络往返）。
 */
import { FILE_LIMITS } from '../types';
import type { OutboundAttachment } from '../types';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 返回错误文案；合法返回 null */
export function validateFiles(files: File[]): string | null {
  if (files.length > FILE_LIMITS.maxFiles) {
    return `最多只能带 ${FILE_LIMITS.maxFiles} 个附件`;
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > FILE_LIMITS.maxTotalBytes) {
    return `附件总大小 ${formatBytes(total)} 超过 ${formatBytes(FILE_LIMITS.maxTotalBytes)} 上限`;
  }
  for (const f of files) {
    if (f.size > FILE_LIMITS.maxFileBytes) {
      return `「${f.name}」${formatBytes(f.size)} 超过单文件 ${formatBytes(FILE_LIMITS.maxFileBytes)} 上限`;
    }
    if (f.size === 0) return `「${f.name}」是空文件，无法发送`;
  }
  return null;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取「${file.name}」失败`));
    reader.onload = () => {
      const raw = String(reader.result ?? '');
      const comma = raw.indexOf(',');
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
    };
    reader.readAsDataURL(file);
  });
}

export async function filesToAttachments(files: File[]): Promise<OutboundAttachment[]> {
  const problem = validateFiles(files);
  if (problem) throw new Error(problem);
  return Promise.all(
    files.map(async (f) => ({
      name: f.name,
      mimeType: f.type || 'application/octet-stream',
      size: f.size,
      contentBase64: await readAsBase64(f),
    })),
  );
}
