/**
 * 出站附件 / 主动发送请求校验单测。
 * 重点覆盖「绝不静默丢文件、绝不把内容写进可持久化结构」这两条底线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, MsgStatus, FILE_LIMITS } from '@unimsg/shared';
import {
  InvalidOutboundRequest,
  decodeAttachment,
  describeAttachments,
  isOutboundComposed,
  normalizeAttachments,
  normalizeCompose,
  sendCapabilities,
} from './outbound';

function pdf(name = 'report.pdf', text = '%PDF-1.4 fake'): {
  name: string; mimeType: string; size: number; contentBase64: string;
} {
  const buf = Buffer.from(text, 'utf8');
  return {
    name,
    mimeType: 'application/pdf',
    size: buf.byteLength,
    contentBase64: buf.toString('base64'),
  };
}

test('normalizeAttachments：合法附件解码长度与声明一致', () => {
  const a = pdf();
  const list = normalizeAttachments([a]);
  assert.equal(list.length, 1);
  assert.equal(decodeAttachment(list[0]).toString('utf8'), '%PDF-1.4 fake');
});

test('normalizeAttachments：伪造 size 直接拒绝', () => {
  const a = pdf();
  assert.throws(
    () => normalizeAttachments([{ ...a, size: a.size + 1 }]),
    (e: unknown) => e instanceof InvalidOutboundRequest && /实际解码/.test(e.message),
  );
});

test('normalizeAttachments：非法 base64 / 路径穿越文件名 / 超限都拒绝', () => {
  const a = pdf();
  assert.throws(() => normalizeAttachments([{ ...a, contentBase64: 'not*base64' }]), InvalidOutboundRequest);
  assert.throws(() => normalizeAttachments([{ ...a, name: '../evil.pdf' }]), InvalidOutboundRequest);
  assert.throws(
    () => normalizeAttachments(Array.from({ length: FILE_LIMITS.maxFiles + 1 }, () => a)),
    InvalidOutboundRequest,
  );
  assert.throws(
    () => normalizeAttachments([{ ...a, size: FILE_LIMITS.maxFileBytes + 1, contentBase64: '' }]),
    InvalidOutboundRequest,
  );
});

test('describeAttachments：只留元数据，绝不携带 contentBase64', () => {
  const a = pdf();
  const info = describeAttachments([a]);
  assert.deepEqual(info, [{ name: 'report.pdf', mimeType: 'application/pdf', size: a.size }]);
  assert.equal(JSON.stringify(info).includes('contentBase64'), false);
  assert.equal(JSON.stringify(info).includes(a.contentBase64), false);
});

test('normalizeCompose：文本 / 纯文件 / 文本+文件都合法，双空拒绝', () => {
  const a = pdf();
  assert.equal(normalizeCompose({ platform: 'feishu', text: 'hi' }).text, 'hi');
  assert.equal(normalizeCompose({ platform: 'feishu', text: '', attachments: [a] }).attachments?.length, 1);
  const both = normalizeCompose({ platform: 'wecom', conversationId: 'zhangsan', text: 'hi', attachments: [a] });
  assert.equal(both.conversationId, 'zhangsan');
  assert.throws(() => normalizeCompose({ platform: 'feishu', text: '' }), InvalidOutboundRequest);
  assert.throws(() => normalizeCompose({ platform: 'unknown', text: 'hi' }), InvalidOutboundRequest);
  assert.throws(() => normalizeCompose({ platform: 'feishu', text: 'hi', attachments: 'x' }), InvalidOutboundRequest);
});

test('isOutboundComposed：识别主动发送的 externalId（含邮箱账号前缀形式）', () => {
  const base = {
    traceId: 't', platform: Platform.FEISHU, externalId: '',
    sender: { id: 'u', name: 'u' }, type: 'text' as const,
    body: '', status: MsgStatus.RECEIVED, createdAt: '', updatedAt: '',
  };
  assert.equal(isOutboundComposed({ ...base, externalId: 'compose:abc' }), true);
  assert.equal(isOutboundComposed({ ...base, externalId: 'qq:compose:abc' }), true);
  assert.equal(isOutboundComposed({ ...base, externalId: 'om_123' }), false);
});

test('sendCapabilities：四个平台都声明文本 + 文件能力并带上体积上限', () => {
  const caps = sendCapabilities();
  assert.equal(caps.length, Object.values(Platform).length);
  for (const c of caps) {
    assert.equal(c.text, true);
    assert.equal(c.file, true);
    assert.equal(c.maxFileBytes, FILE_LIMITS.maxFileBytes);
    assert.ok(c.mode === 'mock' || c.mode === 'real');
  }
});
