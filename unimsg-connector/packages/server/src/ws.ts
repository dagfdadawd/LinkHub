/**
 * WebSocket 实时推送：新消息、状态变更即时下发前端。
 *
 * 鉴权与 REST 一致，两种凭证都接受：
 *  1. 账号会话令牌（登录后颁发，带「我是谁」→ 只收自己名下的消息）；
 *  2. 部署令牌 API_TOKEN（单机演示 / 旧客户端，无用户身份 → 全量视图）。
 *
 * 历史坑（已修）：这里曾经只比对 `config.apiToken`，而前端登录后带的是会话令牌，
 * 于是「一登录实时通道就被 1008 踢掉」，页面永远停在离线、新消息只能靠手动刷新。
 * 两条通道必须同时认；广播也必须按归属过滤，否则修好鉴权后会立刻变成跨账号推送泄漏。
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { config } from './config';
import { loginRequired, resolveApiToken } from './middlewares/auth';
import { userStore } from './services/users';

export interface WsEvent {
  type: string;
  data?: unknown;
}

/** 连接 → 登录用户 id（部署令牌连接为 undefined，代表全量视图） */
const socketUserId = new Map<WebSocket, string | undefined>();

let wss: WebSocketServer | null = null;

/**
 * 握手鉴权。返回 `{ userId }` 表示放行（userId 缺省 = 部署令牌，全量视图）；
 * 返回 `null` 表示拒绝。
 */
export function authorizeWsToken(token: string): { userId?: string } | null {
  const provided = (token ?? '').trim();
  if (!provided) return null;

  // 1) 部署令牌：只有"不要求登录"时才放行（否则隔离可被 dev-token 直接绕过）
  if (provided === resolveApiToken(config.apiToken) && !loginRequired()) {
    return {};
  }

  // 2) 账号会话令牌：带上「我是谁」，广播据此过滤
  const user = userStore().resolveSession(provided);
  if (user) return { userId: user.id };

  return null;
}

export function initWs(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const verdict = authorizeWsToken(url.searchParams.get('token') ?? '');
    if (!verdict) {
      // 1008 = policy violation：前端据此停止重连，直接显示"未授权"
      ws.close(1008, 'unauthorized');
      return;
    }
    socketUserId.set(ws, verdict.userId);
    ws.on('close', () => socketUserId.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', ts: new Date().toISOString() }));
  });
  return wss;
}

/** 事件里携带的消息归属（signal 类事件没有 ownerId → undefined = 广播给所有人） */
function eventOwner(event: WsEvent): string | undefined {
  const data = event.data as { ownerId?: unknown } | undefined;
  return typeof data?.ownerId === 'string' ? data.ownerId : undefined;
}

export function wsBroadcast(event: WsEvent): void {
  if (!wss) return;
  const payload = JSON.stringify(event);
  const owner = eventOwner(event);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const userId = socketUserId.get(client);
    // 登录连接只收自己的消息；带 ownerId 的事件绝不发给别的账号
    if (owner && userId && userId !== owner) continue;
    client.send(payload);
  }
}

/** 当前连接数 / 其中已登录的数量（排错与 /api/health 用） */
export function wsStats(): { total: number; authenticated: number } {
  let total = 0;
  let authenticated = 0;
  for (const client of wss?.clients ?? []) {
    if (client.readyState !== WebSocket.OPEN) continue;
    total += 1;
    if (socketUserId.get(client)) authenticated += 1;
  }
  return { total, authenticated };
}

/** 单测用：断开所有连接并清空登记表 */
export function resetWsForTest(): void {
  for (const client of wss?.clients ?? []) client.terminate();
  socketUserId.clear();
  wss = null;
}