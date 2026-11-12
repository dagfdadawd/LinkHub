import { describe, expect, it } from 'vitest';
import { checkEnvRestart, ENV_RESTART_TOLERANCE_MS } from './envRestart';

const startedAt = '2026-11-12T01:00:00.000Z';
const path = 'C:\\proj\\unimsg-connector\\.env';

describe('checkEnvRestart（.env 改了但没重启）', () => {
  it('旧后端缺字段 / 没有 .env / 时间非法：一律不提示，避免误伤', () => {
    expect(checkEnvRestart(null)).toEqual({ needed: false });
    expect(checkEnvRestart(undefined)).toEqual({ needed: false });
    expect(checkEnvRestart({ startedAt, envFile: null })).toEqual({ needed: false });
    expect(checkEnvRestart({ startedAt, envFile: { path, mtime: 'not-a-date' } })).toEqual({
      needed: false,
    });
    expect(checkEnvRestart({ startedAt: 'bad', envFile: { path, mtime: startedAt } })).toEqual({
      needed: false,
    });
  });

  it('.env 修改时间晚于启动时间：提示需要重启', () => {
    const result = checkEnvRestart({
      startedAt,
      envFile: { path, mtime: '2026-11-12T01:05:00.000Z' },
    });
    expect(result.needed).toBe(true);
    expect(result.envMtime).toBe(Date.parse('2026-11-12T01:05:00.000Z'));
    expect(result.startedAt).toBe(Date.parse(startedAt));
  });

  it('同一秒内的时钟抖动（≤ 容差）不算修改', () => {
    const mtime = new Date(Date.parse(startedAt) + ENV_RESTART_TOLERANCE_MS).toISOString();
    expect(checkEnvRestart({ startedAt, envFile: { path, mtime } }).needed).toBe(false);
  });

  it('.env 早于启动时间（启动后才读到它）：不提示', () => {
    expect(
      checkEnvRestart({
        startedAt,
        envFile: { path, mtime: '2026-11-11T23:00:00.000Z' },
      }).needed,
    ).toBe(false);
  });
});
describe('checkEnvRestart 只对 .env（二轮审计 P1-1）', () => {
  it('settingsFile（本地配置）更新不再触发重启提示，以 app-config.restartRequired 为准', () => {
    const input = {
      startedAt,
      envFile: { path, mtime: '2026-11-11T23:00:00.000Z' },
      settingsFile: { path: 'linkhub-config.json', mtime: '2026-11-12T01:10:00.000Z' },
    } as unknown as Parameters<typeof checkEnvRestart>[0];
    expect(checkEnvRestart(input).needed).toBe(false);
  });
});
