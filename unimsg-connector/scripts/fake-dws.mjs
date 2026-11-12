#!/usr/bin/env node
/**
 * fake-dws：钉钉官方 CLI dws 的**离线桩**（只用于测试与零网络演示，绝不连钉钉）。
 *
 * 用法（与真实 dws 命令行一致）：
 *   node scripts/fake-dws.mjs version
 *   node scripts/fake-dws.mjs auth status --readonly --format json
 *   node scripts/fake-dws.mjs auth login [--device] [--no-browser] -f json
 *   node scripts/fake-dws.mjs auth logout
 *   node scripts/fake-dws.mjs profile list --format json
 *   node scripts/fake-dws.mjs event +listen-im --kind at-me --events message --flatten -f ndjson
 *   node scripts/fake-dws.mjs chat message send --conversation-id cid-x --content "你好" -f json
 *   node scripts/fake-dws.mjs chat message reply --group cid-x --ref-msg-id m1 --ref-sender sid -f json
 *
 * 在 LinkHub 里这样启用（.env）：
 *   DWS_BIN=node scripts/fake-dws.mjs
 *   DINGTALK_MODE=real            # 或「仅本人身份」模式：DINGTALK_IDENTITY=user
 *   DINGTALK_IDENTITY=user
 *   DINGTALK_USER_EVENT_KINDS=all-direct,at-me
 *
 * 字段依据 dws v1.0.68-beta.1 的真实 schema（`dws event schema … --flatten` /
 * `dws auth status --format json` / `dws chat message send --dry-run -f json` 实测），
 * 为可离线运行做了简化；日志行、就绪行（stderr `[event] ready`）保留真实形态，
 * 用于验证 LinkHub 的 NDJSON 容错解析。
 *
 * 可控环境变量：
 *   FAKE_DWS_STATE_FILE      登录状态文件（默认系统临时目录 linkhub-fake-dws-state.json）
 *   FAKE_DWS_AUTHENTICATED   true/false：强制覆盖登录态（不落盘）
 *   FAKE_DWS_FAIL            not-logged-in | permission | validation：模拟失败
 *   FAKE_DWS_EVENT_INTERVAL_MS  事件间隔（默认 3000ms，首条 300ms）
 *   FAKE_DWS_MAX_EVENTS      无 --max-events 时的事件条数上限（默认不限）
 *   FAKE_DWS_SENT_LOG        发送记录 NDJSON（默认状态文件旁 fake-dws-sent.ndjson）
 *   FAKE_DWS_LOGIN_DELAY_MS  登录后多久变为已登录（默认 1200ms，测试可设 0）
 *
 * 退出码与真实 dws 对齐：0 成功；2 用法错误；3 参数/文件校验失败；5 未登录。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const VERSION = 'v1.0.68-beta.1';
const argv = process.argv.slice(2);

/** 全局 flag：存在于任意位置（与 cobra 一致） */
function hasFlag(name) {
  return argv.includes(`--${name}`) || argv.includes(`-${name}`);
}
function flagValue(name, fallback) {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('-')) return argv[idx + 1];
  return fallback;
}

function stateFile() {
  return process.env.FAKE_DWS_STATE_FILE
    || join(tmpdir(), 'linkhub-fake-dws-state.json');
}

function readState() {
  const file = stateFile();
  if (!existsSync(file)) return { authenticated: true, profile: defaultProfile() };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* 损坏视为默认 */
  }
  return { authenticated: true, profile: defaultProfile() };
}

function writeState(next) {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function defaultProfile() {
  return {
    displayName: '张三（模拟）',
    corpId: 'ding-fake-corp',
    userId: 'fake-user-001',
    openDingTalkId: 'fake-open-dingtalk-id-001',
    label: '模拟组织/张三',
  };
}

function authenticated() {
  const forced = (process.env.FAKE_DWS_AUTHENTICATED ?? '').trim().toLowerCase();
  if (forced === 'true' || forced === '1') return true;
  if (forced === 'false' || forced === '0') return false;
  return readState().authenticated === true;
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function failNotLoggedIn() {
  process.stderr.write(
    '● Error: event consume --as user: load access token: reading secure data file: '
    + `open ${join(tmpdir(), '.dws', '.data')}: The system cannot find the file specified.\n`,
  );
  process.exit(5);
}

function failByEnv(command) {
  const mode = (process.env.FAKE_DWS_FAIL ?? '').trim().toLowerCase();
  if (!mode) return false;
  if (mode === 'not-logged-in') {
    if (command === 'auth status') return false; // auth status 要能报告未登录而不是崩
    failNotLoggedIn();
  }
  if (mode === 'permission') {
    printJson({
      ok: false,
      outcome: 'failure',
      error: {
        type: 'permission',
        subtype: 'forbidden',
        exit_code: 1,
        message: 'permission denied: current user has no CLI access (模拟失败 FAKE_DWS_FAIL=permission)',
      },
    });
    process.exit(1);
  }
  if (mode === 'validation') {
    printJson({
      ok: false,
      outcome: 'failure',
      error: {
        type: 'validation',
        subtype: 'invalid_argument',
        exit_code: 3,
        message: 'validation failed (模拟失败 FAKE_DWS_FAIL=validation)',
      },
    });
    process.exit(3);
  }
  return false;
}

const handled = { value: false };
function markHandled() { handled.value = true; }

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------
if (argv[0] === 'version' || hasFlag('version')) {
  markHandled();
  process.stdout.write(
    `Version:        ${VERSION}\n`
    + 'Edition:        open\n'
    + 'Build:          2026-11-06T12:41:21Z\n'
    + 'Commit:         fake0000000000000000000000000000000000\n'
    + 'Architecture:   MCP Static Endpoint Mode\n'
    + 'Go:             1.24+\n'
    + `版本检查: 当前 ${VERSION}，无可用更新（fake-dws 离线桩）。\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// auth status / login / logout
// ---------------------------------------------------------------------------
if (argv[0] === 'auth' && argv[1] === 'status') {
  markHandled();
  failByEnv('auth status');
  const authed = authenticated();
  printJson({
    version_check: {
      current: VERSION,
      latest: '1.0.68-beta.1',
      status: 'up_to_date',
      checked_at: new Date().toISOString(),
      cached: true,
    },
    success: true,
    authenticated: authed,
    message: authed ? '已登录（模拟）' : '未登录',
  });
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'login') {
  markHandled();
  const state = readState();
  const delay = Number(process.env.FAKE_DWS_LOGIN_DELAY_MS ?? '1200');
  const device = hasFlag('device');
  const login = () => {
    writeState({ ...state, authenticated: true, profile: defaultProfile(), loggedInAt: new Date().toISOString() });
    printJson({
      ok: true,
      outcome: 'success',
      data: {
        authenticated: true,
        mode: device ? 'device' : 'browser',
        profile: `${defaultProfile().corpId}:${defaultProfile().userId}`,
        message: 'fake-dws 模拟登录成功（未访问钉钉）',
      },
    });
  };
  if (device) {
    // 真实 dws 设备码登录会先给出 user_code + 短 URL；这里同样先输出，再模拟用户完成授权
    process.stdout.write(
      `请访问 https://fake-login.dingtalk.example/device 并输入设备码 FAKE-1234（fake-dws 模拟，不会真登录）\n`,
    );
  }
  if (delay <= 0) {
    login();
    process.exit(0);
  }
  setTimeout(() => {
    login();
    process.exit(0);
  }, delay);
  // 保持事件循环（等待模拟授权完成）
} else if (argv[0] === 'auth' && argv[1] === 'logout') {
  markHandled();
  writeState({ ...readState(), authenticated: false });
  printJson({ ok: true, outcome: 'success', data: { authenticated: false } });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// profile list
// ---------------------------------------------------------------------------
if (argv[0] === 'profile' && argv[1] === 'list') {
  markHandled();
  const authed = authenticated();
  printJson({
    success: true,
    profiles: authed
      ? [{ displayName: defaultProfile().displayName, corpId: defaultProfile().corpId, userId: defaultProfile().userId, openDingTalkId: defaultProfile().openDingTalkId }]
      : [],
  });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// contact user get-self（本人身份：用于过滤自己发出的消息）
// ---------------------------------------------------------------------------
if (argv[0] === 'contact' && argv[1] === 'user' && argv[2] === 'get-self') {
  markHandled();
  failByEnv('contact user get-self');
  if (!authenticated()) failNotLoggedIn();
  printJson({
    ok: true,
    outcome: 'success',
    data: {
      openDingTalkId: defaultProfile().openDingTalkId,
      userId: defaultProfile().userId,
      displayName: defaultProfile().displayName,
      corpId: defaultProfile().corpId,
    },
  });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// event +listen-im / event consume（长驻，NDJSON 到 stdout，就绪行到 stderr）
// ---------------------------------------------------------------------------
if (argv[0] === 'event' && (argv[1] === '+listen-im' || argv[1] === 'consume')) {
  markHandled();
  failByEnv('event');
  if (!authenticated()) failNotLoggedIn();

  const kind = flagValue('kind', 'at-me');
  const events = flagValue('events', 'message');
  if (events && !events.split(',').map((s) => s.trim()).includes('message') && !events.includes('*')) {
    process.stderr.write(`WARN: 事件范围 ${events} 不包含 message，fake-dws 不会输出消息事件\n`);
  }
  const eventKey = {
    'all-direct': 'user_im_message_receive_o2o_all',
    'at-me': 'user_im_message_receive_at',
    'all-group': 'user_im_message_receive_group_all',
    group: 'user_im_message_receive_group',
    sender: 'user_im_message_receive_user',
  }[kind] ?? 'user_im_message_receive_o2o_all';
  const intervalMs = Math.max(100, Number(process.env.FAKE_DWS_EVENT_INTERVAL_MS ?? '3000'));
  const maxEventsRaw = Number(flagValue('max-events', process.env.FAKE_DWS_MAX_EVENTS ?? '0'));
  const maxEvents = Number.isFinite(maxEventsRaw) && maxEventsRaw > 0 ? Math.floor(maxEventsRaw) : 0;
  const durationRaw = flagValue('duration', '');
  const durationMs = parseDurationMs(durationRaw);

  process.stderr.write(`[event] ready event_count=1 bus_pid=${process.pid}（fake-dws 离线桩，kind=${kind}）\n`);

  const templates = [
    () => ({ content: '你好，麻烦把周报在周五下班前发我（fake-dws 模拟消息）' }),
    () => ({ content: '这条是待办：明天 18:00 前确认演示环境（fake-dws 模拟消息）' }),
    () => ({
      content: JSON.stringify({
        fileName: '季度复盘.pdf',
        fileSize: 20480,
        mediaId: '@fake-media-id-001',
      }),
    }),
  ];
  let seq = 0;
  let timer;
  let finished = false;
  const stop = (code = 0) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    if (durationTimer) clearTimeout(durationTimer);
    process.exit(code);
  };
  const emit = () => {
    if (finished) return;
    seq += 1;
    const tpl = templates[(seq - 1) % templates.length]();
    const nowMs = Date.now();
    // --flatten 输出：业务字段位于 payload（与 dws v1.0.68 一致）
    const line = {
      type: eventKey,
      event_type: eventKey,
      payload: {
        type: eventKey,
        event_id: `fake-event-${seq}-${nowMs}`,
        message_id: `fake-open-message-${seq}-${nowMs}`,
        conversation_id: kind.includes('group') || kind === 'at-me' ? `cid-fake-group-${kind}` : `cid-fake-o2o-${kind}`,
        content: tpl.content,
        create_time: String(nowMs),
        event_time: nowMs,
        timestamp: nowMs,
        sender: '张三（模拟）',
        sender_open_dingtalk_id: 'fake-open-dingtalk-id-002',
        subscribe_id: `fake-subscribe-${kind}`,
      },
      headers: { messageId: `fake-envelope-${seq}`, topic: 'fake-personal-stream' },
    };
    // 偶尔混入一行非 JSON 诊断输出，验证 LinkHub 的 NDJSON 容错（真实 dws 诊断大多走 stderr）
    if (seq % 5 === 0) process.stdout.write(`WARN: fake-dws 诊断行（非 JSON，应被忽略）seq=${seq}\n`);
    process.stdout.write(`${JSON.stringify(line)}\n`);
    if (maxEvents > 0 && seq >= maxEvents) {
      stop(0);
      return;
    }
    timer = setTimeout(emit, intervalMs);
  };
  let durationTimer;
  if (durationMs > 0) durationTimer = setTimeout(() => stop(0), durationMs);
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  timer = setTimeout(emit, 300);
  // 保持进程存活
} else if (argv[0] === 'event' && argv[1] === 'list') {
  markHandled();
  process.stdout.write(
    'EVENT_KEY                             RULE        STATUS   DESCRIPTION\n'
    + 'user_im_message_receive_at            at          enabled  当前用户被 @ 的消息（fake-dws）\n'
    + 'user_im_message_receive_o2o_all       all         enabled  当前用户收到的所有单聊消息（fake-dws）\n'
    + 'user_im_message_receive_group_all     all         enabled  当前用户收到的所有群聊消息（fake-dws）\n',
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// chat message send / reply
// ---------------------------------------------------------------------------
if (argv[0] === 'chat' && argv[1] === 'message' && (argv[2] === 'send' || argv[2] === 'reply')) {
  markHandled();
  failByEnv('chat message send');
  if (!authenticated()) failNotLoggedIn();

  const dryRun = hasFlag('dry-run');
  const conversationId = flagValue('conversation-id', flagValue('group', ''));
  const user = flagValue('user', '');
  const openDingtalkId = flagValue('open-dingtalk-id', '');
  const content = flagValue('content', '');
  const file = flagValue('file', '');
  const msgType = flagValue('msg-type', '');
  const idempotencyKey = flagValue('idempotency-key', flagValue('uuid', ''));
  const refMsgId = flagValue('ref-msg-id', '');
  const reply = argv[2] === 'reply';

  if (reply) {
    if (!conversationId || !refMsgId) {
      printJson({
        ok: false,
        outcome: 'failure',
        error: {
          type: 'validation',
          subtype: 'missing_required_flag',
          exit_code: 3,
          message: 'ERROR: required flag(s) "group", "ref-msg-id" not set',
        },
      });
      process.exit(3);
    }
  } else if (!conversationId && !user && !openDingtalkId) {
    printJson({
      ok: false,
      outcome: 'failure',
      error: {
        type: 'validation',
        subtype: 'missing_target',
        exit_code: 3,
        message: '目标三选一必填：--conversation-id / --user / --open-dingtalk-id',
      },
    });
    process.exit(3);
  }
  if (!reply && !content && !file) {
    printJson({
      ok: false,
      outcome: 'failure',
      error: { type: 'validation', subtype: 'empty_content', exit_code: 3, message: '--content 与 --file 不能同时为空' },
    });
    process.exit(3);
  }
  if (msgType === 'file' && file && !existsSync(file)) {
    printJson({
      ok: false,
      outcome: 'failure',
      error: {
        type: 'validation',
        subtype: 'invalid_file',
        exit_code: 3,
        message: `--file must be a readable local file: cannot read file ${file}`,
      },
    });
    process.exit(3);
  }

  const argumentsPreview = {
    ...(conversationId ? { openConversationId: conversationId } : {}),
    ...(user ? { userId: user } : {}),
    ...(openDingtalkId ? { openDingtalkId } : {}),
    ...(content ? { content: JSON.stringify({ text: content }) } : {}),
    ...(file ? { filePath: file, msgType: 'file' } : {}),
    ...(refMsgId ? { openMessageId: refMsgId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  if (dryRun) {
    printJson({
      ok: true,
      outcome: 'success',
      dry_run: true,
      data: { arguments: argumentsPreview, dry_run: true, executed: false, product: 'chat', tool: 'send_personal_message' },
    });
    process.exit(0);
  }

  const openTaskId = `fake-open-task-${Date.now()}`;
  printJson({
    ok: true,
    outcome: 'success',
    data: {
      openTaskId,
      openMessageId: `fake-open-message-sent-${Date.now()}`,
      openConversationId: conversationId || 'fake-derived-conversation',
      executed: true,
      product: 'chat',
      tool: 'send_personal_message',
      // 说明：fake-dws 未调用钉钉，只记录到本地发送日志供测试/演示断言
      simulated: true,
    },
  });
  // 发送记录落盘：单测/演示可断言「以本人身份发出」的内容（不含真实凭据）
  try {
    const logFile = process.env.FAKE_DWS_SENT_LOG || join(dirname(stateFile()), 'fake-dws-sent.ndjson');
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify({
      at: new Date().toISOString(),
      command: reply ? 'reply' : 'send',
      arguments: argumentsPreview,
      openTaskId,
    })}\n`, 'utf8');
  } catch {
    /* 记录失败不影响成功语义 */
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 其它命令（doc/chat 查询等）：给出「模拟数据」而不是假装真实
// ---------------------------------------------------------------------------
if (!handled.value) {
  process.stderr.write(`fake-dws: 未实现的模拟子命令：${argv.join(' ') || '(空)'}\n`);
  printJson({
    ok: false,
    outcome: 'failure',
    error: {
      type: 'unsupported',
      exit_code: 2,
      message: 'fake-dws 仅支持 version / auth status|login|logout / profile list / event +listen-im|list / chat message send|reply',
    },
  });
  process.exit(2);
}

/** 解析 Go duration（如 5s / 30m / 1h）；解析不出返回 0（不限时） */
function parseDurationMs(raw) {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return 0;
  const match = text.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = match[2] ?? 's';
  if (unit === 'ms') return n;
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60_000;
  return n * 3600_000;
}