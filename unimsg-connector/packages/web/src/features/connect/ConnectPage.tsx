/**
 * 「连接账号」授权中心（个人版首启向导）。
 *
 * 目标：把「去各平台后台翻配置」变成一条按推荐顺序的清单（邮箱 → 钉钉 → 飞书 → 企微），
 * 每个平台只说三件事：现在什么状态、下一步点哪里、管理员要做什么。
 *
 * 复用边界（不在本页重复实现）：
 *  - 钉钉本人身份 → 现有 PersonalIdentityModal（浏览器登录 / 设备码 + 倒计时）；
 *  - 飞书 OAuth → 现有 useFeishuOAuth（回跳反馈 / 弹窗被拦截兜底）；
 *  - .env 改动需重启 → 现有 checkEnvRestart 判定；
 *  - 管理员清单 / 命令 → 后端 onboarding.actions 下发，前端只负责复制或打开展示。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, Alert, Button, Popconfirm, Progress, Skeleton, Tag, Typography } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  DingdingOutlined,
  ExportOutlined,
  GlobalOutlined,
  LinkOutlined,
  MailOutlined,
  ReloadOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  WechatOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../../hooks/useAppState';
import { Platform } from '../../types';
import type {
  MailAccountView,
  OnboardingAction,
  OnboardingStep,
  OnboardingView,
} from '../../services/api';
import { store } from '../../store';
import { checkEnvRestart } from '../../utils/envRestart';
import {
  displayMailAddress,
  dwsSourceLabel,
  ONBOARDING_STATE_META,
  overallProgress,
  sortOnboardingSteps,
} from '../../utils/onboarding';
import { SERVER_RESTART_COMMAND } from './restartCommand';
import { PersonalIdentityModal } from '../accounts/PersonalIdentityModal';
import { useFeishuOAuth } from '../accounts/useFeishuOAuth';
import { MailAccountForm } from './MailAccountForm';
import { mailProviderLabel } from './mailProviders';

const STEP_ICON: Record<string, ReactNode> = {
  mail: <MailOutlined />,
  dingtalk: <DingdingOutlined />,
  feishu: <RocketOutlined />,
  wecom: <WechatOutlined />,
};

const STEP_ORDER_HINT = '按 邮箱 → 钉钉 → 飞书 → 企业微信 的顺序连接';

/** 后端 managers 清单里的「管理员项」：前端只展示/复制，不引导普通用户去改企业后台 */
function stepOwnerNote(step: OnboardingStep): string | undefined {
  if (step.state === 'needs_admin') return '需要企业管理员在平台后台开通，可把下面的清单发给管理员。';
  if (step.state === 'needs_install') return '需要先在这台机器安装/配置运行环境，完成后点「刷新状态」。';
  return undefined;
}

export function ConnectPage() {
  const state = useAppState();
  const navigate = useNavigate();
  const { message: toast } = AntApp.useApp();
  const feishu = useFeishuOAuth({ onLinked: () => { void load(true); } });

  const [onboarding, setOnboarding] = useState<OnboardingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [mailAccounts, setMailAccounts] = useState<MailAccountView[]>([]);
  const [mailError, setMailError] = useState('');
  const [mailOpen, setMailOpen] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dingtalkOpen, setDingtalkOpen] = useState(false);
  const [blockedLink, setBlockedLink] = useState<{ label: string; url: string } | null>(null);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const view = await store.refreshOnboarding();
      if (view) {
        setOnboarding(view);
        setError('');
      } else {
        setError(
          '后端还没有提供授权中心接口（可能需要重启或升级后端）。'
          + '可以先去「平台账号」页手动查看每个平台的状态。',
        );
      }
      try {
        setMailAccounts(await store.mailAccounts());
        setMailError('');
      } catch (e) {
        setMailError(e instanceof Error ? e.message : '读取邮箱账号失败');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const steps = useMemo(
    () => sortOnboardingSteps(onboarding?.steps ?? []),
    [onboarding],
  );
  const progress = overallProgress(onboarding);
  const dingtalkStep = steps.find((s) => s.id === 'dingtalk');

  const dingtalkAccount = state.accounts.find((a) => a.platform === Platform.DINGTALK);
  // 钉钉登录弹窗需要完整 PlatformIdentityView：只从 /api/accounts 取，不用 onboarding detail 的摘要
  const dingtalkIdentity = dingtalkAccount?.identity;
  const dingtalkMocked = dingtalkStep?.state === 'mock'
    || (dingtalkIdentity
      ? dingtalkIdentity.effectiveSend === 'mock' && dingtalkIdentity.effectiveReceive === 'mock'
      : dingtalkAccount?.mode === 'mock');

  // .env 改了但后端没重启：复用账号页同一条判定与文案
  const envRestart = checkEnvRestart(state.health);

  async function refreshAll(): Promise<void> {
    await load(true);
    toast.success('已刷新各平台连接状态');
  }

  /** 打开外部链接：优先 window.open；被浏览器拦截时展示可点击链接（绝不静默失败） */
  function openLink(label: string, url?: string): void {
    if (!url) {
      toast.warning('后端没有提供这个入口的链接，请到对应平台官网手动打开');
      return;
    }
    let popup: Window | null = null;
    try {
      popup = window.open(url, '_blank', 'noopener');
    } catch {
      popup = null;
    }
    if (popup) {
      setBlockedLink(null);
    } else {
      setBlockedLink({ label, url });
      toast.warning('浏览器拦截了新窗口，请点页面上的链接继续');
    }
  }

  /** 复制文本：clipboard 不可用（http / 非安全上下文）时退化为 textarea + execCommand */
  async function copyText(text: string | undefined, what = '内容'): Promise<void> {
    const content = text?.trim();
    if (!content) {
      toast.warning(`后端没有提供可复制的${what}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      toast.success(`已复制${what}`);
      return;
    } catch {
      // 继续走兜底
    }
    try {
      const area = document.createElement('textarea');
      area.value = content;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      if (ok) toast.success(`已复制${what}`);
      else toast.info('自动复制被浏览器拒绝，请手动选择文本复制');
    } catch {
      toast.info('自动复制被浏览器拒绝，请手动选择文本复制');
    }
  }

  async function deleteMailAccount(key: string): Promise<void> {
    setDeletingKey(key);
    try {
      await store.mailAccountDelete(key);
      toast.success('已删除本地邮箱账号');
      await load(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除邮箱账号失败，请稍后重试');
    } finally {
      setDeletingKey(undefined);
    }
  }

  /** api 类动作：只识别钉钉 / 飞书两个已知登录流程，其余引导到平台账号页 */
  async function runApiAction(step: OnboardingStep, action: OnboardingAction): Promise<void> {
    // 已连接平台的「刷新连接状态」是 GET 自检：刷新本页即可，别重新拉起登录
    if (action.id.endsWith('-status')) {
      await refreshAll();
      return;
    }
    if (step.id === 'dingtalk') {
      if (dingtalkStep?.state === 'mock') {
        toast.info('演示模式不会启动真实钉钉登录；启动真实后端后再连接本人账号');
        return;
      }
      setDingtalkOpen(true);
      return;
    }
    if (step.id === 'feishu') {
      await feishu.connect();
      return;
    }
    toast.info(`「${action.label}」需要在「平台账号」页完成`);
    navigate('/accounts');
  }

  function runAction(step: OnboardingStep, action: OnboardingAction): void {
    switch (action.kind) {
      case 'link':
        openLink(action.label, action.url);
        break;
      case 'copy':
        void copyText(action.text, '管理员清单');
        break;
      case 'command':
        void copyText(action.command, '命令');
        break;
      case 'form':
        setMailOpen(true);
        setExpanded((prev) => ({ ...prev, [step.id]: true }));
        break;
      case 'api':
        void runApiAction(step, action);
        break;
      default:
        toast.info('暂不支持这个操作，请到「平台账号」页查看');
    }
  }

  function renderMailList(): ReactNode {
    if (mailError) {
      return <Alert type="warning" showIcon message="读取邮箱账号失败" description={mailError} />;
    }
    if (mailAccounts.length === 0) {
      return (
        <div className="mail-accounts__empty">
          还没有通过 LinkHub 添加的邮箱账号。添加后即可在收件箱查看邮件，并以你自己的邮箱回复。
        </div>
      );
    }
    return (
      <ul className="mail-accounts" data-testid="mail-accounts">
        {mailAccounts.map((account) => (
          <li className="mail-accounts__item" key={account.key}>
            <span className="mail-accounts__addr">{displayMailAddress(account)}</span>
            <span className="mail-accounts__meta">
              {(account.provider || account.label) && (
                <span>{account.provider ? mailProviderLabel(account.provider) : account.label}</span>
              )}
              <Tag color={account.source === 'file' ? 'blue' : 'default'}>
                {account.source === 'file' ? '本地' : '来自 .env'}
              </Tag>
            </span>
            {account.source === 'file' ? (
              <Popconfirm
                title="删除这个邮箱账号？"
                description="只删除 LinkHub 本地保存的账号；.env 里的配置不受影响。"
                okText="删除"
                cancelText="取消"
                onConfirm={() => void deleteMailAccount(account.key)}
              >
                <Button
                  size="small"
                  danger
                  type="text"
                  loading={deletingKey === account.key}
                  disabled={deletingKey !== undefined}
                >
                  删除
                </Button>
              </Popconfirm>
            ) : (
              <span className="mail-accounts__env-hint">不可在页面删除，请修改 .env 后重启</span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  function renderActions(step: OnboardingStep): ReactNode {
    const actions = [...step.actions];
    // 后端暂未下发 form 动作时，邮箱卡片仍要能打开表单（个人版核心路径）
    if (step.id === 'mail' && !actions.some((a) => a.kind === 'form')) {
      actions.push({
        id: 'mail-add-fallback',
        kind: 'form',
        label: mailAccounts.length > 0 ? '再添加一个邮箱' : '添加邮箱账号',
      });
    }
    const commandActions = actions.filter((a) => a.kind === 'command');
    const buttonActions = actions.filter((a) => a.kind !== 'command');
    return (
      <>
        {buttonActions.length > 0 && (
          <div className="connect-card__actions">
            {buttonActions.map((action, index) => (
              <Button
                key={action.id}
                type={index === 0 && step.state !== 'ready' ? 'primary' : 'default'}
                size="small"
                icon={actionIcon(action)}
                onClick={() => runAction(step, action)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
        {buttonActions
          .filter((a) => a.kind === 'copy' && a.text)
          .map((action) => (
            <details className="connect-card__copy-preview" key={`${action.id}-preview`}>
              <summary>查看要复制的内容</summary>
              <pre>{action.text}</pre>
            </details>
          ))}
        {commandActions.map((action) => (
          <div className="connect-card__command" key={action.id}>
            <span className="connect-card__command-label">命令</span>
            <Typography.Text
              code
              copyable={{ text: action.command ?? '', tooltips: ['复制命令', '已复制'] }}
            >
              {action.command ?? action.label}
            </Typography.Text>
          </div>
        ))}
      </>
    );
  }

  function renderCard(step: OnboardingStep): ReactNode {
    const meta = ONBOARDING_STATE_META[step.state];
    const ready = step.state === 'ready';
    const open = !ready || Boolean(expanded[step.id]);
    const ownerNote = stepOwnerNote(step);
    return (
      <section
        className={`connect-card connect-card--${meta.tone}${ready ? ' connect-card--ready' : ''}`}
        data-testid={`connect-step-${step.id}`}
        key={step.id}
      >
        <header className="connect-card__head">
          <span className="connect-card__icon" aria-hidden="true">
            {STEP_ICON[step.id] ?? <LinkOutlined />}
          </span>
          <div className="connect-card__titles">
            <div className="connect-card__title-row">
              <span className="connect-card__label">{step.label}</span>
              <Tag color={meta.tagColor} className="connect-card__state">
                {meta.label}
              </Tag>
            </div>
            <p className="connect-card__summary">{step.summary}</p>
          </div>
          <div className="connect-card__tools">
            {ready && (
              <>
                <Button
                  size="small"
                  type="text"
                  icon={<ReloadOutlined />}
                  loading={refreshing}
                  onClick={() => void refreshAll()}
                >
                  刷新状态
                </Button>
                <Button size="small" type="text" onClick={() => toggleExpanded(step.id)}>
                  {open ? '收起' : '查看详情'}
                </Button>
              </>
            )}
          </div>
        </header>

        {open && (
          <div className="connect-card__body">
            {ownerNote && <div className="connect-card__owner">{ownerNote}</div>}
            {step.hints.length > 0 && (
              <ul className="connect-card__hints">
                {step.hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            )}

            {step.id === 'mail' && (
              <div className="mail-section">
                {renderMailList()}
                {mailOpen && (
                  <MailAccountForm
                    onCancel={() => setMailOpen(false)}
                    onSaved={() => {
                      setMailOpen(false);
                      setExpanded((prev) => ({ ...prev, mail: true }));
                      void load(true);
                    }}
                  />
                )}
              </div>
            )}

            {renderActions(step)}

            {ready && step.hints.length === 0 && step.actions.length === 0 && (
              <div className="connect-card__empty">已连接，无需额外操作。</div>
            )}
          </div>
        )}
      </section>
    );
  }

  function toggleExpanded(id: string): void {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="page connect-page">
      <header className="page__head connect-page__head">
        <div>
          <h1 className="page__title">
            <LinkOutlined /> 连接账号
          </h1>
          <p className="connect-page__sub">
            个人版只需连接你自己的账号；带「需管理员」的项由企业管理员在平台后台开通。
          </p>
        </div>
        <div className="connect-page__head-actions">
          <Button
            icon={<ReloadOutlined />}
            loading={refreshing}
            onClick={() => void refreshAll()}
          >
            刷新状态
          </Button>
          <Button type="text" icon={<ApiOutlined />} onClick={() => navigate('/accounts')}>
            平台账号页
          </Button>
        </div>
      </header>

      {state.demoMode && (
        <Alert
          className="connect-alert"
          type="info"
          showIcon
          message="当前是纯前端演示模式（Mock），不会连接真实账号"
          description="启动真实后端后，这里会显示各平台真实连接状态、可执行的动作与管理清单；演示模式不会伪造「已连接」。"
        />
      )}

      {error && (
        <Alert
          className="connect-alert"
          type="warning"
          showIcon
          message="授权中心暂不可用"
          description={error}
          action={
            <div className="connect-alert__actions">
              <Button size="small" onClick={() => void load()}>重试</Button>
              <Button size="small" type="link" onClick={() => navigate('/accounts')}>
                去平台账号页
              </Button>
            </div>
          }
        />
      )}

      {envRestart.needed && (
        <Alert
          className="connect-alert"
          type="warning"
          showIcon
          message=".env 已修改，需要重启后端才生效"
          description={
            <div className="connect-alert__detail">
              <span>当前运行中的后端仍在使用「启动时读取的配置」，重启后平台状态才会变化。</span>
              <Typography.Text
                code
                copyable={{ text: SERVER_RESTART_COMMAND, tooltips: ['复制重启命令', '已复制'] }}
              >
                {SERVER_RESTART_COMMAND}
              </Typography.Text>
            </div>
          }
        />
      )}

      {blockedLink && (
        <Alert
          className="connect-alert"
          type="warning"
          showIcon
          message="浏览器拦截了新窗口"
          description={
            <div className="connect-alert__detail">
              <span>请点下面这个链接打开「{blockedLink.label}」：</span>
              <a href={blockedLink.url} target="_blank" rel="noreferrer">
                {blockedLink.url}
              </a>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => void copyText(blockedLink.url, '链接')}
              >
                复制链接
              </Button>
            </div>
          }
          action={
            <Button size="small" type="text" onClick={() => setBlockedLink(null)}>
              知道了
            </Button>
          }
        />
      )}

      {(feishu.unfinished || feishu.fallbackUrl) && (
        <Alert
          className="connect-alert"
          type="warning"
          showIcon
          message={feishu.fallbackUrl ? '浏览器拦截了飞书授权窗口' : '飞书授权未完成'}
          description={
            <div className="connect-alert__detail">
              <span>
                {feishu.fallbackUrl
                  ? '授权页没能自动打开，点下面的按钮继续；完成后回到本页会自动刷新。'
                  : '返回 LinkHub 时还没检测到飞书授权成功，请重试或把配置清单发给管理员。'}
              </span>
              {feishu.fallbackUrl && (
                <span className="connect-alert__row">
                  <Button size="small" type="primary" href={feishu.fallbackUrl} target="_blank" rel="noreferrer">
                    打开飞书授权页
                  </Button>
                  <Typography.Text
                    copyable={{ text: feishu.fallbackUrl, tooltips: ['复制授权链接', '已复制'] }}
                  >
                    复制授权链接
                  </Typography.Text>
                </span>
              )}
            </div>
          }
          action={
            <Button size="small" type="text" onClick={feishu.dismiss}>
              我知道了
            </Button>
          }
        />
      )}

      {loading && !onboarding ? (
        <div className="connect-skeleton">
          <Skeleton active paragraph={{ rows: 10 }} />
        </div>
      ) : (
        <>
          <section className="connect-progress" aria-label="授权进度">
            <div className="connect-progress__head">
              <div>
                <span className="connect-progress__value">{progress.label}</span>
                <span className="connect-progress__hint">
                  {STEP_ORDER_HINT}
                  {progress.needsAction > 0 ? `，还有 ${progress.needsAction} 项待处理` : ''}
                </span>
              </div>
              <span className="connect-progress__dws">
                <ThunderboltOutlined /> 钉钉运行环境：{dwsSourceLabel(onboarding?.dws.source)}
              </span>
            </div>
            <Progress percent={progress.percent} showInfo={false} strokeColor="var(--brand)" />
            <div className="connect-progress__meta">
              已就绪 {progress.ready} 项 · 待处理 {progress.needsAction} 项
              {onboarding?.firstRun ? ' · 首次使用建议从「邮箱」开始' : ''}
            </div>
          </section>

          <div className="connect-steps">
            {steps.map((step) => renderCard(step))}
          </div>

          {!onboarding?.firstRun && progress.ready >= progress.total && (
            <Alert
              className="connect-alert"
              type="success"
              showIcon
              message="四个平台都已就绪"
              description="收件箱会持续汇总各平台消息；需要换账号时回到这一页重新连接即可。"
            />
          )}

          <p className="connect-page__footnote">
            <CheckCircleOutlined /> 状态由本机后端实时探测；改完 .env 需要重启后端，平台状态才会更新。
            本页不会显示任何 token 或邮箱授权码。
          </p>
        </>
      )}

      <PersonalIdentityModal
        open={dingtalkOpen}
        identity={dingtalkIdentity}
        mockMode={Boolean(dingtalkMocked)}
        onRefresh={() => { void load(true); }}
        onClose={() => setDingtalkOpen(false)}
      />
    </div>
  );
}

/** 动作按钮图标：让「打开后台 / 复制 / 登录 / 填表」一眼可区分 */
function actionIcon(action: OnboardingAction): ReactNode {
  switch (action.kind) {
    case 'link':
      return <ExportOutlined />;
    case 'copy':
      return <CopyOutlined />;
    case 'form':
      return <MailOutlined />;
    case 'api':
      return <GlobalOutlined />;
    default:
      return <LinkOutlined />;
  }
}


