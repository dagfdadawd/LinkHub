/**
 * 实时推送抽象。
 *
 * 页面只订阅事件；Mock 阶段由内存事件总线模拟，
 * 接后端时替换为原生 WebSocket（/ws?token=...）。
 */
import type { UnifiedMessage } from '../types';

export type RealtimeStatus = 'connected' | 'reconnecting' | 'offline';

export interface RealtimeEvent {
  /**
   * heartbeat 是服务端每 25s 下发的应用层探活帧：
   * 浏览器 JS 读不到 WebSocket 协议层 ping/pong，只能靠它判断「链路还在不在」。
   * 客户端内部消费（刷新存活时间）后**不再向外分发**。
   */
  type: 'message.received' | 'message.updated' | 'message.failed' | 'connected' | 'heartbeat';
  data?: UnifiedMessage;
  /**
   * 仅 `connected` 帧携带：服务端是否支持应用层心跳。
   * 旧后端没有这个字段 —— 前端此时不能按「静默超时」判断断链，
   * 否则升级了前端、没升级后端的部署会每 75s 空重连一次。
   */
  heartbeat?: boolean;
}

export interface RealtimeClient {
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
  subscribeStatus(listener: (status: RealtimeStatus) => void): () => void;
  getStatus(): RealtimeStatus;
  close(): void;
  /** 登录态变化后强制用当前令牌重连（Mock 客户端不需要，故为可选） */
  reconnectNow?: () => void;
}

/** 可手动 emit 的客户端：Mock 服务用它模拟服务端推送 */
export class EmitterRealtime implements RealtimeClient {
  private listeners = new Set<(event: RealtimeEvent) => void>();
  private statusListeners = new Set<(status: RealtimeStatus) => void>();
  private status: RealtimeStatus = 'connected';

  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'connected' });
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  emit(event: RealtimeEvent): void {
    this.listeners.forEach((l) => l(event));
  }

  close(): void {
    this.listeners.clear();
    this.statusListeners.clear();
  }
}