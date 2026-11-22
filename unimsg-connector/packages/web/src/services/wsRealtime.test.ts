import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsRealtime } from './wsRealtime';
import type { RealtimeEvent } from './realtime';

/** 注入用假 WebSocket：手动触发 open/message/close */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  // ---- 测试辅助：模拟服务端行为 ----
  open(): void {
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  rawMessage(data: string): void {
    this.onmessage?.({ data });
  }
  serverClose(code = 1006): void {
    this.onclose?.({ code });
  }
}

function create(options: {
  maxRetries?: number;
  idleDelayMs?: number;
  heartbeatTimeoutMs?: number;
  watchdogMs?: number;
} = {}) {
  return new WsRealtime('ws://127.0.0.1:3001/ws?token=dev-token', {
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    maxRetries: options.maxRetries ?? 2,
    baseDelayMs: 100,
    maxDelayMs: 400,
    idleDelayMs: options.idleDelayMs ?? 5000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    watchdogMs: options.watchdogMs,
  });
}

/** 心跳判定依赖 Date.now()：只 fake 定时器不带 Date 的话，假时钟推进不算「过时」 */
function useFakeTimersWithDate() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
  });
}

/** 模拟新后端的握手：connected 帧声明 heartbeat:true（旧后端没有这个字段） */
function handshakeWithHeartbeat(index = 0) {
  const ws = FakeWebSocket.instances[index];
  ws.open();
  ws.message({ type: 'connected', heartbeat: true });
  return ws;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WsRealtime', () => {
  it('连接成功后进入 connected，并解析分发事件（忽略坏帧）', () => {
    const rt = create();
    const events: RealtimeEvent[] = [];
    rt.subscribe((e) => events.push(e));

    expect(rt.getStatus()).toBe('reconnecting');
    FakeWebSocket.instances[0].open();
    expect(rt.getStatus()).toBe('connected');

    FakeWebSocket.instances[0].message({ type: 'message.received', data: { traceId: 't-1' } });
    FakeWebSocket.instances[0].rawMessage('not-json');

    expect(events.map((e) => e.type)).toEqual(['connected', 'message.received']);
    rt.close();
  });

  it('断开后退避重连，恢复后回到 connected', () => {
    const rt = create();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose();

    expect(rt.getStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(1000); // 覆盖 100ms * 1.5 抖动
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].open();
    expect(rt.getStatus()).toBe('connected');
    rt.close();
  });

  it('退避用完后进入 offline，但保留低频重试，恢复后自动回到 connected', () => {
    const rt = create({ maxRetries: 2, idleDelayMs: 5000 });
    FakeWebSocket.instances[0].open();

    FakeWebSocket.instances[0].serverClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].serverClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[2].serverClose();

    // 如实进入 offline（UI 据此提示），但不再「永久放弃」
    expect(rt.getStatus()).toBe('offline');
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(4);

    // 后端恢复 → 自动回到 connected，用户无需刷新页面
    FakeWebSocket.instances[3].open();
    expect(rt.getStatus()).toBe('connected');
    rt.close();
  });

  it('浏览器恢复联网时立即重连，不等低频重试', () => {
    const rt = create({ maxRetries: 1, idleDelayMs: 60_000 });
    FakeWebSocket.instances[0].serverClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].serverClose();
    expect(rt.getStatus()).toBe('offline');

    window.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.instances[2].open();
    expect(rt.getStatus()).toBe('connected');
    rt.close();
  });

  it('reconnectNow：1008 后登录成功可强制重连，旧连接不会重复调度', () => {
    const rt = create();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose(1008);
    expect(rt.getStatus()).toBe('offline');

    rt.reconnectNow();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(rt.getStatus()).toBe('connected');
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('鉴权失败（1008）直接 offline，不做无意义重连', () => {
    const rt = create();
    FakeWebSocket.instances[0].serverClose(1008);

    expect(rt.getStatus()).toBe('offline');
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    rt.close();
  });

  it('主动 close 后不再重连', () => {
    const rt = create();
    FakeWebSocket.instances[0].open();
    rt.close();
    FakeWebSocket.instances[0].serverClose();

    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('WsRealtime 半开断链（静默断网，TCP 不触发 close）', () => {
  it('超过心跳阈值没收到任何帧：看门狗主动拆线重连', () => {
    useFakeTimersWithDate();
    const rt = create({ heartbeatTimeoutMs: 3000, watchdogMs: 1000 });
    const first = handshakeWithHeartbeat();
    expect(rt.getStatus()).toBe('connected');

    // 半开链路：没有 close 事件、也没有任何帧，状态会一直停在 connected
    vi.advanceTimersByTime(5000);

    expect(first.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(rt.getStatus()).toBe('reconnecting');

    handshakeWithHeartbeat(1);
    expect(rt.getStatus()).toBe('connected');
    rt.close();
  });

  it('收到 heartbeat 帧即刷新存活时间，不会误判断线；心跳不分发给业务层', () => {
    useFakeTimersWithDate();
    const rt = create({ heartbeatTimeoutMs: 3000, watchdogMs: 1000 });
    const ws = handshakeWithHeartbeat();

    const events: RealtimeEvent[] = [];
    rt.subscribe((e) => events.push(e));

    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(2000);
      ws.message({ type: 'heartbeat', ts: '2026-11-23T00:00:00.000Z' });
    }

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rt.getStatus()).toBe('connected');
    // 只有 subscribe 时的 connected 回放；heartbeat 不上业务层
    expect(events.map((e) => e.type)).toEqual(['connected']);
    rt.close();
  });

  it('旧后端（connected 不声明 heartbeat）静默不误判断线', () => {
    useFakeTimersWithDate();
    const rt = create({ heartbeatTimeoutMs: 3000, watchdogMs: 1000 });
    const first = FakeWebSocket.instances[0];
    first.open();
    first.message({ type: 'connected' });

    // 升级了前端、没升级后端：不能每 75s 空重连一次
    vi.advanceTimersByTime(30_000);

    expect(first.closed).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rt.getStatus()).toBe('connected');
    rt.close();
  });

  it('浏览器恢复联网时立即救回（connected 但已静默的连接不再被跳过）', () => {
    useFakeTimersWithDate();
    const rt = create({ heartbeatTimeoutMs: 3000, watchdogMs: 60_000 });
    const first = handshakeWithHeartbeat();

    // 看门狗还没轮到，状态仍是 connected，但链路其实已经静默 5s
    vi.advanceTimersByTime(5000);
    expect(rt.getStatus()).toBe('connected');

    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(200); // 覆盖重连退避（100ms 基数 * 抖动）

    expect(first.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    handshakeWithHeartbeat(1);
    expect(rt.getStatus()).toBe('connected');
    rt.close();
  });
});
