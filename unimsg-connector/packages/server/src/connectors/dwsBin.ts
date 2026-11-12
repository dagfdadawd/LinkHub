/**
 * 钉钉官方 CLI（dws）可执行文件统一解析。
 *
 * 目的：个人版用户不用自己配 DWS_BIN / 装到 PATH 也能用——LinkHub 内置/自动发现 dws。
 *
 * 候选顺序（命中即返回，`source` 如实标注来源，绝不假装找到）：
 *  1. `DWS_BIN`（显式，优先；可带参数，如 `node scripts/fake-dws.mjs`）
 *  2. `LINKHUB_TOOLS_DIR/dws(.exe)`
 *  3. 仓库根 `tools/dws(.exe)`（`pnpm run fetch:dws` 下载到这里）
 *  4. `%USERPROFILE%\.local\bin\dws.exe`（或 `~/.local/bin/dws`）
 *  5. PATH 中的 `dws`（找不到则 source='missing'）
 *
 * 本模块只做「定位」，不跑进程、不读 token；是否可用（版本/登录态）由探测层决定。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** dws 来源（onboarding/doctor 如实展示） */
export type DwsBinSource = 'env' | 'tools' | 'user_profile' | 'path' | 'missing';

export interface ResolvedDwsBin {
  /** 传给子进程的可执行文件/命令（可能带参数，如 `node scripts/fake-dws.mjs`） */
  bin: string;
  source: DwsBinSource;
  /** 解析到的可执行文件路径（source=env 时为原值；missing 时为空串） */
  path?: string;
  /** 人话来源说明（onboarding 展示） */
  pathHint?: string;
}

export interface ResolveDwsBinOptions {
  /** 仓库根（单测注入；默认按本文件位置解析到 unimsg-connector/） */
  monorepoRoot?: string;
  /** 用户目录（单测注入；默认 os.homedir()） */
  homeDir?: string;
  /** 单测注入文件存在性判断 */
  existsImpl?: (path: string) => boolean;
  /** 单测注入 PATH 探测 */
  pathCheckImpl?: () => boolean;
  /** 平台（单测注入；默认 process.platform） */
  platform?: NodeJS.Platform;
}

/** 内置工具目录环境变量（可把 dws 放到自定义目录） */
export const LINKHUB_TOOLS_DIR_ENV = 'LINKHUB_TOOLS_DIR';

/** 默认仓库根：本文件位于 packages/server/src/connectors/，向上 4 层到 unimsg-connector/ */
export function defaultMonorepoRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

/** `tools/` 目录（fetch-dws 下载目标） */
export function defaultToolsDir(monorepoRoot = defaultMonorepoRoot()): string {
  return join(monorepoRoot, 'tools');
}

/** PATH 里是否有 dws（where/which） */
function dwsOnPath(platform: NodeJS.Platform): boolean {
  const cmd = platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, ['dws'], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
    return r.status === 0 && Boolean(String(r.stdout ?? '').trim());
  } catch {
    return false;
  }
}

/**
 * 解析 dws 可执行文件。纯函数式（文件系统/PATH 探测可注入），不抛错。
 */
export function resolveDwsBin(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveDwsBinOptions = {},
): ResolvedDwsBin {
  const platform = opts.platform ?? process.platform;
  const isWin = platform === 'win32';
  const exists = opts.existsImpl ?? ((p: string) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
  const names = isWin ? ['dws.exe', 'dws'] : ['dws'];

  // 1) 显式 DWS_BIN：原样使用（可带参数/相对脚本），不校验存在性（由探测层报中文错误）
  const envBin = (env.DWS_BIN ?? '').trim();
  if (envBin) {
    return { bin: envBin, source: 'env', path: envBin, pathHint: 'DWS_BIN（.env 显式指定）' };
  }

  // 2/3/4) 固定目录候选
  const toolsEnv = (env[LINKHUB_TOOLS_DIR_ENV] ?? '').trim();
  const monorepoRoot = opts.monorepoRoot ?? defaultMonorepoRoot();
  const candidates: { dir: string; source: 'tools' | 'user_profile'; hint: string }[] = [];
  if (toolsEnv) {
    candidates.push({
      dir: isAbsolute(toolsEnv) ? toolsEnv : resolve(toolsEnv),
      source: 'tools',
      hint: `${LINKHUB_TOOLS_DIR_ENV}=${toolsEnv}`,
    });
  }
  candidates.push({ dir: join(monorepoRoot, 'tools'), source: 'tools', hint: '仓库 tools/（pnpm run fetch:dws 下载位置）' });
  candidates.push({ dir: join(opts.homeDir ?? homedir(), '.local', 'bin'), source: 'user_profile', hint: '~/.local/bin' });

  for (const candidate of candidates) {
    for (const name of names) {
      const path = join(candidate.dir, name);
      if (exists(path)) {
        return { bin: path, source: candidate.source, path, pathHint: candidate.hint };
      }
    }
  }

  // 5) PATH
  const onPath = opts.pathCheckImpl ? opts.pathCheckImpl() : dwsOnPath(platform);
  if (onPath) {
    return {
      bin: 'dws',
      source: 'path',
      path: 'dws',
      pathHint: `PATH 中的 dws${isWin ? '.exe' : ''}`,
    };
  }

  // 6) 都没有：bin 仍返回 'dws'（探测层会得到 ENOENT → 中文安装提示），source 如实标 missing
  return {
    bin: 'dws',
    source: 'missing',
    path: '',
    pathHint: [
      '未找到 dws。已自动查找：DWS_BIN → LINKHUB_TOOLS_DIR → 仓库 tools/ → ~/.local/bin → PATH。',
      '个人版可运行 `pnpm run fetch:dws` 一键下载到 tools/（桌面版会内置）。',
    ].join(''),
  };
}