/**
 * 钉钉本人身份（dws CLI）单测：
 *  - 纯解析器（auth status / profile / 事件 NDJSON / 发送参数 / 发送结果 / 失败分类）；
 *  - 可注入 runner 的客户端（缓存、单飞、失败中文报错）；
 *  - 用真实 `scripts/fake-dws.mjs` 子进程做冒烟（不联网、不真实登录、不真实发送）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
  DingtalkPersonalClient,
  DingtalkPersonalError,
  buildReplyArgs,
  buildSendArgs,
  classifyDwsFailure,
  extractLoginHint,
  mapPersonalEventToMessage,
  mapSendResultJson,
  parseAuthStatusJson,
  parseDwsBin,
  parseEventLine,
  parseSelfProfileJson,
  parseProfileListJson,
  parseVersion,
  splitCommandLine,
  type DwsRunResult,
  type DwsRunner,
} from './dingtalkPersonal';

const FAKE_DWS = fileURLToPath(new URL('../../../../scripts/fake-dws.mjs', import.meta.url));
const dirs: string[] = [];
const originalEnv = {
  state: process.env.FAKE_DWS_STATE_FILE,
  sent: process.env.FAKE_DWS_SENT_LOG,
  loginDelay: process.env.FAKE_DWS_LOGIN_DELAY_MS,
};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-dws-'));
  dirs.push(dir);
  return dir;
}

function setFakeEnv(extra: Record<string, string | undefined> = {}): void {
  const dir = tempDir();
  process.env.FAKE_DWS_STATE_FILE = join(dir, 'state.json');
  process.env.FAKE_DWS_SENT_LOG = join(dir, 'sent.ndjson');
  process.env.FAKE_DWS_LOGIN_DELAY_MS = '0';
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

after(() => {
  if (originalEnv.state === undefined) delete process.env.FAKE_DWS_STATE_FILE;
  else process.env.FAKE_DWS_STATE_FILE = originalEnv.state;
  if (originalEnv.sent === undefined) delete process.env.FAKE_DWS_SENT_LOG;
  else process.env.FAKE_DWS_SENT_LOG = originalEnv.sent;
  if (originalEnv.loginDelay === undefined) delete process.env.FAKE_DWS_LOGIN_DELAY_MS;
  else process.env.FAKE_DWS_LOGIN_DELAY_MS = originalEnv.loginDelay;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 假 runner：按顺序返回结果，并记录调用参数 */
function fakeRunner(results: DwsRunResult[]): { runner: DwsRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const runner: DwsRunner = async (args) => {
    calls.push(args);
    const item = results[Math.min(i, results.length - 1)]!;
    i += 1;
    return item;
  };
  return { runner, calls };
}

const ok = (stdout: string): DwsRunResult => ({ code: 0, stdout, stderr: '' });

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

test('splitCommandLine / parseDwsBin：引号、带参数、相对脚本按仓库根解析、裸命令走 PATH', () => {
  assert.deepEqual(splitCommandLine('node "scripts/fake dws.mjs" --mock'), ['node', 'scripts/fake dws.mjs', '--mock']);
  assert.deepEqual(splitCommandLine('  dws  '), ['dws']);
  assert.deepEqual(splitCommandLine(''), []);

  assert.deepEqual(parseDwsBin(undefined), { file: 'dws', prefixArgs: [] });
  assert.deepEqual(parseDwsBin('dws'), { file: 'dws', prefixArgs: [] });
  assert.deepEqual(parseDwsBin('dws.exe'), { file: 'dws.exe', prefixArgs: [] });
  const rel = parseDwsBin('node scripts/fake-dws.mjs');
  assert.equal(rel.file, 'node');
  assert.equal(rel.prefixArgs.length, 1);
  assert.match(rel.prefixArgs[0]!, /scripts[\\/]fake-dws\.mjs$/);
  assert.ok(rel.prefixArgs[0]!.includes('unimsg-connector'), '相对路径应解析到仓库根下');
  const abs = new URL('../../../../scripts/fake-dws.mjs', import.meta.url).pathname;
  const parsedAbs = parseDwsBin(`node ${abs}`);
  assert.equal(parsedAbs.prefixArgs[0], abs, '绝对路径原样保留');
});

test('parseVersion / parseAuthStatusJson / parseProfileListJson：JSON 与非 JSON 都容错', () => {
  assert.equal(
    parseVersion('Version:        v1.0.68-beta.1\nEdition:        open'),
    'v1.0.68-beta.1',
  );
  const authed = parseAuthStatusJson(JSON.stringify({
    success: true,
    authenticated: true,
    message: '已登录',
    version_check: { current: 'v1.0.68-beta.1' },
  }));
  assert.equal(authed.authenticated, true);
  assert.equal(authed.version, 'v1.0.68-beta.1');
  assert.equal(parseAuthStatusJson('{"success":true,"authenticated":false,"message":"未登录"}').authenticated, false);
  // 非 JSON 兜底
  assert.equal(parseAuthStatusJson('authenticated: true\n已登录').authenticated, true);
  assert.equal(parseAuthStatusJson('未登录，请先登录').authenticated, false);

  assert.deepEqual(parseProfileListJson('{"success":true,"profiles":[]}'), []);
  const profiles = parseProfileListJson(JSON.stringify({
    success: true,
    profiles: [{ displayName: '张三', corpId: 'c1', userId: 'u1', openDingTalkId: 'o1' }],
  }));
  assert.equal(profiles[0]!.displayName, '张三');
  assert.equal(profiles[0]!.corpId, 'c1');
  assert.equal(profiles[0]!.openDingtalkId, 'o1');
  assert.deepEqual(parseProfileListJson('not-json'), []);
});

test('parseEventLine：--flatten 的 payload / 普通 envelope / 垃圾行容错', () => {
  const flat = parseEventLine(JSON.stringify({
    type: 'user_im_message_receive_o2o_all',
    event_type: 'user_im_message_receive_o2o_all',
    payload: {
      type: 'user_im_message_receive_o2o_all',
      message_id: 'om_1',
      conversation_id: 'cid_1',
      content: '你好',
      create_time: '1731000000000',
      event_time: 1_731_000_000_000,
      sender: '张三',
      sender_open_dingtalk_id: 'od_1',
    },
    headers: { messageId: 'h1' },
  }));
  assert.equal(flat?.messageId, 'om_1');
  assert.equal(flat?.conversationId, 'cid_1');
  assert.equal(flat?.content, '你好');
  assert.equal(flat?.createTimeMs, 1_731_000_000_000);
  assert.equal(flat?.senderName, '张三');
  assert.equal(flat?.senderOpenDingtalkId, 'od_1');
  assert.equal(flat?.eventType, 'user_im_message_receive_o2o_all');

  // data.payload 形态
  const nested = parseEventLine(JSON.stringify({ data: { payload: { message_id: 'om_2', content: 'x' } } }));
  assert.equal(nested?.messageId, 'om_2');

  // 非 JSON 日志行 / 空行 / 非消息事件
  assert.equal(parseEventLine('WARN: 诊断日志'), null);
  assert.equal(parseEventLine('   '), null);
  const approval = parseEventLine(JSON.stringify({ type: 'user_oa_approval_task_created', payload: { event_id: 'e1' } }));
  assert.ok(approval);
  assert.equal(approval!.messageId, '');
});

test('mapPersonalEventToMessage：文本 / 文件 / 群单聊 / 自己发的一律过滤', () => {
  const base = {
    eventType: 'user_im_message_receive_o2o_all',
    messageId: 'om_1',
    conversationId: 'cid_1',
    content: '明天 18:00 前确认演示环境',
    createTimeMs: 1_731_000_000_000,
    senderName: '张三',
    senderOpenDingtalkId: 'od_other',
    raw: {},
  };
  const msg = mapPersonalEventToMessage(base);
  assert.ok(msg);
  assert.equal(msg.externalId, 'dingtalk:om_1');
  assert.equal(msg.receivedAs, 'user');
  assert.equal(msg.conversation?.id, 'cid_1');
  assert.equal(msg.conversation?.type, 'p2p');
  assert.equal(msg.sender.id, 'od_other');
  assert.equal(msg.sender.name, '张三');
  assert.equal(msg.body, '明天 18:00 前确认演示环境');
  assert.equal(msg.type, 'text');
  assert.equal(msg.createdAt, new Date(1_731_000_000_000).toISOString());

  const fileMsg = mapPersonalEventToMessage({
    ...base,
    messageId: 'om_file',
    content: JSON.stringify({ fileName: '周报.pdf', fileSize: 1024, mediaId: '@m1' }),
  });
  assert.equal(fileMsg!.type, 'file');
  assert.match(fileMsg!.body, /\[文件\] 周报\.pdf/);
  assert.equal(fileMsg!.attachments?.[0]?.name, '周报.pdf');

  const imageMsg = mapPersonalEventToMessage({ ...base, messageId: 'om_img', content: JSON.stringify({ fileName: '图.png' }) });
  assert.equal(imageMsg!.type, 'image');
  assert.equal(imageMsg!.body, '[图片] 图.png');

  const groupMsg = mapPersonalEventToMessage({ ...base, eventType: 'user_im_message_receive_group_all' });
  assert.equal(groupMsg!.conversation?.type, 'group');

  const selfMsg = mapPersonalEventToMessage({ ...base, senderOpenDingtalkId: 'od_self' }, { selfOpenDingtalkId: 'od_self' });
  assert.equal(selfMsg, null);
});

test('buildSendArgs / buildReplyArgs：不带 --title，保留 dws 默认 AI 角标，幂等键与文件参数正确', () => {
  const group = buildSendArgs({
    target: { conversationId: 'cid_1' },
    text: '收到',
    idempotencyKey: 'linkhub-t1',
  });
  assert.deepEqual(group, [
    'chat', 'message', 'send',
    '--conversation-id', 'cid_1',
    '--content', '收到',
    '--idempotency-key', 'linkhub-t1',
    '-f', 'json',
  ]);
  assert.ok(!group.includes('--title'), '不传 --title，避免覆盖正文展示');
  assert.ok(!group.includes('--ai-tag'), '保持 dws 默认 AI 角标（true），不显式关闭');

  const p2p = buildSendArgs({ target: { openDingtalkId: 'od_1' }, text: '你好' });
  assert.deepEqual(p2p.slice(3, 5), ['--open-dingtalk-id', 'od_1']);
  const p2pUser = buildSendArgs({ target: { userId: 'u1' }, text: '你好' });
  assert.deepEqual(p2pUser.slice(3, 5), ['--user', 'u1']);
  assert.throws(
    () => buildSendArgs({ target: {}, text: 'x' }),
    (e: unknown) => e instanceof DingtalkPersonalError && e.kind === 'validation',
  );

  const file = buildSendArgs({ target: { conversationId: 'cid_1' }, filePath: 'C:\\tmp\\a.pdf' });
  assert.deepEqual(file.slice(5), ['--msg-type', 'file', '--file', 'C:\\tmp\\a.pdf', '-f', 'json']);

  const reply = buildReplyArgs({
    conversationId: 'cid_1',
    refMessageId: 'om_1',
    refSenderOpenDingtalkId: 'od_1',
    text: '收到',
    idempotencyKey: 'k1',
  });
  assert.deepEqual(reply, [
    'chat', 'message', 'reply',
    '--group', 'cid_1',
    '--ref-msg-id', 'om_1',
    '--ref-sender', 'od_1',
    '--content', '收到',
    '--uuid', 'k1',
    '-f', 'json',
  ]);
});

test('mapSendResultJson：成功回执 / dry-run 拒绝 / 两种失败结构都是中文错误', () => {
  const success = mapSendResultJson(ok(JSON.stringify({
    ok: true,
    outcome: 'success',
    data: { openTaskId: 'task-1', executed: true },
  })));
  assert.equal(success.ok, true);
  assert.equal(success.platformReply, 'task-1');

  assert.throws(
    () => mapSendResultJson(ok(JSON.stringify({ ok: true, outcome: 'success', dry_run: true, data: {} }))),
    /dry-run/,
  );
  assert.throws(
    () => mapSendResultJson(ok(JSON.stringify({
      ok: false,
      outcome: 'failure',
      error: { type: 'validation', subtype: 'x', exit_code: 3, message: '目标无效' },
    }))),
    (e: unknown) => e instanceof DingtalkPersonalError && /目标无效/.test(e.message),
  );
  assert.throws(
    () => mapSendResultJson({ code: 5, stdout: JSON.stringify({ error: { category: 'internal', code: 5, message: 'cannot resolve' } }), stderr: '' }),
    /未登录|重新登录|授权/,
  );
});

test('classifyDwsFailure：未登录 exit=5 / 没装 ENOENT / 超时 / 权限 / 脚本不存在', () => {
  assert.equal(
    classifyDwsFailure({ code: 5, stdout: '', stderr: 'load access token: reading secure data file' }).kind,
    'not-logged-in',
  );
  assert.match(classifyDwsFailure({ code: 5, stdout: '', stderr: 'x' }).message, /dws auth login/);
  assert.equal(classifyDwsFailure({ code: -1, stdout: '', stderr: '', spawnError: 'ENOENT' }).kind, 'not-installed');
  assert.equal(classifyDwsFailure({ code: 124, stdout: '', stderr: '', timedOut: true }).kind, 'timeout');
  assert.equal(
    classifyDwsFailure({ code: 1, stdout: '', stderr: 'permission denied: CLI 访问未开启' }).kind,
    'permission',
  );
  const moduleNotFound = classifyDwsFailure({
    code: 1,
    stdout: '',
    stderr: "Error: Cannot find module 'C:\\x\\scripts\\fake-dws.mjs'",
  });
  assert.equal(moduleNotFound.kind, 'not-installed');
  assert.match(moduleNotFound.message, /DWS_BIN/);
});

test('extractLoginHint：从输出里抓短授权 URL 与设备码', () => {
  const hint = extractLoginHint('请访问 https://fake-login.dingtalk.example/device 并输入设备码 FAKE-1234');
  assert.equal(hint?.url, 'https://fake-login.dingtalk.example/device');
  assert.equal(hint?.code, 'FAKE-1234');
  assert.equal(extractLoginHint('nothing here'), undefined);
});

// ---------------------------------------------------------------------------
// 客户端（注入 runner，不启子进程）
// ---------------------------------------------------------------------------

test('client：authStatus 30s 缓存 + force 刷新 + 未登录中文提示', async () => {
  let authCalls = 0;
  let authed = false;
  const runner: DwsRunner = async (args) => {
    if (args[0] === 'version') return ok('Version:        v1.0.68-beta.1\n');
    if (args.includes('auth') && args.includes('status')) {
      authCalls += 1;
      return ok(JSON.stringify({ success: true, authenticated: authed, message: authed ? '已登录' : '未登录' }));
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const client = new DingtalkPersonalClient({ bin: 'dws', runner });
  const first = await client.authStatus();
  assert.equal(first.authenticated, false);
  assert.equal(first.available, true);
  assert.equal(authCalls, 1, '首次探测一次');
  const second = await client.authStatus();
  assert.equal(second.authenticated, false);
  assert.equal(authCalls, 1, '缓存期内不再探测');
  authed = true;
  const forced = await client.authStatus({ force: true });
  assert.equal(forced.authenticated, true);
  assert.equal(authCalls, 2, 'force 才重新探测');
  assert.match(client.loginCommand(), /^dws auth login/);
});

test('client：版本 + 发送文本/文件/引用回复参数正确（runner 注入）', async () => {
  const { runner, calls } = fakeRunner([
    ok('Version:        v1.0.68-beta.1\n'),
    ok(JSON.stringify({ ok: true, outcome: 'success', data: { openTaskId: 'task-1' } })),
    ok(JSON.stringify({ ok: true, outcome: 'success', data: { openTaskId: 'task-2' } })),
    ok(JSON.stringify({ ok: true, outcome: 'success', data: { openTaskId: 'task-3' } })),
  ]);
  const client = new DingtalkPersonalClient({ bin: 'dws', runner });
  assert.equal((await client.version()).version, 'v1.0.68-beta.1');
  const sent = await client.sendText({ target: { conversationId: 'cid_1' }, text: '收到', idempotencyKey: 'k1' });
  assert.equal(sent.platformReply, 'task-1');
  assert.ok(calls[1]!.includes('--conversation-id') && calls[1]!.includes('cid_1'));
  assert.ok(calls[1]!.includes('--idempotency-key') && calls[1]!.includes('k1'));

  const fileResult = await client.sendFile({ target: { conversationId: 'cid_1' }, filePath: 'C:\\tmp\\a.pdf' });
  assert.equal(fileResult.platformReply, 'task-2');
  assert.ok(calls[2]!.includes('--msg-type') && calls[2]!.includes('file'));

  const reply = await client.reply({
    conversationId: 'cid_1',
    refMessageId: 'om_1',
    refSenderOpenDingtalkId: 'od_1',
    text: '收到',
  });
  assert.equal(reply.platformReply, 'task-3');
  assert.ok(calls[3]!.includes('reply') && calls[3]!.includes('--ref-msg-id'));
});

test('client：runner 返回未登录 → 抛中文 DingtalkPersonalError（不产生假成功）', async () => {
  const { runner } = fakeRunner([
    ok('Version:        v1.0.68-beta.1\n'),
    { code: 5, stdout: '', stderr: 'load access token: reading secure data file' },
  ]);
  const client = new DingtalkPersonalClient({ bin: 'dws', runner });
  await client.version();
  await assert.rejects(
    () => client.sendText({ target: { conversationId: 'cid_1' }, text: 'x' }),
    (e: unknown) => e instanceof DingtalkPersonalError && e.kind === 'not-logged-in' && /未登录/.test(e.message),
  );
});

test('client：DWS_BIN 带参数时 loginCommand 保留脚本参数（不再退化成 node auth login）', () => {
  const client = new DingtalkPersonalClient({ bin: 'node scripts/fake-dws.mjs' });
  assert.match(client.loginCommand(), /scripts[\\/]fake-dws\.mjs auth login$/);
  const withProfile = new DingtalkPersonalClient({ bin: 'dws', profile: 'corp:user' });
  assert.equal(withProfile.loginCommand(), 'dws auth login --profile corp:user');
});

test('client.startLogin：device 模式解析设备码/URL，后台子进程不阻塞', async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout,
    stderr,
    kill: () => true,
    exitCode: null,
  });
  let spawnedArgs: string[] = [];
  const client = new DingtalkPersonalClient({
    bin: 'dws',
    loginHintWaitMs: 30,
    spawnImpl: (_file, args) => {
      spawnedArgs = args;
      setTimeout(() => {
        stdout.emit('data', Buffer.from('请访问 https://fake-login.example/device 并输入设备码 FAKE-9999\n'));
      }, 5);
      return child as any;
    },
  });
  const started = await client.startLogin();
  assert.equal(started.started, true);
  assert.equal(started.mode, 'device');
  assert.ok(spawnedArgs.includes('--device'));
  assert.ok(spawnedArgs.includes('--no-browser'));
  assert.equal(started.url, 'https://fake-login.example/device');
  assert.equal(started.code, 'FAKE-9999');
  assert.match(started.instructions, /授权|设备码/);
  client.dispose();
});

// ---------------------------------------------------------------------------
// fake-dws 真子进程冒烟
// ---------------------------------------------------------------------------

test('fake-dws 冒烟：version / auth status / profile / 发送（真子进程，不联网）', async () => {
  setFakeEnv();
  const client = new DingtalkPersonalClient({ bin: `node ${FAKE_DWS}` });
  const version = await client.version();
  assert.equal(version.version, 'v1.0.68-beta.1');

  const status = await client.authStatus({ force: true });
  assert.equal(status.available, true);
  assert.equal(status.authenticated, true, 'fake-dws 默认已登录');
  assert.equal(status.version, 'v1.0.68-beta.1');

  const profiles = await client.profiles();
  assert.equal(profiles[0]?.displayName, '张三（模拟）');

  const sent = await client.sendText({
    target: { conversationId: 'cid-fake' },
    text: 'fake-dws 冒烟：本人身份发送',
    idempotencyKey: 'k-smoke',
  });
  assert.equal(sent.ok, true);
  assert.ok(sent.platformReply?.startsWith('fake-open-task-'));
  const logFile = process.env.FAKE_DWS_SENT_LOG!;
  const log = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.match(JSON.stringify(log[0]), /fake-dws 冒烟/);

  // 文件发送：本地文件存在才通过校验
  const dir = tempDir();
  const filePath = join(dir, 'demo.txt');
  writeFileSync(filePath, 'hello', 'utf8');
  const fileOutcome = await client.sendFile({ target: { conversationId: 'cid-fake' }, filePath });
  assert.equal(fileOutcome.ok, true);
});

test('fake-dws 冒烟：未登录/失败模式映射成中文错误', async () => {
  setFakeEnv({ FAKE_DWS_AUTHENTICATED: 'false' });
  const client = new DingtalkPersonalClient({ bin: `node ${FAKE_DWS}` });
  const status = await client.authStatus({ force: true });
  assert.equal(status.authenticated, false);

  process.env.FAKE_DWS_AUTHENTICATED = 'true';
  process.env.FAKE_DWS_FAIL = 'not-logged-in';
  try {
    await assert.rejects(
      () => client.sendText({ target: { conversationId: 'cid-fake' }, text: 'x' }),
      (e: unknown) => e instanceof DingtalkPersonalError && e.kind === 'not-logged-in',
    );
  } finally {
    delete process.env.FAKE_DWS_FAIL;
  }
});

test('parseSelfProfileJson / client.getSelfOpenDingtalkId：用于过滤自己发出的消息', async () => {
  assert.equal(parseSelfProfileJson('{"ok":true,"data":{"openDingTalkId":"od_self","displayName":"我"}}').openDingtalkId, 'od_self');
  assert.equal(parseSelfProfileJson('{"open_dingtalk_id":"od_2"}').openDingtalkId, 'od_2');
  assert.equal(parseSelfProfileJson('not-json').openDingtalkId, undefined);

  setFakeEnv();
  const client = new DingtalkPersonalClient({ bin: `node ${FAKE_DWS}` });
  const id = await client.getSelfOpenDingtalkId();
  assert.equal(id, 'fake-open-dingtalk-id-001');
  assert.equal(client.peekSelfOpenDingtalkId(), 'fake-open-dingtalk-id-001');
  client.invalidateStatus();
  assert.equal(client.peekSelfOpenDingtalkId(), undefined);
});
