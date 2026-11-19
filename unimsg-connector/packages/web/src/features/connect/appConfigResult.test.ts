import { describe, expect, it } from 'vitest';
import { formatIgnoredByEnv, interpretAppConfigSave } from './appConfigResult';
import type { AppConfigSaveResult } from '../../services/api';

function result(patch: Partial<AppConfigSaveResult> = {}): AppConfigSaveResult {
  return {
    saved: true,
    restartRequired: false,
    changedKeys: ['platforms.feishu.appId'],
    ...patch,
  };
}

describe('interpretAppConfigSave（二轮审计 P1-2：不静默假成功）', () => {
  it('identity-only + hotApplied:true → applied，提示已立即生效（无需重启）', () => {
    const outcome = interpretAppConfigSave(
      result({ hotApplied: true, hotAppliedKeys: ['identity.dingtalk'], changedKeys: ['identity.dingtalk'] }),
    );
    expect(outcome).toMatchObject({ status: 'applied', message: '已立即生效（无需重启）' });
  });

  it('identity-only + hotApplied:false（.env 锁定）→ ignored，绝不返回成功', () => {
    const outcome = interpretAppConfigSave(
      result({
        hotApplied: false,
        ignoredByEnv: ['DINGTALK_IDENTITY'],
        changedKeys: ['identity.dingtalk'],
      }),
    );
    expect(outcome.status).toBe('ignored');
    expect(outcome.message).toContain('以下配置来自 .env，页面不能覆盖：钉钉身份策略');
  });

  it('saved:false → failed（有 ignoredByEnv 时为 ignored），消息里带原因', () => {
    expect(interpretAppConfigSave(result({ saved: false, message: '未知配置项' }))).toMatchObject({
      status: 'failed',
      message: '未知配置项',
    });
    expect(
      interpretAppConfigSave(result({ saved: false, ignoredByEnv: ['FEISHU_APP_ID'] })).status,
    ).toBe('ignored');
  });

  it('凭据类 restartRequired:true → restart（保存成功但需重启，不清空 ignored 信息）', () => {
    const outcome = interpretAppConfigSave(
      result({
        restartRequired: true,
        hotApplied: false,
        changedKeys: ['platforms.feishu.appId'],
      }),
    );
    expect(outcome.status).toBe('restart');
  });

  it('ignoredByEnv 非空即使其余保存成功也判 ignored，并逐键列出', () => {
    const outcome = interpretAppConfigSave(
      result({
        ignoredByEnv: ['DINGTALK_CLIENT_ID'],
        changedKeys: ['platforms.dingtalk.clientId'],
      }),
    );
    expect(outcome.status).toBe('ignored');
    expect(outcome.ignoredByEnv).toEqual(['DINGTALK_CLIENT_ID']);
    expect(outcome.message).toContain('钉钉 Client ID');
  });

  it('静态键保存但 hotApplied:false 且无需重启 → ignored（不声称已生效）', () => {
    const outcome = interpretAppConfigSave(
      result({ hotApplied: false, changedKeys: ['platforms.wechat.bridgeUrl'] }),
    );
    expect(outcome.status).toBe('ignored');
  });

  it('formatIgnoredByEnv 空列表给通用指引，不出现空冒号', () => {
    expect(formatIgnoredByEnv([])).not.toContain('：；');
    expect(formatIgnoredByEnv(['A', 'B'])).toContain('A、B');
  });
});
