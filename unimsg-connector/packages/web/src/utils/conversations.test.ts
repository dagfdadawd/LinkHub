import { describe, expect, it } from 'vitest';
import { MsgStatus, Platform } from '../types';
import type { UnifiedMessage } from '../types';
import {
  analyzeTarget,
  buildConversations,
  conversationKey,
  conversationSnippet,
  findConversation,
  normalizeSubject,
  priorityTargetOf,
} from './conversations';

function msg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    traceId: `t-${Math.random().toString(36).slice(2, 8)}`,
    platform: Platform.DINGTALK,
    externalId: `e-${Math.random().toString(36).slice(2, 8)}`,
    sender: { id: 'peer', name: '郑乐斌' },
    type: 'text',
    body: '你好',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('会话聚合', () => {
  it('同一会话的多条消息合并成一个会话，按时间升序排好', () => {
    const conversation = { id: 'cid-1', type: 'p2p' as const };
    const list = buildConversations([
      msg({ traceId: 'a', conversation, body: '第一条', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ traceId: 'b', conversation, body: '第二条', createdAt: '2026-01-01T00:01:00Z' }),
      msg({ traceId: 'c', conversation, body: '第三条', createdAt: '2026-01-01T00:02:00Z' }),
    ]);

    expect(list).toHaveLength(1);
    expect(list[0].messages.map((m) => m.body)).toEqual(['第一条', '第二条', '第三条']);
    expect(list[0].lastMessage.body).toBe('第三条');
  });

  it('未读只统计入站：自己发出的消息（direction=out）不产生未读', () => {
    const conversation = { id: 'cid-2', type: 'p2p' as const };
    const list = buildConversations([
      msg({ conversation, direction: 'in' }),
      msg({ conversation, direction: 'in' }),
      msg({ conversation, direction: 'out', sender: { id: 'linkhub', name: 'LinkHub 统一入口' } }),
    ]);

    expect(list[0].unread).toBe(2);
  });

  it('会话名：群聊用群名，单聊用对方名字', () => {
    const group = buildConversations([
      msg({ conversation: { id: 'g1', type: 'group', title: '项目群' } }),
    ]);
    expect(group[0].title).toBe('项目群');

    const p2p = buildConversations([
      msg({ conversation: { id: 'p1', type: 'p2p' }, sender: { id: 'u', name: '张三' } }),
    ]);
    expect(p2p[0].title).toBe('张三');
  });

  it('没有 conversation.id 时按对方退化分组，不同人不会混成一个会话', () => {
    const list = buildConversations([
      msg({ sender: { id: 'u1', name: '张三' }, traceId: 't1' }),
      msg({ sender: { id: 'u2', name: '李四' }, traceId: 't2' }),
    ]);
    expect(list).toHaveLength(2);
  });

  it('邮件按主题聚合，Re:/Fwd: 前缀会被归一；IM 排在邮件前面', () => {
    const list = buildConversations([
      msg({
        platform: Platform.MAIL,
        conversation: undefined,
        sender: { id: 'a@x.com', name: 'a@x.com' },
        mailMeta: { account: 'qq', inReplyTo: '', subject: 'Re: 周报' },
      }),
      msg({
        platform: Platform.MAIL,
        sender: { id: 'a@x.com', name: 'a@x.com' },
        mailMeta: { account: 'qq', inReplyTo: '', subject: 'Re: Re: 周报' },
      }),
      msg({ platform: Platform.DINGTALK, conversation: { id: 'im1', type: 'p2p' } }),
    ]);

    const mail = list.filter((c) => c.kind === 'mail');
    expect(mail).toHaveLength(1);
    expect(mail[0].messages).toHaveLength(2);
    expect(list[0].kind).toBe('im');
  });

  it('normalizeSubject 去掉中英文回复前缀', () => {
    expect(normalizeSubject('Re: 周报')).toBe('周报');
    expect(normalizeSubject('Fwd: Re: 周报')).toBe('周报');
    expect(normalizeSubject('回复：周报')).toBe('周报');
    expect(normalizeSubject('周报')).toBe('周报');
  });

  it('conversationKey 对同一会话稳定，不同平台互不串', () => {
    const a = msg({ platform: Platform.DINGTALK, conversation: { id: 'x', type: 'p2p' } });
    const b = msg({ platform: Platform.DINGTALK, conversation: { id: 'x', type: 'p2p' } });
    const c = msg({ platform: Platform.FEISHU, conversation: { id: 'x', type: 'p2p' } });
    expect(conversationKey(a)).toBe(conversationKey(b));
    expect(conversationKey(a)).not.toBe(conversationKey(c));
  });

  it('findConversation 用任意一条消息的 traceId 都能定位到会话', () => {
    const conversation = { id: 'cid-9', type: 'p2p' as const };
    const first = msg({ traceId: 'first', conversation });
    const last = msg({ traceId: 'last', conversation, createdAt: '2026-02-02T00:00:00Z' });
    const list = buildConversations([first, last]);
    expect(findConversation(list, 'first')?.key).toBe(findConversation(list, 'last')?.key);
    expect(findConversation(list, 'nope')).toBeUndefined();
  });

  it('analyzeTarget 取最后一条入站消息；全是出站时退回最后一条', () => {
    const conversation = { id: 'cid-10', type: 'p2p' as const };
    const list = buildConversations([
      msg({ traceId: 'in1', conversation, body: '对方消息' }),
      msg({ traceId: 'out1', conversation, direction: 'out', body: '我的回复' }),
    ]);
    expect(analyzeTarget(list[0]).traceId).toBe('in1');

    const outOnly = buildConversations([
      msg({ traceId: 'o1', conversation, direction: 'out', body: '只有我发的' }),
    ]);
    expect(analyzeTarget(outOnly[0]).traceId).toBe('o1');
  });

  it('列表摘要给自己发出的消息加「我：」前缀', () => {
    const conversation = { id: 'cid-11', type: 'p2p' as const };
    const list = buildConversations([
      msg({ conversation, direction: 'out', body: '收到，马上处理' }),
    ]);
    expect(conversationSnippet(list[0])).toBe('我：收到，马上处理');
  });

  it('会话排序只认最后一条消息的创建时间：改优先级刷新 updatedAt 不会把会话顶到最前', () => {
    const list = buildConversations([
      msg({
        traceId: 'old',
        conversation: { id: 'c-old', type: 'p2p' },
        createdAt: '2026-01-01T00:00:00Z',
        // 模拟「改优先级 / 标已读」把 updatedAt 刷成了未来时间
        updatedAt: '2026-03-01T00:00:00Z',
      }),
      msg({
        traceId: 'new',
        conversation: { id: 'c-new', type: 'p2p' },
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
      }),
    ]);

    expect(list.map((c) => c.conversationId)).toEqual(['c-new', 'c-old']);
    expect(list[1].lastAt).toBe('2026-01-01T00:00:00Z');
  });

  it('会话优先级取未完成入站消息里最紧急的一条：标在中间消息上也生效', () => {
    const conversation = { id: 'cid-priority', type: 'p2p' as const };
    const list = buildConversations([
      msg({ traceId: 'p1', conversation, body: '加急', priority: 'urgent', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ traceId: 'p2', conversation, body: '普通', priority: 'normal', createdAt: '2026-01-01T00:01:00Z' }),
      msg({ traceId: 'p3', conversation, direction: 'out', body: '好的', createdAt: '2026-01-01T00:02:00Z' }),
    ]);

    expect(list[0].priority).toBe('urgent');
  });

  it('已完成的消息不再把会话标红；没有未完成入站时没有会话优先级', () => {
    const conversation = { id: 'cid-done', type: 'p2p' as const };
    const list = buildConversations([
      msg({ traceId: 'p1', conversation, priority: 'urgent', done: true }),
      msg({ traceId: 'p2', conversation, priority: 'normal', done: true }),
    ]);

    expect(list[0].priority).toBeUndefined();
  });

  it('紧急会话在同组内置顶，其余仍按最近消息排序', () => {
    const list = buildConversations([
      msg({
        traceId: 'urgent-old',
        conversation: { id: 'c-u', type: 'p2p' },
        priority: 'urgent',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      msg({
        traceId: 'normal-new',
        conversation: { id: 'c-n', type: 'p2p' },
        createdAt: '2026-02-01T00:00:00Z',
      }),
    ]);

    expect(list.map((c) => c.conversationId)).toEqual(['c-u', 'c-n']);
  });

  it('priorityTargetOf：优先未完成入站里最紧急的一条；没有入站时退回最后一条', () => {
    const conversation = { id: 'cid-target', type: 'p2p' as const };
    const list = buildConversations([
      msg({ traceId: 'urgent', conversation, priority: 'urgent', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ traceId: 'later', conversation, createdAt: '2026-01-01T00:01:00Z' }),
    ]);
    expect(priorityTargetOf(list[0].messages).traceId).toBe('urgent');

    const outOnly = buildConversations([
      msg({ traceId: 'only-out', conversation, direction: 'out', createdAt: '2026-01-01T00:00:00Z' }),
    ]);
    expect(priorityTargetOf(outOnly[0].messages).traceId).toBe('only-out');
  });
});