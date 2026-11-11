#!/usr/bin/env node
/**
 * 供 start.bat 读取 .env 的最小解析器（零依赖）。
 *
 * 与 dotenv 16 的解析规则保持一致：BOM、空白、行内注释、引号、空值。
 * 输出 KEY=VALUE 行，供批处理 for /f 解析；只读取 unimsg-connector/.env。
 *
 * 用法：node scripts/env-read.mjs all [envPath]
 *   [envPath] 仅供测试/诊断覆盖，缺省为 unimsg-connector/.env
 *   PORT=3001 / HOST_PORT=3001 / TOKEN=dev-token / ACCOUNTS=0
 *   非法端口会回落默认值，并额外输出一行 WARN=...
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 与 dotenv@16 的 LINE 正则一致（含行内注释 # 与可选的 export 前缀） */
function parseDotenv(src) {
  const line =
    /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
  const env = {};
  const text = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let match;
  while ((match = line.exec(text)) !== null) {
    let value = (match[2] || '').trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
    if (maybeQuote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    env[match[1]] = value;
  }
  return env;
}

function readEnv() {
  try {
    const envPath = process.argv[3] ? resolve(process.argv[3]) : resolve(root, '.env');
    return parseDotenv(readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

function parsePort(raw, name, fallback, warnings) {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    warnings.push(`${name}=${value} is not a valid port (1-65535); using ${fallback} instead`);
    return fallback;
  }
  return port;
}

/** 与 server 的 parseMailAccounts 一致：只认大写 MAIL_<KEY>_AUTH_CODE，值需非空 */
function countCredentials(env) {
  let count = 0;
  for (const key of ['FEISHU_APP_SECRET', 'DINGTALK_CLIENT_SECRET', 'WECOM_SECRET']) {
    if ((env[key] ?? '').trim()) count += 1;
  }
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^MAIL_([A-Z0-9]+)_AUTH_CODE$/);
    if (m && m[1] && String(value ?? '').trim()) count += 1;
  }
  return count;
}

const env = readEnv();
const warnings = [];
const port = parsePort(env.SERVER_PORT, 'SERVER_PORT', 3001, warnings);
const hostPort = parsePort(env.HOST_PORT, 'HOST_PORT', 3001, warnings);
const token = (env.API_TOKEN ?? '').trim() || 'dev-token';

process.stdout.write(`PORT=${port}\n`);
process.stdout.write(`HOST_PORT=${hostPort}\n`);
process.stdout.write(`TOKEN=${token}\n`);
process.stdout.write(`ACCOUNTS=${countCredentials(env)}\n`);
// ASCII-only: start.bat may run under the OEM code page, Chinese text would garble
for (const warning of warnings) process.stderr.write(`[env ] ${warning}\n`);