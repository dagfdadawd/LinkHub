/**
 * 真实 WebSocket 客户端：对接 packages/server 的 /ws 实时推送。
 *
 * 高可用设计：
 *  - 指数退避 + 随机抖动重连，避免服务端重启瞬间被回连风暴打满；
 *  - 鉴权失败（服务端 1008 关闭）不再重连，直接 offline，避免无意义死循环；
 *  - 超过最大重试次数后进入 offline 状态（UI 据此提示），但**不会永久放弃**：
 *    改为低频重试（默认 15s 一次），后端重启/网络恢复后自动回到 connected；
 *  - 浏览器恢复联网（online）、页面重新可见（visibilitychange）时立即重连，
 *    不必等低频重试的下一轮；
 *  - close() 为主动关闭，不再重连（与 EmitterRealtime.close 语义一致）。
 *
 * 为什么不做「重试 N 次后彻底停止」：开发/演示时会频繁重启后端，
 * 页面若在停机窗口里把重试次数用光，就会一直停在离线且日志全是失败，
 * 用户只能手动刷新——这正是「WS 一直连不上」的真实成因。
 *
 * 一致性兜底：重连期间错过的推送，由 AppStore 监听
 * reconnecting/offline → connected 的跃迁后重新拉取列表补齐。
 *
 * 说明：浏览器 WebSocket API 不暴露 ping/pong 帧，应用层心跳需要后端
 * 配套支持（当前后端只下发、不读上行），因此本版本依赖 TCP close
 * 事件触发重连；如需秒级探活，可后续在后端加 ping 帧支持。
 */
import type { RealtimeClient, RealtimeEvent, RealtimeStatus } from './realtime';

export interface WsOptions {
  /** 退避重连次数，超出后进入 offline 并转为低频重试（默认 8） */
  maxRetries?: number;
  /** 退避基数毫秒（默认 500） */
  baseDelayMs?: number;
  /** 退避上限毫秒（默认 10s） */
  maxDelayMs?: number;
  /** 进入 offline 之后的低频重试间隔（默认 15s）：只为自动恢复，不制造请求压力 */
  idleDelayMs?: number;
  /** 测试注入用：替换全局 WebSocket 实现 */
  WebSocketImpl?: typeof WebSocket;
}

/** 服务端鉴权失败的关闭码（见 packages/server/src/ws.ts） */
const WS_CLOSE_UNAUTHORIZED = 1008;

export class WsRealtime implements RealtimeClient {
  private listeners = new Set<(event: RealtimeEvent) => void>();
  private statusListeners = new Set<(status: RealtimeStatus) => void>();
  private status: RealtimeStatus = 'reconnecting';

  private ws?: WebSocket;
  private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly idleDelayMs: number;
  private readonly WS: typeof WebSocket;
  /** 卸载 window/document 监听用；close() 时必须摘掉，否则组件卸载后仍会拉连接 */
  private detachWindowHooks?: () => void;

  constructor(
    private readonly url: string,
    options: WsOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 8;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.idleDelayMs = options.idleDelayMs ?? 15_000;
    this.WS = options.WebSocketImpl ?? WebSocket;
    this.attachWindowHooks();
    this.connect();
  }

  /**
   * 浏览器侧的快速恢复钩子：
   *  - online：断网恢复（笔记本合盖、切 Wi-Fi）——此时低频重试可能还要等十几秒；
   *  - visibilitychange：页面从后台切回前台，浏览器可能已静默断开连接。
   * 两者都直接跳过退避重连，用户不需要手动刷新页面。
   */
  private attachWindowHooks(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onOnline = () => this.revive();
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.revive();
    };
    window.addEventListener('online', onOnline);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisible);
    }
    this.detachWindowHooks = () => {
      window.removeEventListener('online', onOnline);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }

  /** 立即重连：跳过剩余退避等待（已连接时什么都不做，避免重复开连接） */
  private revive(): void {
    if (this.closed || this.status === 'connected') return;
    this.clearTimer();
    this.attempts = 0;
    this.connect();
  }

  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    // 已连接时补发一次 connected，语义对齐 EmitterRealtime
    if (this.status === 'connected') listener({ type: 'connected' });
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

  /** 主动关闭：不再重连，清空订阅（组件卸载/应用销毁时调用） */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.detachWindowHooks?.();
    this.detachWindowHooks = undefined;
    this.ws?.close();
    this.listeners.clear();
    this.statusListeners.clear();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new this.WS(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus('connected');
      this.emit({ type: 'connected' });
    };

    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as RealtimeEvent;
        if (parsed && typeof parsed.type === 'string') this.emit(parsed);
      } catch {
        // 无法解析的帧直接忽略，不影响连接
      }
    };

    // 错误统一交给 onclose 处理重连，避免双触发
    ws.onerror = () => {};

    ws.onclose = (ev) => {
      if (this.closed) return;
      if (ev.code === WS_CLOSE_UNAUTHORIZED) {
        // Token 无效：重连无意义，直接离线交给人处理
        this.setStatus('offline');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.clearTimer();
    this.attempts += 1;
    if (this.attempts > this.maxRetries) {
      /**
       * 退避用完后进入 offline（UI 如实提示「实时连接已断开」），
       * 但继续以固定低频重试——后端重启、网络恢复都能自己爬回来。
       * 之前的实现到这里就直接 return，等于永久放弃：页面只能手动刷新。
       */
      this.setStatus('offline');
      this.timer = setTimeout(() => this.connect(), this.idleDelayMs);
      return;
    }
    this.setStatus('reconnecting');
    // 指数退避 + 50%~100% 随机抖动
    const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.attempts - 1));
    const jitter = backoff * (0.5 + Math.random() * 0.5);
    this.timer = setTimeout(() => this.connect(), jitter);
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  private emit(event: RealtimeEvent): void {
    this.listeners.forEach((l) => l(event));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
