/**
 * 本地应用配置 HTTP 接口（白号 P0：不手改 .env 也能填平台凭据 / 切身份模式 / 切运行模式）。
 *
 *  - GET /api/app-config：脱敏视图（密钥只给 configured + 末 4 位；缺的给环境变量名；标来源 env/local/none）
 *  - PUT /api/app-config：部分更新 → 写 DATA_DIR/linkhub-config.json（原子写、chmod 600）→ 需重启生效
 *
 * 安全：
 *  - 绝不返回任何密钥明文（secret 只回末 4 位）；
 *  - 显式 .env 值优先：GUI 不能覆盖运维已写的 env，这些键会在响应里列入 ignoredByEnv；
 *  - 保存后 restartRequired=true（config 只在启动时解析）。
 */
import { Router, type Request, type Response } from 'express';
import { basename } from 'node:path';
import { config, envFileSnapshot, monorepoRoot } from '../config';
import { reconcileIdentityChannels } from '../services/identityChannels';
import {
  applyConfigPatch,
  buildAppConfigView,
  computeRestartRequired,
  localConfigFilePath,
  readLocalConfig,
  writeLocalConfigFile,
  type LocalConfig,
} from '../services/localConfig';

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

/**
 * 身份策略「热应用」（白号最顺路径）：登录前把 identity.dingtalk='user' 直接写入运行中的 config，
 * 使 identityChannelsReal / resolveIdentity 立刻按「仅本人身份」工作（无需重启）。
 * 凭据/模式等其它键仍然需要重启。返回真正热应用的键。
 */
function hotApplyIdentity(local: LocalConfig, changedKeys: string[]): string[] {
  const applied: string[] = [];
  const identityKeys = changedKeys.filter((key) => key.startsWith('identity.'));
  for (const key of identityKeys) {
    if (key === 'identity.feishu') {
      if ((process.env.FEISHU_IDENTITY ?? '').trim()) continue; // env 显式优先
      const value = local.identity?.feishu;
      if (value) {
        config.identity.feishu.policy = value;
        applied.push(key);
      }
    } else if (key === 'identity.dingtalk') {
      if ((process.env.DINGTALK_IDENTITY ?? '').trim()) continue;
      const value = local.identity?.dingtalk;
      if (value) {
        config.identity.dingtalk.policy = value;
        applied.push(key);
      }
    } else if (key === 'identity.userReceive') {
      const value = local.identity?.userReceive;
      if (typeof value !== 'boolean') continue;
      const feishuEnv = (process.env.FEISHU_USER_RECEIVE ?? '').trim();
      const dingtalkEnv = (process.env.DINGTALK_USER_RECEIVE ?? '').trim();
      if (feishuEnv) config.identity.feishu.receive = feishuEnv === 'true' || feishuEnv === '1';
      else config.identity.feishu.receive = value;
      if (dingtalkEnv) config.identity.dingtalk.receive = dingtalkEnv === 'true' || dingtalkEnv === '1';
      else config.identity.dingtalk.receive = value;
      applied.push(key);
    }
  }
  if (applied.length > 0) {
    // 立刻让接收通道协调器按新身份对齐（无需等重启/兜底定时器）
    reconcileIdentityChannels('身份设置热应用');
  }
  return applied;
}

export function appConfigRouter() {
  const r = Router();

  r.get('/app-config', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const envFile = envFileSnapshot();
      const view = buildAppConfigView({
        monorepoRoot,
        env: process.env,
        // P3：认证接口只给 basename（与公开 health 一致）
        envFile: envFile ? { path: '.env', mtime: envFile.mtime } : null,
      });
      res.json({ ok: true, data: view });
    } catch (e) {
      sendError(res, 500, `读取本地配置失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  r.put('/app-config', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body;
    try {
      const local = readLocalConfig(monorepoRoot);
      if (local.error) {
        // 文件损坏：仍然允许写入（覆盖修复），但提示用户
        console.warn(`[unimsg] ${local.error}`);
      }
      const result = applyConfigPatch(local.config, body);
      // 用户显式修改身份策略 → 清掉「登录成功后自动启用」标记（注销时不再自动回退用户手写的 user）
      if (result.changedKeys.includes('identity.dingtalk') && result.config.identity) {
        delete result.config.identity.dingtalkAutoApplied;
      }
      if (result.errors.length > 0) {
        sendError(res, 400, result.errors.join('；'));
        return;
      }
      if (result.changedKeys.length === 0 && result.ignoredByEnv.length === 0) {
        sendError(res, 400, '没有需要保存的配置项（请提供 identity / platforms / modes / llm 下的字段）');
        return;
      }
      const file = localConfigFilePath(monorepoRoot);
      let mtime: string | undefined;
      if (result.changedKeys.length > 0) {
        mtime = writeLocalConfigFile(file, result.config).mtime;
      }
      const effective = result.changedKeys.length > 0;
      const warnings: string[] = [];
      if (result.ignoredByEnv.length > 0) {
        warnings.push(
          `以下配置已在 .env 显式设置，GUI 修改不会生效（如需改请直接改 .env 并重启）：${result.ignoredByEnv.join(' / ')}`,
        );
      }
      if (!effective && result.ignoredByEnv.length > 0) {
        res.json({
          ok: true,
          data: {
            saved: false,
            hotApplied: false,
            restartRequired: false,
            changedKeys: [],
            hotAppliedKeys: [],
            ignoredByEnv: [...new Set(result.ignoredByEnv)],
            warnings,
            message: '这些配置都来自 .env 显式设置，本次没有写入本地文件。',
            settingsFile: { path: basename(file), mtime: mtime ?? null },
          },
        });
        return;
      }
      // 身份策略可以热应用（登录前切「仅本人身份」无需重启）；凭据/模式写盘后按「静态键 vs 启动基线」判断是否真的需要重启
      const hotAppliedKeys = hotApplyIdentity(result.config, result.changedKeys);
      const staticKeys = result.changedKeys.filter((key) => !key.startsWith('identity.'));
      const restartRequired = staticKeys.length > 0 ? computeRestartRequired(monorepoRoot, process.env) : false;
      res.json({
        ok: true,
        data: {
          saved: true,
          hotApplied: hotAppliedKeys.length > 0,
          hotAppliedKeys,
          // 只有 identity.* 变更时不需要重启；含凭据/模式变更则必须重启
          restartRequired,
          changedKeys: result.changedKeys,
          staticKeys,
          ignoredByEnv: [...new Set(result.ignoredByEnv)],
          warnings,
          message: restartRequired
            ? '已保存到本地配置：身份策略已立即生效；凭据/模式变更需要重启 LinkHub 后生效。'
            : hotAppliedKeys.length > 0
              ? '身份策略已保存并立即生效（无需重启）；长期有效，重启后仍保留。'
              : '已保存到本地配置（与启动基线一致，无需重启）。',
          settingsFile: { path: basename(file), mtime: mtime ?? null },
          savedAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      sendError(res, 500, `保存本地配置失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return r;
}

/** 供其它路由/doctor 使用：当前进程实际使用的配置来源提示（不含密钥） */
export function configSourcesHint(): string {
  const file = localConfigFilePath(monorepoRoot);
  return `本地配置：${file}；.env 显式值优先（${config.port} 端口实例）`;
}