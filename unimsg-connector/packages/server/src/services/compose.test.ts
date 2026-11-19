/**
 * 统一入口「主动发送 + 文件」的闭环单测。
 * 验证：新建发送与带附件回复都走完整状态机、写 trace、附件元数据可见、
 * 文件内容不进入可持久化消息，Mock 通道如实记录而不伪装真实发送。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, MsgStatus } from '@unimsg/shared';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { sentBox } from '../connectors/base';
import { LlmService } from './llm';
import { OcrService } from './ocr';
import { RateLimiter } from './rateLimiter';
import { MessageService } from './message';
import { feishuSample } from '../connectors/samples';
import { config, forceMode, type MailAccount } from '../config';

function makeSvc() {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  return { repo, svc };
}
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function attachment() {
  const buf = Buffer.from('%PDF-1.4 demo', 'utf8');
  return {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: buf.byteLength,
    contentBase64: buf.toString('base64'),
  };
}

function mailAccount(over: Partial<MailAccount> = {}): MailAccount {
  return {
    key: 'qq',
    label: 'QQ邮箱',
    address: 'me@qq.com',
    authCode: 'code',
    provider: 'qq',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    folders: ['INBOX'],
    ...over,
  };
}

test('compose：指定平台/会话主动发送，走完状态机且可回放', async () => {
  const { svc, repo } = makeSvc();
  const ack = await svc.compose({
    platform: Platform.FEISHU,
    conversationId: 'oc_compose_test',
    text: '请查收本周周报',
  });
  assert.equal(ack.message.platform, Platform.FEISHU);
  assert.equal(ack.message.conversation?.id, 'oc_compose_test');
  assert.equal(ack.message.status, MsgStatus.REPLIED);
  assert.equal(ack.message.sender.name, 'LinkHub 统一入口');

  await wait();
  const m = repo.get(ack.taskId)!;
  assert.equal(m.status, MsgStatus.SYNCED);
  assert.equal(m.delivery?.mode, 'mock');
  const events = repo.getLoopLog(ack.taskId).map((e) => e.event);
  for (const ev of ['composed', 'processing', 'replied', 'sent', 'synced']) {
    assert.ok(events.includes(ev), `missing trace: ${ev}`);
  }
});

test('compose：同时加为待办（标题 + 截止）落在同一条消息上，并写手动待办闭环日志', async () => {
  const { svc, repo } = makeSvc();
  const ack = await svc.compose({
    platform: Platform.FEISHU,
    conversationId: 'oc_todo_test',
    text: '明天把周报发我',
    todo: { title: '跟进周报', dueAt: '2026-11-20T02:00:00.000Z' },
  });
  // 待办就是这条发出的消息本身：不是幽灵消息，也不是另一次「加入待办」请求
  assert.equal(ack.message.type, 'todo');
  assert.equal(ack.message.done, false);
  assert.equal(ack.message.todoTitle, '跟进周报');
  assert.equal(ack.message.dueAt, '2026-11-20T02:00:00.000Z');
  assert.equal(ack.message.body, '明天把周报发我', '正文不被标题覆盖，回放仍看得到原话');

  await wait();
  const m = repo.get(ack.taskId)!;
  assert.equal(m.status, MsgStatus.SYNCED, '加待办不影响发送闭环，照样走完状态机');
  assert.equal(m.type, 'todo');
  const todoTrace = svc.getLoopLog(ack.taskId).find((e) => e.event === 'todo_added');
  assert.ok(todoTrace, '缺少 todo_added 闭环事件');
  assert.match(todoTrace.detail ?? '', /新建发送时手动加入待办/);
  assert.match(todoTrace.detail ?? '', /跟进周报/);
});

test('compose：不勾选时消息仍是普通文本（加待办是可选行为）', async () => {
  const { svc } = makeSvc();
  const ack = await svc.compose({
    platform: Platform.FEISHU,
    conversationId: 'oc_plain_test',
    text: '普通消息',
  });
  assert.equal(ack.message.type, 'text');
  assert.equal(ack.message.todoTitle, undefined);
  assert.equal(ack.message.dueAt, undefined);
  await wait();
});

test('compose：带附件时元数据入库、内容不入库，适配器收到原始附件', async () => {
  const { svc, repo } = makeSvc();
  const a = attachment();
  const before = sentBox[Platform.FEISHU].length;

  const ack = await svc.compose({
    platform: Platform.FEISHU,
    conversationId: 'oc_file_test',
    text: '附上文件',
    attachments: [a],
  });
  assert.deepEqual(ack.message.attachments, [
    { name: 'report.pdf', mimeType: 'application/pdf', size: a.size },
  ]);

  await wait();
  const stored = JSON.stringify(repo.get(ack.taskId));
  assert.equal(stored.includes('contentBase64'), false);
  assert.equal(stored.includes(a.contentBase64), false);

  const sent = sentBox[Platform.FEISHU].slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0] as { payload: { attachments?: unknown[] } }).payload.attachments, [
    { name: 'report.pdf', mimeType: 'application/pdf', size: a.size },
  ]);
});

test('compose：只发文件也合法，正文退化为附件摘要', async () => {
  const { svc } = makeSvc();
  const ack = await svc.compose({
    platform: Platform.FEISHU,
    conversationId: 'oc_only_file',
    text: '',
    attachments: [attachment()],
  });
  assert.equal(ack.message.reply, '');
  assert.match(ack.message.body, /^\[附件\] report\.pdf$/);
  assert.equal(ack.message.attachments?.length, 1);
  await wait();
});

test('compose：邮箱可指定发件账号，未指定回退首个账号，未配置账号显式报错', async () => {
  const { svc, repo } = makeSvc();
  const saved = [...config.mail.accounts];
  config.mail.accounts.splice(
    0,
    config.mail.accounts.length,
    mailAccount({ key: 'qq', address: 'me@qq.com' }),
    mailAccount({ key: 'work', label: '工作邮箱', address: 'me@corp.example.com' }),
  );
  try {
    const ack = await svc.compose({
      platform: Platform.MAIL,
      conversationId: 'to@example.com',
      text: '请查收',
      mailAccount: 'work',
    });
    assert.equal(ack.message.mailMeta?.account, 'work');
    assert.equal(ack.message.externalId.startsWith('work:compose:'), true);
    await wait();
    assert.equal(repo.get(ack.taskId)?.status, MsgStatus.SYNCED);
    assert.ok(repo.getLoopLog(ack.taskId).some((e) => /发件账号 work/.test(e.detail ?? '')));

    const fallback = await svc.compose({
      platform: Platform.MAIL,
      conversationId: 'to@example.com',
      text: '默认账号',
    });
    assert.equal(fallback.message.mailMeta?.account, 'qq');

    await assert.rejects(
      () => svc.compose({
        platform: Platform.MAIL,
        conversationId: 'to@example.com',
        text: 'bad',
        mailAccount: 'nope',
      }),
      /发件账号未配置：nope（可用：qq \/ work）/,
    );
    await wait();
  } finally {
    config.mail.accounts.splice(0, config.mail.accounts.length, ...saved);
  }
});

test('compose：Mock 无会话时用 mock:demo 演示发送（不要求会话 ID）；真实模式无会话时显式报错、不伪造目标', async () => {
  const { svc } = makeSvc();
  const ack = await svc.compose({ platform: Platform.WECHAT, text: 'hi' });
  assert.equal(ack.message.conversation?.id, 'mock:demo', 'Mock 演示发送使用固定演示会话');
  forceMode(Platform.WECHAT, 'real');
  try {
    await assert.rejects(
      () => makeSvc().svc.compose({ platform: Platform.WECHAT, text: 'hi' }),
      /缺少目标会话|请在收件箱打开一条消息点「回复」/,
    );
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

test('reply：带附件回写沿用同一状态机，附件元数据可见', async () => {
  const { svc, repo } = makeSvc();
  const { message } = await svc.ingest(Platform.FEISHU, feishuSample);
  const a = attachment();
  const ack = await svc.reply(message.traceId, '收到，附文件', [a]);
  assert.equal(ack.message.status, MsgStatus.REPLIED);
  // 回复的附件写在 replyAttachments：写进 attachments 会挂到原消息上
  assert.equal(ack.message.replyAttachments?.length, 1);
  assert.equal(ack.message.attachments, undefined);

  await wait();
  const m = repo.get(message.traceId)!;
  assert.equal(m.status, MsgStatus.SYNCED);
  assert.deepEqual(m.replyAttachments, [{ name: 'report.pdf', mimeType: 'application/pdf', size: a.size }]);
  assert.equal(JSON.stringify(m).includes(a.contentBase64), false);
  assert.ok(repo.getLoopLog(message.traceId).some((e) => /带 1 个附件/.test(e.detail ?? '')));
});

test('compose：Mock 模式未传 conversationId 允许模拟发送（mock:demo）；真实模式仍 400 且文案可操作', async () => {
  const { svc, repo } = makeSvc();
  const ack = await svc.compose({ platform: Platform.FEISHU, text: 'Mock 主动发送：不需要会话 ID' });
  assert.equal(ack.message.conversation?.id, 'mock:demo', 'Mock 模式自动使用演示会话');
  assert.equal(ack.message.conversation?.type, 'p2p');
  await wait();
  const m = repo.get(ack.taskId)!;
  assert.equal(m.status, MsgStatus.SYNCED);
  assert.equal(m.delivery?.mode, 'mock', '界面必须如实标模拟发送');

  // 真实模式用全新实例（避免复用上面 Mock 消息的会话回退）
  forceMode(Platform.FEISHU, 'real');
  const fresh = makeSvc();
  try {
    await assert.rejects(
      () => fresh.svc.compose({ platform: Platform.FEISHU, text: '真实模式无会话' }),
      /请在收件箱打开一条消息点「回复」，或填写会话 ID/
    );
  } finally {
    forceMode(Platform.FEISHU, 'mock');
  }
});
