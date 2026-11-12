import {
  MailOutlined,
  SendOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Platform } from '../types';

/**
 * 渠道图标：四个渠道各用一个固定图形，渠道标签页与消息头像共用同一套，
 * 避免「同一渠道在不同位置长得不一样」。图标统一取 Ant Design 图标库
 * （项目已有的唯一图标库），不引入第二套风格。
 */
const GLYPH: Record<Platform, typeof MailOutlined> = {
  [Platform.FEISHU]: SendOutlined,
  [Platform.DINGTALK]: ThunderboltOutlined,
  [Platform.WECOM]: TeamOutlined,
  [Platform.MAIL]: MailOutlined,
};

export function PlatformGlyph({ platform, size = 16 }: { platform: Platform; size?: number }) {
  const Icon = GLYPH[platform] ?? MailOutlined;
  return <Icon style={{ fontSize: size }} aria-hidden="true" />;
}