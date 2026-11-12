/**
 * 本地应用配置（白号 P0）单测：路径/原子写/合并优先级（.env 显式优先）、脱敏视图、PUT 校验。
 * 全部使用临时目录，不写真实配置、不依赖网络。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOCAL_CONFIG_FALLBACK_NAME,
  LOCAL_CONFIG_FILE_NAME,
  applyConfigPatch,
  applyLocalConfigToEnv,
  buildAppConfigView,
  captureRestartBaseline,
  computeRestartRequired,
  localConfigFilePath,
  readLocalConfig,
  resetRestartBaselineForTests,
  sanitizeLocalConfig,
  writeLocalConfigFile,
} from './localConfig';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-local-config-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('路径：DATA_DIR 优先 linkhub-config.json；无 DATA_DIR → 仓库根 .linkhub-config.json', () => {
  assert.equal(localConfigFilePath('/repo', { DATA_DIR: 'C:\\data' }).replace(/\\/g, '/'), 'C:/data/' + LOCAL_CONFIG_FILE_NAME);
  assert.equal(localConfigFilePath('/repo', {}), join('/repo', LOCAL_CONFIG_FALLBACK_NAME));
});

test('启动合并：显式 env 优先，本地只补空；bool/enum 正确映射；userReceive 同时作用于飞书/钉钉', () => {
  const config = sanitizeLocalConfig({
    identity: { dingtalk: 'user', feishu: 'auto', userReceive: true },
    platforms: {
      feishu: { appId: 'cli_local', appSecret: 'local-secret' },
      dingtalk: { clientId: 'ding-local', clientSecret: 'secret-local' },
    },
    modes: { feishu: 'real' },
  });
  const env: NodeJS.ProcessEnv = {
    FEISHU_APP_ID: 'env-app-id', // 显式 env → 本地不得覆盖
    FEISHU_USER_RECEIVE: 'false',
    DINGTALK_IDENTITY: 'bot', // 显式 env 身份策略优先
  };
  const { applied } = applyLocalConfigToEnv(config, env);
  assert.equal(env.FEISHU_APP_ID, 'env-app-id', '.env 显式值优先');
  assert.equal(env.DINGTALK_CLIENT_ID, 'ding-local', '本地补空');
  assert.equal(env.FEISHU_APP_SECRET, 'local-secret');
  assert.equal(env.DINGTALK_IDENTITY, 'bot', 'env 身份策略优先');
  assert.equal(env.FEISHU_IDENTITY, 'auto');
  assert.equal(env.FEISHU_USER_RECEIVE, 'false', 'env 显式接收开关优先');
  assert.equal(env.DINGTALK_USER_RECEIVE, 'true', '本地 userReceive 补空');
  assert.equal(env.FEISHU_MODE, 'real');
  assert.ok(applied.includes('platforms.dingtalk.clientId'));
  assert.ok(!applied.includes('platforms.feishu.appId'), '被 env 抢占的字段不应计入 applied');
});

test('sanitize：未知分组/非法枚举被忽略；文件读写往返 + 损坏容错', () => {
  const sanitized = sanitizeLocalConfig({
    identity: { dingtalk: 'root' },
    platforms: { feishu: { appId: 'ok' }, unknown: { x: 1 } },
    modes: { feishu: 'invalid' },
    hack: true,
  });
  assert.equal(sanitized.identity?.dingtalk, undefined);
  assert.equal(sanitized.modes?.feishu, undefined);
  assert.equal(sanitized.platforms?.feishu?.appId, 'ok');

  const dir = tempDir();
  const file = join(dir, 'linkhub-config.json');
  const { config } = applyConfigPatch({ version: 1 }, {
    identity: { dingtalk: 'user' },
    platforms: { feishu: { appId: 'a'.repeat(10) } },
  });
  writeLocalConfigFile(file, config);
  assert.ok(existsSync(file));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.ok(raw.updatedAt);
  const read = readLocalConfig('/unused', { DATA_DIR: dir });
  assert.equal(read.config.identity?.dingtalk, 'user');
  assert.equal(read.config.platforms?.feishu?.appId, 'a'.repeat(10));

  writeFileSync(file, '{bad json', 'utf8');
  const broken = readLocalConfig('/unused', { DATA_DIR: dir });
  assert.equal(broken.exists, true);
  assert.ok(broken.error?.includes('读取失败') || broken.error?.includes('解析'));
});

test('PUT 补丁校验：未知键/非法枚举/超长 → errors；null/空串清除；env 显式优先进入 ignoredByEnv', () => {
  const base = sanitizeLocalConfig({ platforms: { feishu: { appId: 'old' } } });
  const unknown = applyConfigPatch(base, { platforms: { feishu: { appId: 'x', hacked: 'y' } } });
  assert.ok(unknown.errors.some((e) => e.includes('未知配置项')));
  assert.equal(unknown.errors.length, 1);

  const badEnum = applyConfigPatch(base, { identity: { dingtalk: 'robot' } });
  assert.ok(badEnum.errors.some((e) => e.includes('auto / bot / user')));

  const tooLong = applyConfigPatch(base, { platforms: { feishu: { appSecret: 'x'.repeat(600) } } });
  assert.ok(tooLong.errors.some((e) => e.includes('过长')));

  const clear = applyConfigPatch(base, { platforms: { feishu: { appId: null } } });
  assert.deepEqual(clear.errors, []);
  assert.ok(clear.changedKeys.includes('platforms.feishu.appId'));
  assert.equal(clear.config.platforms?.feishu?.appId, undefined);

  const envOccupied = applyConfigPatch(base, { platforms: { feishu: { appSecret: 'local' } } }, { FEISHU_APP_SECRET: 'env-value' });
  assert.ok(envOccupied.ignoredByEnv.includes('FEISHU_APP_SECRET'));
  assert.equal(envOccupied.config.platforms?.feishu?.appSecret, undefined, '.env 显式值时不再写本地（避免以为覆盖了）');

  const identityEnv = applyConfigPatch(base, { identity: { dingtalk: 'user' } }, { DINGTALK_IDENTITY: 'bot' });
  assert.ok(identityEnv.ignoredByEnv.includes('DINGTALK_IDENTITY'));
  assert.equal(identityEnv.config.identity?.dingtalk, 'user', '本地仍保存，供以后删 env 后使用');
});

test('GET 视图：secret 只给末 4 位、source=env/local/none，缺项给 missing 键名，restartRequired 用静态键基线', () => {
  resetRestartBaselineForTests();
  captureRestartBaseline({ version: 1 }); // 模拟进程启动基线：空
  const dir = tempDir();
  const file = join(dir, 'linkhub-config.json');
  writeLocalConfigFile(file, sanitizeLocalConfig({
    platforms: { feishu: { appId: 'cli_local_abcd', appSecret: 'local-secret-wxyz' } },
    identity: { dingtalk: 'user' },
  }));
  const view = buildAppConfigView({
    monorepoRoot: '/unused',
    env: { DATA_DIR: dir, FEISHU_APP_ID: 'cli_env_1234' },
    envFile: { path: '.env', mtime: new Date().toISOString() },
  });
  assert.equal(view.platforms.feishu.fields.appId!.source, 'env');
  assert.equal(view.platforms.feishu.fields.appId!.masked, '****1234');
  assert.equal(view.platforms.feishu.fields.appSecret!.source, 'local');
  assert.equal(view.platforms.feishu.fields.appSecret!.masked, '****wxyz');
  assert.equal(view.identity.dingtalk!.source, 'local');
  assert.equal(view.identity.dingtalk!.value, 'user');
  assert.equal(view.identity.feishu!.source, 'none');
  assert.equal(view.identity.feishu!.configured, false);
  assert.ok(view.platforms.feishu.missing.includes('FEISHU_APP_SECRET') === false, '已本地配置不算 missing');
  assert.ok(view.platforms.dingtalk.missing.length > 0);
  assert.equal(view.restartRequired, true, '静态键（凭据）相对启动基线有变化 → 需要重启');
  assert.ok(view.settingsFile.present);
  assert.equal(view.settingsFile.path, 'linkhub-config.json', 'P3：认证接口只给 basename');

  const text = JSON.stringify(view);
  assert.ok(!text.includes('local-secret-wxyz'), 'GET 视图绝不能含 secret 明文');
  assert.ok(!text.includes('cli_local_abcd'));

  // 模拟「重启」：用当前静态配置重新拍基线 → 不需要重启
  captureRestartBaseline(readLocalConfig('/unused', { DATA_DIR: dir }).config);
  const view2 = buildAppConfigView({ monorepoRoot: '/unused', env: { DATA_DIR: dir } });
  assert.equal(view2.restartRequired, false, '重启后基线更新 → false');
});

test('restartRequired（P1-1）：identity 热应用不算；静态键变化才算；清除回基线/重启后为 false', () => {
  resetRestartBaselineForTests();
  captureRestartBaseline({ version: 1 }); // 进程启动基线：空
  const env = {} as NodeJS.ProcessEnv;

  const identityOnly = applyConfigPatch({ version: 1 }, { identity: { dingtalk: 'user' } });
  assert.equal(computeRestartRequired('/unused', env, identityOnly.config), false, 'identity.* 热应用不触发重启');

  const withCreds = applyConfigPatch(identityOnly.config, { platforms: { feishu: { appId: 'cli_x' } } });
  assert.equal(computeRestartRequired('/unused', env, withCreds.config), true, '凭据属于静态键 → 需要重启');

  const cleared = applyConfigPatch(withCreds.config, { platforms: { feishu: { appId: null } } });
  assert.equal(computeRestartRequired('/unused', env, cleared.config), false, '清除回启动基线 → 不再需要重启');

  // 模拟重启：以变化后的静态配置为新基线
  captureRestartBaseline(withCreds.config);
  assert.equal(computeRestartRequired('/unused', env, withCreds.config), false, '重启后基线更新 → false');

  // 模式（modes.*）也是静态键
  const modeChange = applyConfigPatch(withCreds.config, { modes: { mail: 'real' } });
  assert.equal(computeRestartRequired('/unused', env, modeChange.config), true);
});