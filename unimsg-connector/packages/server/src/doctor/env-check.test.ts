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
  assert.equal(suggestEnvKey('WECOM_CORP_ID_TYPO_TOTALLY_DIFFERENT'), undefined);
});

test('findSuspiciousEnvVars：只报本项目的、非空的、未知变量', () => {
  const found = findSuspiciousEnvVars({
    PATH: '/usr/bin',
    HOME: '/root',
    FEISHU_APPID: 'cli_xxx',
    MAIL_QQ_ADRESS: 'me@qq.com',
    WECOM_AGENT_IDD: '1000002',
    LLM_API_KEY: 'sk-real', // 合法，不该报
    MAIL_WORK_EMAIL: '', // 空值，跳过
    UNRELATED_VAR: 'x',
  });
  assert.deepEqual(found.map((f) => f.name), ['FEISHU_APPID', 'MAIL_QQ_ADRESS', 'WECOM_AGENT_IDD']);
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
    WECOM_CORP_ID: 'ww1',
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
