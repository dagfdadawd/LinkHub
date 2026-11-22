/**
 * doctor 命令行参数解析（纯函数，可单测）。
 *
 * 单独成模块的原因：doctor.ts 在模块加载时会直接执行自检，
 * 单测若从它导入会把整轮探针跑一遍（触网）。
 */
import { Platform } from '@unimsg/shared';

export interface CliOptions {
  /** --json：stdout 只输出合法 JSON（人类提示走 stderr；文本报告不再输出） */
  json: boolean;
  help: boolean;
  /** --out=<路径>：同一份报告额外落盘（写入 docs/verification 或指定文件） */
  out?: string;
  platformFilter?: Platform[];
}

/** 解析命令行参数（参数少，手写即可；不引入依赖） */
export function parseCliArgs(argv: string[]): { options: CliOptions; error?: string } {
  const options: CliOptions = { json: false, help: false };
  let platformSeen = false;
  let outSeen = false;
  for (const arg of argv) {
    // pnpm 会把 `pnpm run doctor -- --platform=...` 里的 `--` 原样透传给脚本，
    // 这里直接忽略：有没有分隔符都按同一套参数解析，避免新手照文档敲却报「未知参数」。
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--out=')) {
      if (outSeen) {
        return { options, error: '重复指定 --out；一次自检写一个报告文件即可' };
      }
      outSeen = true;
      const raw = arg.slice('--out='.length).trim();
      if (!raw) {
        return { options, error: '--out 需要一个文件路径，例如 --out=docs/verification/doctor.json（不传则用默认时间戳文件名）' };
      }
      options.out = raw;
    } else if (arg.startsWith('--platform=')) {
      if (platformSeen) {
        return { options, error: '重复指定 --platform；请合并为一个列表，例如 --platform=feishu,mail' };
      }
      platformSeen = true;
      const raw = arg.slice('--platform='.length).trim();
      // 逗号为主；同时容忍空格（部分 shell 会把 a,b 拆成 "a b" 再传进来）
      const items = raw
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (items.length === 0) {
        return { options, error: '--platform 需要一个平台列表，例如 --platform=feishu,mail' };
      }
      const valid = Object.values(Platform) as string[];
      const unknown = items.filter((item) => !valid.includes(item));
      if (unknown.length > 0) {
        return { options, error: `未知平台：${unknown.join(', ')}（可选：${valid.join(', ')}）` };
      }
      options.platformFilter = [...new Set(items)] as Platform[];
    } else {
      return { options, error: `未知参数：${arg}` };
    }
  }
  return { options };
}
