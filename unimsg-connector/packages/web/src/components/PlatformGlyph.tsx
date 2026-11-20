import {
  DingdingOutlined,
  MailOutlined,
  RocketOutlined,
  WechatOutlined,
} from '@ant-design/icons';
import { Platform } from '../types';

/**
 * 渠道图标：四个渠道各用一个固定图形，渠道标签页、侧栏与消息头像共用同一套，
 * 避免「同一渠道在不同位置长得不一样」。
 *
 * 用平台自己的品牌图形（飞书火箭 / 钉钉翅膀 / 微信气泡 / 邮箱信封），
 * 与「连接账号」里那四张卡片的图标完全一致——用户在连接页认过的图形，
 * 回到侧栏不用再认第二遍。图标仍统一取 Ant Design 图标库，不引入第二套风格。
 */
const GLYPH: Record<Platform, typeof MailOutlined> = {
  [Platform.FEISHU]: RocketOutlined,
  [Platform.DINGTALK]: DingdingOutlined,
  [Platform.MAIL]: MailOutlined,
  [Platform.WECHAT]: WechatOutlined,
};

export function PlatformGlyph({ platform, size = 16 }: { platform: Platform; size?: number }) {
  const Icon = GLYPH[platform] ?? MailOutlined;
  return <Icon style={{ fontSize: size }} aria-hidden="true" />;
}
