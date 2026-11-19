/**
 * Webhook HTTP 级加固测试（node:http + 127.0.0.1 回环，绝不触网）：
 *  1. 空 body / 空 XML 壳 / 缺消息 ID → 400，且不写 trace、不占幂等键（P0）；
 *  2. 正常三平台样例仍 200，返回体形状保持 `{ok:true,duplicate}`；
 *  3. 状态回流前进 → 200 更新；倒退 → 仍 200 但状态不动并写 `sync_ignored`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Platform, MsgStatus } from '@unimsg/shared';
import { createApp } from '../app';
import { isLoopbackAddress } from './webhook';
import { config, forceMode } from '../config';
import { InMemoryRepository } from '../db/repository';
import { connectors } from '../connectors/registry';
import { LlmService } from '../services/llm';
import { OcrService } from '../services/ocr';
import { RateLimiter } from '../services/rateLimiter';
import { MessageService } from '../services/message';
import { feishuSample, dingtalkSample, wechatSample } from '../connectors/samples';

// 富化阶段锁死本地 Mock，保证 HTTP 用例不外呼
config.llm.provider = 'mock';
config.ocr.provider = 'mock';

interface Ctx {
  repo: InMemoryRepository;
  svc: MessageService;
  base: string;
}

interface Reply {
  status: number;
  text: string;
  json: any;
}

/** 每个用例独立 app + 空仓储，避免用例间计数/幂等键互相污染 */
async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const repo = new InMemoryRepository();
  const svc = new MessageService(
    repo, connectors, new LlmService(), new OcrService(), new RateLimiter(3, 5), () => {},
  );
  // corsOrigins=null：显式关闭白名单，聚焦本文件的 webhook 行为
  const server = http.createServer(createApp(svc, { corsOrigins: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ repo, svc, base });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(base: string, path: string, body: string | undefined, contentType = 'application/json', signature?: string): Promise<Reply> {
  const init: RequestInit = { method: 'POST' };
  const headers: Record<string, string> = {};
  if (contentType) headers['content-type'] = contentType;
  if (signature) headers['x-signature'] = signature;
  if (Object.keys(headers).length > 0) init.headers = headers;
  if (body !== undefined) init.body = body;
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

const json = (value: unknown): string => JSON.stringify(value);

// ---------- 空 / 畸形事件 ----------

test('空 body / 空对象：三平台一律 400，且不写任何消息、不占 unknown 幂等键', async () => {
  await withApp(async ({ base, repo }) => {
    for (const platform of ['feishu', 'dingtalk']) {
      const noBody = await post(base, `/api/webhook/${platform}`, undefined);
      assert.equal(noBody.status, 400, `${platform} 无 body 必须 400`);
      assert.equal(noBody.json?.ok, false, `${platform} 空 body 应回 JSON {ok:false}`);

      const emptyObject = await post(base, `/api/webhook/${platform}`, '{}');
      assert.equal(emptyObject.status, 400, `${platform} {} 必须 400`);
      assert.equal(emptyObject.json?.ok, false);
    }
    assert.equal(repo.list().length, 0, '空事件绝不能入库');
    for (const platform of [Platform.FEISHU, Platform.DINGTALK]) {
      assert.equal(repo.findByExternal(platform, 'unknown'), undefined, `${platform} unknown 去重键必须空闲`);
    }
  });
});


test('缺消息唯一 ID：飞书/钉钉/微信 400 且不写 trace；随后正常消息仍能入库', async () => {
  await withApp(async ({ base, repo }) => {
    const feishuNoId = {
      schema: '2.0',
      event: {
        message: {
          message_type: 'text',
          content: json({ text: '没有消息 ID' }),
          sender: { sender_id: { user_id: 'u_no_id' } },
        },
      },
    };
    const feishu = await post(base, '/api/webhook/feishu', json(feishuNoId));
    assert.equal(feishu.status, 400);
    assert.match(String(feishu.json?.error), /externalId/);

    const dingtalk = await post(base, '/api/webhook/dingtalk', json({
      msgtype: 'text', text: { content: '没有消息 ID' }, senderId: 'u_no_id',
    }));
    assert.equal(dingtalk.status, 400);

    const wechat = await post(base, '/api/webhook/wechat', json({ from: '某人', text: '没有消息 ID' }), 'application/json', 'dev-test');
    assert.equal(wechat.status, 400);

    assert.equal(repo.list().length, 0, '畸形事件不得写消息/幂等表');
    assert.equal(repo.findByExternal(Platform.FEISHU, 'unknown'), undefined);
    assert.equal(repo.findByExternal(Platform.DINGTALK, 'unknown'), undefined);

    // 幂等键没有被占死：同平台随后的真实消息正常入库
    const ok = await post(base, '/api/webhook/feishu', json(feishuSample));
    assert.equal(ok.status, 200);
    assert.equal(ok.json?.ok, true);
    assert.equal(repo.list().length, 1);
  });
});

test('畸形 JSON：400 可读 JSON 错误，而不是 Express 默认 HTML 栈', async () => {
  await withApp(async ({ base }) => {
    const res = await post(base, '/api/webhook/feishu', '{"broken": ');
    assert.equal(res.status, 400);
    assert.equal(res.json?.ok, false);
    assert.match(String(res.json?.error), /JSON/);
  });
});

// ---------- 正常样例：行为与返回形状不能变 ----------

test('正常飞书样例：200 {ok:true,duplicate:false}，重推幂等 duplicate:true', async () => {
  await withApp(async ({ base, repo }) => {
    const first = await post(base, '/api/webhook/feishu', json(feishuSample));
    assert.equal(first.status, 200);
    assert.deepEqual({ ok: first.json?.ok, duplicate: first.json?.duplicate }, { ok: true, duplicate: false });

    const again = await post(base, '/api/webhook/feishu', json(feishuSample));
    assert.equal(again.status, 200);
    assert.equal(again.json?.duplicate, true, '幂等语义保持不变');
    assert.equal(repo.list().length, 1);

    const saved = repo.findByExternal(Platform.FEISHU, 'om_demo_001');
    assert.ok(saved);
    assert.equal(saved!.body, '周五前交周报');
  });
});

test('正常钉钉样例：200 {ok:true}', async () => {
  await withApp(async ({ base, repo }) => {
    const res = await post(base, '/api/webhook/dingtalk', json(dingtalkSample));
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
    assert.ok(repo.findByExternal(Platform.DINGTALK, 'msg_demo_001'));
  });
});

test('钉钉群消息（conversationType=2）：入库保留群会话与群名，供「回复发回群」使用', async () => {
  await withApp(async ({ base, repo }) => {
    const res = await post(base, '/api/webhook/dingtalk', json({
      msgId: 'group_msg_001',
      msgtype: 'text',
      text: { content: '@机器人 周五前交周报' },
      senderStaffId: 'staff_group_1',
      senderNick: '钉钉小王',
      conversationId: 'cid_group_001',
      conversationType: '2',
      conversationTitle: '项目协作群',
    }));
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);

    const saved = repo.findByExternal(Platform.DINGTALK, 'group_msg_001');
    assert.ok(saved, '群消息必须入库（平台只推 @机器人 的群消息，推了就不能丢）');
    assert.equal(saved!.conversation?.type, 'group', '群会话不能被误判成单聊，否则回复会私聊发送人');
    assert.equal(saved!.conversation?.id, 'cid_group_001');
    assert.equal(saved!.conversation?.title, '项目协作群', '群名用于界面展示「回复会发回该群」');
  });
});

test('正常微信样例（带 dev 签名）：200 {ok:true} 且入库', async () => {
  await withApp(async ({ base, repo }) => {
    const res = await post(base, '/api/webhook/wechat', json(wechatSample), 'application/json', 'dev-test');
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
    const saved = repo.findByExternal(Platform.WECHAT, 'wx_demo_001');
    assert.ok(saved);
    assert.equal(saved!.sender.id, 'wx_demo_user');
  });
});

test('微信伪造签名：401 拒绝（只认 dev* 本机桥签名，不认外部任意来源）', async () => {
  await withApp(async ({ base, repo }) => {
    const res = await post(base, '/api/webhook/wechat', json(wechatSample), 'application/json', 'forged-signature');
    assert.equal(res.status, 401);
    assert.equal(repo.list().length, 0);
  });
});

test('isLoopbackAddress：只认本机回环，LAN / 公网一律 false', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.10'), false);
  assert.equal(isLoopbackAddress('10.0.0.2'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('微信 real 模式：只接受 dev-rpa，无签名 / mock / 其它 dev 前缀都 401', async () => {
  forceMode(Platform.WECHAT, 'real');
  try {
    await withApp(async ({ base, repo }) => {
      const noSig = await post(base, '/api/webhook/wechat', json(wechatSample));
      assert.equal(noSig.status, 401, '无签名不能靠默认 mock 混进来');
      const mock = await post(base, '/api/webhook/wechat', json(wechatSample), 'application/json', 'mock');
      assert.equal(mock.status, 401);
      const devTest = await post(base, '/api/webhook/wechat', json(wechatSample), 'application/json', 'dev-test');
      assert.equal(devTest.status, 401, 'real 模式只认桥的固定签名，不认任意 dev*');
      assert.equal(repo.list().length, 0);

      const ok = await post(base, '/api/webhook/wechat', json(wechatSample), 'application/json', 'dev-rpa');
      assert.equal(ok.status, 200);
      assert.ok(repo.findByExternal(Platform.WECHAT, 'wx_demo_001'));
    });
  } finally {
    forceMode(Platform.WECHAT, 'mock');
  }
});

// ---------- 状态回流 ----------

test('状态回流（前进）：200 且消息状态更新', async () => {
  await withApp(async ({ base, repo }) => {
    await post(base, '/api/webhook/feishu', json(feishuSample));
    const msg = repo.findByExternal(Platform.FEISHU, 'om_demo_001')!;
    assert.equal(msg.status, MsgStatus.RECEIVED);

    const res = await post(base, '/api/webhook/feishu', json({
      event: 'status', traceId: msg.traceId, status: 'synced',
    }));
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
    assert.equal(repo.get(msg.traceId)!.status, MsgStatus.SYNCED);
  });
});

test('状态回流（倒退）：仍 200，但保持 synced 并写 sync_ignored 说明原因', async () => {
  await withApp(async ({ base, repo }) => {
    await post(base, '/api/webhook/feishu', json(feishuSample));
    const msg = repo.findByExternal(Platform.FEISHU, 'om_demo_001')!;
    repo.update(msg.traceId, { status: MsgStatus.SYNCED });

    const res = await post(base, '/api/webhook/feishu', json({
      event: 'status', externalId: 'om_demo_001', status: 'received',
    }));
    assert.equal(res.status, 200, '防倒退是业务忽略，不能变成接口错误');
    assert.equal(res.json?.ok, true);
    assert.equal(repo.get(msg.traceId)!.status, MsgStatus.SYNCED, '状态不得倒退');

    const ignored = repo.getLoopLog(msg.traceId).find((e) => e.event === 'sync_ignored');
    assert.ok(ignored, '必须留下 sync_ignored 证据');
    assert.match(ignored!.detail ?? '', /倒退/);
  });
});
