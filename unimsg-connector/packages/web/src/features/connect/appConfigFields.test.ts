import { describe, expect, it } from 'vitest';
import {
  APP_CONFIG_GROUPS,
  findAppConfigGroup,
  maxLengthOf,
} from './appConfigFields';
import { APP_CONFIG_LLM_FIELD_KEYS, APP_CONFIG_PLATFORM_FIELD_KEYS } from '../../services/api';

describe('appConfigFields 契约对齐（二轮审计 P3 #6）', () => {
  it('长度上限与后端一致：robotCode 128、provider 64、verifyToken 512', () => {
    expect(maxLengthOf('robotCode')).toBe(128);
    expect(maxLengthOf('provider')).toBe(64);
    expect(maxLengthOf('verifyToken')).toBe(512);
    // 其他常见键保持原上限
    expect(maxLengthOf('appId')).toBe(128);
    expect(maxLengthOf('baseUrl')).toBe(512);
  });

  it('LLM API Key 的 envKey 是 LLM_API_KEY（不是 OPENAI_API_KEY）', () => {
    const llm = findAppConfigGroup('llm');
    expect(llm?.fields.find((f) => f.key === 'apiKey')?.envKey).toBe('LLM_API_KEY');
  });

  it('stream 字段为可选布尔开关，且与后端字段键一致', () => {
    const feishuStream = findAppConfigGroup('feishu')?.fields.find((f) => f.key === 'stream');
    const dingtalkStream = findAppConfigGroup('dingtalk')?.fields.find((f) => f.key === 'stream');
    expect(feishuStream).toMatchObject({ type: 'switch', optional: true, envKey: 'FEISHU_STREAM' });
    expect(dingtalkStream).toMatchObject({ type: 'switch', optional: true, envKey: 'DINGTALK_STREAM' });
    expect(APP_CONFIG_PLATFORM_FIELD_KEYS.feishu).toContain('stream');
    expect(APP_CONFIG_PLATFORM_FIELD_KEYS.dingtalk).toContain('stream');
    expect(APP_CONFIG_LLM_FIELD_KEYS).toEqual(['provider', 'apiKey', 'baseUrl', 'model']);
  });

  it('四组字段键与后端 PUT 契约一致（不丢可选键）', () => {
    const keys = Object.fromEntries(APP_CONFIG_GROUPS.map((group) => [group.id, group.fields.map((f) => f.key)]));
    expect(keys.feishu).toEqual(APP_CONFIG_PLATFORM_FIELD_KEYS.feishu);
    expect(keys.dingtalk).toEqual(APP_CONFIG_PLATFORM_FIELD_KEYS.dingtalk);
    expect(keys.wecom).toEqual(APP_CONFIG_PLATFORM_FIELD_KEYS.wecom);
    expect(keys.llm).toEqual(APP_CONFIG_LLM_FIELD_KEYS);
  });
});