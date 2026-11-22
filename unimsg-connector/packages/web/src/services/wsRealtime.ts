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
 * 半开断链（最重要的一条）：TCP 可能「没断但已经死了」——笔记本合盖、切 Wi-Fi、
 * 中间设备静默丢状态，都不会触发 close 事件，页面会一直停在 connected 却收不到任何推送。
 * 服务端每 25s 下发一条应用层 `heartbeat` 帧（浏览器读不到协议层 ping/pong），
 * 客户端用看门狗盯着「最近一次收到任何帧的时间」：超过 75s 没有任何帧，
 * 就主动拆掉这条连接并按断线重连。online / visibilitychange 也会先做同样的
 * 存活判断，避免「状态是 connected 就什么都不做」把半开连接一直留着。
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
  /** 是否在构造时立即连接（默认 true）；登录守卫可先关着，等认证后再 reconnectNow */
  autoConnect?: boolean;
  /**
   * 判定「静默断链」的阈值（默认 75s = 3 个服务端心跳周期）。
   * 超过这么久没收到任何帧，就认为链路已死，主动拆线重连。
   */
  heartbeatTimeoutMs?: number;
  /** 看门狗检查间隔（默认 15s）：只做本地时间比较，不产生网络请求 */
  watchdogMs?: number;
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
  private readonly heartbeatTimeoutMs: number;
  private readonly watchdogMs: number;
  private readonly WS: typeof WebSocket;
  /** 最近一次收到任何帧的本地时间：判断半开断链的唯一依据 */
  private lastFrameAt = 0;
  /** 服务端是否在 connected 帧里声明支持心跳（旧后端没有 → 保持只靠 close 事件的老行为） */
  private heartbeatSupported = false;
  /** 静默看门狗：定时比较本地时间，不产生网络请求 */
  private watchdog?: ReturnType<typeof setInterval>;
  /** 卸载 window/document 监听用；close() 时必须摘掉，否则组件卸载后仍会拉连接 */
  private detachWindowHooks?: () => void;

  constructor(
    /** 连接地址：可以是字符串，也可以是每次连接时求值的函数（登录态变化后自动带新令牌） */
    private readonly url: string | (() => string),
    options: WsOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 8;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.idleDelayMs = options.idleDelayMs ?? 15_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 75_000;
    this.watchdogMs = options.watchdogMs ?? 15_000;
    this.WS = options.WebSocketImpl ?? WebSocket;
    this.attachWindowHooks();
    if (options.autoConnect !== false) this.connect();
  }

  /**
   * 浏览器侧的快速恢复钩子：
   *  - online：断网恢复（笔记本合盖、切 Wi-Fi）——此时低频重试可能还要等十几秒；
   *  - visibilitychange：页面从后台切回前台，浏览器可能已静默断开连接。
   * 两者都直接跳过退避重连，用户不需要手动刷新页面。
   * `connected` 不等于「链路活着」：半开连接状态仍是 connected，必须先做存活判断。
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

  /** 立即重连：跳过剩余退避等待；链路其实已静默死亡时先拆线 */
  private revive(): void {
    if (this.closed) return;
    if (this.status === 'connected') {
      if (!this.isStale()) return;
      // 之前这里直接 return，导致半开断链下 online/可见性事件都救不回来
      this.dropAndReconnect();
      return;
    }
    this.clearTimer();
    this.attempts = 0;
    this.connect();
  }

  /** 超过心跳阈值没收到任何帧 = 链路已死（或对端不再说话） */
  private isStale(): boolean {
    // 旧后端不心跳：此时「静默」不能作为断链证据，否则会周期性空重连
    if (!this.heartbeatSupported) return false;
    return this.lastFrameAt > 0 && Date.now() - this.lastFrameAt > this.heartbeatTimeoutMs;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.closed || this.status !== 'connected') return;
      if (!this.isStale()) return;
      this.dropAndReconnect();
    }, this.watchdogMs);
    // Node 环境下不要因为这条定时器把进程吊住（浏览器里没有 unref，忽略即可）
    (this.watchdog as unknown as { unref?: () => void }).unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  /**
   * 拆掉一条「看起来还开着、实际已经失联」的连接并按断线重连。
   * 旧连接的监听必须先摘掉，否则它 close 时还会再排一次重连（双连接）。
   */
  private dropAndReconnect(): void {
    const old = this.ws;
    this.ws = undefined;
    if (old) {
      old.onopen = null;
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      try {
        old.close();
      } catch {
        // 关闭半开连接可能抛错，不影响新建
      }
    }
    this.stopWatchdog();
    this.scheduleReconnect();
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

  /**
   * 登录态变化（登录/退出）后强制重连：用当前令牌重新握手。
   * 已连接但令牌变了的旧连接会被后端按 1008 拒绝，必须主动换一条。
   */
  reconnectNow(): void {
    this.closed = false;
    this.attempts = 0;
    this.clearTimer();
    this.stopWatchdog();
    const old = this.ws;
    this.ws = undefined;
    if (old) {
      // 先摘掉旧连接监听，否则它 close 时还会再排一次重连，导致双连接
      old.onopen = null;
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      try {
        old.close();
      } catch {
        // 关闭旧连接失败不影响新建
      }
    }
    this.connect();
  }

  /** 主动关闭：不再重连，清空订阅（组件卸载/应用销毁时调用） */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.stopWatchdog();
    this.detachWindowHooks?.();
    this.detachWindowHooks = undefined;
    this.ws?.close();
    this.listeners.clear();
    this.statusListeners.clear();
  }

  private connect(): void {
    if (this.closed) return;
    // 每次新连接都重新协商：旧后端不会声明心跳支持
    this.heartbeatSupported = false;
    const url = typeof this.url === 'function' ? this.url() : this.url;
    const ws = new this.WS(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastFrameAt = Date.now();
      this.startWatchdog();
      this.setStatus('connected');
      this.emit({ type: 'connected' });
    };

    ws.onmessage = (ev) => {
      // 任何一帧都算「链路活着」：heartbeat 只用于探活，不向业务层分发
      this.lastFrameAt = Date.now();
      try {
        const parsed = JSON.parse(String(ev.data)) as RealtimeEvent;
        if (parsed && parsed.type === 'heartbeat') return;
        // 服务端用 connected 帧声明心跳能力；没有该字段的是旧后端
        if (parsed && parsed.type === 'connected') this.heartbeatSupported = parsed.heartbeat === true;
        if (parsed && typeof parsed.type === 'string') this.emit(parsed);
      } catch {
        // 无法解析的帧直接忽略，不影响连接
      }
    };

    // 错误统一交给 onclose 处理重连，避免双触发
    ws.onerror = () => {};

    ws.onclose = (ev) => {
      this.stopWatchdog();
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
