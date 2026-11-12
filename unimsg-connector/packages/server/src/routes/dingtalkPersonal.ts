/**
 * 钉钉「本人身份」HTTP 接口（Bearer 鉴权，中文错误）：
 *
 *  - POST /api/dingtalk/personal/login  启动 dws 登录（后台 spawn，立即返回操作指引）
 *       body: { mode?: 'auto'|'browser'|'device', force?: boolean }
 *      默认 auto = 优先浏览器 loopback（本机推荐），失败回退设备码；
 *  - GET  /api/dingtalk/personal/status 登录状态（30s 缓存 + 超时，前端 2s 轮询安全）
 *       含 loginInProgress/loginMode/loginUrl/loginCode/loginExpiresAt/loginInstructions（供弹窗恢复，无 token）；
 *  - POST /api/dingtalk/personal/logout 注销本人身份（清缓存，账号页立刻变未连接）。
 *
 * 安全：接口只下发状态与指引，绝不返回 token；dws 不存在时回 400 中文安装指引。
 */
import { Router, type Request, type Response } from 'express';
import {
  dingtalkPersonalClient,
  DingtalkPersonalError,
} from '../connectors/dingtalkPersonal';
import type { LoginMode } from '../connectors/dingtalkPersonal';
import { dingtalkUserIdentity, peekDingtalkProfile } from '../services/identity';
import { reconcileIdentityChannels } from '../services/identityChannels';

interface DingtalkPersonalStatusData {
  available: boolean;
  version?: string;
  authenticated: boolean;
  state: 'unavailable' | 'not_linked' | 'linked' | 'expired' | 'error';
  displayName?: string;
  detail?: string;
  hint: string;
  loginCommand?: string;
  installHint?: string;
  /** 是否有进行中的登录流程（前端打开弹窗时据此恢复状态，而不是重新生成设备码） */
  loginInProgress: boolean;
  /** 进行中登录的实际通道 */
  loginMode?: 'browser' | 'device';
  /** 授权链接（browser=OAuth 127.0.0.1 回调页；device=设备码验证页） */
  loginUrl?: string;
  /** 设备码（仅 device 模式有） */
  loginCode?: string;
  /** 登录有效期（ISO；device=900s 默认，browser=600s 默认，以 dws 解析值为准） */
  loginExpiresAt?: string;
  /** 登录剩余有效秒数（便于前端倒计时，避免时钟偏差） */
  loginExpiresInSec?: number;
  /** 登录流程的操作指引原文（弹窗直接展示/恢复） */
  loginInstructions?: string;
  /** 进行中登录的唯一 ID：前端据此判断是否同一次流程 */
  loginId?: string;
}

/** 把 dws 调用错误映射成 HTTP 状态：可操作类（没装/参数/未登录）→ 400，其余 → 500 */
function statusForError(e: DingtalkPersonalError): number {
  return e.kind === 'not-installed' || e.kind === 'validation' || e.kind === 'not-logged-in' ? 400 : 500;
}

function sendError(res: Response, e: unknown): void {
  if (e instanceof DingtalkPersonalError) {
    res.status(statusForError(e)).json({ ok: false, error: e.message });
    return;
  }
  const message = e instanceof Error ? e.message : String(e);
  res.status(500).json({ ok: false, error: `钉钉本人身份操作失败：${message}` });
}

/** 组装状态响应（登录倒计时轮询用；不触发缓存外的网络调用） */
async function buildStatus(): Promise<DingtalkPersonalStatusData> {
  const client = dingtalkPersonalClient();
  const auth = await client.authStatus();
  const view = dingtalkUserIdentity();
  const profile = peekDingtalkProfile();
  const installHint = auth.available
    ? undefined
    : '未找到 dws 可执行文件：安装钉钉官方 CLI（下载 release 的 dws 可执行文件放到 PATH），'
      + '或把 .env 的 DWS_BIN 指向 dws.exe 完整路径（离线演示可设 DWS_BIN=node scripts/fake-dws.mjs）';
  const login = client.currentLogin();
  const loginExpiresInSec = login?.expiresAt
    ? Math.max(0, Math.round((new Date(login.expiresAt).getTime() - Date.now()) / 1000))
    : undefined;
  return {
    available: auth.available,
    ...(auth.version ? { version: auth.version } : {}),
    authenticated: auth.authenticated,
    state: view.state,
    ...(profile?.displayName ? { displayName: profile.displayName } : {}),
    ...(view.detail ? { detail: view.detail } : {}),
    hint: view.hint,
    ...(view.loginCommand ? { loginCommand: view.loginCommand } : {}),
    ...(installHint ? { installHint } : {}),
    loginInProgress: Boolean(login?.inProgress),
    ...(login?.mode ? { loginMode: login.mode } : {}),
    ...(login?.url ? { loginUrl: login.url } : {}),
    ...(login?.code ? { loginCode: login.code } : {}),
    ...(login?.expiresAt ? { loginExpiresAt: login.expiresAt } : {}),
    ...(loginExpiresInSec !== undefined ? { loginExpiresInSec } : {}),
    ...(login?.instructions ? { loginInstructions: login.instructions } : {}),
    ...(login?.loginId ? { loginId: login.loginId } : {}),
  };
}

export function dingtalkPersonalRouter(): Router {
  const r = Router();

  r.post('/dingtalk/personal/login', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { mode?: unknown; force?: unknown };
    const mode = body.mode === undefined || body.mode === null ? 'auto' : body.mode;
    if (mode !== 'auto' && mode !== 'browser' && mode !== 'device') {
      res.status(400).json({
        ok: false,
        error: "mode 只能是 auto（默认，优先浏览器）、browser（本机浏览器登录）或 device（设备码，远程/无浏览器）",
      });
      return;
    }
    if (body.force !== undefined && body.force !== null && typeof body.force !== 'boolean') {
      res.status(400).json({ ok: false, error: 'force 必须是布尔值（true = 强制重新发起登录，作废旧设备码）' });
      return;
    }
    try {
      const client = dingtalkPersonalClient();
      const started = await client.startLogin(mode as LoginMode, { force: body.force === true });
      // ② 登录流程一启动就对一次接收通道（登录完成后还会由回调/轮询再对齐）
      reconcileIdentityChannels('发起钉钉登录');
      res.json({ ok: true, data: started });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.get('/dingtalk/personal/status', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const client = dingtalkPersonalClient();
      const before = client.lastKnownStatus()?.authenticated;
      const data = await buildStatus();
      // ③ 运行中登录/注销后，前端轮询这里就会把接收通道对齐（无需重启后端）
      if (before !== undefined && before !== data.authenticated) {
        reconcileIdentityChannels(data.authenticated ? '检测到钉钉已登录' : '检测到钉钉已注销');
      }
      res.json({ ok: true, data });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.post('/dingtalk/personal/logout', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const client = dingtalkPersonalClient();
      await client.logout();
      // ⑤ 注销后停止本人身份接收通道
      reconcileIdentityChannels('钉钉已注销');
      res.json({ ok: true, data: { ok: true, authenticated: false } });
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}