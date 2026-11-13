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