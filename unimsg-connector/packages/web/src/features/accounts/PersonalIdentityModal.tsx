/**
 * 钉钉「连接本人账号」引导弹窗。
 *
 * 普通同事不是工程师：这里按「为什么 → 怎么做 → 现在到哪一步 → 成功后怎样」组织，
 * 每一步都给可复制命令 / 可点链接，并自动轮询登录状态（2 秒一次、最长 2 分钟），
 * 不让用户在「登录了但页面没反应」里猜。
 *
 * 平台事实（如实标注，不假装零配置）：
 *  - 钉钉本人身份依赖本机安装官方 [DingTalk Workspace CLI（dws）]；
 *  - 首次登录需要在 dws 里完成 OAuth 授权（浏览器或设备码），LinkHub 不接触密码；
 *  - dws 未安装 / 未登录时，收发会按 auto 策略回退机器人身份（绝不假装成功）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, App as AntApp, Button, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import {
  CheckCircleFilled,
  CloudDownloadOutlined,
  LoginOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { PlatformIdentityView } from '@unimsg/shared';
import type { DingtalkLoginStart } from '../../services/api';
import { store } from '../../store';

/** dws 官方 release 下载页（Windows 用户下载 dws.exe；官方也提供脚本/npm 等多通道，这里只引导最直观的下载） */
export const DWS_DOWNLOAD_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases';
/** 已下载 dws.exe 时的 .env 写法示例（复制到 .env 后重启后端） */
export const DWS_BIN_EXAMPLE = 'DWS_BIN=C:\\Users\\<你的用户名>\\.local\\bin\\dws.exe';

const COPY_TOOLTIPS: [string, string] = ['复制命令', '已复制'];

type Phase = 'idle' | 'starting' | 'waiting' | 'timeout' | 'error';

function Command({ text, className }: { text: string; className?: string }) {
  return (
    <Typography.Text
      className={className ?? 'personal-modal__cmd'}
      code
      copyable={{ text, tooltips: COPY_TOOLTIPS }}
    >
      {text}
    </Typography.Text>
  );
}

function formatExpiry(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 为什么需要登录：普通用户最关心的三句话 */
function WhyLogin() {
  return (
    <ul className="personal-modal__why">
      <li>
        <strong>不用把机器人拉进群</strong>：登录后，消息以你自己的钉钉账号接收（私聊 / @我），
        回复也以你本人发出。
      </li>
      <li>
        <strong>登录的是本机 dws 官方 CLI</strong>：授权在钉钉官方页面完成，LinkHub 只读取
        「已登录 / 未登录」状态，不接触你的密码。
      </li>
      <li>
        <strong>随时可回退</strong>：不登录或注销后，消息会自动走机器人通道兜底；也可以把
        DINGTALK_IDENTITY 设为 bot 固定用机器人。
      </li>
    </ul>
  );
}

export function PersonalIdentityModal({
  open,
  identity,
  mockMode = false,
  onClose,
  onRefresh,
  pollIntervalMs = 2_000,
  pollTimeoutMs = 120_000,
}: {
  open: boolean;
  identity?: PlatformIdentityView;
  /** 平台整体为 Mock：不能登录真实账号，先提示配置凭据 */
  mockMode?: boolean;
  onClose: () => void;
  /** 状态变化后让账号页重拉 /api/accounts */
  onRefresh?: () => void;
  /** 轮询间隔（测试注入更短的值） */
  pollIntervalMs?: number;
  /** 轮询上限（默认 2 分钟） */
  pollTimeoutMs?: number;
}) {
  const { message: toast } = AntApp.useApp();
  const [phase, setPhase] = useState<Phase>('idle');
  const [startInfo, setStartInfo] = useState<DingtalkLoginStart>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  /** 已连接时点「重新登录（换账号）」→ 临时进入登录流程视图 */
  const [reloginMode, setReloginMode] = useState(false);
  const onCloseRef = useRef(onClose);
  const onRefreshRef = useRef(onRefresh);
  onCloseRef.current = onClose;
  onRefreshRef.current = onRefresh;

  const user = identity?.user;
  const linked = Boolean(user?.linked);
  const canLink = Boolean(user?.canLink);
  const unavailable = Boolean(user) && !user?.linked && !canLink;
  // 影响轮询生命周期的关键状态（对象引用会随每次拉取变化，避免每次渲染重启轮询）
  const pollKey = `${open}|${linked}|${canLink}|${mockMode}`;

  // 打开弹窗时重置本地流程状态
  useEffect(() => {
    if (!open) return;
    setPhase('idle');
    setStartInfo(undefined);
    setError('');
    setReloginMode(false);
  }, [open]);

  /**
   * 自动轮询登录状态：即使用户在终端里自己完成了 `dws auth login`，
   * 本弹窗也会在 2 秒内发现并自动关闭，不用手动刷新。
   * 未安装 dws / 已登录 / Mock 模式下不轮询（没有可等的结果）。
   */
  useEffect(() => {
    if (!open || linked || !canLink || mockMode) return;
    let cancelled = false;
    let timer: number | undefined;
    let startedAt = Date.now();
    const tick = async (): Promise<void> => {
      try {
        const status = await store.dingtalkPersonalStatus();
        if (cancelled) return;
        if (status.authenticated) {
          const who = status.displayName ? `：${status.displayName}` : '';
          toast.success(`钉钉本人身份已连接${who}`);
          onRefreshRef.current?.();
          onCloseRef.current();
          return;
        }
      } catch {
        // 网络抖动 / 后端暂不可用时继续等下一轮，不打断用户操作
      }
      if (cancelled) return;
      if (Date.now() - startedAt >= pollTimeoutMs) {
        setPhase((prev) => (prev === 'idle' || prev === 'starting' ? 'timeout' : prev));
        return;
      }
      timer = window.setTimeout(() => { void tick(); }, pollIntervalMs);
    };
    startedAt = Date.now();
    timer = window.setTimeout(() => { void tick(); }, pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // pollKey 已经包含 open/linked/canLink/mockMode；toast 是稳定引用
  }, [pollKey, pollIntervalMs, pollTimeoutMs]);

  async function startLogin(): Promise<void> {
    setPhase('starting');
    setError('');
    try {
      const start = await store.dingtalkPersonalLogin();
      setStartInfo(start);
      setPhase('waiting');
    } catch (e) {
      setError(e instanceof Error ? e.message : '拉起钉钉登录失败，请稍后重试');
      setPhase('error');
    }
  }

  async function checkNow(): Promise<void> {
    setRefreshing(true);
    try {
      const status = await store.dingtalkPersonalStatus();
      if (status.authenticated) {
        toast.success(`钉钉本人身份已连接${status.displayName ? `：${status.displayName}` : ''}`);
        onRefreshRef.current?.();
        onCloseRef.current();
        return;
      }
      setPhase('timeout');
      toast.info('还没检测到登录：请先在浏览器 / 终端完成钉钉授权，再点一次「刷新状态」');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '刷新状态失败，请检查后端服务');
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshDetection(): Promise<void> {
    setRefreshing(true);
    try {
      await Promise.resolve(onRefreshRef.current?.());
      toast.success('已重新检测，请查看账号卡片上的身份状态');
    } finally {
      setRefreshing(false);
    }
  }

  async function logout(): Promise<void> {
    try {
      await store.dingtalkPersonalLogout();
      toast.success('已注销钉钉本人身份，收发已回到机器人 / Mock 通道');
      onRefreshRef.current?.();
      onCloseRef.current();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '注销失败，请稍后重试');
    }
  }

  function renderInstall(): ReactNode {
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          message="本机还没有安装 dws（钉钉工作台 CLI）"
          description="钉钉没有「一登录就自动生效」的云端接口：本人身份收发依赖本机运行官方 dws。装好并登录后，LinkHub 就能以你本人身份收发。"
        />
        <ol className="personal-modal__steps">
          <li>
            打开官方下载页，下载 Windows 版 <strong>dws.exe</strong>：
            <div className="personal-modal__line">
              <Typography.Text className="personal-modal__link" copyable={{ text: DWS_DOWNLOAD_URL, tooltips: COPY_TOOLTIPS }}>
                {DWS_DOWNLOAD_URL}
              </Typography.Text>
            </div>
          </li>
          <li>
            把 dws.exe 放到系统 PATH 里的目录（例如 <code>C:\Users\你的用户名\.local\bin</code>），
            或改 .env 指定绝对路径：
            <div className="personal-modal__line">
              <Command text={DWS_BIN_EXAMPLE} />
            </div>
          </li>
          <li>重启后端（让新配置生效），回到本页点「重新检测」。</li>
        </ol>
        {user?.hint && <div className="personal-modal__hint">{user.hint}</div>}
        <div className="personal-modal__actions">
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refreshDetection()}>
            重新检测
          </Button>
          <Button type="link" href={DWS_DOWNLOAD_URL} target="_blank" icon={<CloudDownloadOutlined />}>
            打不开？直接访问下载页
          </Button>
        </div>
      </Space>
    );
  }

  function renderLinked(): ReactNode {
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div className="personal-modal__linked">
          <Tag color="success" icon={<CheckCircleFilled />}>
            已连接本人账号
          </Tag>
          <span className="personal-modal__linked-name">{user?.displayName ?? '当前登录用户'}</span>
        </div>
        {(user?.detail || user?.expiresAt) && (
          <div className="personal-modal__hint">
            {user?.detail}
            {user?.detail && user?.expiresAt ? ' · ' : ''}
            {user?.expiresAt ? `有效期至 ${formatExpiry(user.expiresAt)}` : ''}
          </div>
        )}
        {user?.hint && <div className="personal-modal__hint">{user.hint}</div>}
        <Alert
          type="success"
          showIcon
          message="现在谁在收、谁在发"
          description="钉钉消息会以你本人身份接收（按 DINGTALK_USER_EVENT_KINDS 的范围），发送也以你本人发出。机器人通道保留为兜底，换账号只需重新登录。"
        />
        <div className="personal-modal__actions">
          <Button
            type="primary"
            icon={<LoginOutlined />}
            onClick={() => {
              setReloginMode(true);
              void startLogin();
            }}
          >
            重新登录（换账号）
          </Button>
          <Popconfirm
            title="注销钉钉本人身份？"
            description="注销后收发会回到机器人（或 Mock）通道，可随时重新登录。"
            okText="注销"
            cancelText="取消"
            onConfirm={() => void logout()}
          >
            <Button danger>注销</Button>
          </Popconfirm>
        </div>
      </Space>
    );
  }

  function renderLogin(): ReactNode {
    const waiting = phase === 'waiting' || phase === 'starting';
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <WhyLogin />
        {user?.hint && <div className="personal-modal__hint">{user.hint}</div>}

        {phase === 'error' && (
          <Alert
            type="error"
            showIcon
            message="拉起登录失败"
            description={error || '请检查后端是否运行、dws 是否可用，然后重试。'}
          />
        )}
        {phase === 'timeout' && (
          <Alert
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            message="还没有检测到登录"
            description="请先在浏览器 / 终端里完成钉钉授权；完成后点「刷新状态」，或关掉弹窗回账号页看身份是否变成「本人」。"
          />
        )}

        {startInfo ? (
          <div className="personal-modal__start">
            <div className="personal-modal__start-title">
              {startInfo.mode === 'device' ? '请在浏览器 / 手机完成授权' : '登录流程已拉起'}
            </div>
            <div className="personal-modal__start-text">{startInfo.instructions}</div>
            {startInfo.url && (
              <div className="personal-modal__line">
                授权链接：
                <Typography.Text copyable={{ text: startInfo.url, tooltips: COPY_TOOLTIPS }}>
                  <a href={startInfo.url} target="_blank" rel="noreferrer">
                    {startInfo.url}
                  </a>
                </Typography.Text>
              </div>
            )}
            {startInfo.code && (
              <div className="personal-modal__line">
                设备码：
                <Typography.Text
                  className="personal-modal__code"
                  code
                  copyable={{ text: startInfo.code, tooltips: COPY_TOOLTIPS }}
                >
                  {startInfo.code}
                </Typography.Text>
              </div>
            )}
            {startInfo.command && (
              <div className="personal-modal__line">
                终端等价命令：<Command text={startInfo.command} />
              </div>
            )}
            {waiting && (
              <div className="personal-modal__waiting" role="status">
                <span className="personal-modal__pulse" aria-hidden="true" />
                正在自动检测登录状态（每 2 秒一次，最多等 2 分钟）…
              </div>
            )}
          </div>
        ) : (
          <div className="personal-modal__start">
            <div className="personal-modal__start-text">
              点下面的「开始登录」，LinkHub 会调用本机 dws 拉起钉钉官方授权页。
              完成后这个弹窗会自动变成「已连接」，账号卡片随即显示「本人」。
            </div>
            {user?.loginCommand && (
              <div className="personal-modal__line">
                也可以在终端自己执行：<Command text={user.loginCommand} />
              </div>
            )}
            {waiting && (
              <div className="personal-modal__waiting" role="status">
                <span className="personal-modal__pulse" aria-hidden="true" />
                正在拉起登录并自动检测状态…
              </div>
            )}
            {!waiting && (
              <div className="personal-modal__waiting" role="status">
                <span className="personal-modal__pulse" aria-hidden="true" />
                正在自动检测本机登录状态（已登录会自动识别）
              </div>
            )}
          </div>
        )}

        <div className="personal-modal__actions">
          <Button
            type="primary"
            icon={<LoginOutlined />}
            loading={phase === 'starting'}
            disabled={waiting}
            onClick={() => void startLogin()}
          >
            {phase === 'idle' || phase === 'timeout' || phase === 'error' ? '开始登录' : '重新发起登录'}
          </Button>
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void checkNow()}>
            我已登录，刷新状态
          </Button>
          <Button type="link" onClick={() => void refreshDetection()} loading={refreshing}>
            重新检测本机 dws
          </Button>
        </div>
      </Space>
    );
  }

  let body: ReactNode;
  if (mockMode) {
    body = (
      <Alert
        type="info"
        showIcon
        message="当前平台通道是 Mock 模拟，无法登录真实钉钉账号"
        description="先在 .env 配置钉钉应用凭据（DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET）并把 DINGTALK_MODE 设为 real，重启后端后再回来连接。Mock 模式不会真实收发，也不会假成功。"
      />
    );
  } else if (!identity || !user) {
    body = (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="后端还没有返回钉钉身份状态"
          description="可能是后端版本较旧或账号接口暂不可用；刷新后重试。"
        />
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refreshDetection()}>
          刷新状态
        </Button>
      </Space>
    );
  } else if (linked && !reloginMode) {
    body = renderLinked();
  } else if (unavailable) {
    body = renderInstall();
  } else {
    body = renderLogin();
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="连接钉钉本人账号"
      width={560}
      destroyOnHidden
      footer={
        <Button onClick={onClose}>
          关闭
        </Button>
      }
    >
      {body}
    </Modal>
  );
}