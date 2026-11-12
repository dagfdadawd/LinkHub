#!/usr/bin/env node
/**
 * WS 探针（verifier 用）：连接 LinkHub /ws，按类型收集事件并落盘，用于验证
 * 「WS 推送 + message.failed 携带失败原因」等前端实时链路。只读，不改任何状态。
 *
 * 用法：
 *   node ws-probe.mjs <wsUrl> <token> <collectMs> <outFile>
 * 例：
 *   node ws-probe.mjs ws://127.0.0.1:3103/ws dev-token 8000 events.ndjson
 *
 * 输出（stdout 最后一行）：{connected, byType: {...}, count}
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const [wsUrl, token, collectMsRaw, outFile] = process.argv.slice(2);
const collectMs = Number(collectMsRaw ?? '8000') || 8000;
if (!wsUrl || !token || !outFile) {
  console.error('用法：node ws-probe.mjs <wsUrl> <token> <collectMs> <outFile>');
  process.exit(2);
}

const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
const byType = {};
let connected = false;
let count = 0;
const lines = [];

const finish = () => {
  try {
    ws.close();
  } catch {
    /* 已关闭 */
  }
  writeFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  console.log(JSON.stringify({ connected, count, byType }));
  process.exit(0);
};

ws.onopen = () => {
  appendFileSync(`${outFile}.open`, `${new Date().toISOString()}\n`, 'utf8');
};
ws.onmessage = (ev) => {
  const raw = String(ev.data);
  let type = 'unknown';
  try {
    const parsed = JSON.parse(raw);
    type = parsed.type ?? 'unknown';
    if (type === 'connected') connected = true;
  } catch {
    /* 非 JSON 帧 */
  }
  byType[type] = (byType[type] ?? 0) + 1;
  count += 1;
  lines.push(raw.replace(/\n/g, ' '));
};
ws.onerror = () => {
  byType.wsError = (byType.wsError ?? 0) + 1;
};
ws.onclose = () => {
  /* 由定时器统一收尾 */
};
setTimeout(finish, collectMs);