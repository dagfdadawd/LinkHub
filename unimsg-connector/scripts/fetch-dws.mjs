#!/usr/bin/env node
/**
 * 一键下载钉钉官方 CLI（dws）到 `unimsg-connector/tools/`，供 LinkHub 个人版内置使用。
 *
 * 为什么需要：dws 是钉钉个人身份（本人账号收/发）的官方依赖，个人版用户不该自己找 release、解压、配 PATH。
 * 下载后 server 的 `resolveDwsBin()` 会自动发现 `tools/dws.exe`（source=tools），无需改 .env。
 *
 * 用法：
 *   pnpm run fetch:dws                # 默认 v1.0.68-beta.1，Windows x64
 *   pnpm run fetch:dws -- --force     # 已存在也重新下载/覆盖
 *   DWS_VERSION=v1.0.68 pnpm run fetch:dws          # 换版本（官方 tag）
 *   DWS_DOWNLOAD_URL=<zip 直链> pnpm run fetch:dws  # 完全自定义下载地址
 *   DWS_DEST_DIR=<目录> pnpm run fetch:dws          # 换安装目录（默认 仓库 tools/）
 *
 * 行为：下载 zip → 解压 → 找到 dws(.exe) → 放到目标目录 → 执行 `dws version` 校验。
 * 失败一律中文提示并 exit 1；不写入任何凭据、不触碰用户登录态。
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const REPO = 'DingTalk-Real-AI/dingtalk-workspace-cli';
const DEFAULT_VERSION = 'v1.0.68-beta.1';
const VERSION = (process.env.DWS_VERSION ?? '').trim() || DEFAULT_VERSION;
const IS_WIN = process.platform === 'win32';
const ASSET = IS_WIN ? 'dws-windows-amd64.zip' : `dws-${process.platform}-${process.arch}.tar.gz`;
const DIRECT_URL = `https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}`;
const API_TAG_URL = `https://api.github.com/repos/${REPO}/releases/tags/${VERSION}`;
const USER_AGENT = 'linkhub-fetch-dws';
/** 仓库根：本文件位于 unimsg-connector/scripts/ */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEST_DIR = (process.env.DWS_DEST_DIR ?? '').trim() || join(REPO_ROOT, 'tools');
const EXE_NAME = IS_WIN ? 'dws.exe' : 'dws';
const FORCE = process.argv.includes('--force') || process.argv.includes('-f');

function fail(message, hint) {
  console.error(`\n[fetch:dws] ✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function info(message) {
  console.log(`[fetch:dws] ${message}`);
}

/** 递归找 dws 可执行文件 */
function findDws(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === EXE_NAME.toLowerCase()) {
        return full;
      }
    }
  }
  return null;
}

/** 解压：优先 tar（Windows 10+/macOS/Linux 自带 bsdtar，支持 zip），失败回退 PowerShell Expand-Archive */
function extract(archive, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tar = spawnSync('tar', ['-xf', archive, '-C', destDir], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (tar.status === 0) return;
  if (IS_WIN) {
    const ps = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    if (ps.status === 0) return;
    fail(
      '解压失败（tar 与 PowerShell Expand-Archive 都失败）。',
      `可手动解压 ${archive}，把 ${EXE_NAME} 放到 ${DEST_DIR} 后重试；或设置 DWS_BIN 指向已有 dws。`,
    );
  }
  fail('解压失败（系统 tar 不可用）。', `请手动解压 ${archive}，把 ${EXE_NAME} 放到 ${DEST_DIR} 后重试。`);
}

/** 跑 `dws version` 校验可执行 + 打印版本 */
function verify(exePath) {
  const r = spawnSync(exePath, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (r.error) {
    fail(
      `下载的 dws 无法执行：${r.error.message}`,
      '可能是杀毒软件拦截 / 下载不完整 / 架构不匹配。可删除后重试，或设置 DWS_BIN 指向可用的 dws。',
    );
  }
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    fail(`dws version 校验失败（exit=${r.status}）：${text.trim().slice(0, 400)}`, `文件位置：${exePath}`);
  }
  const version = text.match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? '(未能解析版本号)';
  return version;
}

/** 解析下载入口：优先 GitHub API 资产地址（重定向到 release-assets 域，网络更稳），失败回退直链 */
async function resolveDownloadTarget() {
  const explicit = (process.env.DWS_DOWNLOAD_URL ?? '').trim();
  if (explicit) return { url: explicit, headers: { 'User-Agent': USER_AGENT }, fallbackUrl: null, label: 'DWS_DOWNLOAD_URL' };

  try {
    const res = await fetch(API_TAG_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const json = await res.json();
      const asset = Array.isArray(json.assets) ? json.assets.find((a) => a && a.name === ASSET) : undefined;
      if (asset && asset.url) {
        info(`GitHub release ${VERSION}：找到资产 ${ASSET}（${(Number(asset.size ?? 0) / 1024 / 1024).toFixed(1)} MB）`);
        return {
          url: asset.url,
          headers: { Accept: 'application/octet-stream', 'User-Agent': USER_AGENT },
          fallbackUrl: asset.browser_download_url || DIRECT_URL,
          label: 'GitHub API 资产地址',
        };
      }
      info(`GitHub API 未找到资产 ${ASSET}（可能版本 tag 写错），改用直链`);
    } else {
      info(`GitHub API 返回 HTTP ${res.status}，改用直链`);
    }
  } catch (e) {
    info(`GitHub API 不可用（${e instanceof Error ? e.message : String(e)}），改用直链`);
  }
  return { url: DIRECT_URL, headers: { 'User-Agent': USER_AGENT }, fallbackUrl: null, label: 'GitHub 直链' };
}

/** 用 curl 兜底下载（系统自带 curl；应对 Node fetch 的代理/TLS 差异） */
function curlDownload(url, headers, targetFile) {
  const args = ['-L', '--fail', '--silent', '--show-error', '--max-time', '300', '-o', targetFile];
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'utf8', windowsHide: true, timeout: 310_000 });
  return r.status === 0 && existsSync(targetFile);
}

async function download(target, targetFile) {
  const attempts = [`${target.label}：${target.url}`];
  if (target.fallbackUrl) attempts.push(`直链兜底：${target.fallbackUrl}`);

  const tryFetch = async (url, headers) => {
    const res = await fetch(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(300_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(targetFile));
  };

  try {
    info(`下载（${target.label}）…`);
    await tryFetch(target.url, target.headers);
  } catch (firstError) {
    info(`首次下载失败：${firstError instanceof Error ? firstError.message : String(firstError)}`);
    let ok = false;
    if (target.fallbackUrl) {
      try {
        info('尝试直链兜底…');
        await tryFetch(target.fallbackUrl, target.headers);
        ok = true;
      } catch (secondError) {
        info(`直链兜底也失败：${secondError instanceof Error ? secondError.message : String(secondError)}`);
      }
    }
    if (!ok) {
      info('尝试系统 curl 兜底…');
      const urlForCurl = target.fallbackUrl || target.url;
      if (!curlDownload(urlForCurl, target.headers, targetFile)) {
        fail(
          '下载 dws 失败（网络无法访问 GitHub release）。',
          [
            `已尝试：${attempts.join('；')}；以及系统 curl。`,
            '解决建议：① 检查网络/代理（公司网络可能需要代理）；② 用浏览器手动打开 release 页面下载对应 zip；',
            `③ 解压后把 ${EXE_NAME} 放到 ${DEST_DIR}（或任意目录并用 DWS_BIN 指向它）；④ 也可以设置 DWS_DOWNLOAD_URL 为可访问的镜像直链。`,
          ].join('\n  '),
        );
      }
    }
  }
  const size = statSync(targetFile).size;
  if (size < 1_000_000) {
    fail(`下载文件过小（${size} 字节），疑似失败/被劫持。`, '请检查网络后重试；公司网络可能需要代理。');
  }
  info(`下载完成（${(size / 1024 / 1024).toFixed(1)} MB）`);
}

async function main() {
  info(`目标目录：${DEST_DIR}`);
  info(`版本：${VERSION}（可用 DWS_VERSION / DWS_DOWNLOAD_URL 覆盖）`);

  const destExe = join(DEST_DIR, EXE_NAME);
  if (existsSync(destExe) && !FORCE) {
    try {
      const version = verify(destExe);
      info(`已存在 ${destExe}（版本 ${version}），无需重复下载。需要重新下载请加 --force。`);
      return;
    } catch {
      info('已存在但校验失败，将重新下载…');
    }
  }

  if (!IS_WIN && !process.env.DWS_DOWNLOAD_URL) {
    fail(
      `当前脚本默认只处理 Windows x64（当前平台 ${process.platform}/${process.arch}）。`,
      'macOS/Linux 用户请到 GitHub release 手动下载对应压缩包解压后用 DWS_BIN 指定，或设置 DWS_DOWNLOAD_URL 为对应资产的直链后重试。',
    );
  }

  mkdirSync(DEST_DIR, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'linkhub-fetch-dws-'));
  const archive = join(workDir, ASSET);
  const extractDir = join(workDir, 'extract');

  try {
    const target = await resolveDownloadTarget();
    await download(target, archive);
    info('解压中…');
    extract(archive, extractDir);
    const found = findDws(extractDir);
    if (!found) {
      fail(`压缩包里没找到 ${EXE_NAME}。`, `已解压到 ${extractDir}，请检查下载地址是否为 dws 官方 release 资产。`);
    }
    // 覆盖安装：先删旧文件（Windows 上正在运行的 exe 可能被占用 → 给中文提示）
    if (existsSync(destExe)) {
      try {
        rmSync(destExe, { force: true });
      } catch (e) {
        fail(
          `无法覆盖已有 ${destExe}：${e instanceof Error ? e.message : String(e)}`,
          '可能有 LinkHub/dws 进程正在使用它：先停止 LinkHub（Ctrl+C）再重试。',
        );
      }
    }
    renameSync(found, destExe);
    if (!IS_WIN) {
      try {
        spawnSync('chmod', ['755', destExe]);
      } catch { /* 忽略：非致命 */ }
    }
    const version = verify(destExe);
    info(`✓ dws 已安装到 ${destExe}（版本 ${version}）`);
    info('后续无需改 .env：server 会自动发现 tools/ 下的 dws（/api/onboarding 的 dws.source=tools）。');
    info('下一步：打开 LinkHub →「平台账号 / 连接账号」→ 钉钉 →「用浏览器登录（推荐）」。');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  fail(`未预期错误：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
});