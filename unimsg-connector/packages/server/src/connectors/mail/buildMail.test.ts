/**
 * 出站附件 MIME 单测：文件必须能被自家解析器读回来（正文不丢、附件名不串）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMail, extractMail, parseMail } from './mime';

test('无附件：保持单 part text/plain 结构（字节级兼容旧行为）', () => {
  const raw = buildMail('me@qq.com', 'you@example.com', '项目周报', '第一行\n第二行', {
    messageId: 'm1@linkhub.local',
  });
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
  assert.doesNotMatch(raw, /multipart/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
});

test('带附件：升级 multipart/mixed，正文与附件名可被解析器还原', () => {
  const content = Buffer.from('%PDF-1.4 attachment body', 'utf8').toString('base64');
  const raw = buildMail('me@qq.com', 'you@example.com', '项目周报', '请查收附件', {
    messageId: 'm2@linkhub.local',
    inReplyTo: 'original@example.com',
    attachments: [
      { name: 'report.pdf', mimeType: 'application/pdf', contentBase64: content },
    ],
  });
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(raw, /Content-Disposition: attachment; filename="report\.pdf"/);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  assert.match(raw, /In-Reply-To: <original@example\.com>/);

  const extracted = extractMail(parseMail(raw));
  assert.equal(extracted.text.trim(), '请查收附件');
  assert.deepEqual(extracted.attachments, ['report.pdf']);
});

test('带多个中文名附件：文件名 encoded-word 可还原，正文仍不丢', () => {
  const a = Buffer.from('A', 'utf8').toString('base64');
  const raw = buildMail('me@qq.com', 'you@example.com', '文件', '正文', {
    messageId: 'm3@linkhub.local',
    attachments: [
      { name: '报表.pdf', mimeType: 'application/pdf', contentBase64: a },
      { name: '说明.txt', mimeType: 'text/plain', contentBase64: a },
    ],
  });
  const extracted = extractMail(parseMail(raw));
  assert.equal(extracted.text.trim(), '正文');
  assert.deepEqual(extracted.attachments, ['报表.pdf', '说明.txt']);
});
