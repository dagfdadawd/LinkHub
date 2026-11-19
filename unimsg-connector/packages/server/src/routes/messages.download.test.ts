/**
 * 附件下载 HTTP 层：鉴权、二进制响应头、错误转 JSON。
 * 不触网：MessageService 用最小假实现，createApp 只装配路由。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { MessageService } from '../services/message';
import { AttachmentDownloadError } from '../services/attachmentDownload';
import { resolveApiToken } from '../middlewares/auth';
import { config } from '../config';

const TOKEN = resolveApiToken(config.apiToken);

async function withDownloadApp(
  download: (id: string, index: number, field: string) => Promise<{
    buffer: Buffer;
    filename: string;
    mimeType: string;
    source: 'feishu' | 'dingtalk';
  }>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const svc = { downloadAttachment: download } as unknown as MessageService;
  const server = http.createServer(createApp(svc));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('附件下载：Bearer 鉴权 + 二进制 + 中文文件名 Content-Disposition', async () => {
  await withDownloadApp(
    async (id, index, field) => {
      assert.equal(id, 't-1');
      assert.equal(index, 0);
      assert.equal(field, 'attachments');
      return {
        buffer: Buffer.from('%PDF-1.4'),
        filename: '季度复盘 2026.pdf',
        mimeType: 'application/pdf',
        source: 'dingtalk',
      };
    },
    async (base) => {
      const res = await fetch(`${base}/api/messages/t-1/attachments/0/download`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.equal(res.headers.get('content-length'), '8');
      assert.match(res.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
      assert.match(res.headers.get('content-disposition') ?? '', /%E5%AD%A3%E5%BA%A6/);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '%PDF-1.4');
    },
  );
});

test('附件下载：未授权 401；附件不存在 404 JSON', async () => {
  await withDownloadApp(
    async () => {
      throw new AttachmentDownloadError('附件不存在', 404);
    },
    async (base) => {
      const unauthorized = await fetch(`${base}/api/messages/t-1/attachments/0/download`);
      assert.equal(unauthorized.status, 401);

      const missing = await fetch(`${base}/api/messages/t-1/attachments/0/download`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { ok: false, error: '附件不存在' });
    },
  );
});

test('附件下载：回复附件通过 field=replyAttachments 选择', async () => {
  await withDownloadApp(
    async (_id, _index, field) => {
      assert.equal(field, 'replyAttachments');
      return { buffer: Buffer.from('ok'), filename: 'a.txt', mimeType: 'text/plain', source: 'feishu' };
    },
    async (base) => {
      const res = await fetch(`${base}/api/messages/t-1/attachments/0/download?field=replyAttachments`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'ok');
    },
  );
});
