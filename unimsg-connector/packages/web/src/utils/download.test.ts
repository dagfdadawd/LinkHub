import { describe, expect, it } from 'vitest';
import {
  canDownloadAttachment,
  filenameFromContentDisposition,
  safeDownloadFilename,
} from './download';

describe('附件下载工具', () => {
  it('有平台资源引用才显示下载按钮（微信 fileToken / 旧 localPath / 邮件 mailUid 也算）', () => {
    expect(canDownloadAttachment({ mediaId: 'm1' })).toBe(true);
    expect(canDownloadAttachment({ fileId: 'f1' })).toBe(true);
    expect(canDownloadAttachment({ fileKey: 'k1' })).toBe(true);
    expect(canDownloadAttachment({ fileToken: 'wxfile_t' })).toBe(true);
    expect(canDownloadAttachment({ localPath: 'C:/wx/a.pdf' })).toBe(true);
    expect(canDownloadAttachment({ mailUid: 42 })).toBe(true);
    expect(canDownloadAttachment({ mailUid: 0 })).toBe(true, 'UID 0 是合法引用');
    expect(canDownloadAttachment({ preview: 'data:image/png;base64,AAAA' })).toBe(true);
    expect(canDownloadAttachment({})).toBe(false);
    expect(canDownloadAttachment(undefined)).toBe(false);
  });

  it('优先解析 RFC 5987 中文文件名', () => {
    const header = "attachment; filename=\"____.pdf\"; filename*=UTF-8''%E5%91%A8%E6%8A%A5.pdf";
    expect(filenameFromContentDisposition(header)).toBe('周报.pdf');
  });

  it('退化解析普通 filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="report.pdf"')).toBe('report.pdf');
    expect(filenameFromContentDisposition(null)).toBeUndefined();
  });

  it('文件名去路径 / 控制字符', () => {
    expect(safeDownloadFilename('../../etc/passwd')).toBe('passwd');
    expect(safeDownloadFilename('周报<2026>.pdf')).toBe('周报_2026_.pdf');
    expect(safeDownloadFilename('')).toBe('附件');
  });
});
