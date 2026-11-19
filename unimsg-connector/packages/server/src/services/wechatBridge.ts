/**
 * 微信 RPA 桥的「运行态」探测。
 *
 * 为什么需要这一层：`WECHAT_MODE=real` 只说明「配置上允许真实操作」，
 * 完全不代表桥真的起来了、更不代表桥在 rpa 模式不会偷偷只写日志。
 * 以前 onboarding 只看这个环境变量就报 `ready`，等于把「配了个地址」当成「已连上微信」。
 *
 * 这一层做两件事：
 *  1. 真的去问桥（`GET /health`，只读、本机、1.2s 超时）；
 *  2. 把「桥在 mock / 桥没实现接收 / 桥读不到窗口」如实翻译成 canReceive + reason，
 *     供 onboarding、doctor、/api/health 共用同一套口径。
 *
 * 缓存 5s：health / onboarding 会被前端频繁轮询，不能每次请求都戳桥；
 * 但也不能缓存太久，否则「刚重启桥」要等半天才反映过来。
 */
import { config } from '../config';
import { bridgeUrl } from '../connectors/wechat';

export type WechatBridgeState = 'unknown' | 'unreachable' | 'mock' | 'rpa';

/**
 * 桥探测到的微信客户端形态。
 * 3.x 是原生控件（UIA 可读）；4.x（Weixin）是 Qt 自绘，UIA/MSAA 都只有空壳，
 * 这不是「没登录」也不是「装少了依赖」，是版本本身不提供可访问性 —— 必须分开讲。
 */
export interface WechatClientInfo {
  kind: 'wechat3' | 'weixin4' | 'none' | 'unknown';
  uiaUsable: boolean;
  reason: string;
  className?: string;
}

export interface WechatBridgeStatus {
  /** 桥的运行态；unknown = 桥可达但没上报模式（版本不匹配） */
  state: WechatBridgeState;
  url: string;
  reachable: boolean;
  mode?: 'mock' | 'rpa';
  /** 入站真实采集是否可用（仅 rpa 模式 + 桥实现了读取 + 当前能读到窗口才为 true） */
  canReceive: boolean;
  /** 真实发送是否可用（桥在 rpa 模式；具体能否送达由 send 的 verified 决定） */
  canSend: boolean;
  /** 接收方式：auto=自动轮询；pull=4.x 按需拉取；none=不可用 */
  receiveMode: 'auto' | 'pull' | 'none';
  /** 给界面直接显示的一句话（不夸大、可操作） */
  receiveReason: string;
  /** 桥是否上报了 receive 能力（旧版桥没有，按「未实现」处理，不猜） */
  reportedReceive: boolean;
  /** 本机微信客户端形态（新版桥才上报；旧版桥为空，不猜） */
  client?: WechatClientInfo;
  checkedAt: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 1200;
const CACHE_MS = 5000;

let cache: { at: number; status: WechatBridgeStatus } | null = null;
let inflight: Promise<WechatBridgeStatus> | null = null;

function parseClient(raw: unknown): WechatClientInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const kind = String(r.kind ?? '').trim();
  if (!kind) return undefined;
  return {
    kind: (['wechat3', 'weixin4', 'none', 'unknown'].includes(kind) ? kind : 'unknown') as WechatClientInfo['kind'],
    uiaUsable: r.uiaUsable === true,
    reason: String(r.reason ?? '').trim(),
    ...(r.class ? { className: String(r.class) } : {}),
  };
}

function receiveVerdict(
  mode: 'mock' | 'rpa' | undefined,
  reportedReceive: boolean,
  receive: any,
  client?: WechatClientInfo,
): { canReceive: boolean; receiveReason: string } {
  if (mode === 'mock') {
    return { canReceive: false, receiveReason: '桥运行在 mock 模式：不会操作微信，也不采集真实消息' };
  }
  if (mode !== 'rpa') {
    return { canReceive: false, receiveReason: '桥没有上报运行模式，无法确认真实收发能力' };
  }
  if (!reportedReceive) {
    return { canReceive: false, receiveReason: '桥版本过旧（/health 未上报 receive 能力），按「未实现接收」处理' };
  }
  if (receive?.implemented !== true) {
    return { canReceive: false, receiveReason: '桥的入站读取未实现（read_new_messages 为空）' };
  }
  if (receive?.supported !== true) {
    // 微信 4.x 是「版本不给接口」，不是「配置没做好」，优先把这一点说透
    if (client?.kind === 'weixin4') {
      return {
        canReceive: false,
        receiveReason: client.reason || '检测到微信 4.x（Qt 自绘）：不暴露可访问性控件树，无法读取消息；请改用微信 3.9.x',
      };
    }
    return {
      canReceive: false,
      receiveReason: String(receive?.reason || '桥读不到微信窗口（未安装 uiautomation、或微信未登录/未打开）'),
    };
  }
  return { canReceive: true, receiveReason: '已就绪：RPA 轮询读取微信窗口新消息（会切换会话）' };
}

/** 单次探测（不读缓存）。任何失败都转成 `unreachable`，绝不抛异常给调用方。 */
export async function probeWechatBridge(opts: { timeoutMs?: number; url?: string } = {}): Promise<WechatBridgeStatus> {
  const url = (opts.url ?? bridgeUrl()).replace(/\/+$/, '');
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(`${url}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json().catch(() => ({}))) as any;
    const rawMode = String(json?.mode ?? '').trim().toLowerCase();
    const mode: 'mock' | 'rpa' | undefined = rawMode === 'rpa' ? 'rpa' : rawMode === 'mock' ? 'mock' : undefined;
    const receive = json?.receive;
    const reportedReceive = Boolean(receive && typeof receive === 'object');
    const client = parseClient(json?.client);
    const verdict = receiveVerdict(mode, reportedReceive, receive, client);
    const pullAvailable = json?.pull?.available === true;
    const receiveMode: WechatBridgeStatus['receiveMode'] =
      mode !== 'rpa' ? 'none'
        : receive?.supported === true ? 'auto'
          : client?.kind === 'weixin4' && pullAvailable ? 'pull'
            : 'none';
    return {
      state: mode ?? 'unknown',
      url,
      reachable: true,
      ...(mode ? { mode } : {}),
      canSend: mode === 'rpa',
      canReceive: verdict.canReceive,
      receiveMode,
      receiveReason: verdict.receiveReason,
      reportedReceive,
      ...(client ? { client } : {}),
      checkedAt,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      state: 'unreachable',
      url,
      reachable: false,
      canSend: false,
      canReceive: false,
      receiveMode: 'none',
      receiveReason: `连不上本机 RPA 桥（${url}）：${detail}`,
      reportedReceive: false,
      checkedAt,
      error: detail,
    };
  }
}

/**
 * 取桥状态（带 5s 缓存 + 并发去重）。
 * `maxAgeMs=0` 表示强制重新探测（doctor 需要现场结论）。
 */
export async function wechatBridgeStatus(
  opts: { timeoutMs?: number; maxAgeMs?: number; url?: string } = {},
): Promise<WechatBridgeStatus> {
  const maxAge = opts.maxAgeMs ?? CACHE_MS;
  if (cache && Date.now() - cache.at < maxAge) return cache.status;
  if (inflight) return inflight;
  inflight = probeWechatBridge(opts)
    .then((status) => {
      cache = { at: Date.now(), status };
      return status;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 同步读缓存（health 这类高频接口用，不阻塞响应）；没探测过或已过期返回 null。
 * 默认 10s：账号页只读缓存，不能把半小时前的“桥可用”一直当真。
 */
export function peekWechatBridgeStatus(maxAgeMs = 10_000): WechatBridgeStatus | null {
  if (!cache) return null;
  if (maxAgeMs > 0 && Date.now() - cache.at > maxAgeMs) return null;
  return cache.status;
}

/** 后台预热：不 await、失败吞掉（下次请求再试）。 */
export function warmWechatBridge(opts: { timeoutMs?: number } = {}): void {
  void wechatBridgeStatus(opts).catch(() => undefined);
}

/** 测试用：清空缓存，避免用例之间互相污染。 */
export function resetWechatBridgeCache(): void {
  cache = null;
  inflight = null;
}

/** 桥地址（配置里的值，缺省本机 8787）：给 onboarding 提示文案用 */
export function currentWechatBridgeUrl(): string {
  return bridgeUrl();
}

/** 仅当平台真的配了 real 才值得探测；mock 下探测没有意义（也不会影响判定） */
export function shouldProbeWechatBridge(): boolean {
  return config.runtime.wechat.mode === 'real';
}
