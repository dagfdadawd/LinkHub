#!/usr/bin/env node
/**
 * 飞书开放平台「本地只读桩」——verifier 用，绝不连接真实飞书。
 *
 * 目的：在没有真实租户授权的前提下，验证「飞书本人身份接收链路」的代码行为
 * （OAuth 令牌文件 → identity 视图 → 用户轮询 → 入库 receivedAs=user → 水位/幂等）。
 * 做法与契约 §3.2 的「注入 fetch」等价：把 FEISHU_BASE_URL 指向本桩，服务端
 * 的飞书用户轮询会请求这里而不是 open.feishu.cn。
 *
 * 用法：
 *   node docs/qa/verification/tools/feishu-stub.mjs [port]        # 默认 3198
 *
 * 环境变量：
 *   FEISHU_STUB_MODE=ok|permission|server_error   默认 ok
 *   FEISHU_STUB_LOG=<文件路径>                    每个请求写一行 JSON（审计/证据）
 *   FEISHU_STUB_SELF_OPEN_ID                      默认 ou_stub_self
 *
 * 行为（与官方响应同构的极简版）：
 *   GET /open-apis/authen/v1/user_info          → { code:0, data:{ open_id, name } }
 *   GET /open-apis/im/v1/chats                  → 1 个单聊 + 1 个群聊（分页一次返回）
 *   GET /open-apis/im/v1/messages?container_id= → 每个会话返回：
 *       1) 一条「每次请求都新的」消息（递增 id，create_time=当前时间）→ 验证增量入库；
 *       2) 一条固定 id 的边界消息（create_time 落在当前秒）→ 每次都会被再次拉到，验证幂等去重；
 *       3) 一条「本人自己发的」消息（sender.id = self）→ 应该被自环过滤跳过。
 *   permission 模式：所有业务接口返回 { code: 99991672, msg:'no permission' }（HTTP 200）。
 *   server_error 模式：返回 HTTP 500 非 JSON（验证网络/HTTP 错误降级）。
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 3198);
const mode = (process.env.FEISHU_STUB_MODE ?? 'ok').trim().toLowerCase();
const logFile = (process.env.FEISHU_STUB_LOG ?? '').trim();
const SELF_OPEN_ID = (process.env.FEISHU_STUB_SELF_OPEN_ID ?? 'ou_stub_self').trim();
const SELF_NAME = '验证用本人（本地桩）';

let seq = 0;
const startedAt = Date.now();
const chats = [
  {
    chat_id: 'oc_stub_p2p',
    name: '验证单聊（本地桩）',
    chat_mode: 'p2p',
    chat_type: 'p2p',
    avatar: '',
    description: '',
    owner_id: SELF_OPEN_ID,
  },
  {
    chat_id: 'oc_stub_group',
    name: '验证群（本地桩）',
    chat_mode: 'group',
    chat_type: 'group',
    avatar: '',
    description: '',
    owner_id: SELF_OPEN_ID,
  },
];
const colleague = { id: 'ou_stub_colleague', id_type: 'open_id', sender_type: 'user' };
const self = { id: SELF_OPEN_ID, id_type: 'open_id', sender_type: 'user' };

function log(entry) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* 日志失败不影响桩 */
  }
}

function json(res, body, status = 200) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(raw) });
  res.end(raw);
}

/** 生成一批增量消息；边界消息 useNowSecond 让 create_time 落在当前秒内，保证下一轮仍会被拉取 */
function messageBatch(chatId, nowMs) {
  seq += 1;
  const nowSec = Math.floor(nowMs / 1000);
  const boundaryTime = nowSec * 1000 + 500; // 落在本秒内 → floor(水位/1000)*1000 <= boundaryTime，下一轮还会返回
  return [
    {
      message_id: `om_stub_inc_${seq}_${nowMs}`,
      create_time: String(nowMs),
      msg_type: 'text',
      chat_id: chatId,
      body: { content: JSON.stringify({ text: `本地桩增量消息 #${seq}（验证本人身份接收，未连接真实飞书）` }) },
      sender: colleague,
      deleted: false,
    },
    {
      message_id: `om_stub_boundary_${chatId}`,
      create_time: String(boundaryTime),
      msg_type: 'text',
      chat_id: chatId,
      body: { content: JSON.stringify({ text: '本地桩边界消息（每轮都会拉到，用于验证幂等去重）' }) },
      sender: colleague,
      deleted: false,
    },
    {
      message_id: `om_stub_self_${chatId}`,
      create_time: String(boundaryTime),
      msg_type: 'text',
      chat_id: chatId,
      body: { content: JSON.stringify({ text: '本人自己发出的消息（应被自环过滤跳过）' }) },
      sender: self,
      deleted: false,
    },
    {
      // 富文本 post：验证正文提取（不属于上面三类）
      message_id: `om_stub_post_${chatId}`,
      create_time: String(boundaryTime),
      msg_type: 'post',
      chat_id: chatId,
      body: { content: JSON.stringify({ title: '本地桩富文本标题', content: [[{ tag: 'text', text: '富文本正文' }]] }) },
      sender: colleague,
      deleted: false,
    },
  ];
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;
  log({ method: req.method, path, query: Object.fromEntries(url.searchParams) });

  if (mode === 'server_error') {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('stub server_error（模拟飞书 5xx，验证降级提示）');
    return;
  }
  if (mode === 'permission' && path.startsWith('/open-apis/im/')) {
    json(res, { code: 99991672, msg: 'no permission: stub 模拟缺少用户身份读消息权限' });
    return;
  }

  if (path === '/open-apis/authen/v1/user_info') {
    json(res, { code: 0, msg: 'success', data: { open_id: SELF_OPEN_ID, name: SELF_NAME } });
    return;
  }
  if (path === '/open-apis/im/v1/chats') {
    const pageSize = Number(url.searchParams.get('page_size') ?? '100');
    json(res, { code: 0, msg: 'success', data: { items: chats.slice(0, pageSize), has_more: false } });
    return;
  }
  if (path === '/open-apis/im/v1/messages') {
    const chatId = url.searchParams.get('container_id') ?? '';
    const startTimeSec = Number(url.searchParams.get('start_time') ?? '0');
    const nowMs = Date.now();
    const all = messageBatch(chatId || 'oc_unknown', nowMs);
    // 与官方语义一致：start_time（秒）过滤 create_time >= start_time*1000
    const items = startTimeSec > 0
      ? all.filter((m) => Number(m.create_time) >= startTimeSec * 1000)
      : all;
    json(res, { code: 0, msg: 'success', data: { items, has_more: false } });
    return;
  }
  // 其它（OAuth token 刷新等）：明确报错，避免静默当成成功
  json(res, { code: 99999, msg: `stub 未实现的接口：${path}` });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[feishu-stub] listening on http://127.0.0.1:${port} (mode=${mode}, self=${SELF_OPEN_ID})`);
  console.log(`[feishu-stub] startedAt=${new Date(startedAt).toISOString()}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));