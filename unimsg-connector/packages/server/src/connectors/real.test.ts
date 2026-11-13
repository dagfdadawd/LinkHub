/**
 * 真实适配器单测：加解密、签名校验、发送请求形状。
 * 不触网：fetch 全部打桩，凭据用测试值覆盖。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, MsgStatus, type OutboundAttachment } from '@unimsg/shared';
import { config, forceAllModes } from '../config';
import { feishuConnector } from './feishu';
import { dingtalkConnector, describeInbound } from './dingtalk';
import { feishuEncrypt, dingtalkEncrypt, dingtalkSign } from './crypto';
import { resetTokenCache } from './real';

const origFetch = globalThis.fetch;
const origDingtalkPolicy = config.identity.dingtalk.policy;

interface Call {
  url: string;
  init: RequestInit;
  body: any;
  /** multipart 等非 JSON 请求体的原始文本（JSON 请求体时与 body 等价） */
  raw?: string;
}

function stubFetch(replies: unknown[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const raw = init?.body ? String(init.body) : undefined;
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url: String(url), init, body, raw });
    const reply = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

before(() => {
  forceAllModes('real');
  config.platforms.feishu.appId = 'cli_test';
  config.platforms.feishu.appSecret = 'secret_test';
  config.platforms.feishu.verifyToken = 'verify_test';
  config.platforms.feishu.encryptKey = 'encrypt_test_key_1234567890abcd';
  // 现有用例断言的是机器人通道；显式锁 bot，避免误读开发者本机的用户令牌文件
  config.feishuAuth.sendAs = 'bot';
  config.platforms.dingtalk.appKey = 'ding_test';
  config.platforms.dingtalk.appSecret = 'ding_secret_test';
  config.platforms.dingtalk.robotCode = 'robot_test';
  config.platforms.dingtalk.aesToken = 'aes_token_test';
  config.platforms.dingtalk.aesKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
  // 现有用例断言的是机器人发送通道；显式锁 bot，避免误读开发者本机 .env 的
  // DINGTALK_IDENTITY=user（否则会走 dws 本人通道，未登录时直接抛错）
  config.identity.dingtalk.policy = 'bot';
});

after(() => {
  globalThis.fetch = origFetch;
  forceAllModes('mock');
  config.identity.dingtalk.policy = origDingtalkPolicy;
  resetTokenCache();
});

beforeEach(() => {
  resetTokenCache();
});

test('飞书 AES 解密：本地加密后能还原并识别 challenge', () => {
  const plain = JSON.stringify({ type: 'url_verification', challenge: 'c-123', token: 'verify_test' });
  const encrypted = feishuEncrypt(config.platforms.feishu.encryptKey, plain);
  const decoded = feishuConnector.decrypt?.({ encrypt: encrypted }) as any;
  assert.equal(decoded.challenge, 'c-123');
  assert.deepEqual(feishuConnector.challenge?.(decoded), { challenge: 'c-123' });
});

test('飞书验签：token 匹配通过，错误 token 拒绝', () => {
  assert.equal(feishuConnector.verify({ header: { token: 'verify_test' } }, ''), true);
  assert.equal(feishuConnector.verify({ header: { token: 'wrong' } }, ''), false);
  assert.equal(feishuConnector.verify({}, ''), false);
});

test('飞书 receive：v2 事件带出 conversation', () => {
  const msg = feishuConnector.receive({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '周五前交周报' }),
        sender: { sender_id: { user_id: 'u_1' } },
      },
    },
  });
  assert.equal(msg.conversation?.id, 'oc_1');
  assert.equal(msg.conversation?.type, 'group');
  assert.equal(msg.externalId, 'om_1');
  assert.equal(msg.type, 'todo');
});

test('飞书 receive：真实事件 sender 在 event 层（与 message 平级）也能解析出 open_id', () => {
  const msg = feishuConnector.receive({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_abc', user_id: 'u_9' }, sender_type: 'user' },
      message: {
        message_id: 'om_2',
        chat_id: 'oc_2',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '你好' }),
      },
    },
  });
  assert.equal(msg.sender.id, 'ou_abc');
  assert.equal(msg.conversation?.id, 'oc_2');
  assert.equal(msg.externalId, 'om_2');
});

test('飞书真实发送：换取 tenant_access_token 并调用 im/v1/messages', async () => {
  const calls = stubFetch([
    { code: 0, tenant_access_token: 't-123', expire: 7200 },
    { code: 0, data: { message_id: 'om_sent_1' } },
  ]);
  const msg = {
    traceId: 't1',
    platform: Platform.FEISHU,
    externalId: 'om_1',
    sender: { id: 'u_1', name: 'u_1' },
    conversation: { id: 'oc_1', type: 'group' as const },
    type: 'text' as const,
    body: '原文',
    reply: '回写内容',
    status: MsgStatus.REPLIED,
    createdAt: '',
    updatedAt: '',
  };
  const r = await feishuConnector.send(msg);
  assert.equal(r.ok, true);
  assert.equal(r.platformReply, 'om_sent_1');
  assert.match(calls[0].url, /tenant_access_token\/internal$/);
  assert.deepEqual(calls[0].body, { app_id: 'cli_test', app_secret: 'secret_test' });
  assert.match(calls[1].url, /im\/v1\/messages\?receive_id_type=chat_id$/);
  assert.equal(calls[1].body.receive_id, 'oc_1');
  assert.equal(calls[1].body.msg_type, 'text');
  assert.deepEqual(JSON.parse(calls[1].body.content), { text: '回写内容' });
  assert.equal((calls[1].init.headers as any).Authorization, 'Bearer t-123');
});

test('飞书真实发送：单聊会话的 chat_id 仍按 chat_id 投递（不再误用 open_id）', async () => {
  const calls = stubFetch([
    { code: 0, tenant_access_token: 't-123', expire: 7200 },
    { code: 0, data: { message_id: 'om_sent_2' } },
  ]);
  const msg = {
    traceId: 't5',
    platform: Platform.FEISHU,
    externalId: 'om_3',
    sender: { id: 'ou_1', name: 'ou_1' },
    conversation: { id: 'oc_p2p', type: 'p2p' as const },
    type: 'text' as const,
    body: '原文',
    reply: '回写',
    status: MsgStatus.REPLIED,
    createdAt: '',
    updatedAt: '',
  };
  await feishuConnector.send(msg);
  assert.match(calls[1].url, /im\/v1\/messages\?receive_id_type=chat_id$/);
  assert.equal(calls[1].body.receive_id, 'oc_p2p');
});

test('飞书真实发送：显式 open_id 会话按 open_id 投递', async () => {
  const calls = stubFetch([
    { code: 0, tenant_access_token: 't-123', expire: 7200 },
    { code: 0, data: { message_id: 'om_sent_3' } },
  ]);
  const msg = {
    traceId: 't6',
    platform: Platform.FEISHU,
    externalId: 'om_4',
    sender: { id: 'linkhub', name: 'linkhub' },
    conversation: { id: 'ou_target', type: 'p2p' as const },
    type: 'text' as const,
    body: '原文',
    reply: '回写',
    status: MsgStatus.REPLIED,
    createdAt: '',
    updatedAt: '',
  };
  await feishuConnector.send(msg);
  assert.match(calls[1].url, /im\/v1\/messages\?receive_id_type=open_id$/);
  assert.equal(calls[1].body.receive_id, 'ou_target');
});

test('飞书真实发送：没有会话时抛错而不是静默失败', async () => {
  const msg: any = {
    traceId: 't2', platform: Platform.FEISHU, externalId: 'om_2',
    sender: { id: 'u_1', name: 'u_1' }, type: 'text', body: 'x', status: MsgStatus.REPLIED,
    createdAt: '', updatedAt: '',
  };
  await assert.rejects(() => feishuConnector.send(msg), /conversation\.id/);
});

test('钉钉签名：正确签名通过，篡改时间戳拒绝', () => {
  const ts = String(Date.now());
  const sign = dingtalkSign('aes_token_test', ts, config.platforms.dingtalk.aesKey);
  assert.equal(dingtalkConnector.verify({}, '', { timestamp: ts, sign }), true);
  assert.equal(dingtalkConnector.verify({}, '', { timestamp: String(Date.now() - 2 * 3600_000), sign }), false);
  assert.equal(dingtalkConnector.verify({}, '', { timestamp: ts, sign: 'bad' }), false);
});

test('钉钉 AES 解密：32 字节块填充可还原', () => {
  const plain = JSON.stringify({ msgId: 'm1', text: { content: '周报' }, conversationId: 'cid1', conversationType: '2' });
  const encrypted = dingtalkEncrypt(config.platforms.dingtalk.aesKey, plain);
  const decoded = dingtalkConnector.decrypt?.({ encrypt: encrypted }) as any;
  assert.equal(decoded.msgId, 'm1');
  assert.equal(decoded.conversationId, 'cid1');
});

test('钉钉 receive：群会话与发送者映射', () => {
  const msg = dingtalkConnector.receive({
    msgId: 'm1', msgtype: 'text', text: { content: '周五前交周报' },
    senderId: 'u1', senderStaffId: 'staff1', senderNick: '小王',
    conversationId: 'cid1', conversationType: '2',
  });
  assert.equal(msg.sender.id, 'staff1');
  assert.equal(msg.sender.name, '小王');
  assert.equal(msg.conversation?.id, 'cid1');
  assert.equal(msg.conversation?.type, 'group');
});

test('钉钉 receive：conversationType 数字 2 也按群聊处理，并保留群名', () => {
  const msg = dingtalkConnector.receive({
    msgId: 'm2', msgtype: 'text', text: { content: '@机器人 周五前交周报' },
    senderStaffId: 'staff1', senderNick: '小王',
    conversationId: 'cid2', conversationType: 2, conversationTitle: '项目协作群',
  });
  assert.equal(msg.conversation?.type, 'group');
  assert.equal(msg.conversation?.title, '项目协作群');
});

test('钉钉 receive：单聊不误判成群聊，也不带群名', () => {
  const msg = dingtalkConnector.receive({
    msgId: 'm3', msgtype: 'text', text: { content: '在吗' },
    senderStaffId: 'staff1', senderNick: '小王', conversationId: 'cid3', conversationType: '1',
  });
  assert.equal(msg.conversation?.type, 'p2p');
  assert.equal(msg.conversation?.title, undefined);
});

test('钉钉入站日志摘要：群聊写明群名、单聊不写群名（判断平台到底推没推）', () => {
  assert.match(describeInbound({
    msgId: 'm4', conversationId: 'cid4', conversationType: '2',
    conversationTitle: '项目协作群', senderNick: '小王', msgtype: 'text',
  }), /群聊「项目协作群」/);
  assert.match(describeInbound({
    msgId: 'm5', conversationId: 'cid5', conversationType: '1', senderNick: '小王', msgtype: 'text',
  }), /单聊/);
});

test('钉钉真实发送：群消息走 groupMessages/send', async () => {
  const calls = stubFetch([
    { accessToken: 'd-123', expireIn: 7200 },
    { processQueryKey: 'pqk_1' },
  ]);
  const msg: any = {
    traceId: 't3', platform: Platform.DINGTALK, externalId: 'm1',
    sender: { id: 'staff1', name: '小王' },
    conversation: { id: 'cid1', type: 'group' },
    type: 'text', body: '原文', reply: '回写内容', status: MsgStatus.REPLIED,
    createdAt: '', updatedAt: '',
  };
  const r = await dingtalkConnector.send(msg);
  assert.equal(r.ok, true);
  assert.equal(r.platformReply, 'pqk_1');
  assert.match(calls[0].url, /oauth2\/accessToken$/);
  assert.deepEqual(calls[0].body, { appKey: 'ding_test', appSecret: 'ding_secret_test' });
  assert.match(calls[1].url, /robot\/groupMessages\/send$/);
  assert.equal(calls[1].body.robotCode, 'robot_test');
  assert.equal(calls[1].body.openConversationId, 'cid1');
  assert.equal(calls[1].body.msgKey, 'sampleText');
  assert.deepEqual(JSON.parse(calls[1].body.msgParam), { content: '回写内容' });
  assert.equal((calls[1].init.headers as any)['x-acs-dingtalk-access-token'], 'd-123');
});

test('钉钉真实发送：单聊走 oToMessages/batchSend', async () => {
  const calls = stubFetch([
    { accessToken: 'd-123', expireIn: 7200 },
    { processQueryKey: 'pqk_2' },
  ]);
  const msg: any = {
    traceId: 't4', platform: Platform.DINGTALK, externalId: 'm2',
    sender: { id: 'staff1', name: '小王' },
    conversation: { id: 'cid2', type: 'p2p' },
    type: 'text', body: '原文', reply: '回写内容', status: MsgStatus.REPLIED,
    createdAt: '', updatedAt: '',
  };
  await dingtalkConnector.send(msg);
  assert.match(calls[1].url, /robot\/oToMessages\/batchSend$/);
  assert.deepEqual(calls[1].body.userIds, ['staff1']);
  assert.equal(calls[1].body.openConversationId, undefined);
});

const ATTACHMENT_BUF = Buffer.from('fake-png-bytes');
const ATTACHMENT: OutboundAttachment = {
  name: '屏幕截图 2026-11-05 215616.png',
  mimeType: 'image/png',
  size: ATTACHMENT_BUF.length,
  contentBase64: ATTACHMENT_BUF.toString('base64'),
};

function attachMsg(): any {
  return {
    traceId: 't5', platform: Platform.DINGTALK, externalId: 'm3',
    sender: { id: 'staff1', name: '小王' },
    conversation: { id: 'cid3', type: 'group' },
    type: 'text', body: '原文', reply: '回写内容', status: MsgStatus.REPLIED,
    createdAt: '', updatedAt: '',
  };
}

test('钉钉真实发送附件：先上传到 oapi 媒体库，再用返回的 media_id 发 sampleFile', async () => {
  const calls = stubFetch([
    { accessToken: 'd-123', expireIn: 7200 },
    { processQueryKey: 'pqk_text' },
    { errcode: 0, errmsg: 'ok', media_id: '@lA_test_media' },
    { processQueryKey: 'pqk_file' },
  ]);
  const r = await dingtalkConnector.send(attachMsg(), [ATTACHMENT]);

  assert.equal(r.mode, 'real');
  assert.equal(r.platformReply, 'pqk_text,pqk_file');

  // 上传接口在 oapi.dingtalk.com，不是 api.dingtalk.com/v1.0/robot/media/upload（后者 404）
  assert.equal(calls[2].url, 'https://oapi.dingtalk.com/media/upload?access_token=d-123');
  assert.match(String((calls[2].init.headers as any)['Content-Type']), /^multipart\/form-data; boundary=/);
  assert.match(calls[2].raw ?? '', /name="type"\r\n\r\nfile/);
  assert.match(calls[2].raw ?? '', new RegExp(`name="media"; filename="${ATTACHMENT.name}"`));
  assert.ok((calls[2].raw ?? '').includes(ATTACHMENT_BUF.toString()));

  assert.equal(calls[3].body.msgKey, 'sampleFile');
  assert.deepEqual(JSON.parse(calls[3].body.msgParam), {
    mediaId: '@lA_test_media',
    fileName: ATTACHMENT.name,
    fileType: 'png',
  });
});

test('钉钉媒体上传失败：把平台 errcode/errmsg 带进错误，进死信队列的原因可读', async () => {
  stubFetch([
    { accessToken: 'd-123', expireIn: 7200 },
    { processQueryKey: 'pqk_text' },
    { errcode: 40004, errmsg: '不合法的媒体文件类型' },
  ]);
  await assert.rejects(
    () => dingtalkConnector.send(attachMsg(), [ATTACHMENT]),
    (e: Error) => /40004/.test(e.message) && /不合法的媒体文件类型/.test(e.message),
  );
});
