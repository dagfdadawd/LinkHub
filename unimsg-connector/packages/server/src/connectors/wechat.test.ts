/**
 * 微信 RPA 连接器单测：验签、事件映射、mock 发送如实标注。
 * 不依赖真实微信 / RPA 桥（underTest 默认把平台模式强制为 mock）。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Platform, MsgStatus, type UnifiedMessage } from '@unimsg/shared';
import { config, forceMode } from '../config';
import { sentBox } from './base';
import { convert, receive, send, verify, WECHAT_EVENT_KINDS } from './wechat';

/** 起一个假的 RPA 桥（只回 /send），用例结束立刻关闭，不联网 */
async function withFakeBridge(
  reply: Record<string, unknown>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/send')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const prev = config.platforms.wechat.bridgeUrl;
  config.platforms.wechat.bridgeUrl = `http://127.0.0.1:${port}`;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    config.platforms.wechat.bridgeUrl = prev;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function baseMsg(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    traceId: 'trace-1',
    platform: Platform.WECHAT,
    externalId: 'wx-1',
    sender: { id: 'wxfriend', name: '微信好友' },
    type: 'text',
    body: '你好',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

test('verify：mock 模式接受 dev*/mock；real 模式只认 dev-rpa', () => {
  forceMode(Platform.WECHAT, 'mock');
  assert.equal(verify({}, 'dev-rpa'), true);
  assert.equal(verify({}, 'dev-demo'), true);
  assert.equal(verify({}, 'mock'), true);
  forceMode(Platform.WECHAT, 'real');
  assert.equal(verify({}, 'dev-rpa'), true);
  assert.equal(verify({}, 'dev-demo'), false);
  assert.equal(verify({}, 'mock'), false);
  forceMode(Platform.WECHAT, 'mock');
});

test('verify：mock 模式仍拒绝非 dev/mock 的任意签名', () => {
  forceMode(Platform.WECHAT, 'mock');
  assert.equal(verify({}, 'dev-rpa'), true);
  assert.equal(verify({}, 'mock'), true);
  assert.equal(verify({}, 'real-signature'), false);
  assert.equal(verify({}, ''), false);
});

test('receive：文本事件 → 统一消息，externalId 保幂等键', () => {
  const m = receive({
    event: {
      externalId: 'wx-abc',
      from: '张三',
      senderId: 'zhangsan',
      text: '明天 10:00 交周报',
      conversation: '项目群',
      conversationType: 'group',
      at: 1732000000000,
    },
  });
  assert.equal(m.platform, Platform.WECHAT);
  assert.equal(m.externalId, 'wx-abc');
  assert.equal(m.sender.name, '张三');
  assert.equal(m.body, '明天 10:00 交周报');
  assert.equal(m.conversation?.title, '项目群');
  assert.equal(m.conversation?.type, 'group');
  assert.equal(m.receivedAs, 'user');
  assert.equal(m.direction, 'in');
  assert.equal(m.status, MsgStatus.RECEIVED);
  assert.ok(m.createdAt && m.updatedAt);
});

test('receive：按需拉取自己的消息标 out，不标成本人接收', () => {
  const m = receive({
    externalId: 'wx-self',
    from: '我自己',
    senderId: 'myself',
    conversation: '项目群',
    type: 'text',
    text: '收到',
    direction: 'out',
  });
  assert.equal(m.direction, 'out');
  assert.equal(m.status, MsgStatus.SENT);
  assert.equal(m.receivedAs, undefined);
});

test('receive：文件事件把文件名写进正文并生成附件元数据', () => {
  const m = receive({ externalId: 'wx-f', from: '李四', type: 'file', fileName: '方案.pptx', text: '' });
  assert.equal(m.type, 'file');
  assert.match(m.body, /方案\.pptx/);
  assert.equal(m.attachments?.[0]?.name, '方案.pptx');
  assert.equal(m.attachments?.[0]?.localPath, undefined, '旧版桥只给文件名，不臆造本地路径');
});

test('receive：结构化附件带本机路径 → 记 localPath，供下载用（P1 微信附件）', () => {
  const m = receive({
    externalId: 'wx-a',
    from: '李四',
    type: 'file',
    text: '[文件] 方案.pptx',
    attachments: [{ name: '方案.pptx', path: 'C:\\Users\\me\\Documents\\WeChat Files\\wxid\\FileStorage\\File\\2026-11\\方案.pptx', size: 1024 }],
  });
  const a = m.attachments?.[0];
  assert.ok(a);
  assert.equal(a.name, '方案.pptx');
  assert.equal(a.size, 1024);
  assert.match(a.localPath ?? '', /FileStorage/);
});

test('receive：新版桥只给 token → fileToken，不把本机绝对路径写进消息', () => {
  const m = receive({
    externalId: 'wx-token',
    from: '李四',
    type: 'file',
    attachments: [{ name: '方案.pdf', token: 'wxfile_abc', size: 1024 }],
  });
  const a = m.attachments?.[0];
  assert.ok(a);
  assert.equal(a.fileToken, 'wxfile_abc');
  assert.equal(a.localPath, undefined);
});

test('receive：多附件全部保留（不再只留第一个）', () => {
  const m = receive({
    externalId: 'wx-m',
    from: '王五',
    type: 'file',
    attachments: [
      { name: 'a.pdf', path: 'C:\\wx\\a.pdf', size: 1 },
      { name: 'b.png', path: 'C:\\wx\\b.png', size: 2 },
    ],
  });
  assert.deepEqual((m.attachments ?? []).map((a) => a.name), ['a.pdf', 'b.png']);
});

test('receive：缺少 externalId 时留空（由 ingestUnified 拒收，不臆造幂等键）', () => {
  const m = receive({ from: '某人', text: 'hi' });
  assert.equal(m.externalId, '');
});

test('convert：出站载荷含会话名/正文/附件，不打文件内容到日志', () => {
  const out = convert(baseMsg({
    reply: '收到',
    conversation: { id: 'g1', title: '项目群', type: 'group' },
  }), [{ name: 'a.pdf', mimeType: 'application/pdf', size: 3, contentBase64: 'YWJj' }]) as any;
  assert.equal(out.text, '收到');
  assert.equal(out.conversation, '项目群');
  assert.equal(out.attachments.length, 1);
  assert.equal(out.attachments[0].name, 'a.pdf');
  assert.equal(out.attachments[0].contentBase64, 'YWJj');
});

test('send：mock 模式走 mockSend，如实返回 mode=mock 且入已发送箱', async () => {
  forceMode(Platform.WECHAT, 'mock');
  const before = sentBox[Platform.WECHAT].length;
  const res = await send(baseMsg({ reply: '模拟回复' }));
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'mock');
  assert.equal(sentBox[Platform.WECHAT].length, before + 1);
  forceMode(Platform.WECHAT, 'mock');
});

test('send：桥不可达时抛错，绝不返回成功', async () => {
  forceMode(Platform.WECHAT, 'real');
  config.platforms.wechat.bridgeUrl = 'http://127.0.0.1:1';  // 必定连不上
  await assert.rejects(() => send(baseMsg({ reply: 'x' })), /微信 RPA 发送失败/);
  forceMode(Platform.WECHAT, 'mock');
});

test('P0：桥自报 mock 模式时抛错，绝不把"没碰微信"写成 real', async () => {
  forceMode(Platform.WECHAT, 'real');
  try {
    await withFakeBridge({ ok: true, messageId: 'rpa-x', mode: 'mock' }, async () => {
      await assert.rejects(
        () => send(baseMsg({ reply: '你好' })),
        /RPA 桥当前是 mock 模式.*没有真实操作微信/,
      );
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

test('P0：桥没上报 mode 时同样拒绝（不默认相信）', async () => {
  forceMode(Platform.WECHAT, 'real');
  try {
    await withFakeBridge({ ok: true, messageId: 'rpa-y' }, async () => {
      await assert.rejects(() => send(baseMsg({ reply: 'hi' })), /未知.*模式/);
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

test('send：桥在 rpa 模式才回 mode=real（平台回执带 rpa: 前缀）', async () => {
  forceMode(Platform.WECHAT, 'real');
  try {
    await withFakeBridge({ ok: true, messageId: 'rpa-1', mode: 'rpa' }, async () => {
      const res = await send(baseMsg({ reply: '真实回复' }));
      assert.equal(res.ok, true);
      assert.equal(res.mode, 'real');
      assert.match(String(res.platformReply), /^rpa:/);
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

test('send：透传桥的 verified=true（只有桥确认才标已核对）', async () => {
  forceMode(Platform.WECHAT, 'real');
  try {
    await withFakeBridge({ ok: true, messageId: 'rpa-v1', mode: 'rpa', verified: true }, async () => {
      const res = await send(baseMsg({ reply: '真实回复' }));
      assert.equal((res as { verified?: boolean }).verified, true);
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

test('send：桥回 verified=false 时透传 false，绝不升级成已核对', async () => {
  forceMode(Platform.WECHAT, 'real');
  try {
    await withFakeBridge({ ok: true, messageId: 'rpa-v0', mode: 'rpa', verified: false }, async () => {
      const res = await send(baseMsg({ reply: '4.x 未核对' }));
      assert.equal((res as { verified?: boolean }).verified, false);
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

test('send：桥 mock 拒绝带 noRetry，避免非幂等 RPA 被重试 7 秒', async () => {
  forceMode(Platform.WECHAT, 'real');
  try {
    await withFakeBridge({ ok: true, messageId: 'rpa-mock', mode: 'mock' }, async () => {
      await assert.rejects(
        () => send(baseMsg({ reply: '不应该重试' })),
        (e: Error & { noRetry?: boolean }) => {
          assert.equal(e.noRetry, true);
          return /mock 模式/.test(e.message);
        },
      );
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

test('WECHAT_EVENT_KINDS 声明了 RPA 收/发两类事件', () => {
  assert.ok(WECHAT_EVENT_KINDS.includes('message'));
  assert.ok(WECHAT_EVENT_KINDS.includes('send'));
});
