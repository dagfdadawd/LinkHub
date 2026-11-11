import { describe, expect, it } from 'vitest';
import { FILE_LIMITS } from '../types';
import { filesToAttachments, formatBytes, validateFiles } from './attachments';

function file(name: string, size: number, type = 'application/pdf'): File {
  const f = new File(['x'.repeat(size)], name, { type });
  return f;
}

describe('附件工具', () => {
  it('formatBytes 三档可读', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('拒绝空文件 / 超单文件 / 超总大小 / 超数量', () => {
    expect(validateFiles([file('a.pdf', 0)])).toMatch(/空文件/);
    expect(validateFiles([file('a.pdf', FILE_LIMITS.maxFileBytes + 1)])).toMatch(/单文件/);
    expect(validateFiles([
      file('a.pdf', FILE_LIMITS.maxTotalBytes / 2 + 1),
      file('b.pdf', FILE_LIMITS.maxTotalBytes / 2 + 1),
    ])).toMatch(/总大小/);
    expect(validateFiles(Array.from({ length: FILE_LIMITS.maxFiles + 1 }, () => file('a.pdf', 1))))
      .toMatch(/最多/);
  });

  it('File → 出站附件：base64 长度与声明 size 一致，MIME 缺省有兜底', async () => {
    const [a] = await filesToAttachments([file('note.txt', 5, '')]);
    expect(a.name).toBe('note.txt');
    expect(a.mimeType).toBe('application/octet-stream');
    expect(a.size).toBe(5);
    expect(atob(a.contentBase64)).toBe('xxxxx');
  });
});
