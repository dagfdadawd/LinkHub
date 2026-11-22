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

/**
 * 心跳周期。两层作用：
 *  1. 协议层 ping/pong：回收服务端视角已死、但 TCP 还没断的连接；
 *  2. 应用层 heartbeat 帧：浏览器 JS 读不到协议层 ping/pong，前端靠它判断
 *     「链路还活着」，从而发现半开断链（合盖、切网）并主动重连。
 * 25s 是「足够便宜 + 75s 内能发现断链」的折中；前端阈值默认取 3 个周期。
 */
export const WS_HEARTBEAT_MS = 25_000;

/** 连接 → 上一轮 ping 之后是否回过 pong */
const socketAlive = new WeakMap<WebSocket, boolean>();

/** 连接 → 登录用户 id（部署令牌连接为 undefined，代表全量视图） */
const socketUserId = new Map<WebSocket, string | undefined>();

let wss: WebSocketServer | null = null;
let heartbeatStop: (() => void) | null = null;

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

/** 标记连接存活（收到 pong 时调用；单测也可用它模拟「回 pong 的活连接」） */
export function markWsAlive(client: WebSocket): void {
  socketAlive.set(client, true);
}

/**
 * 单轮心跳：
 *  - 上一轮 ping 之后没回过 pong 的连接 → 判定已死，terminate 回收；
 *  - 其余的置为「等待 pong」并下发协议层 ping + 应用层 heartbeat 帧。
 * 返回本轮回收的连接数（测试与诊断用）。
 */
export function heartbeatRound(clients: Iterable<WebSocket>): number {
  const at = new Date().toISOString();
  let reaped = 0;
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (socketAlive.get(client) === false) {
      socketAlive.delete(client);
      socketUserId.delete(client);
      try {
        client.terminate();
      } catch {
        // 已经断了：忽略，映射表已清理
      }
      reaped += 1;
      continue;
    }
    socketAlive.set(client, false);
    try {
      client.ping();
      client.send(JSON.stringify({ type: 'heartbeat', ts: at }));
    } catch {
      // 本轮发不出去，下一轮会被当作未回 pong 回收
    }
  }
  return reaped;
}

/** 启动心跳定时器；返回停止函数（wss 关闭 / 测试重置时调用） */
export function startWsHeartbeat(server: WebSocketServer, intervalMs = WS_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => heartbeatRound(server.clients), intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export function initWs(server: Server): WebSocketServer {
  // 重复初始化时先停掉旧心跳，避免定时器叠加
  heartbeatStop?.();
  heartbeatStop = null;

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
    socketAlive.set(ws, true);
    // 浏览器对协议层 ping 会自动回 pong（不需要业务代码），这里刷新存活标记
    ws.on('pong', () => markWsAlive(ws));
    ws.on('close', () => {
      socketUserId.delete(ws);
      socketAlive.delete(ws);
    });
    // heartbeat:true = 告诉前端「我会定期发心跳，你可以用它判断半开断链」
    ws.send(JSON.stringify({ type: 'connected', heartbeat: true, ts: new Date().toISOString() }));
  });
  const stopHeartbeat = startWsHeartbeat(wss);
  heartbeatStop = stopHeartbeat;
  wss.on('close', () => {
    // 只停自己这一个定时器：initWs 可能被再次调用（换 server / 测试），
    // 旧 wss 关闭时若按模块变量停表，会把新 wss 的心跳一起停掉。
    stopHeartbeat();
    if (heartbeatStop === stopHeartbeat) heartbeatStop = null;
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
  heartbeatStop?.();
  heartbeatStop = null;
  for (const client of wss?.clients ?? []) client.terminate();
  socketUserId.clear();
  wss = null;
}