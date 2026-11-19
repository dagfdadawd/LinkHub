/**
 * 微信 RPA 桥的「本机进程管理」（A 形态：后端与微信桌面端在同一台机器）。
 *
 * 只做三件事：探测、启动、停止。进程参数全部由服务端固定，不接受前端传命令；
 * 桥仍只监听 127.0.0.1，和现有 connector 的信任边界一致。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { config, monorepoRoot } from '../config';
import { bridgeUrl } from '../connectors/wechat';
import {
  probeWechatBridge,
  type WechatBridgeStatus,
} from './wechatBridge';

export interface WechatBridgeProcessView {
  /** 是否由本进程启动（外部手动启动的桥 managed=false，不能从这里 stop） */
  managed: boolean;
  pid?: number;
  url: string;
  logPath: string;
  bridge: WechatBridgeStatus;
}

export interface WechatBridgeStartView extends WechatBridgeProcessView {
  started: boolean;
  alreadyRunning?: boolean;
  error?: string;
}

export interface WechatBridgeStopView extends WechatBridgeProcessView {
  stopped: boolean;
  error?: string;
}

export interface WechatBridgeManagerDeps {
  probe: (opts?: { timeoutMs?: number; url?: string }) => Promise<WechatBridgeStatus>;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  wait: (ms: number) => Promise<void>;
  scriptPath: string;
  python: string;
  host: string;
  port: number;
  linkhubBase: string;
  logPath: string;
  /** 记录本进程启动的桥 PID，后端重启后可继续管理同一个桥 */
  pidPath: string;
  platform: NodeJS.Platform;
}

export interface WechatBridgeManager {
  status(): Promise<WechatBridgeProcessView>;
  start(): Promise<WechatBridgeStartView>;
  stop(): Promise<WechatBridgeStopView>;
}

const jsonUrl = (host: string, port: number): string => {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${h}:${port}`;
};

/** 桥只允许本机地址；A 形态不做远程桥（避免把任意进程接口暴露出去）。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function endpoint(): { host: string; port: number } {
  try {
    const u = new URL(bridgeUrl());
    return { host: u.hostname, port: Number(u.port || 8787) };
  } catch {
    return { host: '127.0.0.1', port: 8787 };
  }
}

function logTail(path: string, max = 1600): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.slice(-max).trim();
  } catch {
    return '';
  }
}

export function createWechatBridgeManager(deps: WechatBridgeManagerDeps): WechatBridgeManager {
  let child: ChildProcess | null = null;
  let pid: number | undefined;
  let adoptedPid: number | undefined;
  let starting = false;

  const url = jsonUrl(deps.host, deps.port);

  function removePidFile(): void {
    try {
      unlinkSync(deps.pidPath);
    } catch {
      // 文件可能已被清理；忽略
    }
  }

  function alivePid(candidate: number | undefined): number | undefined {
    if (!candidate || candidate <= 0) return undefined;
    try {
      process.kill(candidate, 0);
      return candidate;
    } catch {
      return undefined;
    }
  }

  function readAdoptedPid(): number | undefined {
    try {
      const value = Number(readFileSync(deps.pidPath, 'utf8').trim());
      const alive = alivePid(value);
      if (!alive) removePidFile();
      return alive;
    } catch {
      return undefined;
    }
  }

  function currentPid(): number | undefined {
    if (child && child.exitCode === null && !child.killed) return child.pid;
    if (adoptedPid === undefined) adoptedPid = readAdoptedPid();
    return adoptedPid;
  }

  async function status(): Promise<WechatBridgeProcessView> {
    const bridge = await deps.probe({ url, timeoutMs: 900 });
    const active = currentPid();
    return {
      managed: Boolean(active),
      ...(active ? { pid: active } : {}),
      url,
      logPath: deps.logPath,
      bridge,
    };
  }

  async function start(): Promise<WechatBridgeStartView> {
    const before = await deps.probe({ url, timeoutMs: 600 });
    if (before.reachable) {
      return {
        ...(await status()),
        started: false,
        alreadyRunning: true,
        ...(before.mode !== 'rpa'
          ? { error: `RPA 桥已在 ${before.mode ?? '未知'} 模式运行，请先手动停止再用 --mode rpa 启动` }
          : {}),
      };
    }
    if (!isLoopbackHost(deps.host)) {
      return {
        ...(await status()),
        started: false,
        error: 'A 形态只允许启动本机 RPA 桥（127.0.0.1 / localhost / ::1）',
      };
    }
    if (!existsSync(deps.scriptPath)) {
      return { ...(await status()), started: false, error: `找不到桥脚本：${deps.scriptPath}` };
    }
    if (starting || (child && child.exitCode === null && !child.killed)) {
      return { ...(await status()), started: false, error: 'RPA 桥正在启动中，请稍后再试' };
    }

    starting = true;
    try {
      mkdirSync(dirname(deps.logPath), { recursive: true });
      const fd = openSync(deps.logPath, 'a');
      let proc: ChildProcess;
      try {
        proc = deps.spawn(
          deps.python,
          [
            deps.scriptPath,
            '--mode', 'rpa',
            '--port', String(deps.port),
            '--linkhub', deps.linkhubBase,
          ],
          {
            cwd: dirname(deps.scriptPath),
            detached: true,
            windowsHide: true,
            stdio: ['ignore', fd, fd],
          },
        );
      } finally {
        closeSync(fd);
      }
      child = proc;
      pid = proc.pid;
      adoptedPid = undefined;
      if (proc.pid) {
        mkdirSync(dirname(deps.pidPath), { recursive: true });
        writeFileSync(deps.pidPath, String(proc.pid), 'utf8');
      }
      proc.once('exit', () => {
        if (pid === proc.pid) {
          child = null;
          pid = undefined;
          removePidFile();
        }
      });
      proc.unref();

      // 最多等 5 秒；桥启动失败时把日志尾部带给界面，而不是只说“启动失败”。
      for (let i = 0; i < 20; i += 1) {
        await deps.wait(250);
        const now = await deps.probe({ url, timeoutMs: 500 });
        if (now.reachable) {
          return { ...(await status()), started: true };
        }
        if (proc.exitCode !== null) break;
      }
      const tail = logTail(deps.logPath);
      return {
        ...(await status()),
        started: false,
        error: `RPA 桥启动超时或提前退出${tail ? `；日志：${tail}` : '；请检查 Python 依赖与微信登录状态'}`,
      };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { ...(await status()), started: false, error: `启动 RPA 桥失败：${detail}` };
    } finally {
      starting = false;
    }
  }

  async function stop(): Promise<WechatBridgeStopView> {
    const active = currentPid();
    if (!active) {
      return {
        ...(await status()),
        stopped: false,
        error: 'RPA 桥不是由 LinkHub 启动的（可能是手动启动），请在桥终端里停止',
      };
    }
    try {
      if (child && child.exitCode === null && !child.killed) {
        child.kill(deps.platform === 'win32' ? undefined : 'SIGTERM');
      } else {
        // 后端重启后 child 句柄丢失，但 PID 文件还在：按 PID 停止同一个桥。
        process.kill(active, deps.platform === 'win32' ? undefined : 'SIGTERM');
      }
      await deps.wait(300);
      child = null;
      pid = undefined;
      adoptedPid = undefined;
      removePidFile();
      return { ...(await status()), stopped: true };
    } catch (e) {
      return {
        ...(await status()),
        stopped: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return { status, start, stop };
}

function singleton(): WechatBridgeManager {
  const { host, port } = endpoint();
  const logPath = join(monorepoRoot, '.wechat-rpa', 'bridge.log');
  const pidPath = join(monorepoRoot, '.wechat-rpa', 'bridge.pid');
  return createWechatBridgeManager({
    probe: (opts) => probeWechatBridge(opts),
    spawn,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    scriptPath: join(monorepoRoot, 'scripts', 'wechat-rpa', 'rpa_bridge.py'),
    python: (process.env.WECHAT_PYTHON ?? '').trim() || (process.platform === 'win32' ? 'python' : 'python3'),
    host,
    port: Number.isFinite(port) && port > 0 ? port : 8787,
    linkhubBase: `http://127.0.0.1:${config.port}`,
    logPath,
    pidPath,
    platform: process.platform,
  });
}

let manager: WechatBridgeManager | null = null;

export function wechatBridgeManager(): WechatBridgeManager {
  if (!manager) manager = singleton();
  return manager;
}
