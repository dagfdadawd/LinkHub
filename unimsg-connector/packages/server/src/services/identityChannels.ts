/**
 * 本人身份接收通道协调器（运行期 reconcile）。
 *
 * 问题：飞书用户轮询 / 钉钉个人事件流原先只在**后端启动时**按当时身份状态启动一次。
 * 用户在运行中完成本人账号登录（点连接 → 浏览器授权成功）后，身份已变成「本人」，
 * 但接收通道不会自动启动，必须重启后端才能收本人消息——这与「点连接就能用」的预期不符。
 *
 * 做法：根据 `resolveIdentity(platform).effectiveReceive` 决定 start/stop：
 *  - 已启动且仍需要 → 不重复启动；
 *  - 需要但未启动 → 启动并打一行中文日志；
 *  - 不再需要（未连接 / Mock / 固定机器人 / 接收关闭）→ 停止。
 *
 * 调用时机（由 index.ts 与相关路由触发）：
 *  ① 启动 warm 之后；② POST /dingtalk/personal/login 后；
 *  ③ GET /dingtalk/personal/status 检测到 authenticated 变化；
 *  ④ 飞书 OAuth 回调成功后；⑤ logout 后；⑥ 30–60s 兜底定时 reconcile（unref）。
 *
 * 该模块只做编排，不直接碰平台协议；真实启动器可注入（单测不启子进程）。
 */
import { Platform } from '@unimsg/shared';
import type { MessageService } from './message';
import {
  identityChannelsReal,
  resolveIdentity,
  warmIdentityProbes,
} from './identity';
import { dingtalkPersonalClient } from '../connectors/dingtalkPersonal';
import { maybeAutoEnableDingtalkPersonalIdentity } from './personalIdentity';
import { startFeishuUserPoller, type FeishuUserPollerHandle } from '../stream/feishuUserPoller';
import { startDingtalkPersonalStream, type DingtalkPersonalStream } from '../stream/dingtalkPersonalStream';

/** 兜底 reconcile 间隔：登录/授权可能在外部终端完成，没有回调可依赖 */
export const IDENTITY_CHANNELS_RECONCILE_MS = 45_000;

export interface IdentityChannelsSnapshot {
  feishuUserPoller: boolean;
  dingtalkPersonalStream: boolean;
}

export interface IdentityChannelsOptions {
  log?: (line: string) => void;
  /** 启动飞书用户轮询（单测注入，避免真实网络/子进程） */
  startFeishuPoller?: (svc: MessageService) => FeishuUserPollerHandle | null;
  /** 启动钉钉个人事件流（单测注入，避免真实子进程） */
  startDingtalkStream?: (svc: MessageService) => DingtalkPersonalStream | null;
  /** 身份视图解析（单测注入，便于构造「运行中登录」场景） */
  resolveView?: typeof resolveIdentity;
  /** 刷新钉钉登录态（单测注入；默认 authStatus(force) 1–3s 单飞） */
  refreshDingtalkStatus?: () => Promise<void>;
}

export class IdentityChannelsCoordinator {
  private feishuPoller?: FeishuUserPollerHandle;
  private dingtalkStream?: DingtalkPersonalStream;
  /** 串行化：reconcile 期间再次触发只标记重跑，避免并发起/停同一通道 */
  private running = false;
  private rerun = false;

  private readonly log: (line: string) => void;
  private readonly startFeishuPoller: (svc: MessageService) => FeishuUserPollerHandle | null;
  private readonly startDingtalkStream: (svc: MessageService) => DingtalkPersonalStream | null;
  private readonly resolveView: typeof resolveIdentity;
  private readonly refreshDingtalkStatus: () => Promise<void>;

  constructor(private readonly svc: MessageService, opts: IdentityChannelsOptions = {}) {
    this.log = opts.log ?? ((line) => console.log(line));
    this.startFeishuPoller = opts.startFeishuPoller ?? ((s) => startFeishuUserPoller(s));
    this.startDingtalkStream = opts.startDingtalkStream ?? ((s) => startDingtalkPersonalStream(s));
    this.resolveView = opts.resolveView ?? resolveIdentity;
    this.refreshDingtalkStatus = opts.refreshDingtalkStatus ?? (async () => {
      // 只在「钉钉本人身份通道可能真实工作」时探测；Mock 模式绝不外呼（契约 §1）
      if (!identityChannelsReal(Platform.DINGTALK)) return;
      await dingtalkPersonalClient().authStatus({ force: true }).catch(() => undefined);
    });
  }

  /** 当前通道运行情况（测试/doctor 用） */
  snapshot(): IdentityChannelsSnapshot {
    return {
      feishuUserPoller: Boolean(this.feishuPoller),
      dingtalkPersonalStream: Boolean(this.dingtalkStream),
    };
  }

  /** 对齐一次：按当前身份视图启动/停止接收通道（串行、可重入） */
  async reconcile(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.reconcileFeishu();
        await this.reconcileDingtalk();
      } while (this.rerun);
    } finally {
      this.running = false;
    }
  }

  private async reconcileFeishu(): Promise<void> {
    const view = this.resolveView(Platform.FEISHU);
    const want = view.effectiveReceive === 'user';
    if (want && !this.feishuPoller) {
      const handle = this.startFeishuPoller(this.svc);
      if (handle) {
        this.feishuPoller = handle;
        this.log('[identity] 检测到飞书本人身份可用，启动用户轮询接收');
      }
    } else if (!want && this.feishuPoller) {
      this.feishuPoller.stop();
      this.feishuPoller = undefined;
      this.log('[identity] 飞书本人身份接收已不可用，停止用户轮询');
    }
  }

  private async reconcileDingtalk(): Promise<void> {
    // 登录态可能刚变化（浏览器授权成功 / 外部终端登录）：强制探一次（客户端自带单飞与超时）
    await this.refreshDingtalkStatus().catch(() => undefined);
    // 「一登即用」：已登录 + 没有机器人凭据 + 身份策略 auto → 自动热应用仅本人身份（持久化）
    const auth = dingtalkPersonalClient().lastKnownStatus();
    if (auth?.authenticated) {
      await maybeAutoEnableDingtalkPersonalIdentity('定时对齐检测到钉钉已登录', { authenticated: true }).catch(() => undefined);
    }
    const view = this.resolveView(Platform.DINGTALK);
    const want = view.effectiveReceive === 'user';
    if (want && !this.dingtalkStream) {
      const stream = this.startDingtalkStream(this.svc);
      if (stream) {
        this.dingtalkStream = stream;
        this.log('[identity] 检测到钉钉本人身份已连接，启动个人事件接收');
      }
    } else if (!want && this.dingtalkStream) {
      const stream = this.dingtalkStream;
      this.dingtalkStream = undefined;
      await stream.stop().catch(() => undefined);
      this.log('[identity] 钉钉本人身份接收已不可用，停止个人事件接收');
    }
  }

  /** 服务关闭：停掉全部接收通道（Windows 下由各通道负责 taskkill 树） */
  async stopAll(): Promise<void> {
    const feishu = this.feishuPoller;
    const dingtalk = this.dingtalkStream;
    this.feishuPoller = undefined;
    this.dingtalkStream = undefined;
    if (dingtalk) await dingtalk.stop().catch(() => undefined);
    feishu?.stop();
  }
}

// ---------------------------------------------------------------------------
// 生产单例（index.ts 初始化；路由在测试环境未初始化时安全 no-op）
// ---------------------------------------------------------------------------

let instance: IdentityChannelsCoordinator | undefined;

/** 启动时初始化（index.ts 调用） */
export function initIdentityChannels(
  svc: MessageService,
  opts: IdentityChannelsOptions = {},
): IdentityChannelsCoordinator {
  instance = new IdentityChannelsCoordinator(svc, opts);
  return instance;
}

/** 读取单例（未初始化 → undefined，便于单测/纯路由测试安全跳过） */
export function currentIdentityChannels(): IdentityChannelsCoordinator | undefined {
  return instance;
}

/**
 * 触发一次后台 reconcile（不等待、不抛错）：
 * 登录/注销/授权回调/状态探测到变化时调用；失败只 warn，绝不影响 HTTP 响应。
 */
export function reconcileIdentityChannels(reason?: string): void {
  const coordinator = instance;
  if (!coordinator) return;
  void coordinator.reconcile().catch((e) => {
    console.warn(`[identity] 接收通道对齐失败${reason ? `（${reason}）` : ''}：`, e instanceof Error ? e.message : e);
  });
}

/** 单测用：清空单例 */
export function resetIdentityChannelsForTests(): void {
  instance = undefined;
}