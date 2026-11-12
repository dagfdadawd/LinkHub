/**
 * 邮箱账号「测试连接」：只做 IMAP 登录 + SMTP 登录自检，绝不发信、绝不落盘、绝不打印授权码。
 *
 * 复用 doctor 的探针（同一个生产客户端、同一套中文错误解释），保证账号页测试结果与自检一致。
 */
import type { Platform } from '@unimsg/shared';
import { createMailAccountFromInput, type MailAccount, type MailAccountInput } from '../config/runtime';
import { probeMailAccount } from '../doctor/probes';
import type { CheckResult } from '../doctor/report';
import { maskMailAddress } from './mailAccounts';

export interface MailTestLeg {
  ok: boolean;
  /** 中文说明（已脱敏） */
  detail: string;
  /** 中文修复建议（失败时给） */
  hint?: string;
}

export interface MailAccountTestResult {
  ok: boolean;
  address: string;
  provider: string;
  imap: MailTestLeg;
  smtp: MailTestLeg;
  checkedAt: string;
}

export interface MailAccountTestDeps {
  /** 单测注入：不连真实网络（默认 probeMailAccount，走真实 IMAP/SMTP 登录自检） */
  probe?: (account: MailAccount) => Promise<CheckResult[]>;
  /** 单测注入时钟 */
  now?: () => number;
}

/** 把探针 CheckResult 收敛成一个 leg；缺失对应探针视为失败（绝不假成功） */
function toLeg(checks: CheckResult[], suffix: ':imap' | ':smtp', label: string): MailTestLeg {
  const check = checks.find((c) => c.id.endsWith(suffix));
  if (!check) {
    return { ok: false, detail: `${label} 自检未返回结果（内部错误：探针缺失）`, hint: '请重试；若持续出现请反馈日志。' };
  }
  return {
    ok: check.status === 'PASS',
    detail: check.detail,
    ...(check.hint ? { hint: check.hint } : {}),
  };
}

/**
 * 校验输入 + 测试连接（返回结构化结果，不抛网络错）。
 * - 输入不合法 → { errors }（路由 400，中文逐条）
 * - 校验通过 → 总是返回 result（ok 可能是 false，附带可操作 hint；HTTP 仍是 200，避免把「授权码错了」报成服务端 500）
 */
export async function testMailAccountInput(
  input: MailAccountInput,
  deps: MailAccountTestDeps = {},
): Promise<{ errors?: string[]; result?: MailAccountTestResult }> {
  const built = createMailAccountFromInput(input);
  if (!built.account) return { errors: built.errors };
  const account = built.account;
  const probe = deps.probe ?? ((acc: MailAccount) => probeMailAccount(acc));
  let checks: CheckResult[];
  try {
    checks = await probe(account);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      result: {
        ok: false,
        address: maskMailAddress(account.address),
        provider: account.provider,
        imap: { ok: false, detail: `IMAP 自检失败：${message}`, hint: '检查网络/代理后重试；也可先在邮箱网页端确认 IMAP 服务已开启。' },
        smtp: { ok: false, detail: 'SMTP 自检未执行（IMAP 阶段已出错）' },
        checkedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
      },
    };
  }
  const imap = toLeg(checks, ':imap', 'IMAP');
  const smtp = toLeg(checks, ':smtp', 'SMTP');
  return {
    result: {
      ok: imap.ok && smtp.ok,
      address: maskMailAddress(account.address),
      provider: account.provider,
      imap,
      smtp,
      checkedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    },
  };
}

/** 仅用于展示的占位类型（避免把 Platform 值泄露到上层） */
export type MailTestPlatform = Platform;