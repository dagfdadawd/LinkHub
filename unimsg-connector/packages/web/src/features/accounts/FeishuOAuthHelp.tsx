/**
 * 飞书 OAuth 授权未完成 / 弹窗被拦截的共享帮助面板（账号页 & 授权中心共用）。
 *
 * 为什么抽成组件：桌面版点「连接本人账号」后，飞书授权页最常见报 `20029 重定向 URL 有误`
 * ——飞书后台只登记了 localhost:3001，而桌面版后端跑在随机端口 3901–3930。用户卡在
 * 飞书那一页，回 LinkHub 只看到泛泛的「授权未完成」，不知道把哪个地址填到哪里。
 *
 * 这里把「结论 + 本次真实回调地址 + 复制按钮 + 飞书开放平台入口 + 其余原因」一次摆出来，
 * 并如实告诉用户需要手动粘一次（不承诺自动完成、不编造 appId deep link）。
 */
import { App as AntApp, Alert, Button, Typography } from 'antd';
import { CopyOutlined, ExportOutlined, LoginOutlined } from '@ant-design/icons';
import {
  FEISHU_OAUTH_COMMON_REASONS,
  FEISHU_OAUTH_REDIRECT_GUIDE,
  FEISHU_OAUTH_REDIRECT_URI_FALLBACK,
  FEISHU_OAUTH_UNFINISHED_TITLE,
  FEISHU_OPEN_PLATFORM_URL,
} from './feishuOAuthFeedback';

export interface FeishuOAuthHelpProps {
  /** 授权回跳后仍未连接 */
  unfinished: boolean;
  /** 弹窗被浏览器拦截时的授权 URL（优先级高于未完成面板） */
  fallbackUrl?: string;
  /** 本次授权实际使用的回调地址；拿不到时展示兜底文案，不编造地址 */
  redirectUri?: string;
  connecting?: boolean;
  onReconnect: () => void;
  onDismiss: () => void;
  /** 外层间距类（账号页 .accounts-alert / 授权中心 .connect-alert） */
  className?: string;
}

export function FeishuOAuthHelp({
  unfinished,
  fallbackUrl,
  redirectUri,
  connecting = false,
  onReconnect,
  onDismiss,
  className,
}: FeishuOAuthHelpProps) {
  const { message } = AntApp.useApp();

  // 弹窗被拦截：先让用户把授权页打开，这一步与 20029 无关，不混入重定向 URL 说明
  if (fallbackUrl) {
    return (
      <Alert
        className={className}
        type="warning"
        showIcon
        message="浏览器拦截了飞书授权窗口"
        description={
          <div className="feishu-oauth-help">
            <p className="feishu-oauth-help__guide">
              授权页没能自动打开。点下面的按钮或复制链接，在新标签里完成授权；完成后回到本页会自动刷新状态。
            </p>
            <div className="feishu-oauth-help__uri">
              <Button type="primary" size="small" href={fallbackUrl} target="_blank" rel="noreferrer">
                打开飞书授权页
              </Button>
              <Typography.Text copyable={{ text: fallbackUrl, tooltips: ['复制授权链接', '已复制'] }}>
                复制授权链接
              </Typography.Text>
            </div>
            <div className="feishu-oauth-help__actions">
              <Button size="small" loading={connecting} onClick={onReconnect}>
                重新授权
              </Button>
              <Button size="small" type="text" onClick={onDismiss}>
                我知道了
              </Button>
            </div>
          </div>
        }
      />
    );
  }

  if (!unfinished) return null;

  const copyRedirectUri = async (): Promise<void> => {
    if (!redirectUri) {
      message.info(FEISHU_OAUTH_REDIRECT_URI_FALLBACK);
      return;
    }
    try {
      await navigator.clipboard.writeText(redirectUri);
      message.success('已复制回调地址，去飞书开放平台「安全设置 → 重定向 URL」粘贴');
    } catch {
      message.info('自动复制失败，请手动选中上面的回调地址复制');
    }
  };

  const openFeishuPlatform = (): void => {
    let popup: Window | null = null;
    try {
      popup = window.open(FEISHU_OPEN_PLATFORM_URL, '_blank', 'noopener');
    } catch {
      popup = null;
    }
    if (!popup) {
      message.info(`浏览器拦截了新窗口，请手动打开 ${FEISHU_OPEN_PLATFORM_URL}`);
    }
  };

  return (
    <Alert
      className={className}
      type="warning"
      showIcon
      message={FEISHU_OAUTH_UNFINISHED_TITLE}
      description={
        <div className="feishu-oauth-help" data-testid="feishu-oauth-unfinished">
          <p className="feishu-oauth-help__guide">{FEISHU_OAUTH_REDIRECT_GUIDE}</p>
          <p className="feishu-oauth-help__guide">
            下面的地址要填进飞书后台（普通用户不用管，可直接复制发给企业管理员）。
          </p>
          <div className="feishu-oauth-help__uri">
            <span className="feishu-oauth-help__label">本次的回调地址：</span>
            {redirectUri ? (
              <Typography.Text className="mono" code data-testid="feishu-oauth-redirect-uri">
                {redirectUri}
              </Typography.Text>
            ) : (
              <span className="feishu-oauth-help__fallback" data-testid="feishu-oauth-redirect-uri-fallback">
                {FEISHU_OAUTH_REDIRECT_URI_FALLBACK}
              </span>
            )}
            {redirectUri && (
              <Button size="small" icon={<CopyOutlined />} onClick={() => void copyRedirectUri()}>
                复制地址
              </Button>
            )}
            <Button size="small" icon={<ExportOutlined />} onClick={openFeishuPlatform}>
              打开飞书开放平台
            </Button>
          </div>
          <ul className="feishu-oauth-help__reasons">
            {FEISHU_OAUTH_COMMON_REASONS.map((reason) => (
              <li key={reason.title}>
                <strong>
                  {reason.code ? `${reason.code} ` : ''}
                  {reason.title}
                </strong>
                ：{reason.reason} → {reason.action}
              </li>
            ))}
          </ul>
          <div className="feishu-oauth-help__actions">
            <Button size="small" type="primary" icon={<LoginOutlined />} loading={connecting} onClick={onReconnect}>
              重新授权
            </Button>
            <Button size="small" type="text" onClick={onDismiss}>
              我知道了
            </Button>
          </div>
        </div>
      }
    />
  );
}
