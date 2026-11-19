/**
 * 附件下载服务单测：平台资源引用 → 字节流。
 *
 * 全部注入假依赖：不启动 dws、不访问飞书等真实平台，单测在 CI 里可离线跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { MsgStatus, Platform, type AttachmentInfo, type UnifiedMessage } from '@unimsg/shared';
import { DingtalkPersonalError } from '../connectors/dingtalkPersonal';
import type { BinaryResponse } from '../connectors/real';
import {
  AttachmentDownloadError,
  downloadAttachment,
  isAttachmentDownloadable,
  safeDownloadFilename,
  type AttachmentDownloadDeps,
} from './attachmentDownload';

function message(patch: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    traceId: 't-1',
    platform: Platform.DINGTALK,
    externalId: 'dingtalk:om_1',
    sender: { id: 'u1', name: '张三' },
    conversation: { id: 'cid_1', type: 'p2p' },
    type: 'file',
    body: '[文件] 周报.pdf',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

type DepsOverride = {
  dingtalk?: Partial<AttachmentDownloadDeps['dingtalk']>;
  feishu?: Partial<AttachmentDownloadDeps['feishu']>;
  wechat?: Partial<NonNullable<AttachmentDownloadDeps['wechat']>>;
};

/** 记录调用；默认成功返回 PDF 内容 */
function fakeDeps(overrides: DepsOverride = {}): {
  deps: AttachmentDownloadDeps;
  calls: { drive: unknown[]; media: unknown[]; feishu: string[]; wechat: string[] };
} {
  const calls = {
    drive: [] as unknown[],
    media: [] as unknown[],
    feishu: [] as string[],
    wechat: [] as string[],
  };
  const base: AttachmentDownloadDeps = {
    dingtalk: {
      downloadDriveFile: async (input) => {
        calls.drive.push(input);
        writeFileSync(input.outputPath, Buffer.from('%PDF-1.4 fake'));
      },
      downloadMedia: async (input) => {
        calls.media.push(input);
        writeFileSync(input.outputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      },
    },
    feishu: {
      baseUrl: 'https://open.feishu.test',
      userToken: async () => 'user-token',
      tenantToken: async () => 'tenant-token',
      getBinary: async (url, headers): Promise<BinaryResponse> => {
        calls.feishu.push(`${url}|${headers.Authorization ?? ''}`);
        return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), contentType: 'application/octet-stream' };
      },
    },
    wechat: {
      fileUrl: (value, kind) => `http://127.0.0.1:8787/file?${kind}=${encodeURIComponent(value)}`,
      getBinary: async (url): Promise<BinaryResponse> => {
        calls.wechat.push(url);
        return { buffer: Buffer.from('%PDF-1.4 wx'), contentType: 'application/pdf' };
      },
    },
  };
  return {
    deps: {
      dingtalk: { ...base.dingtalk, ...(overrides.dingtalk ?? {}) },
      feishu: { ...base.feishu, ...(overrides.feishu ?? {}) },
      wechat: {
        ...base.wechat,
        ...(overrides.wechat ?? {}),
      } as NonNullable<AttachmentDownloadDeps['wechat']>,
    },
    calls,
  };
}

test('isAttachmentDownloadable：平台资源引用任一即可（含微信 token / 旧 localPath）', () => {
  assert.equal(isAttachmentDownloadable({ mediaId: 'm' }), true);
  assert.equal(isAttachmentDownloadable({ fileId: 'f' }), true);
  assert.equal(isAttachmentDownloadable({ fileKey: 'k' }), true);
  assert.equal(isAttachmentDownloadable({ fileToken: 'wxfile_t' }), true);
  assert.equal(isAttachmentDownloadable({ localPath: 'C:/wx/a.pdf' }), true);
  assert.equal(isAttachmentDownloadable({ preview: 'data:image/png;base64,AAAA' }), true);
  assert.equal(isAttachmentDownloadable({}), false);
});

test('safeDownloadFilename：去路径 / 控制字符，保留中文与扩展名', () => {
  assert.equal(safeDownloadFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeDownloadFilename('周报<2026>.pdf'), '周报_2026_.pdf');
  assert.equal(safeDownloadFilename(''), '附件');
});

test('钉钉 fileId：调用 drive download，返回真实字节 + PDF MIME', async () => {
  const { deps, calls } = fakeDeps();
  const attachment: AttachmentInfo = {
    name: '季度复盘.pdf',
    mimeType: 'application/octet-stream',
    size: 0,
    fileId: 'file-1',
    resourceType: 'file',
  };

  const file = await downloadAttachment(message(), attachment, deps);
  assert.equal(file.filename, '季度复盘.pdf');
  assert.equal(file.mimeType, 'application/pdf');
  assert.equal(file.buffer.toString(), '%PDF-1.4 fake');
  assert.equal(file.source, Platform.DINGTALK);
  const driveCall = calls.drive[0] as { fileId: string; outputPath: string };
  assert.equal(driveCall.fileId, 'file-1');
  assert.match(driveCall.outputPath, /季度复盘\.pdf$/);
  assert.doesNotMatch(driveCall.outputPath, /\.\./);
});

test('钉钉 mediaId：带上消息 ID 与会话 ID 调 download-media', async () => {
  const { deps, calls } = fakeDeps();
  const attachment: AttachmentInfo = {
    name: '图片.png',
    mimeType: 'image/*',
    size: 0,
    mediaId: '@media-1',
    resourceType: 'image',
  };

  const file = await downloadAttachment(message({ platform: Platform.DINGTALK }), attachment, deps);
  assert.equal(file.mimeType, 'image/png');
  const call = calls.media[0] as { mediaId: string; messageId: string; conversationId: string };
  assert.equal(call.mediaId, '@media-1');
  assert.equal(call.messageId, 'om_1');
  assert.equal(call.conversationId, 'cid_1');
});

test('飞书本人身份：用 user token 调 resources 接口（中文文件名保留）', async () => {
  const { deps, calls } = fakeDeps();
  const attachment: AttachmentInfo = {
    name: '复盘.pdf',
    mimeType: 'application/octet-stream',
    size: 0,
    fileKey: 'fk_1',
    resourceType: 'file',
  };

  const file = await downloadAttachment(
    message({ platform: Platform.FEISHU, externalId: 'om_f1', receivedAs: 'user', conversation: undefined }),
    attachment,
    deps,
  );
  assert.equal(file.mimeType, 'application/pdf');
  assert.match(calls.feishu[0]!, /\/messages\/om_f1\/resources\/fk_1\?type=file\|Bearer user-token$/);
});

test('飞书机器人通道：用 tenant token，图片按 type=image 取', async () => {
  const { deps, calls } = fakeDeps();
  const attachment: AttachmentInfo = {
    name: '图片.png',
    mimeType: 'image/*',
    size: 0,
    fileKey: 'ik_1',
    resourceType: 'image',
  };

  const file = await downloadAttachment(
    message({ platform: Platform.FEISHU, externalId: 'om_bot', receivedAs: 'bot', conversation: undefined }),
    attachment,
    deps,
  );
  assert.equal(file.mimeType, 'image/png');
  assert.match(calls.feishu[0]!, /\?type=image\|Bearer tenant-token$/);
});

test('只有预览 data URL（如图片）：直接还原成文件，不要求平台资源 ID', async () => {
  const { deps } = fakeDeps();
  const attachment: AttachmentInfo = {
    name: '截图',
    mimeType: 'image/*',
    size: 0,
    preview: 'data:image/png;base64,iVBORw0KGgo=',
  };
  const file = await downloadAttachment(message({ platform: Platform.FEISHU }), attachment, deps);
  assert.equal(file.filename, '截图.png');
  assert.equal(file.mimeType, 'image/png');
  assert.equal(file.buffer.toString('base64'), 'iVBORw0KGgo=');
});

test('没有平台资源引用：409，不假装能下载', async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    () => downloadAttachment(message(), { name: '本机文件.pdf', mimeType: 'application/pdf', size: 3 }, deps),
    (e: unknown) => e instanceof AttachmentDownloadError && e.status === 409 && /没有平台资源引用/.test(e.message),
  );
});

test('邮件附件：明确 409（内容未入库）', async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    () => downloadAttachment(
      message({ platform: Platform.MAIL, externalId: 'qq:INBOX:1', conversation: { id: 'a@b.com', type: 'p2p' } }),
      { name: 'a.pdf', mimeType: 'application/pdf', size: 0 },
      deps,
    ),
    (e: unknown) => e instanceof AttachmentDownloadError && e.status === 409 && /邮件附件/.test(e.message),
  );
});

test('钉钉未登录：把 dws 错误翻译成 409 中文原因', async () => {
  const { deps } = fakeDeps({
    dingtalk: {
      downloadDriveFile: async () => {
        throw new DingtalkPersonalError('dws 未登录，请先完成本人授权', 'not-logged-in');
      },
    },
  });
  await assert.rejects(
    () => downloadAttachment(
      message(),
      { name: 'a.pdf', mimeType: 'application/pdf', size: 0, fileId: 'f1' },
      deps,
    ),
    (e: unknown) => e instanceof AttachmentDownloadError
      && e.status === 409
      && /未登录/.test(e.message),
  );
});


// ---------------------------------------------------------------------------
// 微信：文件在微信客户端落盘，经桥 /file 回吐（后端不直接读盘）
// ---------------------------------------------------------------------------

test('微信 fileToken：向桥的 /file?token= 取字节，消息里不需要绝对路径', async () => {
  const { deps, calls } = fakeDeps();
  const attachment: AttachmentInfo = {
    name: '方案.pdf',
    mimeType: 'application/pdf',
    size: 12,
    fileToken: 'wxfile_opaque_1',
  };
  const file = await downloadAttachment(message({ platform: Platform.WECHAT, externalId: 'wx-1' }), attachment, deps);
  assert.equal(file.source, Platform.WECHAT);
  assert.equal(calls.wechat[0], 'http://127.0.0.1:8787/file?token=wxfile_opaque_1');
});

test('微信 localPath：向桥的 /file 取字节，路径要编码（旧消息兼容）', async () => {
  const { deps, calls } = fakeDeps();
  const attachment: AttachmentInfo = {
    name: '方案 终版.pdf',
    mimeType: 'application/octet-stream',
    size: 12,
    localPath: 'C:/Users/me/Documents/WeChat Files/wxid/FileStorage/File/2026-11/方案 终版.pdf',
  };
  const file = await downloadAttachment(message({ platform: Platform.WECHAT, externalId: 'wx-1' }), attachment, deps);
  assert.equal(file.source, Platform.WECHAT);
  assert.equal(file.mimeType, 'application/pdf');
  assert.equal(file.buffer.toString(), '%PDF-1.4 wx');
  assert.equal(calls.wechat.length, 1);
  const url = calls.wechat[0]!;
  assert.match(url, /^http:\/\/127\.0\.0\.1:8787\/file\?path=/);
  assert.match(url, /%E6%96%B9%E6%A1%88%20%E7%BB%88%E7%89%88\.pdf/, '中文与空格必须 URL 编码');
});

test('微信附件没有 localPath：409 且说清原因（不假装能下）', async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    () => downloadAttachment(
      message({ platform: Platform.WECHAT }),
      { name: '旧消息.pdf', mimeType: 'application/pdf', size: 0 },
      deps,
    ),
    (e: unknown) => e instanceof AttachmentDownloadError && e.status === 409 && /没有可下载的文件引用/.test(e.message),
  );
});

test('微信桥不可达：502 并提示确认桥已启动', async () => {
  const { deps } = fakeDeps({
    wechat: {
      getBinary: async () => {
        throw new Error('fetch failed');
      },
    },
  });
  await assert.rejects(
    () => downloadAttachment(
      message({ platform: Platform.WECHAT }),
      { name: 'a.pdf', mimeType: 'application/pdf', size: 1, localPath: 'C:/wx/a.pdf' },
      deps,
    ),
    (e: unknown) => e instanceof AttachmentDownloadError && e.status === 502 && /连不上本机 RPA 桥/.test(e.message),
  );
});
