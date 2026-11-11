import { useEffect, useRef, useState } from 'react';
import { Button, Card, Col, message, Row, Tag } from 'antd';
import {
  ApiOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DatabaseOutlined,
  ExperimentOutlined,
  InboxOutlined,
  LinkOutlined,
  SendOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { DeliveryMode } from '@unimsg/shared';
import { useAppState } from '../../hooks/useAppState';
import { Platform } from '../../types';
import type { AccountInfo, FeishuIdentityInfo, MailAccountInfo } from '../../services/api';
import { store } from '../../store';
import { PLATFORM_META, toneStyle } from '../../utils/format';
import { DrawerSection } from '../../components/DrawerSection';
import { Sparkline } from '../../components/Sparkline';
import { useHealthSeries } from '../../hooks/useHealthSeries';

/** 本次实际通道：真实接口=绿，Mock 模拟=橙（Mock 结果绝不伪装成真实成功） */
const MODE_META: Record<DeliveryMode, { label: string; color: 'success' | 'warning' }> = {
  real: { label: '真实接口', color: 'success' },
  mock: { label: 'Mock 模拟', color: 'warning' },
};

/** 通道策略文案（后端 policy 字段；未知值原样展示，避免前端写死后端取值） */
const POLICY_LABEL: Record<string, string> = {
  auto: '策略 auto（按凭据自动）',
  real: '策略 real（强制真实）',
  mock: '策略 mock（强制模拟）',
};

function policyLabel(policy: string): string {
  return POLICY_LABEL[policy] ?? `策略 ${policy}`;
}

/** 邮箱平台下的单个账号：只展示地址 / host / 监听目录，授权码永不下发 */
function MailAccountRow({ account }: { account: MailAccountInfo }) {
  const mode = account.mode ? MODE_META[account.mode] : undefined;
  return (
    <div className="mail-account">
      <div className="mail-account__head">
        <span className="mail-account__label">{account.label}</span>
        <span className="mail-account__key mono">{account.key}</span>
        {mode && (
          <Tag className="mail-account__mode" color={mode.color}>
            {mode.label}
          </Tag>
        )}
      </div>
      <div className="mail-account__addr mono">{account.address}</div>
      <div className="mail-account__line">
        IMAP <span className="mono">{account.imapHost}</span>
      </div>
      <div className="mail-account__line">
        SMTP <span className="mono">{account.smtpHost}</span>
      </div>
      <div className="mail-account__line">监听目录：{account.folders.join('、')}</div>
    </div>
  );
}

function formatExpiry(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 飞书发送身份：机器人 / 本人 + 一键授权入口 */
function FeishuIdentityBlock({
  identity,
  canConnect,
  connecting,
  onConnect,
}: {
  identity: FeishuIdentityInfo;
  canConnect: boolean;
  connecting: boolean;
  onConnect?: () => void;
}) {
  const user = identity.effective === 'user';
  const authorized = identity.configured
    && (identity.tokenState === 'active' || identity.tokenState === 'refreshable');
  const identityLabel = !user
    ? '机器人'
    : authorized
      ? '本人（用户授权）'
      : identity.tokenState === 'expired' || identity.tokenState === 'invalid'
        ? '本人（授权失效）'
        : '本人（未连接）';
  const risky = identity.tokenState === 'expired'
    || identity.tokenState === 'invalid'
    || (identity.sendAs === 'user' && identity.tokenState === 'none');

  return (
    <div className="feishu-identity" data-testid="feishu-identity">
      <div className="feishu-identity__head">
        <span className="feishu-identity__label">发送身份</span>
        <Tag color={user && authorized ? 'blue' : user ? 'orange' : 'default'}>{identityLabel}</Tag>
        {identity.sendAs !== 'auto' && (
          <span className="feishu-identity__policy mono">FEISHU_SEND_AS={identity.sendAs}</span>
        )}
      </div>
      <div className={`feishu-identity__hint${risky ? ' feishu-identity__hint--warn' : ''}`}>
        {identity.hint}
      </div>
      {identity.accessExpiresAt && (
        <div className="feishu-identity__expiry">
          access 至 {formatExpiry(identity.accessExpiresAt)}
          {identity.refreshExpiresAt ? ` · refresh 至 ${formatExpiry(identity.refreshExpiresAt)}` : ''}
        </div>
      )}
      {canConnect && identity.sendAs !== 'bot' && onConnect && (
        <Button
          size="small"
          icon={<LinkOutlined />}
          loading={connecting}
          onClick={onConnect}
          className="feishu-identity__btn"
        >
          {identity.configured ? '重新授权' : '连接飞书用户身份'}
        </Button>
      )}
    </div>
  );
}

/** 单个平台账号卡：mode Tag + policy + missing + warnings/issues（导出便于渲染测试） */
export function AccountCard({
  account,
  showFeishuConnect = false,
  feishuConnecting = false,
  onFeishuConnect,
}: {
  account: AccountInfo;
  showFeishuConnect?: boolean;
  feishuConnecting?: boolean;
  onFeishuConnect?: () => void;
}) {
  const meta = PLATFORM_META[account.platform];
  const mode = account.mode ? MODE_META[account.mode] : undefined;
  const mailAccounts = account.platform === Platform.MAIL ? account.accounts ?? [] : [];
  const missing = account.missing ?? [];
  const warnings = account.warnings ?? [];
  const issues = account.issues ?? [];
  const hasAlerts = warnings.length > 0 || issues.length > 0;

  return (
    <Card className="account-card" data-testid={`account-card-${account.platform}`}>
      <div className="account-card__head">
        <span className="account-card__logo" style={toneStyle(meta)}>
          {meta.short}
        </span>
        <div className="account-card__title">
          <div className="account-card__name">{account.label ?? meta.name}</div>
          <div className="account-card__sub">
            {account.platform === Platform.MAIL
              ? 'IMAP 轮询收 · SMTP 发送 · 可挂多账号'
              : 'Webhook 接入 · 统一消息模型'}
          </div>
        </div>
        {mode && (
          <Tag className="account-card__mode" color={mode.color}>
            {mode.label}
          </Tag>
        )}
      </div>

      <div className="account-card__status">
        {account.configured ? (
          <Tag icon={<CheckCircleFilled />} color="success">
            已配置
          </Tag>
        ) : (
          <Tag icon={<CloseCircleFilled />} color="default">
            未配置
          </Tag>
        )}
        {account.policy && <span className="account-card__policy">{policyLabel(account.policy)}</span>}
        {account.canReceive === false && <span className="chip chip--warn">不可接收</span>}
        {account.canSend === false && <span className="chip chip--warn">不可发送</span>}
        {account.reason && <span className="account-card__hint">{account.reason}</span>}
      </div>

      {account.platform === Platform.FEISHU && account.mode !== 'mock' && account.feishuIdentity && (
        <FeishuIdentityBlock
          identity={account.feishuIdentity}
          canConnect={showFeishuConnect}
          connecting={feishuConnecting}
          onConnect={onFeishuConnect}
        />
      )}

      {missing.length > 0 && (
        <div className="account-card__missing">
          缺少环境变量：<code>{missing.join('、')}</code>
        </div>
      )}

      {/* 能力缺口 / 配置问题：逐条一行，橙=warn、红=error；与 missing / reason 不重复堆叠 */}
      {hasAlerts && (
        <ul className="account-card__alerts" aria-label="能力与配置告警">
          {warnings.map((warning) => (
            <li className="account-card__alert" key={warning}>
              <WarningOutlined />
              <span>{warning}</span>
            </li>
          ))}
          {issues.map((issue) => (
            <li
              className={`account-card__alert${issue.level === 'error' ? ' account-card__alert--error' : ''}`}
              key={`${issue.level}-${issue.message}`}
            >
              {issue.level === 'error' ? <CloseCircleFilled /> : <WarningOutlined />}
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}

      {mailAccounts.length > 0 && (
        <div className="account-card__mail">
          {mailAccounts.map((mail) => (
            <MailAccountRow key={mail.key} account={mail} />
          ))}
        </div>
      )}
    </Card>
  );
}

export function AccountsPage() {
  const state = useAppState();
  const health = state.health;
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [feishuConnecting, setFeishuConnecting] = useState(false);
  const connectingRef = useRef(false);
  // 只在小抽屉展开时采样（不做后台轮询）；数据不足 3 点不画
  const receivedSeries = useHealthSeries(health?.received, metricsOpen);

  // 授权页是另一个标签：回到本页时静默刷新账号状态（授权成功/取消都能立刻反映）
  useEffect(() => {
    let timer: number | undefined;
    const onFocus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void store.refreshAccounts(); }, 250);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const connectFeishu = async (): Promise<void> => {
    // state 更新是异步的，同 tick 连点会绕过 feishuConnecting；用 ref 同步拦截
    if (connectingRef.current) return;
    connectingRef.current = true;
    setFeishuConnecting(true);
    // 必须在 await 之前同步开空白页，否则会被浏览器当作弹窗拦截
    const tab = window.open('about:blank', '_blank');
    if (tab) {
      try { tab.opener = null; } catch { /* 跨域前设置失败不影响授权 */ }
    }
    try {
      const { url } = await store.feishuOAuthStart();
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      message.error(e instanceof Error ? e.message : '获取飞书授权地址失败');
    } finally {
      connectingRef.current = false;
      setFeishuConnecting(false);
    }
  };

  const METRICS = [
    { key: 'received', label: '接收', value: health?.received, icon: <InboxOutlined /> },
    { key: 'deduped', label: '幂等去重', value: health?.deduped, icon: <DatabaseOutlined /> },
    { key: 'sent', label: '成功发送', value: health?.sent, icon: <SendOutlined /> },
    {
      key: 'sentMock',
      label: '模拟发送',
      value: health?.sentMock,
      icon: <ExperimentOutlined />,
      tone: 'warn' as const,
    },
    {
      key: 'failed',
      label: '发送失败',
      value: health?.failed,
      icon: <WarningOutlined />,
      tone: 'danger' as const,
    },
    {
      key: 'dlq',
      label: '死信队列',
      value: health?.dlq,
      icon: <WarningOutlined />,
      tone: 'danger' as const,
    },
  ];

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">
            <ApiOutlined /> 平台账号
          </h1>
        </div>
      </header>

      <Row gutter={[16, 16]} className="account-grid">
        {state.accounts.map((account) => (
          <Col xs={24} md={12} xl={6} key={account.platform}>
            <AccountCard
              account={account}
              showFeishuConnect={!state.demoMode && account.mode !== 'mock' && account.canSend !== false}
              feishuConnecting={feishuConnecting}
              onFeishuConnect={connectFeishu}
            />
          </Col>
        ))}
      </Row>

      <DrawerSection
        title="运行指标"
        summary={`接收 ${health?.received ?? 0} · 发送 ${health?.sent ?? 0} · 失败 ${health?.failed ?? 0}`}
        onOpenChange={setMetricsOpen}
      >
        <div className="metrics-grid">
          {METRICS.map((item) => {
            const value = item.value ?? 0;
            const tone = item.tone && value > 0 ? item.tone : undefined;
            return (
              <div
                key={item.key}
                className={`surface-card surface-card--hover metric-card${tone ? ` metric-card--${tone}` : ''}`}
                data-testid={`metric-${item.key}`}
              >
                <div className="metric-card__main">
                  <span className="metric-card__label">{item.label}</span>
                  <span className="metric-card__value">{value}</span>
                </div>
                <span className="metric-card__icon" aria-hidden="true">
                  {item.icon}
                </span>
              </div>
            );
          })}
        </div>

        {/* 只在"真的有变化"时出图：一条平直的线是装饰，不是信息 */}
        {receivedSeries.length >= 3 &&
          Math.max(...receivedSeries) > Math.min(...receivedSeries) && (
            <div className="metrics-trend">
              <span className="metrics-trend__label">接收量 · 本次会话</span>
              <Sparkline
                values={receivedSeries}
                width={236}
                height={34}
                label={`接收量趋势，本次会话采样的 ${receivedSeries.length} 个点`}
              />
              <span className="metrics-trend__hint">
                {receivedSeries.length} 次采样 · 每 10 秒
              </span>
            </div>
          )}
      </DrawerSection>

    </div>
  );
}
