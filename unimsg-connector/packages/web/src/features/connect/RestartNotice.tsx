/**
 * 「已保存，需要重启」持久提示（配置弹窗 / 连接账号页共用）。
 *
 * 为什么必须常驻而不是 toast：应用凭据只在后端启动时读取，用户关掉 toast 后
 * 很容易忘记重启、然后以为配置没保存。这里把重启方式与「我已重启，重新检测」放在眼前。
 */
import { Alert, Button, Typography } from 'antd';
import { CheckCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { SERVER_RESTART_COMMAND } from './restartCommand';

export function RestartNotice({
  onRecheck,
  rechecking = false,
  applied = false,
  appliedText = '配置已生效，无需重启。',
  detected = false,
}: {
  /** 点击「我已重启，重新检测」：重新拉 health / app-config 后由父组件判断是否已生效 */
  onRecheck: () => void;
  rechecking?: boolean;
  applied?: boolean;
  appliedText?: string;
  /** true=检测到本地配置已变更（并非本次页面保存），文案不要写成「已保存」 */
  detected?: boolean;
}) {
  if (applied) {
    return (
      <Alert
        className="restart-notice"
        type="success"
        showIcon
        icon={<CheckCircleOutlined />}
        message="配置已生效"
        description={appliedText}
      />
    );
  }
  return (
    <Alert
      className="restart-notice"
      type="warning"
      showIcon
      message={
        detected ? '.env 已修改，需要重启后端才生效' : '已保存，需要重启 LinkHub 生效'
      }
      description={
        <div className="restart-notice__body">
          <span>
            {detected
              ? '检测到 .env 文件比后端启动时间新；当前运行中的后端仍在使用启动时读取的配置，重启后才会生效。'
              : '应用凭据在后端启动时读取。开发版请重启后端；桌面版请用菜单「配置 → 重新加载」。'}
          </span>
          <span className="restart-notice__row">
            <span>重启命令：</span>
            <Typography.Text
              code
              copyable={{ text: SERVER_RESTART_COMMAND, tooltips: ['复制重启命令', '已复制'] }}
            >
              {SERVER_RESTART_COMMAND}
            </Typography.Text>
          </span>
        </div>
      }
      action={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={rechecking}
          onClick={onRecheck}
        >
          我已重启，重新检测
        </Button>
      }
    />
  );
}