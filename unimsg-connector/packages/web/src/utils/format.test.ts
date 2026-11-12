import { describe, expect, it } from 'vitest';
import {
  conversationLabel,
  deliveryLabel,
  formatRelative,
  initials,
  receivedIdentityLabel,
  sendIdentityLabel,
  shortTrace,
  sortMessages,
} from './format';
import { MsgStatus, Platform } from '../types';
import type { UnifiedMessage } from '../types';

function msg(partial: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    traceId: 't-1',
    platform: Platform.FEISHU,
    externalId: 'e-1',
    sender: { id: 'u1', name: '张三' },
    type: 'text',
    body: 'hello',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe('format utils', () => {
  it('相对时间：刚刚 / 分钟 / 今天', () => {
    // 固定"现在"为本地时间中午，避免用例在 00:00–00:59 运行时 "-1 小时" 落到昨天而误判（跨午夜 flaky）
    const now = new Date(2026, 10, 4, 12, 0, 0).getTime();
    expect(formatRelative(new Date(now - 5_000).toISOString(), now)).toBe('刚刚');
    expect(formatRelative(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 分钟前');
    expect(formatRelative(new Date(now - 60 * 60_000).toISOString(), now)).toMatch(/^今天 \d{2}:\d{2}$/);
    expect(formatRelative(new Date(now - 26 * 60 * 60_000).toISOString(), now)).toMatch(/^昨天 \d{2}:\d{2}$/);
  });

  it('姓名首字与 traceId 缩略', () => {
    expect(initials('张三')).toBe('三');
    expect(initials('alice')).toBe('A');
    expect(shortTrace('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toContain('…');
  });

  it('排序：按创建时间倒序', () => {
    const old = msg({ traceId: 'a', createdAt: new Date(Date.now() - 60_000).toISOString() });
    const fresh = msg({ traceId: 'b', createdAt: new Date().toISOString() });
    const older = msg({ traceId: 'c', needsReview: true, createdAt: new Date(Date.now() - 120_000).toISOString() });
    expect(sortMessages([old, fresh, older]).map((m) => m.traceId)).toEqual(['b', 'a', 'c']);
  });

  it('投递方式：真实 / Mock / 无（Mock 必须醒目标注），真实回写带上身份', () => {
    const at = new Date().toISOString();
    expect(deliveryLabel(undefined)).toEqual({ text: '—', kind: 'none' });
    expect(deliveryLabel({ mode: 'mock', at })).toEqual({
      text: '模拟发送（未调用真实平台）',
      kind: 'mock',
    });
    expect(deliveryLabel({ mode: 'real', platformReply: 'om_123', at })).toEqual({
      text: '真实接口（om_123）',
      kind: 'real',
    });
    expect(deliveryLabel({ mode: 'real', at })).toEqual({ text: '真实接口', kind: 'real' });
    // 真实回写：必须写清是本人还是机器人发的，不能含糊
    expect(deliveryLabel({ mode: 'real', identity: 'user', platformReply: 'om_123', at })).toEqual({
      text: '本人发送 · 真实接口（om_123）',
      kind: 'real',
    });
    expect(deliveryLabel({ mode: 'real', identity: 'bot', at })).toEqual({
      text: '机器人发送 · 真实接口',
      kind: 'real',
    });
  });

  it('接收/发送身份文案：本人 / 机器人；Mock 只写模拟发送；没有身份不虚构', () => {
    expect(receivedIdentityLabel('user')).toBe('本人账号接收');
    expect(receivedIdentityLabel('bot')).toBe('机器人接收');
    expect(receivedIdentityLabel(undefined)).toBeUndefined();
    expect(sendIdentityLabel(undefined)).toBeUndefined();
    expect(sendIdentityLabel({ mode: 'mock', at: new Date().toISOString() })).toBe('模拟发送');
    expect(sendIdentityLabel({ mode: 'real', identity: 'user', at: new Date().toISOString() })).toBe('本人发送');
    expect(sendIdentityLabel({ mode: 'real', identity: 'bot', at: new Date().toISOString() })).toBe('机器人发送');
    // 旧数据/旧后端没有 delivery.identity：不猜身份
    expect(sendIdentityLabel({ mode: 'real', at: new Date().toISOString() })).toBeUndefined();
  });

  it('会话类型：群聊带群名 / 群聊无群名 / 单聊 / 无会话', () => {
    expect(conversationLabel(msg({ conversation: { id: 'cid1', type: 'group', title: '项目协作群' } }))).toBe(
      '群聊「项目协作群」',
    );
    expect(conversationLabel(msg({ conversation: { id: 'cid2', type: 'group' } }))).toBe('群聊');
    expect(conversationLabel(msg({ conversation: { id: 'u1', type: 'p2p' } }))).toBe('单聊');
    expect(conversationLabel(msg({}))).toBe('—');
  });
});
