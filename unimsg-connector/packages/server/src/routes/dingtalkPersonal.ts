/**
 * 钉钉「本人身份」HTTP 接口（Bearer 鉴权，中文错误）：
 *
 *  - POST /api/dingtalk/personal/login  启动 dws 登录（后台 spawn，立即返回操作指引）；
 *  - GET  /api/dingtalk/personal/status 登录状态（30s 缓存 + 超时，前端 2s 轮询安全）；
 *  - POST /api/dingtalk/personal/logout 注销本人身份（清缓存，账号页立刻变未连接）。
 *
 * 安全：接口只下发状态与指引，绝不返回 token；dws 不存在时回 400 中文安装指引。
 */
import { Router, type Request, type Response } from 'express';
import {
  dingtalkPersonalClient,
  DingtalkPersonalError,
} from '../connectors/dingtalkPersonal';
import { dingtalkUserIdentity, peekDingtalkProfile } from '../services/identity';

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
  };
}

export function dingtalkPersonalRouter(): Router {
  const r = Router();

  r.post('/dingtalk/personal/login', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const client = dingtalkPersonalClient();
      const started = await client.startLogin();
      res.json({ ok: true, data: started });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.get('/dingtalk/personal/status', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const data = await buildStatus();
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
      res.json({ ok: true, data: { ok: true, authenticated: false } });
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}