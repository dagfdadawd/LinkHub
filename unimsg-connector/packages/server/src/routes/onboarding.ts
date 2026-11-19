/**
 * `GET /api/onboarding`：授权中心 / 首次使用向导的聚合视图（Bearer 鉴权）。
 *
 * 只读聚合，**不触发慢网络调用**：
 *  - 身份视图取进程内缓存（dws 未探测时后台预热，下次请求就有版本/登录态）；
 *  - 邮箱账号取本地/环境配置并脱敏；
 *  - 微信仅在 WECHAT_MODE=real 时探测本机 RPA 桥（`GET /health`，1.2s 上限、5s 缓存）：
 *    "配了 real" 不等于 "桥活着且在 rpa 模式"，不给 ready 就是不给假成功；
 *  - 响应绝不包含 token / 授权码 / 密钥。
 */
import { basename } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { Platform } from '@unimsg/shared';
import { config, envFileSnapshot } from '../config';
import { modeOf } from '../config';
import { dingtalkPersonalClient } from '../connectors/dingtalkPersonal';
import { identityChannelsReal, resolveIdentity } from '../services/identity';
import { buildOnboarding } from '../services/onboarding';
import { shouldProbeWechatBridge, wechatBridgeStatus } from '../services/wechatBridge';
import { currentMailAccounts } from '../services/mailAccounts';

/** 飞书未显式配置重定向 URL 时，给个人版一个本机默认值（与 OAuth 路由保持一致的默认） */
function defaultFeishuRedirectUri(): string {
  const explicit = (config.feishuAuth.redirectUri ?? '').trim();
  if (explicit) return explicit;
  return `http://127.0.0.1:${config.port}/api/feishu/oauth/callback`;
}

/** 构造 onboarding 依赖（路由与单测共用；单测可直接替换 buildOnboarding） */
export async function collectOnboardingDeps() {
  const client = dingtalkPersonalClient();
  const cached = client.lastKnownStatus();
  // 没有缓存时后台预热（不阻塞本次响应）：下次刷新就能看到 dws 版本/登录态
  if (!cached) void client.warmStatus().catch(() => undefined);
  const source = config.identity.dingtalk.binSource ?? 'env';
  const dws = {
    available: source !== 'missing' && cached?.available !== false,
    ...(cached?.version ? { version: cached.version } : {}),
    source,
    ...(config.identity.dingtalk.binPathHint ? { pathHint: config.identity.dingtalk.binPathHint } : {}),
  };
  const mail = currentMailAccounts().snapshot();
  const feishuView = resolveIdentity(Platform.FEISHU);
  const dingtalkView = resolveIdentity(Platform.DINGTALK);
  return {
    envFile: (() => {
      const snapshot = envFileSnapshot();
      return snapshot ? { path: '.env', mtime: snapshot.mtime } : null;
    })(),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    mail: {
      accounts: mail.masked,
      // P3：认证接口只给 basename，不暴露本机绝对路径
      filePath: basename(mail.filePath),
      issues: mail.issues,
      mode: modeOf(Platform.MAIL),
      policy: config.runtime[Platform.MAIL].policy,
      pollSeconds: Math.max(5, Math.round(config.mail.pollMs / 1000)),
    },
    dingtalk: {
      view: dingtalkView,
      runtime: config.runtime[Platform.DINGTALK],
      dws,
      // personal-only 时 identityChannelsReal=true（白号最顺路径：仅本人身份）
      identityChannelsReal: identityChannelsReal(Platform.DINGTALK),
    },
    feishu: {
      view: feishuView,
      runtime: config.runtime[Platform.FEISHU],
      scopes: config.feishuAuth.scopes,
      redirectUri: defaultFeishuRedirectUri(),
      identityChannelsReal: identityChannelsReal(Platform.FEISHU),
    },
    wechat: {
      runtime: config.runtime[Platform.WECHAT],
      // 只有真的配了 real 才值得戳桥；mock 下探测没意义（也不会因此变 ready）
      bridge: shouldProbeWechatBridge() ? await wechatBridgeStatus({ timeoutMs: 1200, maxAgeMs: 5000 }) : null,
    },
    port: config.port,
  };
}

export function onboardingRouter() {
  const r = Router();

  r.get('/onboarding', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(buildOnboarding(await collectOnboardingDeps()));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: `生成连接账号视图失败：${message}` });
    }
  });

  return r;
}
