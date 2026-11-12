import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
  WarningOutlined,
} from '@ant-design/icons';
import type { DeliveryMode, PlatformIdentityView } from '@unimsg/shared';
import { useAppState } from '../../hooks/useAppState';
import { Platform } from '../../types';
import type { AccountInfo, MailAccountInfo } from '../../services/api';
import { store } from '../../store';
import { PLATFORM_META, formatDateTime, toneStyle } from '../../utils/format';
import { checkEnvRestart } from '../../utils/envRestart';
import { DrawerSection } from '../../components/DrawerSection';
import { IdentityTag } from '../../components/IdentityTag';
import { Sparkline } from '../../components/Sparkline';
import { useHealthSeries } from '../../hooks/useHealthSeries';
import { PersonalIdentityModal } from './PersonalIdentityModal';
import {
  FEISHU_OAUTH_CHECKLIST,
  FEISHU_OAUTH_UNFINISHED_HINT,
  clearFeishuOAuthPending,
  defaultOAuthStorage,
  markFeishuOAuthPending,
  readFeishuOAuthPending,
} from './feishuOAuthFeedback';

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
  // Mock 平台 / 企业微信 / 邮箱 / 本人未连接且机器人不可用：保持原来的能力缺口提示，
  // 「模拟」口径由身份块/通道 Tag 表达，不在能力 chip 里重复。
  return action === 'receive' ? '不可接收' : '不可发送';
}

/** 每个平台的策略环境变量名：让用户知道界面状态由哪个变量决定（可替换性） */
const IDENTITY_ENV: Record<string, string> = {
  [Platform.FEISHU]: 'FEISHU_IDENTITY',
  [Platform.DINGTALK]: 'DINGTALK_IDENTITY',
};

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

/**
 * 身份块：一眼回答「现在谁在收、谁在发」。
 *
 * 设计约束（普通同事不是工程师）：
 *  - 先把结论摆出来：接收 / 发送两行 Tag（本人 / 机器人 / 模拟）+ 人话说明；
 *  - 没连接时说明「下一步点哪里、为什么需要登录、登录后会怎样」；
 *  - 如实标注：随平台整体 Mock 时一律「模拟」，不显示成本人/机器人真实通道。
 */
export function IdentityBlock({
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
  const canStart = actionsEnabled && !mockMode && identity.policy !== 'bot';
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

  return (
    <div className="identity-block" data-testid={`identity-block-${platform}`}>
      <div className="identity-block__head">
        <span className="identity-block__title">身份 · 谁在收、谁在发</span>
        {IDENTITY_ENV[platform] && (
          <span className="identity-block__policy mono" title="该平台身份策略（.env 可改，改完重启后端生效）">
            {IDENTITY_ENV[platform]}={identity.policy}
          </span>
        )}
      </div>

      <div className="identity-block__rows">
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
      </div>

      {explainWhy && (
        <div className="identity-block__why">
          登录你自己的{PLATFORM_META[platform].name}账号后：消息以本人身份接收、回复以本人身份发出，
          不需要把机器人拉进每个群。未登录时自动走机器人通道兜底。
        </div>
      )}

      {mockMode && (
        <div className="identity-block__hint">
          当前平台通道是「Mock 模拟」：不会真实收发。要使用本人账号，请先在 .env 配置该平台凭据并重启后端，再回来连接。
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
            {mode.label}
          </Tag>
        )}
      </div>

      <div className="account-card__status">
        {account.configured ? (
          <Tag icon={<CheckCircleFilled />} color="success">
            {realMode ? '已配置（未验证）' : '已配置'}
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
  const health = state.health;
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [feishuConnecting, setFeishuConnecting] = useState(false);
  const [dingtalkOpen, setDingtalkOpen] = useState(false);
  /** 飞书回跳后仍未连接：显示中文原因与配置清单，而不是静默无反应 */
  const [feishuUnfinished, setFeishuUnfinished] = useState(false);
  /** 弹窗被浏览器拦截时，给用户可点的授权链接（绝不把当前页整页跳走） */
  const [feishuFallbackUrl, setFeishuFallbackUrl] = useState<string>();
  const connectingRef = useRef(false);
  const oauthStorage = useMemo(() => defaultOAuthStorage(), []);
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

  /**
   * 飞书 OAuth 回跳反馈（P1-6）：
   * 授权页在另一个标签，回到本页时刷新账号；若仍是未连接，展示中文原因 + 配置清单。
   * 页面重载回来（sessionStorage 标记还在）同样会恢复提示。
   */
  useEffect(() => {
    let timer: number | undefined;
    let alive = true;
    const pending = readFeishuOAuthPending(oauthStorage);
    if (pending) setFeishuUnfinished(true);

    const evaluateReturn = async () => {
      if (!readFeishuOAuthPending(oauthStorage)) return;
      await store.refreshAccounts();
      if (!alive) return;
      const feishu = store.getSnapshot().accounts.find((a) => a.platform === Platform.FEISHU);
      if (feishu?.identity?.user.linked) {
        clearFeishuOAuthPending(oauthStorage);
        setFeishuUnfinished(false);
        message.success('飞书本人身份已连接');
      } else {
        setFeishuUnfinished(true);
      }
    };

    const onFocus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void store.refreshAccounts();
        // 授权回调可能还在服务端落 token：稍等再判断一次，避免「刚成功却提示失败」
        void evaluateReturn();
      }, 250);
    };
    window.addEventListener('focus', onFocus);
    // 页面重载进入时也判断一次（同页跳转/刚拿到回调的情况）
    if (pending) timer = window.setTimeout(() => { void evaluateReturn(); }, 800);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [oauthStorage]);

  const connectFeishu = async (): Promise<void> => {
    // state 更新是异步的，同 tick 连点会绕过 feishuConnecting；用 ref 同步拦截
    if (connectingRef.current) return;
    connectingRef.current = true;
    setFeishuConnecting(true);
    setFeishuFallbackUrl(undefined);
    // 在授权前落 pending 标记：回来若仍未连接，就能给出失败反馈
    markFeishuOAuthPending(oauthStorage);
    // 必须在 await 之前同步开空白页，否则会被浏览器当作弹窗拦截
    const tab = window.open('about:blank', '_blank');
    if (tab) {
      try { tab.opener = null; } catch { /* 跨域前设置失败不影响授权 */ }
    }
    try {
      const { url } = await store.feishuOAuthStart();
      if (tab) {
        tab.location.href = url;
      } else {
        // 弹窗被拦截：绝不整页跳走（会丢失 LinkHub 上下文，失败回来也没有提示）；
        // 改为展示可点击链接 + 可复制 URL，用户点一下仍在浏览器手势内，能正常打开。
        setFeishuFallbackUrl(url);
        message.warning('浏览器拦截了飞书授权窗口，请点页面上的「打开飞书授权页」继续');
      }
    } catch (e) {
      tab?.close();
      clearFeishuOAuthPending(oauthStorage);
      message.error(e instanceof Error ? e.message : '获取飞书授权地址失败');
    } finally {
      connectingRef.current = false;
      setFeishuConnecting(false);
    }
  };

  const dismissFeishuUnfinished = (): void => {
    clearFeishuOAuthPending(oauthStorage);
    setFeishuUnfinished(false);
    setFeishuFallbackUrl(undefined);
  };

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

      {/* P1-6：飞书 OAuth 失败/被拦截的回跳反馈——不再静默，也不再整页跳走 */}
      {(feishuUnfinished || feishuFallbackUrl) && (
        <Alert
          className="accounts-alert"
          type="warning"
          showIcon
          message={feishuFallbackUrl ? '浏览器拦截了飞书授权窗口' : '飞书授权未完成'}
          description={
            <div className="accounts-alert__detail">
              <div>
                {feishuFallbackUrl
                  ? '授权页没能自动打开。点下面的按钮或复制链接，在新标签里完成授权；完成后回到本页会自动刷新状态。'
                  : FEISHU_OAUTH_UNFINISHED_HINT}
              </div>
              {feishuFallbackUrl && (
                <div className="accounts-alert__row">
                  <Button
                    type="primary"
                    size="small"
                    href={feishuFallbackUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开飞书授权页
                  </Button>
                  <Typography.Text
                    className="accounts-alert__copy"
                    copyable={{ text: feishuFallbackUrl, tooltips: ['复制授权链接', '已复制'] }}
                  >
                    复制授权链接
                  </Typography.Text>
                </div>
              )}
              <details className="accounts-alert__steps">
                <summary>查看配置步骤（常见失败原因）</summary>
                <ul>
                  {FEISHU_OAUTH_CHECKLIST.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
              <div className="accounts-alert__row">
                <Button
                  size="small"
                  loading={feishuConnecting}
                  onClick={() => void connectFeishu()}
                >
                  重新发起授权
                </Button>
                <Button size="small" type="text" onClick={dismissFeishuUnfinished}>
                  我知道了
                </Button>
              </div>
            </div>
          }
        />
      )}

      <Row gutter={[16, 16]} className="account-grid">
        {state.accounts.map((account) => (
          <Col xs={24} md={12} xl={6} key={account.platform}>
            <AccountCard
              account={account}
              actionsEnabled={actionsEnabled}
              feishuConnecting={feishuConnecting}
              onFeishuConnect={connectFeishu}
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