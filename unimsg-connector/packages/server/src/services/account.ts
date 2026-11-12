/**
 * 账号/凭据状态（只读视图，供前端展示"每个平台现在到底走真实接口还是 Mock"）。
 *
 * 安全约定：只返回布尔值、环境变量名、脱敏后的邮箱地址；
 * 绝不返回任何密钥 / 授权码 / 令牌 / 完整工号。
 */
import { Platform, type DeliveryMode, type PlatformIdentityView } from '@unimsg/shared';
import { config } from '../config';
import { mailAccountSummary } from '../config/runtime';
import { peekMailAccounts } from './mailAccounts';
import { resolveIdentity } from './identity';

export interface MailAccountView {
  key: string;
  label: string;
  address: string;
  provider: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  folders: string[];
  /** 该邮箱账号本次实际走的通道（与平台整体一致） */
  mode: DeliveryMode;
}

export interface AccountView {
  platform: Platform;
  label: string;
  /** 凭据是否足以真实工作（能否真实发送） */
  configured: boolean;
  /** 请求的策略 auto / real / mock */
  policy: string;
  /** 本次实际通道 real / mock */
  mode: DeliveryMode;
  canReceive: boolean;
  canSend: boolean;
  /** 缺失的环境变量名（不含值） */
  missing: string[];
  /** 能力缺口警告（例如只能发不能收、60020 风险） */
  warnings: string[];
  /** 人类可读的解析理由 */
  reason: string;
  /** 仅邮箱平台：已配置的邮箱账号明细（地址会脱敏中间部分） */
  accounts?: MailAccountView[];
  /** 邮箱配置问题（缺授权码、host 未填等） */
  issues?: { level: 'error' | 'warn'; message: string }[];
  /**
   * 仅飞书 / 钉钉：完整身份视图（本人 / 机器人 / 模拟 + 连接状态 + 修复提示）。
   * 前端据此渲染「接收身份 / 发送身份」标签与连接按钮，无需自己推导策略。
   */
  identity?: PlatformIdentityView;
}

/** 脱敏邮箱地址：只保留首字符与域名，避免把账号明文贴进截图/日志 */
export function maskAddress(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return address;
  const name = address.slice(0, at);
  const domain = address.slice(at);
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, name.length - 1)))}${domain}`;
}

export function listAccounts(): AccountView[] {
  return Object.values(Platform).map((platform) => {
    const r = config.runtime[platform];
    const view: AccountView = {
      platform,
      label: r.label,
      configured: r.configured,
      policy: r.policy,
      mode: r.mode,
      canReceive: r.canReceive,
      canSend: r.canSend,
      missing: [...r.missing],
      warnings: [...r.warnings],
      reason: r.reason,
    };
    // 飞书 / 钉钉：统一下发身份视图（本人 / 机器人 / 模拟）
    if (platform === Platform.FEISHU || platform === Platform.DINGTALK) {
      view.identity = resolveIdentity(platform);
    }
    if (platform === Platform.MAIL) {
      const mailStore = peekMailAccounts();
      view.accounts = config.mail.accounts.map((a) => ({
        ...mailAccountSummary(a),
        // 地址脱敏下发：账号页用 key/label 区分，避免截图/日志泄露完整邮箱
        address: maskAddress(a.address),
        mode: r.mode,
        // 账号来源：.env 还是本地导入文件（个人版「连接账号」页导入的显示 file）
        source: mailStore?.sourceOf(a.key) ?? 'env',
      }));
      view.issues = config.mail.issues.map((i) => ({ level: i.level, message: i.message }));
    }
    return view;
  });
}
