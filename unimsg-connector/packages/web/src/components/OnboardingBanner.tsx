/**
 * 收件箱顶部「首次使用」横幅：把用户引到「连接账号」授权中心。
 *
 * 客户化（白号 P2-9）：按实际状态动态措辞，不再固定写「需管理员」；
 * 主 CTA「去连接账号」+ 次 CTA「先体验演示（注入示例消息）」+「稍后再说」。
 * 是否显示由 utils/onboarding#shouldShowOnboardingBanner 判定。
 */
import { Button } from 'antd';
import { PlayCircleOutlined, RocketOutlined } from '@ant-design/icons';

export function OnboardingBanner({
  onOpen,
  onDemo,
  onDismiss,
  adminCount = 0,
  selfServiceCount = 0,
}: {
  onOpen: () => void;
  /** 先体验演示：注入一条示例消息（不连接真实平台） */
  onDemo?: () => void;
  onDismiss: () => void;
  /** 来自 onboarding steps：needs_admin/needs_install 数量 */
  adminCount?: number;
  /** 来自 onboarding steps：needs_user_auth（可自己登录/添加）数量 */
  selfServiceCount?: number;
}) {
  // 统一口径：管理员项与可自助项分开说，不把邮箱/钉钉算进「需管理员」
  const detailParts: string[] = [];
  if (adminCount > 0) detailParts.push(`${adminCount} 项需管理员开通`);
  if (selfServiceCount > 0) detailParts.push(`${selfServiceCount} 项可自己登录/添加`);
  const dynamicDetail = detailParts.length > 0
    ? `其中 ${detailParts.join('、')}。`
    : '连接一次即可，之后消息会自动汇总到这里。';
  return (
    <section
      className="onboard-banner"
      data-testid="onboarding-banner"
      aria-label="首次使用引导"
    >
      <span className="onboard-banner__icon" aria-hidden="true">
        <RocketOutlined />
      </span>
      <div className="onboard-banner__body">
        <strong className="onboard-banner__title">首次使用：先连接你自己的账号</strong>
        <span className="onboard-banner__text">
          邮箱、钉钉、飞书、微信逐项连接；不用把机器人拉进群。
          {dynamicDetail}
        </span>
      </div>
      <div className="onboard-banner__actions">
        <Button type="primary" onClick={onOpen}>
          去连接账号
        </Button>
        {onDemo && (
          <Button icon={<PlayCircleOutlined />} onClick={onDemo}>
            先体验演示
          </Button>
        )}
        <Button type="text" onClick={onDismiss}>
          稍后再说
        </Button>
      </div>
    </section>
  );
}
