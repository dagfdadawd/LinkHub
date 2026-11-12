/**
 * 钉钉「本人身份」接收：dws 个人事件长连接子进程监管。
 *
 * 每个事件范围（`DINGTALK_USER_EVENT_KINDS`）起一个子进程：
 *   `dws event +listen-im --kind <kind> --events message --flatten -f ndjson -y`
 * 契约依据 dws v1.0.68-beta.1 `dws event consume --help` / `event +listen-im --help`：
 *  - 默认输出 transport envelope（type/event_type/data/headers），`--flatten` 后业务字段在 payload；
 *  - stderr 会打就绪行 `[event] ready ...`，诊断信息也走 stderr —— **stderr 不算错误**；
 *  - 停机用 SIGTERM（或关 stdin）；**不要 kill -9**（会跳过服务端退订、泄漏订阅）。
 *
 * 监管策略：
 *  - stdout 按行解析 NDJSON，多行 JSON / 非 JSON 日志行一律容错跳过（计数，不崩溃）；
 *  - 子进程退出/崩溃 → 指数退避重启 1s→2s→4s…上限 60s，日志说明「第 N 次重启」；
 *  - 未登录（exit=5 / stderr `load access token`）不崩溃，打印中文下一步命令；
 *  - 关闭时 SIGTERM → 5s 未退则 Windows `taskkill /T /F`、其它 SIGKILL，绝不残留子进程。
 *
 * 事件 → 统一消息 → `svc.ingestUnified()`（与机器人链路共用幂等/trace/广播，receivedAs='user'）。
 */
import { spawn, execFile } from 'node:child_process';
import { Platform, type UnifiedMessage } from '@unimsg/shared';
import { config } from '../config';
import { MessageService } from '../services/message';
import {
  DWS_EXIT_NOT_LOGGED_IN,
  classifyDwsFailure,
  dingtalkPersonalClient,
  mapPersonalEventToMessage,
  MONOREPO_ROOT,
  parseDwsBin,
  parseEventLine,
} from '../connectors/dingtalkPersonal';
import { identityChannelsReal, resolveIdentity } from '../services/identity';

/** 重启退避：1s → 2s → 4s … 上限 60s */
export const RESTART_BASE_MS = 1_000;
export const RESTART_MAX_MS = 60_000;
/** 解析缓冲上限：防止异常输出把内存打爆 */
export const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
/** 非消息事件（审批/待办/回执等）日志节流：每累计 N 条打一行 */
export const IGNORED_LOG_EVERY = 100;

/** 第 attempt 次重启（1 起）的等待时长 */
export function restartDelay(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (n - 1));
}

/** 构造 listen 参数（供单测断言；--profile 由运行器统一追加） */
export function buildListenArgs(kind: string): string[] {
  return ['event', '+listen-im', '--kind', kind, '--events', 'message', '--flatten', '-f', 'ndjson', '-y'];
}

/** 从一行 stdout 里解析事件：非 JSON/日志行返回 null（调用方计数） */
export function parseStreamLine(line: string): { event?: ReturnType<typeof parseEventLine>; raw: string } {
  const text = line.trim();
  if (!text) return { raw: text };
  if (!text.startsWith('{')) return { raw: text };
  return { event: parseEventLine(text), raw: text };
}

export type StreamExitKind = 'not-logged-in' | 'not-installed' | 'permission' | 'exited';

/** 子进程退出原因分类（中文日志用） */
export function classifyStreamExit(code: number | null, stderr: string, bin = 'dws'): {
  kind: StreamExitKind;
  message: string;
} {
  const text = stderr ?? '';
  if (code === DWS_EXIT_NOT_LOGGED_IN || /load access token|secure data file|未登录|not logged in/i.test(text)) {
    return {
      kind: 'not-logged-in',
      message: '钉钉本人身份未登录：请先执行 `dws auth login`（或到「平台账号」页点「连接本人账号」）完成授权；'
        + '未登录期间个人事件不会启动，登录后会自动恢复（每轮按退避重试）。',
    };
  }
  if (/ENOENT|spawn .* ENOENT/i.test(text)) {
    return {
      kind: 'not-installed',
      message: `未找到 dws 可执行文件（${bin}）：请安装钉钉官方 CLI `
        + '（https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli），或把 DWS_BIN 指向可执行文件路径。',
    };
  }
  if (/permission|forbidden|CLI 访问|权限/i.test(text)) {
    return {
      kind: 'permission',
      message: '钉钉本人身份权限不足：请联系企业管理员确认已开启「CLI 访问管理」（或改用自有应用 Custom App 模式）。',
    };
  }
  return {
    kind: 'exited',
    message: `dws 个人事件进程退出（exit=${code ?? 'unknown'}）：将按退避策略自动重启；`
      + '若反复出现请检查网络/代理，或运行 `pnpm run doctor --platform=dingtalk` 自检。',
  };
}

// ---------------------------------------------------------------------------
// 子进程监管
// ---------------------------------------------------------------------------

export interface SpawnedProcessLike {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  killed?: boolean;
  exitCode?: number | null;
  kill(signal?: NodeJS.Signals | string): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
}

export type SpawnLike = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; stdio?: any },
) => SpawnedProcessLike;

export interface DingtalkPersonalStreamOptions {
  /** 单测注入 spawn */
  spawnImpl?: SpawnLike;
  /** 单测注入计时器（避免真实等待） */
  setTimeoutImpl?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimeoutImpl?: (handle: NodeJS.Timeout | number) => void;
  /** 单测注入时钟 */
  now?: () => number;
  /** 事件范围（默认取 config.identity.dingtalk.eventKinds） */
  kinds?: string[];
  /** dws 可执行文件（默认 config.identity.dingtalk.bin） */
  bin?: string;
  profile?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

interface ChannelState {
  kind: string;
  child?: SpawnedProcessLike;
  attempt: number;
  restartTimer?: NodeJS.Timeout | number;
  stopped: boolean;
  killing?: boolean;
  ignoredEvents: number;
  buffer: string;
}

/** 收下一条事件的管道（单测可替换） */
export async function ingestPersonalEvent(
  svc: MessageService,
  evt: ReturnType<typeof parseEventLine>,
  counters: { ignored: number },
  selfOpenDingtalkId?: string,
): Promise<UnifiedMessage | null> {
  if (!evt) return null;
  // 传 selfOpenDingtalkId 过滤自己发出的消息（取不到时 mapper 不过滤，宁可噪音也不误丢）
  const msg = mapPersonalEventToMessage(evt, selfOpenDingtalkId ? { selfOpenDingtalkId } : {});
  if (!msg) {
    counters.ignored += 1;
    return null;
  }
  await svc.ingestUnified(Platform.DINGTALK, msg);
  return msg;
}

export class DingtalkPersonalStream {
  private readonly channels: ChannelState[] = [];
  private readonly spawnImpl: SpawnLike;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  private readonly clearTimeoutImpl: (handle: NodeJS.Timeout | number) => void;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;
  private readonly bin: string;
  private readonly profile: string;
  private stopped = false;
  private started = false;
  /** 本人 openDingTalkId（用于过滤自己发出的消息；取不到则不过滤） */
  private selfOpenDingtalkId?: string;

  constructor(
    private readonly svc: MessageService,
    opts: DingtalkPersonalStreamOptions = {},
  ) {
    this.spawnImpl = opts.spawnImpl ?? (spawn as unknown as SpawnLike);
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.log = opts.log ?? ((line) => console.log(line));
    this.warn = opts.warn ?? ((line) => console.warn(line));
    this.bin = opts.bin ?? config.identity.dingtalk.bin;
    this.profile = opts.profile ?? config.identity.dingtalk.profile;
    const kinds = opts.kinds ?? config.identity.dingtalk.eventKinds;
    for (const kind of kinds) {
      this.channels.push({ kind, attempt: 0, stopped: false, ignoredEvents: 0, buffer: '' });
    }
  }

  /** 启动全部事件子进程（幂等；不满足身份条件时只打日志不启动） */
  start(): void {
    if (this.started) return;
    this.started = true;
    const view = resolveIdentity(Platform.DINGTALK);
    if (!identityChannelsReal(Platform.DINGTALK)) {
      this.log('[dingtalk-user] 钉钉当前为模拟模式，跳过本人身份事件订阅（DINGTALK_MODE=real 或仅本人身份模式下才启动）');
      return;
    }
    if (view.effectiveReceive !== 'user') {
      this.log(`[dingtalk-user] 本次接收身份为「${view.effectiveReceive === 'bot' ? '机器人' : '模拟'}」，跳过本人身份事件订阅；${view.user.hint}`);
      return;
    }
    // best-effort：本人 openDingTalkId（账号页预热阶段已尝试拉取，这里只读缓存）
    this.selfOpenDingtalkId = dingtalkPersonalClient().peekSelfOpenDingtalkId();
    if (!this.selfOpenDingtalkId) {
      this.warn('[dingtalk-user] 未取得本人 openDingTalkId，无法过滤自己发出的消息（不影响接收；可运行 pnpm run doctor --platform=dingtalk 自检）');
    }
    for (const channel of this.channels) this.spawnChannel(channel);
  }

  private spawnChannel(channel: ChannelState): void {
    if (this.stopped || channel.stopped) return;
    const { file, prefixArgs } = parseDwsBin(this.bin);
    const args = [
      ...prefixArgs,
      ...buildListenArgs(channel.kind),
      ...(this.profile ? ['--profile', this.profile] : []),
    ];
    let child: SpawnedProcessLike;
    try {
      child = this.spawnImpl(file, args, {
        cwd: MONOREPO_ROOT,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.warn(`[dingtalk-user] 启动 dws 事件子进程失败（kind=${channel.kind}）：${message}；${classifyStreamExit(null, message, file).message}`);
      this.scheduleRestart(channel);
      return;
    }
    channel.child = child;
    channel.buffer = '';
    const startedAt = Date.now();

    const onStdout = (chunk: Buffer | string): void => {
      this.consume(channel, String(chunk), 'stdout');
    };
    child.stdout?.on('data', onStdout as any);
    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stderrBuf = (stderrBuf + text).slice(-4000);
      // stderr 是 dws 的诊断/就绪信息（[event] ready …），只做调试日志，不当错误
      if (/ready/i.test(text)) this.log(`[dingtalk-user] dws 事件订阅就绪（kind=${channel.kind}）：${text.trim().slice(0, 200)}`);
    });
    child.on('error', (err: Error) => {
      this.warn(`[dingtalk-user] dws 事件子进程错误（kind=${channel.kind}）：${err.message}`);
    });
    child.on('exit', (code: number | null) => {
      channel.child = undefined;
      if (this.stopped || channel.stopped) return;
      const info = classifyStreamExit(code, stderrBuf, parseDwsBin(this.bin).file);
      const ranMs = Date.now() - startedAt;
      // 跑满 30s 才退出视为「正常运行后断开」，退避计数归零，避免长期服务偶发断线后越退越久
      if (ranMs > 30_000) channel.attempt = 0;
      channel.attempt += 1;
      const delay = restartDelay(channel.attempt);
      this.warn(
        `[dingtalk-user] ${info.message} 第 ${channel.attempt} 次重启将在 ${Math.round(delay / 1000)}s 后执行（kind=${channel.kind}）`,
      );
      this.scheduleRestart(channel, delay);
    });
    this.log(
      `[dingtalk-user] 已启动 dws 个人事件订阅（kind=${channel.kind}，pid=${child.pid ?? '?'}）：`
      + '只接收当前登录用户可见的消息，进程退出会自动重启',
    );
  }

  private scheduleRestart(channel: ChannelState, delay?: number): void {
    if (this.stopped || channel.stopped) return;
    const wait = delay ?? restartDelay(channel.attempt);
    channel.restartTimer = this.setTimeoutImpl(() => {
      channel.restartTimer = undefined;
      this.spawnChannel(channel);
    }, wait);
  }

  /** 解析 stdout 缓冲：按行切分（容忍 CRLF / 多行 JSON / 非 JSON 日志行） */
  private consume(channel: ChannelState, chunk: string, source: 'stdout' | 'stderr'): void {
    channel.buffer += chunk;
    if (channel.buffer.length > MAX_LINE_BUFFER_BYTES) {
      this.warn(`[dingtalk-user] dws 输出缓冲超过 ${MAX_LINE_BUFFER_BYTES} 字节，已丢弃旧内容（kind=${channel.kind}）`);
      channel.buffer = channel.buffer.slice(-Math.floor(MAX_LINE_BUFFER_BYTES / 2));
    }
    for (;;) {
      const idx = channel.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = channel.buffer.slice(0, idx).replace(/\r$/, '');
      channel.buffer = channel.buffer.slice(idx + 1);
      this.handleLine(channel, line, source);
    }
  }

  private handleLine(channel: ChannelState, line: string, source: 'stdout' | 'stderr'): void {
    const text = line.trim();
    if (!text) return;
    if (source === 'stderr') {
      // stderr 只记录（不当作事件）
      if (!/ready/i.test(text)) this.log(`[dingtalk-user] dws 诊断(kind=${channel.kind})：${text.slice(0, 300)}`);
      return;
    }
    const parsed = parseStreamLine(text);
    if (!parsed.event) {
      // 非 JSON 行（日志/提示）：计数即可，不刷屏
      if (text.includes('ready')) this.log(`[dingtalk-user] dws 就绪(kind=${channel.kind})：${text.slice(0, 200)}`);
      return;
    }
    void this.ingestEvent(channel, parsed.event);
  }

  private async ingestEvent(
    channel: ChannelState,
    evt: NonNullable<ReturnType<typeof parseEventLine>>,
  ): Promise<void> {
    const counters = { ignored: 0 };
    try {
      const msg = await ingestPersonalEvent(this.svc, evt, counters, this.selfOpenDingtalkId);
      if (msg) {
        this.log(
          `[dingtalk-user] 本人账号收到消息：${msg.conversation?.type === 'p2p' ? '单聊' : '群聊'}`
          + ` · 发送者=${msg.sender.name} · 类型=${msg.type}`,
        );
      }
      if (counters.ignored > 0) channel.ignoredEvents += counters.ignored;
      if (channel.ignoredEvents >= IGNORED_LOG_EVERY) {
        this.log(`[dingtalk-user] 已忽略 ${channel.ignoredEvents} 条非消息事件（审批/待办/回执等，kind=${channel.kind}）`);
        channel.ignoredEvents = 0;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.warn(`[dingtalk-user] 个人事件入库失败（kind=${channel.kind}）：${message}`);
    }
  }

  /** 优雅关闭：SIGTERM → 5s 后 taskkill /SIGKILL；返回全部子进程退出后的 Promise */
  async stop(timeoutMs = 5_000): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const waits: Promise<void>[] = [];
    for (const channel of this.channels) {
      channel.stopped = true;
      if (channel.restartTimer !== undefined) {
        this.clearTimeoutImpl(channel.restartTimer);
        channel.restartTimer = undefined;
      }
      const child = channel.child;
      if (!child || child.exitCode !== undefined && child.exitCode !== null) continue;
      waits.push(killChildTree(child, timeoutMs));
    }
    await Promise.all(waits);
    this.log('[dingtalk-user] 本人身份事件订阅已停止');
  }
}

/**
 * 终止子进程：先 SIGTERM（dws 会优雅退订），超时后 Windows 用 taskkill /T /F，
 * 其它平台 SIGKILL。绝不残留。
 */
export function killChildTree(child: SpawnedProcessLike, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    // timer 必须用 let 提前声明：Windows 上 kill() 可能同步触发 exit 事件，
    // 此时 finish() 会在 timer 初始化前执行；用 const 会导致 TDZ ReferenceError。
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    timer = setTimeout(() => {
      const pid = child.pid;
      if (process.platform === 'win32' && pid) {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => finish());
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
        finish();
      }
    }, timeoutMs);
    timer.unref?.();
  });
}

/** 启动入口：不满足条件时返回 null（并已打印中文原因） */
export function startDingtalkPersonalStream(svc: MessageService): DingtalkPersonalStream {
  const stream = new DingtalkPersonalStream(svc);
  stream.start();
  return stream;
}