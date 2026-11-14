import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ECHO_WINDOW_MS,
  isSelfId,
  learnSelfId,
  matchEcho,
  normalizeEchoText,
  rememberSent,
  resetEchoState,
} from './echoRegistry';

beforeEach(() => resetEchoState());

describe('echoRegistry · 回声匹配', () => {
  it('同会话 + 同文本 + 时间窗内才命中（文本归一化掉多余空白）', () => {
    const now = 1_000_000;
    rememberSent({
      platform: 'dingtalk',
      conversationId: 'conv-a',
      text: normalizeEchoText('  收到， 我看看  '),
      at: now,
    });

    assert.ok(matchEcho({ platform: 'dingtalk', conversationId: 'conv-a', text: '收到， 我看看', now: now + 5_000 }));
    assert.equal(
      matchEcho({ platform: 'dingtalk', conversationId: 'conv-b', text: '收到， 我看看', now: now + 5_000 }),
      undefined,
      '不同会话不能命中，否则会把别人的同文案消息吞掉',
    );
    assert.equal(
      matchEcho({ platform: 'dingtalk', conversationId: 'conv-a', text: '收到，我看看', now: now + 5_000 }),
      undefined,
      '文本必须归一化后完全一致',
    );
  });

  it('超过时间窗不再命中（避免把很久以后同样的回复当回声）', () => {
    const now = 2_000_000;
    rememberSent({ platform: 'dingtalk', conversationId: 'c', text: '好', at: now });
    assert.ok(matchEcho({ platform: 'dingtalk', conversationId: 'c', text: '好', now: now + ECHO_WINDOW_MS - 1 }));
    assert.equal(
      matchEcho({ platform: 'dingtalk', conversationId: 'c', text: '好', now: now + ECHO_WINDOW_MS + 1 }),
      undefined,
    );
  });

  it('同一句话发两次：两条登记各自可被匹配（不能只按文本去重）', () => {
    const now = 3_000_000;
    rememberSent({ platform: 'dingtalk', conversationId: 'c', text: '在吗', at: now });
    rememberSent({ platform: 'dingtalk', conversationId: 'c', text: '在吗', at: now + 1_000 });
    assert.ok(matchEcho({ platform: 'dingtalk', conversationId: 'c', text: '在吗', now: now + 2_000 }));
    assert.ok(matchEcho({ platform: 'dingtalk', conversationId: 'c', text: '在吗', now: now + 2_000 }));
  });

  it('空文本永不命中（防止把空消息当回声吞掉）', () => {
    rememberSent({ platform: 'dingtalk', conversationId: 'c', text: '', at: Date.now() });
    assert.equal(matchEcho({ platform: 'dingtalk', conversationId: 'c', text: '  ' }), undefined);
  });

  it('纯附件消息按文件名认回声（平台回推里文本是 fileId 乱码）', () => {
    const now = 4_000_000;
    rememberSent({
      platform: 'dingtalk',
      conversationId: 'conv',
      text: '', // 只发了文件，没有正文
      fileNames: ['灰烬之城 Ashen City.docx'],
      at: now,
    });

    // 钉钉回推的文件消息模板
    const echoed = '[文件] 灰烬之城 Ashen City.docx fileId: 3NwLYZXWywdamn7wU0ovKQmZJkyEqBQm 注意：如需下载使用dws drive download命令下载';
    assert.ok(
      matchEcho({
        platform: 'dingtalk',
        conversationId: 'conv',
        text: echoed,
        fileNames: ['灰烬之城 Ashen City.docx'],
        now: now + 3_000,
      }),
      '同一份文件在时间窗内应判为回声，不能入库成新消息',
    );
    // 文件名大小写不敏感（Windows / 平台回推可能改大小写）
    assert.ok(
      matchEcho({
        platform: 'dingtalk',
        conversationId: 'conv',
        text: echoed,
        fileNames: ['灰烬之城 ashen city.DOCX'],
        now: now + 3_000,
      }),
    );
    // 别的文件不能误吞
    assert.equal(
      matchEcho({
        platform: 'dingtalk',
        conversationId: 'conv',
        text: '[文件] 别的东西.docx fileId: x',
        fileNames: ['别的东西.docx'],
        now: now + 3_000,
      }),
      undefined,
    );
  });

  it('图片回声：只吞一条、超 60s 不再吞，避免误吞对方紧接着发的图', () => {
    const now = 5_000_000;
    rememberSent({
      platform: 'dingtalk',
      conversationId: 'conv',
      text: '',
      mediaCount: 1,
      at: now,
    });
    const echo = { platform: 'dingtalk', conversationId: 'conv', text: '[图片消息] (mediaId=$abc)', mediaOnly: true };
    assert.ok(matchEcho({ ...echo, now: now + 3_000 }), '自己发的图回推应判为回声');
    assert.equal(matchEcho({ ...echo, now: now + 4_000 }), undefined, '同一条发送只吞一条回推');

    rememberSent({ platform: 'dingtalk', conversationId: 'conv', text: '', mediaCount: 1, at: now });
    assert.equal(
      matchEcho({ ...echo, now: now + 90_000 }),
      undefined,
      '超过 60s 的图片回推不再当回声，避免把对方新发的图吞掉',
    );
  });

  it('归一化会剥掉文件占位串（fileId + 下载提示），正文只剩可读内容', () => {
    const normalized = normalizeEchoText(
      '[文件] 周报.docx fileId: abc123 注意：如需下载使用dws drive download命令下载',
    );
    assert.equal(normalized, '');
  });
});

describe('echoRegistry · 本人 ID 学习', () => {
  it('学习后能识别本人，重复学习是幂等的', () => {
    assert.equal(isSelfId('dingtalk', 'od_self'), false);
    assert.equal(learnSelfId('dingtalk', 'od_self'), true);
    assert.equal(isSelfId('dingtalk', 'od_self'), true);
    assert.equal(learnSelfId('dingtalk', 'od_self'), false, '第二次学习不应再算「新学到」');
  });

  it('按平台隔离：钉钉学到的 ID 不会影响飞书', () => {
    learnSelfId('dingtalk', 'od_self');
    assert.equal(isSelfId('feishu', 'od_self'), false);
  });

  it('空 ID 不学习', () => {
    assert.equal(learnSelfId('dingtalk', '   '), false);
    assert.equal(isSelfId('dingtalk', ''), false);
  });
});