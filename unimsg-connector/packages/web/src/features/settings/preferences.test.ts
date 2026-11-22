/**
 * 偏好持久化单测：sanitize 对新消息提醒维度的兜底——非法值一律回落默认，
 * 平台静音表去重且只认合法平台值；保证坏数据进不来、旧行为不被破坏。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  patchPreferences,
  resetPreferences,
  savePreferences,
} from './preferences';
import { Platform } from '../../types';

afterEach(() => {
  resetPreferences();
  window.localStorage.clear();
});

describe('preferences sanitize（新消息提醒维度）', () => {
  it('默认：级别仅紧急、无平台静音、免打扰关', () => {
    expect(DEFAULT_PREFERENCES.alertLevel).toBe('urgent');
    expect(DEFAULT_PREFERENCES.alertMutedPlatforms).toEqual([]);
    expect(DEFAULT_PREFERENCES.dndEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.dndFrom).toBe('22:00');
    expect(DEFAULT_PREFERENCES.dndTo).toBe('08:00');
  });

  it('非法级别 / 非法平台 / 非法时间串一律回落默认', () => {
    savePreferences({
      ...DEFAULT_PREFERENCES,
      alertLevel: 'loud' as never,
      alertMutedPlatforms: ['nope', 42, Platform.MAIL] as never,
      dndEnabled: 'yes' as never,
      dndFrom: '25:00',
      dndTo: '8am',
    });
    const prefs = getPreferences();
    expect(prefs.alertLevel).toBe('urgent');
    expect(prefs.alertMutedPlatforms).toEqual([Platform.MAIL]);
    expect(prefs.dndEnabled).toBe(false);
    expect(prefs.dndFrom).toBe('22:00');
    expect(prefs.dndTo).toBe('08:00');
  });

  it('平台静音表去重；合法值原样保留', () => {
    savePreferences({
      ...DEFAULT_PREFERENCES,
      alertMutedPlatforms: [Platform.MAIL, Platform.MAIL, Platform.WECHAT],
    });
    expect(getPreferences().alertMutedPlatforms).toEqual([Platform.MAIL, Platform.WECHAT]);
  });

  it('patchPreferences 合并写入，其余字段不受影响', () => {
    patchPreferences({ alertLevel: 'all', dndEnabled: true });
    const prefs = getPreferences();
    expect(prefs.alertLevel).toBe('all');
    expect(prefs.dndEnabled).toBe(true);
    expect(prefs.urgentSound).toBe(true); // 未触及的字段保持默认
  });
});
