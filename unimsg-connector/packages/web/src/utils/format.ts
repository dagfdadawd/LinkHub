import type { CSSProperties } from 'react';
import type { DeliveryInfo } from '@unimsg/shared';
import { mixHex, readableInk } from './ink';
import { MsgStatus, Platform } from '../types';
import type { MsgType, UnifiedMessage } from '../types';

/**
 * 标签色板：**一个作者值**（`color`）派生出四支，不再各处硬编码。
 *
 * - `color` 品牌原色，只给**图形**（色点、头像底、连接灯）——非文字只需 3:1
 * - `soft` 文字底：`color` 混白 90%
 * - `ink` 浅底上的墨色：同色相压暗，≥4.5:1
 * - `softDark` / `inkDark` 暗色主题那一对（浅底混黑 16% → 重新算墨色）
 *
 * 原来 color / soft / ink 是三个独立字符串，暗色还要在 CSS 里用 `!important`
 * 再覆盖一次——同一个视觉决策有四处真相，改一处必忘三处。现在只留 `color`，
 * 其余由 `tone()` 推导，组件只负责把 CSS 变量挂上去。
 */
export interface TagTone {
  color: string;
  soft: string;
  ink: string;
  softDark: string;
  inkDark: string;
}

/** 浅底混黑的比例：与 `--surface-3` 同一档灰度，保留一点点色相偏色 */
const DARK_TINT = 0.16;

export function tone(color: string): TagTone {
  // 往白走到 90% → 浅色底；从纯黑往浅底走 16% → 暗色底（两者同一个色相来源）
  const soft = mixHex(color, '#ffffff', 0.9);
  const softDark = mixHex('#000000', soft, DARK_TINT);
  return {
    color,
    soft,
    ink: readableInk(color, soft),
    softDark,
    inkDark: readableInk(color, softDark),
  };
}

/** 挂到元素上的 CSS 变量（`as CSSProperties` 让自定义属性穿过类型检查） */
export function toneStyle(t: TagTone): CSSProperties {
  return {
    '--tag-soft': t.soft,
    '--tag-ink': t.ink,
    '--tag-soft-dark': t.softDark,
    '--tag-ink-dark': t.inkDark,
  } as CSSProperties;
}

export interface PlatformTone extends TagTone {
  name: string;
  short: string;
}

export const PLATFORM_META: Record<Platform, PlatformTone> = {
  [Platform.FEISHU]: { name: '飞书', short: '飞', ...tone('#3370ff') },
  [Platform.DINGTALK]: { name: '钉钉', short: '钉', ...tone('#0089ff') },
  [Platform.WECOM]: { name: '企业微信', short: '企', ...tone('#07c160') },
  [Platform.MAIL]: { name: '邮箱', short: '邮', ...tone('#ff9500') },
};

/** 状态机展示元信息（color 给色点，ink 给文字） */
export interface StatusTone extends TagTone {
  label: string;
}

export const STATUS_META: Record<MsgStatus, StatusTone> = {
  [MsgStatus.RECEIVED]: { label: '已接收', ...tone('#6e6e73') },
  [MsgStatus.PROCESSING]: { label: '处理中', ...tone('#0a6cd6') },
  [MsgStatus.REPLIED]: { label: '已回复', ...tone('#1f8a9e') },
  [MsgStatus.SENT]: { label: '已发送', ...tone('#4a47c4') },
  [MsgStatus.SYNCED]: { label: '已同步', ...tone('#248a3d') },
  [MsgStatus.FAILED]: { label: '发送失败', ...tone('#d70015') },
};

/** 闭环状态顺序（用于时间线与进度条） */
export const STATUS_FLOW: MsgStatus[] = [
  MsgStatus.RECEIVED,
  MsgStatus.PROCESSING,
  MsgStatus.REPLIED,
  MsgStatus.SENT,
  MsgStatus.SYNCED,
];

export const TYPE_LABEL: Record<MsgType, string> = {
  text: '文本',
  image: '图片',
  file: '文件',
  todo: '待办',
};

/** 投递方式展示结果：kind 决定 Tag 颜色，text 直接展示 */
export interface DeliveryLabel {
  text: string;
  kind: 'real' | 'mock' | 'none';
}

/** 身份角色的人话标签（「本人」/「机器人」；模拟单独处理） */
export const IDENTITY_ROLE_LABEL: Record<'bot' | 'user', string> = {
  user: '本人',
  bot: '机器人',
};

/**
 * 回写投递方式文案（收件箱详情与账号页复用）。
 * 契约要求：Mock 结果必须明确标注「未调用真实平台」，绝不伪装成真实平台已收到；
 * 真实回写如果带了身份，还要如实说明是「本人发送」还是「机器人发送」。
 */
export function deliveryLabel(delivery?: DeliveryInfo): DeliveryLabel {
  if (!delivery) return { text: '—', kind: 'none' };
  if (delivery.mode === 'mock') return { text: '模拟发送（未调用真实平台）', kind: 'mock' };
  const platformReply = delivery.platformReply?.trim();
  const identity = delivery.identity ? `${IDENTITY_ROLE_LABEL[delivery.identity]}发送` : '';
  const channel = platformReply ? `真实接口（${platformReply}）` : '真实接口';
  return { text: identity ? `${identity} · ${channel}` : channel, kind: 'real' };
}

/**
 * 「接收身份」文案：只有真实接收通道才会带 receivedAs；
 * Mock 演示消息不写该字段（如实标注，绝不冒充真实接收）。
 */
export function receivedIdentityLabel(receivedAs?: 'bot' | 'user'): string | undefined {
  if (receivedAs === 'user') return '本人账号接收';
  if (receivedAs === 'bot') return '机器人接收';
  return undefined;
}

/**
 * 「发送身份」文案：优先看真实回写的 delivery.identity；
 * Mock 回写一律明确写「模拟发送」，绝不声称是本人/机器人真实发出。
 */
export function sendIdentityLabel(delivery?: DeliveryInfo): string | undefined {
  if (!delivery) return undefined;
  if (delivery.mode === 'mock') return '模拟发送';
  if (delivery.identity === 'user') return '本人发送';
  if (delivery.identity === 'bot') return '机器人发送';
  return undefined;
}

/**
 * 是否「自己在 Mock 演示里主动发出的消息」。
 * 这类消息不是收到的来信：不计未读，并在列表标「我发出的（模拟）」。
 */
export function isSelfComposedMock(message: {
  delivery?: DeliveryInfo;
  sender?: { id?: string };
  externalId?: string;
}): boolean {
  if (message.delivery?.mode !== 'mock') return false;
  if (message.sender?.id === 'linkhub') return true;
  return /(^|:)compose:/.test(message.externalId ?? '');
}

/**
 * 会话类型文案（详情页「会话」一行）：
 * 群聊消息必须一眼看出回复会发回群里，而不是私聊给发送人。
 */
export function conversationLabel(message: Pick<UnifiedMessage, 'conversation'>): string {
  const c = message.conversation;
  if (!c) return '—';
  if (c.type !== 'group') return '单聊';
  return c.title ? `群聊「${c.title}」` : '群聊';
}

/** 相对时间：刚刚 / n 分钟前 / 今天 HH:mm / 昨天 HH:mm / MM-DD HH:mm */
export function formatRelative(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, now - t);
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;

  const d = new Date(t);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `今天 ${hm}`;

  const yesterday = new Date(now - 24 * 60 * minute);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${hm}`;

  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function shortTrace(traceId: string): string {
  return traceId.length > 12 ? `${traceId.slice(0, 8)}…${traceId.slice(-4)}` : traceId;
}

export function initials(name: string): string {
  // 先剥掉包裹符号与首尾标点：「（我发出的会话）」直接取字会拿到「）」，
  // 这类合成标题必须先去掉括号，再取有意义的字符
  const cleaned = name
    .trim()
    .replace(/^[\s(（[【「『<《"'“”‘’·•…]+/, '')
    .replace(/[\s)）\]】」』>》"'“”‘’·•…]+$/, '')
    .trim();
  const target = cleaned || name.trim();
  if (!target) return '?';
  return /^[a-zA-Z]/.test(target) ? target.slice(0, 1).toUpperCase() : target.slice(-1);
}

/** 意图标签配色：待办橙、咨询蓝、通知紫、未分类灰 */
export function intentColor(intent?: string): TagTone {
  if (!intent) return tone('#6e6e73');
  if (intent.includes('待办')) return tone('#b25000');
  if (intent.includes('咨询')) return tone('#0a6cd6');
  if (intent.includes('通知')) return tone('#4a47c4');
  return tone('#6e6e73');
}

/** 列表排序：按创建时间倒序（与后端 list 接口默认行为一致） */
export function sortMessages(list: UnifiedMessage[]): UnifiedMessage[] {
  return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function clamp(text: string, max: number): string {
  // 防御：后端个别通道（如钉钉个人事件）可能把非字符串塞进 body，
  // 这里统一转成字符串，避免界面上出现 "[object Object]"。
  const value = typeof text === 'string' ? text : text == null ? '' : String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}