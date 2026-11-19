/**
 * 飞书「本人身份」接收：纯解析 / 注入 fetch 的 HTTP 封装单测（不联网）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '@unimsg/shared';
import {
  FeishuUserReceiveError,
  describeFeishuError,
  feishuChatTypesEnabled,
  fetchChatMessages,
  fetchUserChats,
  getSelfUserInfo,
  mapFeishuUserMessage,
  resetFeishuChatTypesProbe,
  type FeishuChat,
  type FeishuUserMessageRaw,
} from './feishuUserReceive';

/** 假 fetch：按顺序返回预设响应，并记录请求 URL/头 */
function stubFetch(responses: { status?: number; body: unknown }[]): {
  impl: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const impl = (async (input: any, init?: any) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const item = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const body = typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
    return new Response(body, { status: item.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const chatP2p: FeishuChat = { chatId: 'oc_p2p_1', name: '与张三的单聊', chatMode: 'p2p' };

function raw(overrides: Partial<FeishuUserMessageRaw> = {}): FeishuUserMessageRaw {
  return {
    message_id: 'om_1',
    create_time: '1731000000000',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '你好' }) },
    sender: { id: 'ou_sender', id_type: 'open_id', sender_type: 'user' },
    chat_id: 'oc_p2p_1',
    ...overrides,
  };
}

test('fetchUserChats：默认带 types=p2p,group 才能列到单聊；分页/截断正常', async () => {
  resetFeishuChatTypesProbe();
  const { impl, calls } = stubFetch([
    { body: { code: 0, data: { items: [{ chat_id: 'oc_1', name: '群一', chat_mode: 'group' }], has_more: true, page_token: 'p2' } } },
    { body: { code: 0, data: { items: [{ chat_id: 'oc_2', name: '单聊', chat_mode: 'p2p' }], has_more: false } } },
  ]);
  const result = await fetchUserChats('u-token', { fetchImpl: impl });
  assert.equal(result.chats.length, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.p2pIncluded, true);
  assert.equal(result.chats[0]!.chatMode, 'group');
  assert.equal(result.chats[1]!.chatMode, 'p2p');
  assert.match(calls[0]!.url, /im\/v1\/chats\?user_id_type=open_id&page_size=100&types=p2p%2Cgroup/);
  assert.match(calls[1]!.url, /types=p2p%2Cgroup/);
  assert.match(calls[1]!.url, /page_token=p2/);
  assert.equal(calls[0]!.headers.Authorization, 'Bearer u-token');

  const truncated = await fetchUserChats('u-token', {
    fetchImpl: stubFetch([
      { body: { code: 0, data: { items: [{ chat_id: 'oc_1' }, { chat_id: 'oc_2' }], has_more: false } } },
    ]).impl,
    maxChats: 1,
  });
  assert.equal(truncated.chats.length, 1);
  assert.equal(truncated.truncated, true);
});

test('fetchUserChats：types 被平台判为参数错误（232001）时自动降级为纯群列表，绝不阻断接收', async () => {
  resetFeishuChatTypesProbe();
  const { impl, calls } = stubFetch([
    { status: 400, body: { code: 232001, msg: 'Your request contains an invalid request parameter.' } },
    { body: { code: 0, data: { items: [{ chat_id: 'oc_group', chat_mode: 'group' }], has_more: false } } },
  ]);
  const result = await fetchUserChats('u-token', { fetchImpl: impl });
  assert.equal(result.chats.length, 1);
  assert.equal(result.p2pIncluded, false);
  assert.match(calls[0]!.url, /types=p2p%2Cgroup/, '第一次应带上 types 试探');
  assert.doesNotMatch(calls[1]!.url, /types=/, '被拒后应不带 types 重试');
  assert.equal(feishuChatTypesEnabled(), false, '降级状态应被记住（进程内不再白试）');
  resetFeishuChatTypesProbe();
});

test('fetchUserChats：权限错误码 → 中文可操作错误（含所需 scope）', async () => {
  const { impl } = stubFetch([{ body: { code: 99991672, msg: 'permission denied' } }]);
  await assert.rejects(
    () => fetchUserChats('u-token', { fetchImpl: impl }),
    (e: unknown) => {
      assert.ok(e instanceof FeishuUserReceiveError);
      assert.equal(e.kind, 'permission');
      assert.match(e.message, /用户身份权限/);
      assert.match(e.message, /im:message\.p2p_msg:get_as_user/);
      assert.match(e.message, /重新授权/);
      return true;
    },
  );
});

test('getSelfUserInfo：返回 open_id/name；缺 open_id 时按授权不完整报错', async () => {
  const ok = stubFetch([{ body: { code: 0, data: { open_id: 'ou_self', name: '李四' } } }]);
  const info = await getSelfUserInfo('u-token', { fetchImpl: ok.impl });
  assert.equal(info.openId, 'ou_self');
  assert.equal(info.name, '李四');
  assert.match(ok.calls[0]!.url, /authen\/v1\/user_info/);

  const bad = stubFetch([{ body: { code: 0, data: { name: '无 open_id' } } }]);
  await assert.rejects(() => getSelfUserInfo('u-token', { fetchImpl: bad.impl }), /open_id/);
});

test('fetchChatMessages：start_time 秒 + 升序 + 分页 + maxCreateTimeMs', async () => {
  const { impl, calls } = stubFetch([
    {
      body: {
        code: 0,
        data: {
          items: [raw({ message_id: 'om_1' }), raw({ message_id: 'om_2', create_time: '1731000009000' })],
          has_more: true,
          page_token: 'next',
        },
      },
    },
    { body: { code: 0, data: { items: [raw({ message_id: 'om_3', create_time: '1731000010000' })], has_more: false } } },
  ]);
  const r = await fetchChatMessages('u-token', 'oc_p2p_1', {
    fetchImpl: impl,
    startTimeSec: 1_731_000_000,
  });
  assert.equal(r.messages.length, 3);
  assert.equal(r.pages, 2);
  assert.equal(r.maxCreateTimeMs, 1_731_000_010_000);
  assert.match(calls[0]!.url, /container_id_type=chat/);
  assert.match(calls[0]!.url, /container_id=oc_p2p_1/);
  assert.match(calls[0]!.url, /sort_type=ByCreateTimeAsc/);
  assert.match(calls[0]!.url, /start_time=1731000000/);
});

test('mapFeishuUserMessage：文本消息映射（externalId 用裸 message_id、receivedAs=user）', () => {
  const msg = mapFeishuUserMessage(raw(), chatP2p, 'ou_self');
  assert.ok(msg);
  assert.equal(msg.platform, Platform.FEISHU);
  assert.equal(msg.externalId, 'om_1');
  assert.equal(msg.body, '你好');
  assert.equal(msg.type, 'text');
  assert.equal(msg.receivedAs, 'user');
  assert.equal(msg.conversation?.id, 'oc_p2p_1');
  assert.equal(msg.conversation?.type, 'p2p');
  assert.equal(msg.conversation?.title, '与张三的单聊');
  assert.equal(msg.sender.id, 'ou_sender');
  assert.equal(msg.createdAt, new Date(1_731_000_000_000).toISOString());
});

test('mapFeishuUserMessage：post 富文本 / file / image 映射', () => {
  const post = mapFeishuUserMessage(raw({
    message_id: 'om_post',
    msg_type: 'post',
    body: {
      content: JSON.stringify({
        title: '周报',
        content: [[
          { tag: 'text', text: '本周完成：' },
          { tag: 'a', text: '看板', href: 'https://example.com' },
        ], [{ tag: 'at', user_id: 'ou_x', user_name: '王五' }]],
      }),
    },
  }), chatP2p, 'ou_self');
  assert.match(post!.body, /周报/);
  assert.match(post!.body, /本周完成/);
  assert.match(post!.body, /@王五/);

  const file = mapFeishuUserMessage(raw({
    message_id: 'om_file',
    msg_type: 'file',
    body: { content: JSON.stringify({ file_key: 'fk', file_name: '复盘.pdf' }) },
  }), chatP2p, 'ou_self');
  assert.equal(file!.type, 'file');
  assert.match(file!.body, /\[文件\] 复盘\.pdf/);
  assert.equal(file!.attachments?.[0]?.name, '复盘.pdf');

  const image = mapFeishuUserMessage(raw({
    message_id: 'om_img',
    msg_type: 'image',
    body: { content: JSON.stringify({ image_key: 'ik' }) },
  }), chatP2p, 'ou_self');
  assert.equal(image!.type, 'image');
  assert.equal(image!.body, '[图片]');
});

test('mapFeishuUserMessage：跳过自己发的 / 已撤回 / 系统 / 未知类型', () => {
  assert.equal(mapFeishuUserMessage(raw({ sender: { id: 'ou_self', id_type: 'open_id', sender_type: 'user' } }), chatP2p, 'ou_self'), null);
  assert.equal(mapFeishuUserMessage(raw({ deleted: true }), chatP2p, 'ou_self'), null);
  assert.equal(mapFeishuUserMessage(raw({ sender: { id: 'sys', sender_type: 'system' } }), chatP2p, 'ou_self'), null);
  assert.equal(mapFeishuUserMessage(raw({ msg_type: 'video_chat' }), chatP2p, 'ou_self'), null);
  // 缺 message_id 也跳过
  assert.equal(mapFeishuUserMessage(raw({ message_id: '' }), chatP2p, 'ou_self'), null);
  // 拿不到 selfOpenId 时不过滤（宁可噪音也不误丢，由调用方告警）
  assert.ok(mapFeishuUserMessage(raw({ sender: { id: 'ou_self' } }), chatP2p, undefined));
  // id_type 不是 open_id 时不做字符串比较，避免跨 ID 空间误判
  assert.ok(mapFeishuUserMessage(raw({ sender: { id: 'ou_self', id_type: 'user_id' } }), chatP2p, 'ou_self'));
});

test('describeFeishuError：区分缺权限与需重新授权', () => {
  assert.equal(describeFeishuError(99991672).kind, 'permission');
  assert.match(describeFeishuError(99991672).hint, /im:resource/);
  assert.equal(describeFeishuError(20027).kind, 'permission');
  assert.equal(describeFeishuError(99991663).kind, 'auth');
  assert.match(describeFeishuError(99991663).hint, /重新连接/);
  const unknown = describeFeishuError(123456, 'something weird');
  assert.equal(unknown.kind, 'http');
  assert.match(unknown.hint, /123456/);
});
const chatGroup: FeishuChat = { chatId: 'oc_group_1', name: '项目群', chatMode: 'group' };

test('mapFeishuUserMessage：群聊只收「@我」——没 @ 我的普通群消息跳过', () => {
  const notMentioned = mapFeishuUserMessage(raw({ chat_id: 'oc_group_1' }), chatGroup, 'ou_self');
  assert.equal(notMentioned, null, '群聊普通消息不该入库（会把会话列表刷满）');

  const mentioned = mapFeishuUserMessage(
    raw({
      message_id: 'om_group_at',
      chat_id: 'oc_group_1',
      body: { content: JSON.stringify({ text: '@_user_1 明天评审改到 10 点' }) },
      mentions: [{ id: { open_id: 'ou_self' }, key: '@_user_1', name: '我' }],
    }),
    chatGroup,
    'ou_self',
  );
  assert.ok(mentioned, '@我 的群消息必须入库');
  assert.equal(mentioned.conversation?.type, 'group');
});

test('mapFeishuUserMessage：单聊不受「@我」过滤影响', () => {
  const msg = mapFeishuUserMessage(raw(), chatP2p, 'ou_self');
  assert.ok(msg);
  assert.equal(msg.conversation?.type, 'p2p');
});

test('mapFeishuUserMessage：onlyMentionMe=false 时群聊保留全量（排障用）', () => {
  const msg = mapFeishuUserMessage(raw({ chat_id: 'oc_group_1' }), chatGroup, 'ou_self', {
    onlyMentionMe: false,
  });
  assert.ok(msg);
});
