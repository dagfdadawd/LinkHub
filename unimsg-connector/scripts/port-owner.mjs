#!/usr/bin/env node
/**
 * 供 start.bat 判断「占用端口的到底是不是 LinkHub 自己」的最小 helper（零依赖）。
 *
 * 为什么需要它：start.bat 以前只看端口是否被占用，重复双击时会把「上一次还没关的
 * LinkHub」误报成 "another program"，用户只能去猜/去杀进程；而 `start.bat stop`
 * 是按端口杀进程，可能误伤别人的程序。这里改为看**占用者的命令行 / 父进程链是否
 * 指向本仓库**，从而区分「自己的旧实例」和「别人的程序」：
 *
 *   check 退出码：
 *     0 = 所有端口空闲，可以启动
 *     2 = 所有端口都被 LinkHub 自己占着（= LinkHub 已在运行，直接复用/开浏览器）
 *     4 = 只有部分端口被 LinkHub 占着（残留实例，提示 restart）
 *     3 = 存在非 LinkHub / 无法判断的占用者（保持「被别的程序占用」的保守提示）
 *
 *   stop：只结束**本仓库**的监听进程（连同其子进程，如 dws），绝不碰别人的程序。
 *     0 = LinkHub 的监听进程已全部结束；2 = 还有别的程序占着端口（未动）；1 = 失败。
 *
 * 用法（由 start.bat 调用）：
 *   node scripts/port-owner.mjs check 3001 5173
 *   node scripts/port-owner.mjs stop  3001 5173
 *   [--root <dir>]  覆盖「本仓库」路径（仅供测试/诊断；默认取本脚本上一级目录）
 *
 * 说明：
 *   - 输出 ASCII only：start.bat 可能运行在 OEM 代码页，中文会被拆坏。
 *   - 仅支持 Windows（start.bat 本身就是 Windows 启动器）；非 Windows 返回 3，按
 *     「看不清占用者」保守处理，绝不乱杀进程。
 *   - 识别规则按命令行包含项目根路径、最多向上找 8 层父进程；即使监听进程本身
 *     命令行看不懂（权限不足），父进程的命令行命中也能认出来。
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 统一成小写 + 正斜杠 + 去掉末尾斜杠，便于跨命令行写法做包含匹配。 */
export function normalizePath(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 监听进程自己（或任一 node.exe 父进程，如 corepack / pnpm / tsx 包装层）的命令行里
 * 出现本仓库路径 → 认为是 LinkHub 自己的进程。
 *
 * 只看 node.exe：cmd / pwsh / powershell 等 shell 的命令行可能因为别的命令恰好包含
 * 仓库路径（例如脚本里 cd 过或引用过项目），把它们也算进来会误判成「LinkHub 的进程」。
 * LinkHub 的服务端/前端最终都是 node.exe，且其命令行必然带 node_modules 绝对路径，
 * 所以只认 node.exe 足够准。
 */
export function classifyProcess(chain, root) {
  const needle = normalizePath(root);
  if (!needle) return false;
  for (const item of chain ?? []) {
    if (normalizePath(item?.name) !== 'node.exe') continue;
    const haystack = normalizePath(item?.cmd);
    if (haystack && haystack.includes(needle)) return true;
  }
  return false;
}

/**
 * 汇总每个端口的占用情况。
 * @param {Array<{port:number, pid:number, chain:Array<{pid:number,name:string,cmd:string}>}>} rows
 * @param {number[]} ports
 * @param {string} root
 * @returns {{code: 0|2|3|4, ports: Array<{port:number, busy:boolean, owned:boolean, pid:string, name:string}>}}
 */
export function classifyPorts(rows, ports, root) {
  const byPort = new Map();
  for (const row of rows ?? []) {
    const port = Number(row?.port);
    if (!Number.isInteger(port)) continue;
    if (!byPort.has(port)) byPort.set(port, []);
    byPort.get(port).push(row);
  }

  const detail = ports.map((port) => {
    const owners = byPort.get(port) ?? [];
    if (owners.length === 0) {
      return { port, busy: false, owned: false, pid: '', name: '' };
    }
    return {
      port,
      busy: true,
      owned: owners.every((row) => classifyProcess(row.chain, root)),
      pid: owners.map((row) => (row.pid ?? '?')).join(','),
      name: owners.map((row) => (row.chain?.[0]?.name ?? 'unknown')).join(','),
    };
  });

  const busy = detail.filter((item) => item.busy);
  if (busy.length === 0) return { code: 0, ports: detail };
  if (busy.some((item) => !item.owned)) return { code: 3, ports: detail };
  if (busy.length === ports.length) return { code: 2, ports: detail };
  return { code: 4, ports: detail };
}

/** PowerShell 探针：端口 → 监听 PID → 最多 8 层父进程的 名称/命令行，输出 JSON。 */
function buildProbeScript(ports) {
  const list = `@(${ports.map((port) => Number(port)).join(',')})`;
  return `
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ports = ${list}
$rows = @()
foreach ($port in $ports) {
  $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  foreach ($conn in $conns) {
    $ownerPid = [int]$conn.OwningProcess
    $chain = @()
    $cursor = $ownerPid
    for ($i = 0; $i -lt 8 -and $cursor -gt 0; $i++) {
      $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $cursor) -ErrorAction SilentlyContinue
      if (-not $proc) { break }
      $chain += [pscustomobject]@{
        pid = [int]$proc.ProcessId
        name = [string]$proc.Name
        cmd = [string]$proc.CommandLine
      }
      $cursor = [int]$proc.ParentProcessId
    }
    $rows += [pscustomobject]@{ port = $port; pid = $ownerPid; chain = $chain }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 6
`.trim();
}

/** 依次尝试 pwsh 7、Windows PowerShell 5.1（start.bat 也要能在没装 pwsh 的机器上跑）。 */
function runPowerShell(script) {
  const failures = [];
  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    try {
      return execFileSync(
        exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      failures.push(`${exe}: ${error?.code ?? error?.message ?? 'failed'}`);
    }
  }
  throw new Error(failures.join('; ') || 'PowerShell not available');
}

function readListeners(ports) {
  if (process.platform !== 'win32') {
    throw new Error('port owner inspection is Windows-only (start.bat is a Windows launcher)');
  }
  const raw = runPowerShell(buildProbeScript(ports));
  const text = String(raw ?? '').trim();
  if (!text || text === '[]' || text === 'null') return [];
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter((row) => row && Number.isInteger(Number(row.port)));
}

function killTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 15000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function describePort(item) {
  if (!item.busy) return `[port] ${item.port} free`;
  if (item.owned) return `[port] ${item.port} busy: LinkHub (pid ${item.pid}, ${item.name})`;
  return `[port] ${item.port} busy: another program (pid ${item.pid || '?'}, ${item.name || 'unknown'}) - NOT LinkHub`;
}

function runCheck(ports, root) {
  let rows;
  try {
    rows = readListeners(ports);
  } catch (error) {
    // 看不清占用者 = 保守当成「被占用」，绝不继续启动（避免 EADDRINUSE 英文栈）。
    console.log(`[port] cannot inspect port owners: ${String(error?.message ?? error).split('\n')[0]}`);
    console.log('[port] treating ports as occupied to avoid killing or colliding with anything');
    return 3;
  }
  const result = classifyPorts(rows, ports, root);
  for (const item of result.ports) console.log(describePort(item));
  return result.code;
}

function runStop(ports, root) {
  const stopped = new Set();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    let rows;
    try {
      rows = readListeners(ports);
    } catch (error) {
      console.log(`[port] cannot inspect port owners: ${String(error?.message ?? error).split('\n')[0]}`);
      return 1;
    }
    const result = classifyPorts(rows, ports, root);
    if (result.code === 0 || result.code === 3) break;

    let killedAny = false;
    for (const row of rows) {
      const pid = Number(row?.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === process.pid || pid === process.ppid) continue; // 绝不动自己和直接父进程
      if (!classifyProcess(row.chain, root)) continue;
      if (stopped.has(pid)) continue;
      const name = row.chain?.[0]?.name ?? 'process';
      if (killTree(pid)) {
        stopped.add(pid);
        killedAny = true;
        console.log(`[port] stopped LinkHub process pid=${pid} (${name}) on port ${row.port}`);
      }
    }
    if (!killedAny && result.code === 2) {
      // 端口都在自己手里但杀不动（权限等）：留给下面统一报失败
      break;
    }
    sleep(400);
  }

  let finalRows;
  try {
    finalRows = readListeners(ports);
  } catch (error) {
    console.log(`[port] cannot re-check port owners: ${String(error?.message ?? error).split('\n')[0]}`);
    return 1;
  }
  const finalResult = classifyPorts(finalRows, ports, root);
  const ownedLeft = finalResult.ports.filter((item) => item.busy && item.owned);
  if (ownedLeft.length > 0) {
    for (const item of ownedLeft) console.log(`[port] ${item.port} still held by LinkHub (pid ${item.pid}); stop it manually`);
    return 1;
  }
  const foreign = finalResult.ports.filter((item) => item.busy && !item.owned);
  if (foreign.length > 0) {
    for (const item of foreign) console.log(describePort(item));
    return 2;
  }
  if (stopped.size === 0) console.log('[port] no LinkHub process was listening on those ports');
  return 0;
}

function parseCli(argv) {
  const args = [...argv];
  let root = process.env.LINKHUB_PORT_OWNER_ROOT
    ? resolve(process.env.LINKHUB_PORT_OWNER_ROOT)
    : DEFAULT_ROOT;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root') {
      i += 1;
      if (args[i]) root = resolve(args[i]);
      continue;
    }
    rest.push(args[i]);
  }
  const action = (rest.shift() ?? 'check').toLowerCase();
  const ports = rest.map((value) => Number(value));
  return { action, ports, root };
}

function main() {
  const { action, ports, root } = parseCli(process.argv.slice(2));
  const validPorts =
    ports.length > 0 && ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  if (!validPorts) {
    console.error('[port] usage: node scripts/port-owner.mjs check|stop <port> [port ...]');
    // 3 = 保守：调用方（start.bat）会当成「端口不可用」处理，而不是继续启动。
    return 3;
  }
  if (action === 'check') return runCheck(ports, root);
  if (action === 'stop') return runStop(ports, root);
  console.error(`[port] unknown action "${action}"; use check or stop`);
  return 3;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  process.exitCode = main();
}
