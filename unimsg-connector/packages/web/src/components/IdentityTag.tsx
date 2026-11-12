/**
 * 身份标签：把「谁在收 / 谁在发」如实标出来。
 *
 * 颜色语义（与账号页、收件箱统一）：
 *  - 本人 = 绿（推荐路径：不必把机器人拉进群）
 *  - 机器人 = 蓝（兼容 / 兜底，仍然可用）
 *  - 模拟 = 橙（Mock，绝不假装真实平台已收到）
 *
 * 契约：任何状态都不允许含糊——真实接收/发送必须写清身份，Mock 一律标「模拟」。
 */
import { Tag } from 'antd';
import type { IdentityRole } from '../types';

export type IdentityTagRole = IdentityRole | 'mock';
export type IdentityTagAction = 'receive' | 'send';

interface IdentityTagMeta {
  color: 'success' | 'processing' | 'warning';
  short: string;
  receive: string;
  send: string;
}

const IDENTITY_TAG_META: Record<IdentityTagRole, IdentityTagMeta> = {
  user: { color: 'success', short: '本人', receive: '本人账号接收', send: '本人发送' },
  bot: { color: 'processing', short: '机器人', receive: '机器人接收', send: '机器人发送' },
  mock: { color: 'warning', short: '模拟', receive: '模拟接收', send: '模拟发送' },
};

export function identityTagMeta(role: IdentityTagRole): IdentityTagMeta {
  return IDENTITY_TAG_META[role];
}

export function IdentityTag({
  role,
  action = 'send',
  short = false,
  bordered = true,
}: {
  role: IdentityTagRole;
  /** receive=接收身份；send=发送身份 */
  action?: IdentityTagAction;
  /** true=只显示「本人 / 机器人 / 模拟」（账号页的两枚 Tag） */
  short?: boolean;
  bordered?: boolean;
}) {
  const meta = IDENTITY_TAG_META[role];
  return (
    <Tag
      className={`identity-tag identity-tag--${role}`}
      color={meta.color}
      bordered={bordered}
      data-identity={role}
    >
      {short ? meta.short : action === 'receive' ? meta.receive : meta.send}
    </Tag>
  );
}