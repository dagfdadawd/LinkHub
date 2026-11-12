/**
 * 飞书本人身份轮询器单测：水位 / 基线 / 回溯 / 增量 / 权限错误 / 映射跳过。
 * 全部注入假 fetch 函数，不联网。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedMessage } from '@unimsg/shared';
import {
  loadUserReceiveState,
  planChatPolling,
  pollFeishuUserOnce,
  saveUserReceiveState,
  type FeishuUserReceiveState,
} from './feishuUserPoller';
import {
  FeishuUserReceiveError,
  type FeishuChat,
  type FeishuSelfUserInfo,
  type FeishuUserMessageRaw,
} from '../connectors/feishuUserReceive';
import { getFeishuReceiveError, resetIdentityCaches } from '../services/identity';

const dirs: string[] = [];
function tempFile(name = 'state.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-feishu-user-'));
  dirs.push(dir);
  return join(dir, name);
}

after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetIdentityCaches();
});

const chatA: FeishuChat = { chatId: 'oc_a', name: '群A', chatMode: 'group' };
const chatB: FeishuChat = { chatId: 'oc_b', name: '单聊B', chatMode: 'p2p' };

function rawMsg(id: string, createTime: number, text = '你好'): FeishuUserMessageRaw {
  return {
    message_id: id,
    create_time: String(createTime),
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: 'ou_other', id_type: 'open_id', sender_type: 'user' },
    chat_id: 'oc_a',
  };
}

function emptyState(): FeishuUserReceiveState {
  return { version: 1, chats: {} };
}

test('水位文件：缺失 → 空状态；损坏 JSON / 非法条目 → 可恢复并带回原因', () => {
  const missing = loadUserReceiveState(tempFile('none.json'));
  assert.equal(missing.exists, false);
  assert.equal(missing.restored, 0);
  assert.deepEqual(missing.state.chats, {});

  const broken = tempFile('broken.json');
  writeFileSync(broken, 'not-json', 'utf8');
  const r1 = loadUserReceiveState(broken);
  assert.equal(r1.exists, true);
  assert.match(r1.error ?? '', /JSON/);
  assert.deepEqual(r1.state.chats, {});

  const mixed = tempFile('mixed.json');
  writeFileSync(mixed, JSON.stringify({ version: 1, selfOpenId: 'ou_self', chats: { oc_a: 123, oc_bad: 'x' } }), 'utf8');
  const r2 = loadUserReceiveState(mixed);
  assert.equal(r2.state.chats.oc_a, 123);
  assert.equal(r2.state.chats.oc_bad, undefined);
  assert.equal(r2.state.selfOpenId, 'ou_self');
  assert.match(r2.error ?? '', /非法/);
});

test('水位文件：原子写 + 往返恢复（临时文件不残留）', () => {
  const file = tempFile();
  const state: FeishuUserReceiveState = { version: 1, selfOpenId: 'ou_self', chats: { oc_b: 2, oc_a: 1 } };
  saveUserReceiveState(file, state);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.selfOpenId, 'ou_self');
  assert.deepEqual(raw.chats, { oc_a: 1, oc_b: 2 });
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, '临时文件必须被 rename 掉');
  const loaded = loadUserReceiveState(file);
  assert.deepEqual(loaded.state.chats, { oc_a: 1, oc_b: 2 });
});

test('planChatPolling：首轮只立基线；已知会话拉增量；受 chatLimit 限制', () => {
  const state = emptyState();
  state.chats.oc_b = 1000;
  const plan = planChatPolling([chatA, chatB], state, { now: 5_000, chatLimit: 5, backfillHours: 0 });
  assert.deepEqual(plan.baseline.map((c) => c.chatId), ['oc_a']);
  assert.deepEqual(plan.fetch.map((f) => f.chat.chatId), ['oc_b']);
  assert.equal(plan.fetch[0]!.sinceMs, 1000);
});

test('planChatPolling：回溯模式从 N 小时前拉；chatLimit 按最久未检查优先', () => {
  const now = 10 * 3600_000;
  const plan = planChatPolling([chatA, chatB], emptyState(), { now, chatLimit: 1, backfillHours: 24 });
  assert.equal(plan.baseline.length, 0);
  assert.equal(plan.fetch.length, 1);
  assert.equal(plan.fetch[0]!.sinceMs, now - 24 * 3600_000);

  const busy = emptyState();
  busy.chats.oc_a = now - 1000;
  busy.chats.oc_b = now - 9000;
  const pick = planChatPolling([chatA, chatB], busy, { now, chatLimit: 1, backfillHours: 0 });
  assert.equal(pick.fetch[0]!.chat.chatId, 'oc_b', '最久没检查的会话优先');
});

test('pollFeishuUserOnce：首轮只立基线，不拉历史消息', async () => {
  const state = emptyState();
  let fetchMessagesCalls = 0;
  const result = await pollFeishuUserOnce({
    state,
    getToken: async () => 'u-token',
    ingest: async () => ({ duplicate: false }),
    fetchChats: (async () => ({ chats: [chatA, chatB], pages: 1, truncated: false })) as any,
    fetchMessages: (async () => {
      fetchMessagesCalls += 1;
      return { messages: [], pages: 1 };
    }) as any,
    getSelfInfo: async () => ({ openId: 'ou_self', name: '我' }),
    fetchOptions: { fetchImpl: (async () => { throw new Error('should not fetch'); }) as any },
    now: () => 7_000,
    chatLimit: 10,
    backfillHours: 0,
  });
  assert.equal(result.baselined, 2);
  assert.equal(fetchMessagesCalls, 0);
  assert.equal(state.chats.oc_a, 7000);
  assert.equal(state.chats.oc_b, 7000);
  assert.equal(state.selfOpenId, 'ou_self');
});

test('pollFeishuUserOnce：增量入库 + 水位推进 + 自己消息/重复/空格跳过', async () => {
  const state = emptyState();
  state.chats.oc_a = 1_000_000;
  const ingested: UnifiedMessage[] = [];
  const selfEcho: FeishuUserMessageRaw = {
    ...rawMsg('om_self', 1_000_500),
    sender: { id: 'ou_self', id_type: 'open_id', sender_type: 'user' },
  };
  const result = await pollFeishuUserOnce({
    state,
    getToken: async () => 'u-token',
    ingest: async (msg) => {
      ingested.push(msg);
      return { duplicate: msg.externalId === 'om_dup' };
    },
    fetchChats: (async () => ({ chats: [chatA], pages: 1, truncated: false })) as any,
    fetchMessages: (async () => ({
      messages: [
        rawMsg('om_1', 1_000_100),
        rawMsg('om_dup', 1_000_200),
        selfEcho,
        { message_id: '', create_time: '1000300' } as FeishuUserMessageRaw,
        rawMsg('om_2', 1_000_400),
      ],
      pages: 1,
      maxCreateTimeMs: 1_000_500,
    })) as any,
    getSelfInfo: async () => ({ openId: 'ou_self' }),
    now: () => 2_000_000,
    chatLimit: 10,
    backfillHours: 0,
  });
  assert.equal(result.fetchedChats, 1);
  assert.equal(result.fetchedMessages, 5);
  assert.equal(result.added, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.skipped, 2);
  assert.equal(state.chats.oc_a, 1_000_400, '水位推进到实际处理到的最后一条');
  assert.equal(ingested[0]!.receivedAs, 'user');
});

test('pollFeishuUserOnce：权限错误 → 抛错并把中文修复提示写进身份 hint', async () => {
  resetIdentityCaches();
  const state = emptyState();
  state.chats.oc_a = 1_000;
  await assert.rejects(
    () => pollFeishuUserOnce({
      state,
      getToken: async () => 'u-token',
      ingest: async () => ({ duplicate: false }),
      fetchChats: (async () => ({ chats: [chatA], pages: 1, truncated: false })) as any,
      fetchMessages: (async () => {
        throw new FeishuUserReceiveError('飞书用户身份缺少「读消息」权限（错误码 99991672）：请开通 im:message', { kind: 'permission', code: 99991672 });
      }) as any,
      getSelfInfo: async () => ({ openId: 'ou_self' }),
      now: () => 1_000_000,
      chatLimit: 10,
      backfillHours: 0,
      onError: () => {},
    }),
    /权限/,
  );
  assert.match(getFeishuReceiveError() ?? '', /im:message/);
});

test('pollFeishuUserOnce：取不到 selfOpenId 时跳过过滤但继续收消息', async () => {
  const state = emptyState();
  state.chats.oc_a = 1000;
  const ingested: UnifiedMessage[] = [];
  const result = await pollFeishuUserOnce({
    state,
    getToken: async () => 'u-token',
    ingest: async (msg) => {
      ingested.push(msg);
      return { duplicate: false };
    },
    fetchChats: (async () => ({ chats: [chatA], pages: 1, truncated: false })) as any,
    fetchMessages: (async () => ({ messages: [rawMsg('om_x', 2000)], pages: 1 })) as any,
    getSelfInfo: async () => undefined as FeishuSelfUserInfo | undefined,
    now: () => 1_000_000,
    chatLimit: 10,
    backfillHours: 0,
  });
  assert.equal(result.added, 1);
  assert.equal(ingested.length, 1);
  assert.equal(state.selfOpenId, undefined);
});