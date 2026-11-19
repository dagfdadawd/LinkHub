import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Col, message, Popconfirm, Row, Tag, Typography } from 'antd';
import {
  ApiOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DatabaseOutlined,
  InboxOutlined,
  LinkOutlined,
  LoginOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { DeliveryMode, PlatformIdentityView } from '@unimsg/shared';
import { useAppState } from '../../hooks/useAppState';
import { Platform } from '../../types';
import type { AccountInfo, DingtalkPersonalStatus, MailAccountInfo } from '../../services/api';
import { store } from '../../store';
import { PLATFORM_META, formatDateTime, toneStyle } from '../../utils/format';
import { checkEnvRestart } from '../../utils/envRestart';
import { DrawerSection } from '../../components/DrawerSection';
import { IdentityTag } from '../../components/IdentityTag';
import { Sparkline } from '../../components/Sparkline';
import { useHealthSeries } from '../../hooks/useHealthSeries';
import { PersonalIdentityModal } from './PersonalIdentityModal';
import { AppConfigModal } from '../connect/AppConfigModal';
import { FeishuOAuthHelp } from './FeishuOAuthHelp';
import { useFeishuOAuth } from './useFeishuOAuth';

/** 本次实际通道：真实接口=绿，Mock 模拟=橙（Mock 结果绝不伪装成真实成功） */
const MODE_META: Record<DeliveryMode, { label: string; color: 'success' | 'warning' }> = {
  real: { label: '真实接口', color: 'success' },
  mock: { label: '未配置（演示模式）', color: 'warning' },
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

/** 卡片上的自检命令：变量齐了 ≠ 平台能连通，用户可直接复制去跑 doctor */
export function doctorCommand(platform: Platform): string {
  return `pnpm run doctor --platform=${platform}`;
}

/** 发送指标口径：health.sent 含 Mock，拆成「共 / 真实 / 模拟」，避免被读成「真实发了 N 条」 */
export interface SendBreakdown {
  total: number;
  real: number;
  mock: number;
}

export function sendBreakdown(sent?: number, sentMock?: number): SendBreakdown {
  const total = Math.max(0, Math.trunc(sent ?? 0));
  const mock = Math.min(total, Math.max(0, Math.trunc(sentMock ?? 0)));
  return { total, real: total - mock, mock };
}

/**
 * 卡片摘要里的「不可接收 / 不可发送」chip：必须和身份块口径一致（NEW-P2-1）。
 *
 * 之前的矛盾：摘要说的 `canReceive/canSend` 是**机器人兜底通道**的能力，
 * 而身份块说的是**当前生效身份**。本人身份已连接时，机器人通道不可用 ≠ 收发不可用。
 */
export function capabilityWarning(
  action: 'receive' | 'send',
  available: boolean | undefined,
  identity?: PlatformIdentityView,
): string | undefined {
  if (available !== false) return undefined;
  const effective = action === 'receive' ? identity?.effectiveReceive : identity?.effectiveSend;
  // 当前生效身份就是本人：机器人通道不可用不影响收发，身份块已经写清「接收/发送 本人」，
  // 再挂一个「不可接收」只会自相矛盾（NEW-P2-1）。
  if (effective === 'user') return undefined;
  // Mock 平台 / 微信 / 邮箱 / 本人未连接且机器人不可用：保持原来的能力缺口提示，
  // 「模拟」口径由身份块/通道 Tag 表达，不在能力 chip 里重复。
  return action === 'receive' ? '不可接收' : '不可发送';
}

/** 平台身份策略的客户可见文案（原始环境变量名只保留在技术详情里） */
const IDENTITY_POLICY_LABEL: Record<string, string> = {
  auto: '自动（本人优先）',
  user: '仅本人',
  bot: '仅机器人',
};

/** 每个平台的策略说明：让用户知道界面状态由哪条策略决定（可替换性） */
const IDENTITY_POLICY_TITLE = '身份策略决定以谁的身份收发；可在「连接账号 → 平台应用配置」修改；凭据类变更需重启后端才生效';

/** 邮箱平台下的单个账号：只展示地址 / host / 监听目录，授权码永不下发 */
function MailAccountRow({ account }: { account: MailAccountInfo }) {
  const mode = account.mode ? MODE_META[account.mode] : undefined;
  // P2-5：账号列表里再写「未配置」会自相矛盾，行内只说明通道是演示
  const modeLabel = account.mode === 'mock' ? '演示模式' : mode?.label;
  return (
    <div className="mail-account">
      <div className="mail-account__head">
        <span className="mail-account__label">{account.label}</span>
        <span className="mail-account__key mono">{account.key}</span>
        {mode && (
          <Tag className="mail-account__mode" color={mode.color}>
            {modeLabel}
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

/**
 * 身份块：一眼回答「现在谁在收、谁在发」。
 *
 * 设计约束（普通同事不是工程师）：
 *  - 先把结论摆出来：接收 / 发送两行 Tag（本人 / 机器人 / 模拟）+ 人话说明；
 *  - 没连接时说明「下一步点哪里、为什么需要登录、登录后会怎样」；
 *  - 如实标注：随平台整体 Mock 时一律「模拟」，不显示成本人/机器人真实通道。
 */
export 
/** 把秒数转成「1 小时 58 分」这种口语时长 */
function formatRemaining(sec: number): string {
  if (sec <= 0) return '已过期';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${Math.max(1, m)} 分钟`;
}

/**
 * 钉钉本人身份的**有效期倒计时**。
 *
 * dws 的访问令牌约 2 小时到期；如果续期失败（普通权限进程写不进凭据库），
 * 整个登录态会失效、收件箱的会话名会退回「群聊」——用户很难把这两件事联系起来。
 * 所以在到期前直接显示剩余时间，提前提醒重新授权。
 */
function DingtalkSessionHint({ onRelogin }: { onRelogin?: () => void }) {
  const [status, setStatus] = useState<DingtalkPersonalStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void store
        .dingtalkPersonalStatus()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch(() => undefined);
    };
    load();
    // 1 分钟刷新一次：既能看到剩余时间在减少，也不会频繁打后端（后端有 30s 缓存）
    const timer = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!status?.authenticated) return null;
  const left = status.tokenExpiresInSec;
  if (left === undefined) return null;

  const expired = left <= 0;
  const soon = left > 0 && left < 15 * 60;

  return (
    <div className={`dt-session${expired ? ' dt-session--bad' : soon ? ' dt-session--warn' : ''}`}>
      <span className="dt-session__dot" />
      <span className="dt-session__text">
        {expired
          ? '钉钉登录已过期：收件箱的会话名会退回「群聊」'
          : soon
            ? `钉钉登录将在 ${formatRemaining(left)} 后到期`
            : `钉钉登录有效，剩余 ${formatRemaining(left)}`}
      </span>
      {(expired || soon) && onRelogin && (
        <Button size="small" type="primary" onClick={onRelogin}>
          重新登录
        </Button>
      )}
    </div>
  );
}

function IdentityBlock({
  platform,
  identity,
  actionsEnabled,
  connecting = false,
  onConnect,
  onLogout,
}: {
  platform: Platform;
  identity: PlatformIdentityView;
  /** 是否允许发起连接（纯前端演示模式为 false，避免点了也没有后端） */
  actionsEnabled: boolean;
  connecting?: boolean;
  onConnect?: () => void;
  onLogout?: () => void;
}) {
  const user = identity.user;
  const linked = user.linked;
  /**
   * 平台整体 Mock 的判定以**身份视图**为准，而不是账号卡片的 mode：
   * 「仅本人身份」部署里机器人通道是 Mock（account.mode='mock'），但本人身份通道
   * 是真实工作的（effective=user），此时必须显示「本人」并允许登录，不能误标成模拟。
   */
  const mockMode = identity.effectiveSend === 'mock' && identity.effectiveReceive === 'mock';
  const receiveRole = identity.effectiveReceive;
  const sendRole = identity.effectiveSend;
  const risky =
    user.state === 'expired' ||
    user.state === 'error' ||
    (identity.policy === 'user' && !linked);
  const canStart =
    actionsEnabled
    && identity.policy !== 'bot'
    // 钉钉：Mock 运行态也允许登录本人账号（白号 P1-1）；登录后需启用「仅用本人身份」
    && (!mockMode || (platform === Platform.DINGTALK && user.canLink));
  const connectLabel = linked
    ? platform === Platform.FEISHU
      ? '重新授权'
      : '重新登录'
    : platform === Platform.DINGTALK && !user.canLink
      ? '查看连接步骤'
      : user.state === 'expired' || user.state === 'error'
        ? '重新连接'
        : '连接本人账号';
  // 钉钉即使 dws 未安装也允许打开弹窗看安装步骤；飞书缺 App 凭据只能给提示
  const showConnect =
    canStart && (user.canLink || (platform === Platform.DINGTALK && !linked));

  const explainWhy = !linked && !mockMode && actionsEnabled && identity.policy !== 'bot';
  /** 策略固定「仅本人」但未登录：不能显示「发送 本人」又不能接收的矛盾状态 */
  const userFixedUnlinked = identity.policy === 'user' && !linked;

  return (
    <div className="identity-block" data-testid={`identity-block-${platform}`}>
      <div className="identity-block__head">
        <span className="identity-block__title">身份 · 谁在收、谁在发</span>
        {IDENTITY_POLICY_LABEL[identity.policy] && (
          <span className="identity-block__policy" title={IDENTITY_POLICY_TITLE}>
            身份策略：{IDENTITY_POLICY_LABEL[identity.policy]}
          </span>
        )}
      </div>

      <div className="identity-block__rows">
        {userFixedUnlinked ? (
          <div className="identity-block__row">
            <span className="identity-block__row-label">状态</span>
            <Tag color="warning">本人身份（未登录）</Tag>
            <span className="identity-block__row-text">
              身份策略已固定为「仅本人」，未登录期间不会以本人身份收发；请点下方按钮重新登录。
            </span>
          </div>
        ) : (
          <>
            <div className="identity-block__row">
              <span className="identity-block__row-label">接收</span>
              <IdentityTag role={receiveRole} action="receive" short />
              <span className="identity-block__row-text">{identity.receiveHint}</span>
            </div>
            <div className="identity-block__row">
              <span className="identity-block__row-label">发送</span>
              <IdentityTag role={sendRole} action="send" short />
              <span className="identity-block__row-text">{identity.sendHint}</span>
            </div>
          </>
        )}
      </div>

      {explainWhy && (
        <div className="identity-block__why">
          登录你自己的{PLATFORM_META[platform].name}账号后：消息以本人身份接收、回复以本人身份发出，
          不需要把机器人拉进每个群。未登录时自动走机器人通道兜底。
        </div>
      )}

      {mockMode && (
        <div className="identity-block__hint">
          {platform === Platform.DINGTALK && user.canLink
            ? '当前平台是「演示模式」运行态（不会真实收发）：可以先登录本人账号（无需机器人应用）；登录后到「连接账号」启用「仅用本人身份」（热应用、无需重启），才会真实收发。'
            : '当前平台通道是「演示模式」：不会真实收发。可到「连接账号 → 平台应用配置」填写应用凭据并重启后端，再回来连接。'}
        </div>
      )}

      {!mockMode && user.hint && (
        <div className={`identity-block__hint${risky ? ' identity-block__hint--warn' : ''}`}>
          {user.hint}
        </div>
      )}

      {linked && !mockMode && (
        <div className="identity-block__linked">
          {user.displayName ? `已连接：${user.displayName}` : '本人账号已连接'}
          {user.detail ? ` · ${user.detail}` : ''}
          {user.expiresAt ? ` · 有效期至 ${formatExpiry(user.expiresAt)}` : ''}
        </div>
      )}

      {/* 机器人兜底能力只在真实通道下有意义；Mock 下说「机器人可用」会自相矛盾 */}
      {!mockMode && (
        <div className="identity-block__bot">
          {identity.botAvailable ? '机器人通道可用（兜底）：' : '机器人通道不可用：'}
          {identity.botHint}
        </div>
      )}

      {/* 钉钉：显示登录剩余有效期，快到期/已过期时给「重新登录」 */}
      {platform === Platform.DINGTALK && linked && (
        <DingtalkSessionHint onRelogin={showConnect ? onConnect : undefined} />
      )}

      {(showConnect || (canStart && linked && platform === Platform.DINGTALK && onLogout)) && (
        <div className="identity-block__actions">
          {showConnect && onConnect && (
            <Button
              size="small"
              type={linked ? 'default' : 'primary'}
              icon={linked ? <LinkOutlined /> : <LoginOutlined />}
              loading={connecting}
              onClick={onConnect}
            >
              {connectLabel}
            </Button>
          )}
          {canStart && linked && platform === Platform.DINGTALK && onLogout && (
            <Popconfirm
              title="注销钉钉本人身份？"
              description="注销后收发会回到机器人（或 Mock）通道，之后可随时重新登录。"
              okText="注销"
              cancelText="取消"
              onConfirm={onLogout}
            >
              <Button size="small" danger icon={<LogoutOutlined />}>
                注销
              </Button>
            </Popconfirm>
          )}
        </div>
      )}
    </div>
  );
}

/** 单个平台账号卡：mode Tag + policy + missing + warnings/issues（导出便于渲染测试） */
export function AccountCard({
  account,
  actionsEnabled = false,
  feishuConnecting = false,
  onFeishuConnect,
  onDingtalkConnect,
  onDingtalkLogout,
}: {
  account: AccountInfo;
  /** 是否显示连接/注销按钮（真实后端 + 非演示模式） */
  actionsEnabled?: boolean;
  feishuConnecting?: boolean;
  onFeishuConnect?: () => void;
  onDingtalkConnect?: () => void;
  onDingtalkLogout?: () => void;
}) {
  const meta = PLATFORM_META[account.platform];
  const mode = account.mode ? MODE_META[account.mode] : undefined;
  const mailAccounts = account.platform === Platform.MAIL ? account.accounts ?? [] : [];
  const missing = account.missing ?? [];
  const warnings = account.warnings ?? [];
  const issues = account.issues ?? [];
  const hasAlerts = warnings.length > 0 || issues.length > 0;
  const identity = account.identity;
  const realMode = account.mode === 'real';
  const doctor = doctorCommand(account.platform);
  const receiveWarning = capabilityWarning('receive', account.canReceive, identity);
  const sendWarning = capabilityWarning('send', account.canSend, identity);

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
            {account.platform === Platform.MAIL && mailAccounts.length > 0 && account.mode === 'mock'
              ? `已添加 ${mailAccounts.length} 个账号（演示模式）`
              : mode.label}
          </Tag>
        )}
      </div>

      <div className="account-card__status">
        {account.configured ? (
          <Tag icon={<CheckCircleFilled />} color="success">
            {realMode ? '已配置（未验证）' : '已配置'}
          </Tag>
        ) : mailAccounts.length > 0 ? (
          // P2-5：已添加本地邮箱账号 ≠ 未配置；卡片头如实写「已添加 N 个账号」
          <Tag icon={<CheckCircleFilled />} color="warning">
            已添加 {mailAccounts.length} 个账号（未验证）
          </Tag>
        ) : (
          <Tag icon={<CloseCircleFilled />} color="default">
            未配置
          </Tag>
        )}
        {account.policy && <span className="account-card__policy">{policyLabel(account.policy)}</span>}
        {/* 能力缺口 chip 跟随「生效身份」口径，避免与身份块「接收=本人」打架（NEW-P2-1） */}
        {receiveWarning && <span className="chip chip--warn">{receiveWarning}</span>}
        {sendWarning && <span className="chip chip--warn">{sendWarning}</span>}
        {account.reason && <span className="account-card__hint">{account.reason}</span>}
      </div>

      {/* P1-1：「变量填齐」不等于「平台连得通」。真实模式给可复制的 doctor 自检命令，
          避免小白把「已配置 / 真实接口」误读成「已经连上、发送一定成功」。 */}
      {realMode && account.configured && (
        <div className="account-card__verify" data-testid={`verify-${account.platform}`}>
          <div className="account-card__verify-line">
            <WarningOutlined />
            <span>变量齐了 ≠ 平台能连通，请运行自检确认：</span>
          </div>
          <Typography.Text
            className="account-card__doctor mono"
            code
            copyable={{ text: doctor, tooltips: ['复制自检命令', '已复制'] }}
          >
            {doctor}
          </Typography.Text>
        </div>
      )}

      {identity && (
        <IdentityBlock
          platform={account.platform}
          identity={identity}
          actionsEnabled={actionsEnabled}
          connecting={feishuConnecting}
          onConnect={
            account.platform === Platform.FEISHU
              ? onFeishuConnect
              : account.platform === Platform.DINGTALK
                ? onDingtalkConnect
                : undefined
          }
          onLogout={account.platform === Platform.DINGTALK ? onDingtalkLogout : undefined}
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
  const navigate = useNavigate();
  const health = state.health;
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [dingtalkOpen, setDingtalkOpen] = useState(false);
  const [appConfigOpen, setAppConfigOpen] = useState(false);
  /** 飞书 OAuth 共用流程：与「连接账号」授权中心同一套回跳/拦截反馈 */
  const feishu = useFeishuOAuth();
  // 只在小抽屉展开时采样（不做后台轮询）；数据不足 3 点不画
  const receivedSeries = useHealthSeries(health?.received, metricsOpen);

  const dingtalkAccount = state.accounts.find((a) => a.platform === Platform.DINGTALK);
  const dingtalkIdentity = dingtalkAccount?.identity;
  // 「仅本人身份」部署：机器人通道 mock 但本人身份真实可用，不能当成整体 Mock 拦住登录
  const dingtalkIdentityMocked = dingtalkIdentity
    ? dingtalkIdentity.effectiveSend === 'mock' && dingtalkIdentity.effectiveReceive === 'mock'
    : dingtalkAccount?.mode === 'mock';

  // P1-5：.env 在上次启动后被改过 → 明确提示「需重启后端」
  const envRestart = checkEnvRestart(health);

  const logoutDingtalk = async (): Promise<void> => {
    try {
      await store.dingtalkPersonalLogout();
      message.success('已注销钉钉本人身份，收发已回到机器人 / Mock 通道');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '注销失败，请稍后重试');
    }
  };

  // P2-4：health.sent 含 Mock，必须拆开写，避免「成功发送 N」被读成真实发了 N 条
  const breakdown = sendBreakdown(health?.sent, health?.sentMock);
  const hasMockCount = typeof health?.sentMock === 'number';
  const METRICS: Array<{
    key: string;
    label: string;
    value?: number;
    icon: ReactNode;
    tone?: 'warn' | 'danger';
    note?: string;
  }> = [
    { key: 'received', label: '接收', value: health?.received, icon: <InboxOutlined /> },
    { key: 'deduped', label: '幂等去重', value: health?.deduped, icon: <DatabaseOutlined /> },
    {
      key: 'sent',
      label: '发送共',
      value: health?.sent,
      icon: <SendOutlined />,
      ...(hasMockCount ? { note: `真实 ${breakdown.real} · 模拟 ${breakdown.mock}` } : {}),
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

  const actionsEnabled = !state.demoMode;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">
            <ApiOutlined /> 平台账号
          </h1>
        </div>
        <div className="accounts-head-actions">
          <Button icon={<SettingOutlined />} onClick={() => setAppConfigOpen(true)}>
            平台应用配置
          </Button>
          <Button icon={<LinkOutlined />} onClick={() => navigate('/connect')}>
            打开「连接账号」向导
          </Button>
        </div>
      </header>

      <p className="accounts-intro">
        「身份」说的是这条消息以<strong>谁</strong>的名义收发：连接<strong>本人账号</strong>后，
        消息直接走你自己的飞书 / 钉钉账号，<strong>不用把机器人拉进每个群</strong>；
        机器人身份保留为兜底。下面每张卡片的「接收 / 发送」就是当前生效身份，未连接时会告诉你下一步点哪里。
      </p>
      <p className="accounts-intro accounts-intro--verify">
        「已配置 / 真实接口」只代表<strong>变量填齐、通道按真实接口工作</strong>，不代表平台一定连得通；
        真实模式的卡片里有可复制的自检命令（doctor），跑一次就能确认平台是否真的可用。
      </p>

      {/* P1-5：.env 改了但后端没重启——最常见的小白困惑，必须显式提示 */}
      {envRestart.needed && (
        <Alert
          className="accounts-alert"
          type="warning"
          showIcon
          message=".env 已修改，需要重启后端才生效"
          description={
            <div className="accounts-alert__detail">
              <div>
                当前运行中的后端仍在用「启动时读取的配置」：.env 修改于{' '}
                {formatDateTime(new Date(envRestart.envMtime ?? 0).toISOString())}，后端启动于{' '}
                {formatDateTime(new Date(envRestart.startedAt ?? 0).toISOString())}。
                重启后账号状态才会变——不用怀疑变量名或填写位置。
              </div>
              <div className="accounts-alert__row">
                <span>重启命令：</span>
                <Typography.Text
                  className="mono"
                  code
                  copyable={{ text: 'pnpm --filter @unimsg/server start', tooltips: ['复制重启命令', '已复制'] }}
                >
                  pnpm --filter @unimsg/server start
                </Typography.Text>
                <span className="accounts-alert__muted">（或双击 start.bat 重新启动）</span>
              </div>
            </div>
          }
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void store.refreshHealth()}>
              重新检查
            </Button>
          }
        />
      )}

      {/* P1-6 + 20029：飞书 OAuth 失败/被拦截的回跳反馈——不再静默，也不再整页跳走 */}
      <FeishuOAuthHelp
        className="accounts-alert"
        unfinished={feishu.unfinished}
        fallbackUrl={feishu.fallbackUrl}
        redirectUri={feishu.redirectUri}
        connecting={feishu.connecting}
        onReconnect={() => void feishu.connect()}
        onDismiss={feishu.dismiss}
      />

      <Row gutter={[16, 16]} className="account-grid">
        {state.accounts.map((account) => (
          <Col xs={24} md={12} xl={6} key={account.platform}>
            <AccountCard
              account={account}
              actionsEnabled={actionsEnabled}
              feishuConnecting={feishu.connecting}
              onFeishuConnect={feishu.connect}
              onDingtalkConnect={() => setDingtalkOpen(true)}
              onDingtalkLogout={logoutDingtalk}
            />
          </Col>
        ))}
      </Row>

      <PersonalIdentityModal
        open={dingtalkOpen}
        identity={dingtalkIdentity}
        mockMode={dingtalkIdentityMocked}
        onRefresh={() => { void store.refreshAccounts(); }}
        onClose={() => setDingtalkOpen(false)}
      />

      <AppConfigModal
        open={appConfigOpen}
        initialGroup="feishu"
        onClose={() => setAppConfigOpen(false)}
        onSaved={() => {
          void store.refreshHealth();
          void store.refreshAccounts();
        }}
      />

      <DrawerSection
        title="运行指标 · 本次启动以来"
        summary={
          `接收 ${health?.received ?? 0} · 发送共 ${breakdown.total}`
          + `（真实 ${breakdown.real} / 模拟 ${breakdown.mock}） · 失败 ${health?.failed ?? 0}`
        }
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
                  {item.note && <span className="metric-card__note">{item.note}</span>}
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


