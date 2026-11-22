import type { CSSProperties, ReactNode } from 'react';
import type { Platform } from '../types';
import { initials, platformMeta } from '../utils/format';

export function AvatarBadge({
  name,
  platform,
  size = 36,
  icon,
}: {
  name: string;
  platform: Platform;
  size?: number;
  /**
   * 用图标代替首字。
   * 会话没有真实联系人时（例如整段都是自己发出的消息），标题是「（我发出的会话）」
   * 这类合成文案，取首字只会得到「）」这种废字符，不如直接显示一个发送图标。
   */
  icon?: ReactNode;
}) {
  const meta = platformMeta(platform);
  return (
    <span
      className={`avatar-badge${icon ? ' avatar-badge--icon' : ''}`}
      style={
        {
          width: size,
          height: size,
          // 底与墨走变量（明暗两套都在 --tag-* 里），字色仍是平台原色
          '--tag-soft': meta.soft,
          '--tag-soft-dark': meta.softDark,
          color: meta.color,
          borderColor: `${meta.color}33`,
          fontSize: size <= 28 ? 12 : 14,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {icon ?? initials(name)}
    </span>
  );
}