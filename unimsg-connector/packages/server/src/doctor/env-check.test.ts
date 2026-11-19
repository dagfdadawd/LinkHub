/**
 * 环境变量拼写检查单测（纯函数，不联网）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSuspiciousEnvVars,
  isKnownEnvKey,
  levenshtein,
  suggestEnvKey,
} from './env-check';

test('isKnownEnvKey：精确名 / 动态邮箱名 / 旧钉钉兼容名 / 未知名', () => {
  assert.equal(isKnownEnvKey('FEISHU_APP_ID'), true);
  assert.equal(isKnownEnvKey('MAIL_WORK_ADDRESS'), true);
  assert.equal(isKnownEnvKey('MAIL_SCHOOL2_FOLDERS'), true);
  assert.equal(isKnownEnvKey('DINGTALK_APP_KEY'), true);
  for (const key of ['DATA_DIR', 'DATA_FILE', 'WEB_DIST', 'VITE_API_BASE', 'VITE_API_TOKEN', 'LINKHUB_DEPLOY_TOKEN', 'HOST_PORT']) {
    assert.equal(isKnownEnvKey(key), true, `${key} 应被认作合法变量`);
  }
  assert.equal(isKnownEnvKey('FEISHU_APPID'), false);
  assert.equal(isKnownEnvKey('MAIL_QQ_ADRESS'), false);
  assert.equal(isKnownEnvKey('PATH'), false);
});

test('levenshtein：基础距离', () => {
  assert.equal(levenshtein('APP_ID', 'APP_ID'), 0);
  assert.equal(levenshtein('APPID', 'APP_ID'), 1);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('suggestEnvKey：常见拼写错误能给出正确建议', () => {
  assert.equal(suggestEnvKey('FEISHU_APPID'), 'FEISHU_APP_ID');
  assert.equal(suggestEnvKey('FEISHU_APP_SECRECT'), 'FEISHU_APP_SECRET');
  assert.equal(suggestEnvKey('DINGTALK_CLIENTID'), 'DINGTALK_CLIENT_ID');
  assert.equal(suggestEnvKey('MAIL_QQ_ADRESS'), 'MAIL_QQ_ADDRESS');
  assert.equal(suggestEnvKey('MAIL_QQ_AUTHCODE'), 'MAIL_QQ_AUTH_CODE');
  assert.equal(suggestEnvKey('WECHAT_BRIDGE_ULR'), 'WECHAT_BRIDGE_URL');
});

test('findSuspiciousEnvVars：只报本项目的、非空的、未知变量', () => {
  const found = findSuspiciousEnvVars({
    PATH: '/usr/bin',
    HOME: '/root',
    FEISHU_APPID: 'cli_xxx',
    MAIL_QQ_ADRESS: 'me@qq.com',
    WECHAT_BRIDGE_ULR: 'http://127.0.0.1:8787',
    LLM_API_KEY: 'sk-real', // 合法，不该报
    MAIL_WORK_EMAIL: '', // 空值，跳过
    UNRELATED_VAR: 'x',
  });
  assert.deepEqual(found.map((f) => f.name), ['FEISHU_APPID', 'MAIL_QQ_ADRESS', 'WECHAT_BRIDGE_ULR']);
  assert.equal(found.find((f) => f.name === 'FEISHU_APPID')?.suggestion, 'FEISHU_APP_ID');
  assert.equal(found.find((f) => f.name === 'MAIL_QQ_ADRESS')?.suggestion, 'MAIL_QQ_ADDRESS');
  assert.ok(found.every((f) => f.reason.includes('不被读取') || f.reason.includes('未在文档中定义')));
});

test('findSuspiciousEnvVars：正常配置零误报', () => {
  const found = findSuspiciousEnvVars({
    FEISHU_MODE: 'auto',
    FEISHU_APP_ID: 'cli_xxx',
    FEISHU_APP_SECRET: 'secret',
    DINGTALK_CLIENT_ID: 'ding',
    DINGTALK_STREAM: 'true',
    WECHAT_BRIDGE_URL: 'http://127.0.0.1:8787',
    MAIL_ACCOUNTS: 'qq',
    MAIL_QQ_ADDRESS: 'me@qq.com',
    MAIL_QQ_AUTH_CODE: 'code',
    MAIL_QQ_FOLDERS: 'INBOX,Junk',
    API_TOKEN: 'dev-token',
    MOCK: 'true',
  });
  assert.deepEqual(found, []);
});

test('回归：.env.example 里出现的每个键（含注释示例）都必须被认作合法，否则 doctor 会把模板变量误报成拼错', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
  const keys = [...new Set(
    text.split(/\r?\n/)
      .map((line) => line.match(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)[ \t]*=/)?.[1])
      .filter((k): k is string => Boolean(k)),
  )];
  assert.ok(keys.length >= 60, `应解析出足够多的键（含注释示例），实际 ${keys.length}`);
  const unknown = keys.filter((k) => !isKnownEnvKey(k));
  assert.deepEqual(unknown, [], `这些 .env.example 键未被认作合法：${unknown.join(', ')}`);
});


test('拼写提示文案：不承诺"会回退 Mock"（取决于同平台其他变量）', () => {
  const found = findSuspiciousEnvVars({ FEISHU_APPID: 'x' });
  assert.equal(found.length, 1);
  assert.match(found[0]!.reason, /不会被读取/);
  assert.match(found[0]!.reason, /是否回退 Mock 取决于同平台其他变量/);
  assert.ok(!/会静默回退 Mock/.test(found[0]!.reason));
});

test('身份能力新变量进入已知白名单（不会被误报为拼写错误）', () => {
  for (const key of [
    'FEISHU_IDENTITY', 'FEISHU_USER_RECEIVE', 'FEISHU_USER_RECEIVE_SECONDS',
    'FEISHU_USER_CHAT_LIMIT', 'FEISHU_USER_BACKFILL_HOURS', 'FEISHU_USER_STATE_FILE',
    'DINGTALK_IDENTITY', 'DINGTALK_USER_RECEIVE', 'DINGTALK_USER_EVENT_KINDS',
    'DWS_BIN', 'DWS_PROFILE', 'DWS_AUTH_TIMEOUT_MS', 'DWS_SEND_TIMEOUT_MS',
  ]) {
    assert.equal(isKnownEnvKey(key), true, `${key} 应在已知变量白名单里`);
  }
  // 拼错的 DWS 变量仍能被提示
  const typo = findSuspiciousEnvVars({ DWS_BINN: 'dws' });
  assert.equal(typo.length, 1);
  assert.equal(typo[0]!.suggestion, 'DWS_BIN');
});

test('LLM_BASE_URL 是 GUI 的兼容别名，不应再被当成拼错变量', () => {
  assert.equal(isKnownEnvKey('LLM_BASE_URL'), true);
  assert.equal(isKnownEnvKey('LLM_ENDPOINT'), true);
  assert.equal(findSuspiciousEnvVars({ LLM_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3' }).length, 0);
});
