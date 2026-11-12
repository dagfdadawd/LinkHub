/**
 * 邮箱服务商预设：个人版最常遇到的 8 种，填好 IMAP/SMTP 地址与官方设置页深链。
 *
 * 安全：这里只放「去哪里生成授权码」的公开设置页，不包含任何账号或密钥。
 * 端口默认按服务商常用值给参考，仍可在「高级设置」里改。
 */
export type MailProviderId = 'qq' | '163' | '126' | 'yeah' | 'gmail' | 'outlook' | 'icloud' | 'custom';

export interface MailProviderPreset {
  value: MailProviderId;
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** 官方设置 / 授权码生成页（新窗口打开） */
  helpUrl?: string;
  /** 中文操作说明（去哪开 IMAP、怎么拿授权码） */
  helpText: string;
}

export const MAIL_PROVIDERS: MailProviderPreset[] = [
  {
    value: 'qq',
    label: 'QQ 邮箱',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    helpUrl: 'https://service.mail.qq.com/detail/0/75',
    helpText: 'QQ 邮箱网页版 → 设置 → 账户 → 开启「IMAP/SMTP 服务」，按提示生成授权码（不是 QQ 密码）。',
  },
  {
    value: '163',
    label: '网易 163 邮箱',
    imapHost: 'imap.163.com',
    imapPort: 993,
    smtpHost: 'smtp.163.com',
    smtpPort: 465,
    helpUrl: 'https://mail.163.com/',
    helpText: '163 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP，新增并保存授权码。',
  },
  {
    value: '126',
    label: '网易 126 邮箱',
    imapHost: 'imap.126.com',
    imapPort: 993,
    smtpHost: 'smtp.126.com',
    smtpPort: 465,
    helpUrl: 'https://mail.126.com/',
    helpText: '126 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP，新增并保存授权码。',
  },
  {
    value: 'yeah',
    label: '网易 yeah 邮箱',
    imapHost: 'imap.yeah.net',
    imapPort: 993,
    smtpHost: 'smtp.yeah.net',
    smtpPort: 465,
    helpUrl: 'https://mail.yeah.net/',
    helpText: 'yeah 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP，新增并保存授权码。',
  },
  {
    value: 'gmail',
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    helpUrl: 'https://myaccount.google.com/apppasswords',
    helpText: 'Google 账号 → 安全性 → 两步验证 → 应用专用密码，生成 16 位密码作为授权码。',
  },
  {
    value: 'outlook',
    label: 'Outlook / Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    helpUrl: 'https://account.microsoft.com/security',
    helpText: 'Microsoft 账号 → 安全 → 高级安全选项 → 应用密码（需先开启两步验证）。',
  },
  {
    value: 'icloud',
    label: 'iCloud 邮箱',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    helpUrl: 'https://appleid.apple.com/account/manage',
    helpText: 'Apple ID → 登录与安全 → App 专用密码（需先开启双重认证）。',
  },
  {
    value: 'custom',
    label: '自定义 / 企业邮箱',
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 465,
    helpText: '填写企业邮箱服务商提供的 IMAP / SMTP 服务器；端口通常是 993（IMAP）和 465 / 587（SMTP）。',
  },
];

export function findMailProvider(value?: string): MailProviderPreset | undefined {
  return MAIL_PROVIDERS.find((p) => p.value === value);
}

/** 服务商显示名：未知值原样展示，避免前端把后端/旧配置的 provider 吃掉 */
export function mailProviderLabel(value?: string): string {
  if (!value) return '';
  return findMailProvider(value)?.label ?? value;
}