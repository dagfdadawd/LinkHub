/**
 * 飞书用户身份授权路由：
 *  - POST /api/feishu/oauth/start（Bearer）：生成一次性 state，返回飞书授权页 URL；
 *  - GET  /api/feishu/oauth/callback（公共）：校验 state，用 code 换 user_access_token，
 *    令牌落盘后返回一个可自动关闭的中文结果页。
 *
 * 安全：state 一次性、10 分钟过期；回调页绝不回显 code / access_token / refresh_token。
 */
import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { feishuUserAuth, type FeishuUserTokenStatus } from '../connectors/feishuUserAuth';
import { config } from '../config';

const STATE_TTL_MS = 10 * 60_000;
const pendingStates = new Map<string, number>();

function pruneStates(now = Date.now()): void {
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(state);
  }
}

function issueState(): string {
  const now = Date.now();
  pruneStates(now);
  const state = randomBytes(24).toString('base64url');
  pendingStates.set(state, now + STATE_TTL_MS);
  return state;
}

function consumeState(state: string): boolean {
  pruneStates();
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(expiresAt && expiresAt > Date.now());
}

/** 单测用：清空进行中的授权 state */
export function resetFeishuOAuthStates(): void {
  pendingStates.clear();
}

function queryString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(iso?: string): string {
  if (!iso) return '未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function pageShell(title: string, tone: 'ok' | 'error', inner: string, autoClose: boolean): string {
  const accent = tone === 'ok' ? '#22c55e' : '#ef4444';
  const icon = tone === 'ok' ? '✓' : '!';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{width:min(560px,calc(100vw - 48px));background:#111c33;border:1px solid #24324d;border-radius:16px;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
  .icon{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${accent}22;color:${accent};font-size:26px;font-weight:700;margin-bottom:16px}
  h1{font-size:22px;margin:0 0 12px}
  p{line-height:1.75;margin:8px 0;color:#cbd5e1}
  .muted{color:#94a3b8;font-size:13px}
  .hint{margin-top:16px;padding:12px 14px;background:#1e293b;border-left:3px solid ${accent};border-radius:8px;color:#e2e8f0;font-size:14px;line-height:1.7}
  code{background:#0b1220;padding:2px 6px;border-radius:4px;font-size:12px}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    ${inner}
  </div>
  ${autoClose ? '<script>setTimeout(function(){window.close();},1500);</script>' : ''}
</body>
</html>`;
}

function successPage(status: FeishuUserTokenStatus): string {
  return pageShell('飞书用户身份连接成功', 'ok', `
    <p>后续从 LinkHub 回写到飞书的消息，将以<strong>你本人</strong>的身份发出。</p>
    <p class="muted">access_token 有效至：${escapeHtml(formatTime(status.accessExpiresAt))}</p>
    <p class="muted">refresh_token 有效至：${escapeHtml(formatTime(status.refreshExpiresAt))}</p>
    <p class="muted">本页会自动关闭；若未关闭，请返回 LinkHub 账号页并刷新。</p>
  `, true);
}

function hintForError(message: string): string {
  if (/20027|permission|权限/i.test(message)) {
    return '请在飞书开放平台「权限管理 → 用户身份权限」开通 im:message、im:message.send_as_user、im:resource，并发布应用版本后再试。';
  }
  if (/20010/.test(message)) {
    return '当前飞书账号不在应用可用范围内：请让企业管理员把你的账号加入应用可用范围。';
  }
  if (/redirect_uri|20029/i.test(message)) {
    return `回调地址与飞书后台登记不一致：请把 ${config.feishuAuth.redirectUri} 原样填入「安全设置 → 重定向 URL」。`;
  }
  if (/invalid_grant|code expired|authorization code|授权码/i.test(message)) {
    return '授权码已过期或已被使用：请回到 LinkHub「平台账号」页，重新点击「连接本人账号」。';
  }
  return '请检查飞书后台的权限、重定向 URL 与「刷新 user_access_token」开关，然后重新授权。';
}

function failurePage(title: string, message: string, hint: string): string {
  return pageShell(title, 'error', `
    <p>${escapeHtml(message)}</p>
    <div class="hint">${escapeHtml(hint)}</div>
    <p class="muted">关闭本页，回到 LinkHub 账号页重试即可。</p>
  `, false);
}

function sendHtml(res: Response, statusCode: number, html: string): void {
  res.status(statusCode).type('html').send(html);
}

/** 公共回调路由：必须挂在 apiAuth 之前（浏览器跳转带不了 Bearer） */
export function feishuOAuthCallbackRouter(): Router {
  const r = Router();

  r.get('/feishu/oauth/callback', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const oauthError = queryString(req.query.error);
    if (oauthError) {
      const description = queryString(req.query.error_description);
      const message = oauthError === 'access_denied'
        ? '你取消了飞书授权。'
        : `飞书返回授权错误：${oauthError}${description ? `（${description}）` : ''}`;
      sendHtml(res, 400, failurePage('授权未完成', message, '需要发送身份时再点一次「连接本人账号」即可。'));
      return;
    }

    const state = queryString(req.query.state);
    if (!state || !consumeState(state)) {
      sendHtml(res, 400, failurePage(
        '授权状态无效或已过期',
        '本次授权链接已失效（有效期 10 分钟，且只能使用一次）。',
        '请回到 LinkHub「平台账号」页，重新点击「连接本人账号」。',
      ));
      return;
    }

    const code = queryString(req.query.code);
    if (!code) {
      sendHtml(res, 400, failurePage(
        '缺少授权码',
        '飞书回调没有携带 code，无法换取用户令牌。',
        '请回到 LinkHub 账号页重新发起授权。',
      ));
      return;
    }

    try {
      const status = await feishuUserAuth().exchange(code);
      sendHtml(res, 200, successPage(status));
      console.log('[feishu-oauth] 用户身份授权成功（令牌已落盘）');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 只记录错误摘要，绝不记录 code / token
      console.warn('[feishu-oauth] 用户身份授权失败:', message);
      sendHtml(res, 400, failurePage('授权失败', message, hintForError(message)));
    }
  });

  return r;
}

/** 受 Bearer 保护的授权启动路由 */
export function feishuOAuthRouter(): Router {
  const r = Router();

  r.post('/feishu/oauth/start', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const auth = feishuUserAuth();
    if (!auth.canAuthorize()) {
      res.status(400).json({
        ok: false,
        error: 'FEISHU_APP_ID / FEISHU_APP_SECRET 未配置，无法发起飞书用户授权',
      });
      return;
    }
    const state = issueState();
    res.json({
      ok: true,
      data: {
        url: auth.authorizeUrl(state),
        redirectUri: auth.redirectUri,
      },
    });
  });

  return r;
}