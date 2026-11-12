/**
 * 收件箱顶部「首次使用」横幅：把用户引到「连接账号」授权中心。
 *
 * 只负责展示与回调；是否显示由 utils/onboarding#shouldShowOnboardingBanner 判定
 * （演示模式不打扰、已全部就绪不出现、点过「去连接 / 稍后」后不再出现）。
 */
import { Button } from 'antd';
import { RocketOutlined } from '@ant-design/icons';

export function OnboardingBanner({
  onOpen,
  onDismiss,
}: {
  onOpen: () => void;
  onDismiss: () => void;
}) {
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
          邮箱、钉钉、飞书、企业微信逐项连接；不用把机器人拉进群。带「需管理员」的项需要企业管理员开通。
        </span>
      </div>
      <div className="onboard-banner__actions">
        <Button type="primary" onClick={onOpen}>
          去连接账号
        </Button>
        <Button type="text" onClick={onDismiss}>
          稍后再说
        </Button>
      </div>
    </section>
  );
}