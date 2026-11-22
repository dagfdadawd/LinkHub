/**
 * 钉钉「连接本人账号」引导弹窗。
 *
 * 普通同事不是工程师：这里按「为什么 → 怎么做 → 现在到哪一步 → 成功后怎样」组织，
 * 每一步都给可复制命令 / 可点链接，并自动轮询登录状态，不让用户在「登录了但页面没反应」里猜。
 *
 * 登录方式（2026-11 实测修正）：
 *  - **用浏览器登录（推荐）**：dws 起本机 loopback 回调（127.0.0.1），浏览器扫码/账号登录后自动完成，
 *    **不用手输设备码**；必须在运行 LinkHub 的这台机器上打开授权页。
 *  - **使用设备码登录（远程/无浏览器）**：用于服务器 / SSH / 容器；设备码有时效，过期必须重新获取，
 *    否则钉钉页面会提示「Invalid or expired user code」。
 *
 * 平台事实（如实标注，不假装零配置）：
 *  - 钉钉本人身份依赖本机安装官方 [DingTalk Workspace CLI（dws）]；
 *  - 首次登录需要在 dws 里完成 OAuth 授权，LinkHub 不接触密码；
 *  - dws 未安装 / 未登录时，收发会按 auto 策略回退机器人身份（绝不假装成功）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, App as AntApp, Button, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import {
  CheckCircleFilled,
  CloudDownloadOutlined,
  GlobalOutlined,
  LinkOutlined,
  LoginOutlined,
  MobileOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { PlatformIdentityView } from '@unimsg/shared';
import type {
  DingtalkLoginMode,
  DingtalkLoginStart,
  DingtalkPersonalStatus,
} from '../../services/api';
import { store } from '../../store';

/** dws 官方 release 下载页（Windows 用户下载 dws.exe；官方也提供脚本/npm 等多通道，这里只引导最直观的下载） */
export const DWS_DOWNLOAD_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases';
/** 已下载 dws.exe 时的 .env 写法示例（复制到 .env 后重启后端） */
export const DWS_BIN_EXAMPLE = 'DWS_BIN=C:\\Users\\<你的用户名>\\.local\\bin\\dws.exe';

/** 授权成功后的统一 toast（docs 与本文件保持一致） */
export const DINGTALK_SUCCESS_TOAST = '钉钉本人身份已连接，后续消息将以本人身份收发';

/** 设备码模式的有效期说明（避免用户继续输入过期码） */
export const DEVICE_CODE_TTL_HINT =
  '设备码有有效期（见下方倒计时，通常 15 分钟）。过期后请点「重新获取授权码」，'
  + '不要继续输入旧码，否则钉钉页面会提示「授权码无效或已过期」。';

const COPY_TOOLTIPS: [string, string] = ['复制命令', '已复制'];
const COPY_CODE_TOOLTIPS: [string, string] = ['复制授权码', '已复制'];
const COPY_URL_TOOLTIPS: [string, string] = ['复制授权链接', '已复制'];

type Phase = 'idle' | 'starting' | 'waiting' | 'timeout' | 'error';
type LoginMode = 'browser' | 'device';

/** 进行中的登录流程（来自 POST login 或 GET status 的恢复数据） */
export interface ActiveLogin {
  mode: LoginMode;
  url?: string;
  code?: string;
  instructions?: string;
  command?: string;
  /** 有效期截止时间（ms）；undefined = 后端没给有效期，不显示倒计时 */
  expiresAt?: number;
  loginId?: string;
}

/** 计算有效期截止时间：优先 expiresAt，其次 expiresInSec（兼容后端只给其一的版本） */
export function parseExpiresAt(
  info: { expiresAt?: string; expiresInSec?: number },
  now = Date.now(),
): number | undefined {
  if (info.expiresAt) {
    const parsed = Date.parse(info.expiresAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof info.expiresInSec === 'number' && Number.isFinite(info.expiresInSec) && info.expiresInSec > 0) {
    return now + info.expiresInSec * 1_000;
  }
  return undefined;
}

/** POST login 返回 → 进行中登录态 */
export function activeFromStart(start: DingtalkLoginStart, now = Date.now()): ActiveLogin {
  return {
    mode: start.mode,
    ...(start.url ? { url: start.url } : {}),
    ...(start.code ? { code: start.code } : {}),
    ...(start.instructions ? { instructions: start.instructions } : {}),
    ...(start.command ? { command: start.command } : {}),
    ...(parseExpiresAt(start, now) !== undefined ? { expiresAt: parseExpiresAt(start, now) } : {}),
    ...(start.loginId ? { loginId: start.loginId } : {}),
  };
}

/** GET status 返回 → 进行中登录态（供打开弹窗时恢复；没在登录返回 undefined） */
export function activeFromStatus(
  status: DingtalkPersonalStatus,
  now = Date.now(),
): ActiveLogin | undefined {
  if (!status.loginInProgress) return undefined;
  const mode: LoginMode = status.loginMode ?? (status.loginCode ? 'device' : 'browser');
  // 后端同时给 loginExpiresInSec（按它自己的时钟算好）与 loginExpiresAt；优先 ISO，缺失时用秒数
  const expiresAt = parseExpiresAt(
    { expiresAt: status.loginExpiresAt, expiresInSec: status.loginExpiresInSec },
    now,
  );
  return {
    mode,
    ...(status.loginUrl ? { url: status.loginUrl } : {}),
    ...(status.loginCode ? { code: status.loginCode } : {}),
    ...(status.loginInstructions ? { instructions: status.loginInstructions } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(status.loginId ? { loginId: status.loginId } : {}),
  };
}

/** 倒计时文案：m:ss（向下取整到秒，避免显示 0:00 前还有半秒的空档） */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 是否已过期（没有有效期时永不过期，交给轮询/后端判断） */
export function isLoginExpired(expiresAt: number | undefined, now = Date.now()): boolean {
  return typeof expiresAt === 'number' && expiresAt <= now;
}

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
        <strong>登录用的是本机的钉钉官方工具</strong>：授权在钉钉官方页面完成，LinkHub 只读取
        「已登录 / 未登录」状态，不接触你的密码。
      </li>
      <li>
        <strong>随时可回退</strong>：不登录或退出后，消息会自动走机器人通道兜底；如果部署时
        固定成「只用机器人」，则不登录也能照常收发。
      </li>
    </ul>
  );
}

export function PersonalIdentityModal({
  open,
  identity,
  mockMode = false,
  autoStart,
  onClose,
  onRefresh,
  successToast,
  pollIntervalMs = 2_000,
  pollTimeoutMs = 120_000,
  countdownIntervalMs = 1_000,
}: {
  open: boolean;
  identity?: PlatformIdentityView;
  /**
   * 平台整体为 Mock（运行态 effective=mock）：
   * 白号允许直接登录本人账号（后端不禁），登录后还需启用「仅用本人身份」才会真实收发。
   */
  mockMode?: boolean;
  /** 打开后自动发起登录（连接账号页「用钉钉本人账号登录（推荐）」一登即用） */
  autoStart?: 'browser' | 'device';
  onClose: () => void;
  /** 状态变化后让账号页重拉 /api/accounts */
  onRefresh?: () => void;
  /** 登录成功后的 toast 文案（连接账号页「一登即用」需要说明身份已自动启用） */
  successToast?: string;
  /** 轮询间隔（测试注入更短的值） */
  pollIntervalMs?: number;
  /** 没有进行中登录时最多自动检测多久；有 expiresAt 时会自动延长到过期后 30s */
  pollTimeoutMs?: number;
  /** 倒计时刷新间隔（测试注入更短的值） */
  countdownIntervalMs?: number;
}) {
  const { message: toast } = AntApp.useApp();
  const [phase, setPhase] = useState<Phase>('idle');
  const [active, setActive] = useState<ActiveLogin>();
  const [startingMode, setStartingMode] = useState<LoginMode>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  /** 已连接时点「重新登录（换账号）」→ 临时进入登录流程视图 */
  const [reloginMode, setReloginMode] = useState(false);
  /** 倒计时用「当前时间」：由定时器驱动，过期态与剩余时间都从这里派生 */
  const [now, setNow] = useState(() => Date.now());

  const onCloseRef = useRef(onClose);
  const onRefreshRef = useRef(onRefresh);
  const successToastRef = useRef(successToast);
  onCloseRef.current = onClose;
  onRefreshRef.current = onRefresh;
  successToastRef.current = successToast;

  const user = identity?.user;
  const linked = Boolean(user?.linked);
  const canLink = Boolean(user?.canLink);
  const unavailable = Boolean(user) && !user?.linked && !canLink;

  // 给「只在打开时执行一次」的 effect 读取最新值，避免状态刷新导致重复恢复/重复轮询
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const canLinkRef = useRef(canLink);
  canLinkRef.current = canLink;
  const mockModeRef = useRef(mockMode);
  mockModeRef.current = mockMode;
  const autoStartRef = useRef(autoStart);
  autoStartRef.current = autoStart;
  const autoStartedRef = useRef(false);
  const activeRef = useRef<ActiveLogin>();
  activeRef.current = active;
  /** 用户发起过登录（用于「父级刷新后 identity.linked=true」时自动关闭） */
  const attemptedRef = useRef(false);
  /** 成功只处理一次（toast/onClose 不重复） */
  const successRef = useRef(false);

  /** 授权成功统一出口：toast + 刷新账号页 + 自动关闭 */
  function successClose(): void {
    if (successRef.current) return;
    successRef.current = true;
    if (mockModeRef.current) {
      // P0-2：登录成功 ≠ 能真实收发——运行态仍是 Mock 时必须如实提醒
      toast.warning(
        '钉钉本人账号已登录，但钉钉当前仍是演示模式：'
        + '请到「连接账号」启用「仅用本人身份」（立即生效，无需重启）后才会真实收发。',
      );
    } else {
      toast.success(successToastRef.current ?? DINGTALK_SUCCESS_TOAST);
    }
    onRefreshRef.current?.();
    onCloseRef.current();
  }

  // 打开弹窗：重置本地状态 + 从 /status 恢复进行中的登录（深链 / 刷新 / 重开弹窗不丢进度）
  useEffect(() => {
    if (!open) return;
    setPhase('idle');
    setActive(undefined);
    setStartingMode(undefined);
    setError('');
    setRefreshing(false);
    setRestoring(false);
    setPopupBlocked(false);
    setReloginMode(false);
    setNow(Date.now());
    attemptedRef.current = false;
    successRef.current = false;
    autoStartedRef.current = false;

    // Mock 运行态也允许登录（白号 P1-1）；已连接 / 不可登录场景不需要探测
    if (linkedRef.current || !canLink) return;

    let alive = true;
    setRestoring(true);
    void (async () => {
      try {
        const status = await store.dingtalkPersonalStatus();
        if (!alive) return;
        if (status.authenticated) {
          successClose();
          return;
        }
        const restored = activeFromStatus(status);
        if (restored) {
          // 恢复上一次未完成的登录：不重新生成设备码 / 不重复打开浏览器
          setActive(restored);
          setNow(Date.now());
          attemptedRef.current = true;
          setPhase('waiting');
          return;
        }
        // 「一登即用」：打开即自动拉起浏览器登录（同一时间只发起一次）
        if (autoStartRef.current && !autoStartedRef.current) {
          autoStartedRef.current = true;
          await startLogin(autoStartRef.current);
        }
      } catch {
        // 状态接口抖动：保持可手动发起登录，不阻塞弹窗
      } finally {
        if (alive) setRestoring(false);
      }
    })();
    return () => {
      alive = false;
    };
    // 只在「打开」时执行；linked/canLink/mockMode/autoStart 用 ref 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 倒计时：仅在存在有效期时每秒刷新 now，避免无谓渲染
  useEffect(() => {
    if (!open || active?.expiresAt === undefined) return;
    const timer = window.setInterval(
      () => setNow(Date.now()),
      Math.max(200, countdownIntervalMs),
    );
    return () => window.clearInterval(timer);
  }, [open, active?.expiresAt, countdownIntervalMs]);

  /**
   * 自动轮询登录状态：浏览器授权完成 / 设备码被确认后 2 秒内自动识别并关闭。
   * 未登录本人身份时才轮询；已连接（换账号视图）不轮询，避免旧 token 让弹窗误判成功。
   */
  useEffect(() => {
    if (!open || linked || !canLink) return;
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    // 有进行中登录且知道有效期时，延长自动检测窗口（设备码通常 15 分钟有效）
    const pollLimitMs = (): number => {
      const expiresAt = activeRef.current?.expiresAt;
      return expiresAt ? Math.max(pollTimeoutMs, expiresAt - Date.now() + 30_000) : pollTimeoutMs;
    };

    const tick = async (): Promise<void> => {
      try {
        const status = await store.dingtalkPersonalStatus();
        if (cancelled) return;
        if (status.authenticated) {
          successClose();
          return;
        }
        const restored = activeFromStatus(status);
        if (restored) {
          const current = activeRef.current;
          const changed =
            !current ||
            current.mode !== restored.mode ||
            current.code !== restored.code ||
            current.url !== restored.url;
          if (changed) {
            setActive(restored);
            setNow(Date.now());
            attemptedRef.current = true;
            setPhase('waiting');
          } else if (restored.expiresAt && restored.expiresAt !== current.expiresAt) {
            setActive({ ...current, expiresAt: restored.expiresAt });
          }
        } else if (activeRef.current && status.loginInProgress === false) {
          // 登录流程结束了但没成功（浏览器关闭 / 设备码过期 / 被取消）
          setPhase('timeout');
        }
      } catch {
        // 网络抖动 / 后端暂不可用时继续等下一轮，不打断用户操作
      }
      if (cancelled) return;
      if (Date.now() - startedAt >= pollLimitMs()) {
        setPhase('timeout');
        return;
      }
      timer = window.setTimeout(() => { void tick(); }, pollIntervalMs);
    };

    timer = window.setTimeout(() => { void tick(); }, pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, linked, canLink, pollIntervalMs, pollTimeoutMs]);

  // 父级刷新后 identity 变成「已连接」且本次确实发起过登录：自动收尾（不等下一次轮询）
  useEffect(() => {
    if (!open || !linked || successRef.current) return;
    if (!attemptedRef.current) return;
    successClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, linked]);

  /** 发起登录：browser=本机 loopback（推荐）；device=设备码（远程/无浏览器） */
  async function startLogin(mode: DingtalkLoginMode, options: { force?: boolean } = {}): Promise<void> {
    const requested: LoginMode = mode === 'auto' ? 'browser' : mode;
    setPhase('starting');
    setStartingMode(requested);
    setError('');
    setPopupBlocked(false);
    attemptedRef.current = true;
    try {
      const start = await store.dingtalkPersonalLogin({
        mode,
        ...(options.force ? { force: true } : {}),
      });
      setActive(activeFromStart(start));
      setNow(Date.now());
      if (start.started === false) {
        // 后端把 dws 的启动失败/回退原因放在 instructions 里：不假装在等，直接给可操作提示
        setError(start.instructions || '登录未能自动启动，请重试；或在终端手动执行登录命令（高级）。');
        setPhase('error');
      } else {
        setPhase('waiting');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '拉起钉钉登录失败，请稍后重试');
      setPhase('error');
    } finally {
      setStartingMode(undefined);
    }
  }

  /** 打开授权页：优先 window.open；被浏览器拦截时展示可点击链接（不静默失败） */
  function openAuthUrl(url?: string): void {
    if (!url) return;
    let popup: Window | null = null;
    try {
      popup = window.open(url, '_blank', 'noopener');
    } catch {
      popup = null;
    }
    setPopupBlocked(!popup);
  }

  async function checkNow(): Promise<void> {
    setRefreshing(true);
    try {
      const status = await store.dingtalkPersonalStatus();
      if (status.authenticated) {
        // 换账号视图里旧 token 仍是 authenticated：登录流程没结束前别急着报成功
        if (linked && status.loginInProgress) {
          toast.info('登录流程仍在进行：请先在浏览器 / 设备上完成钉钉授权，再刷新状态');
          return;
        }
        successClose();
        return;
      }
      const restored = activeFromStatus(status);
      if (restored) {
        setActive(restored);
        setNow(Date.now());
        attemptedRef.current = true;
        setPhase('waiting');
        toast.info('登录流程仍在进行：完成授权后会自动刷新，也可以再点一次「我已登录，刷新状态」');
        return;
      }
      setPhase('timeout');
      toast.info('还没检测到登录：请先在浏览器 / 设备完成钉钉授权，再点「我已登录，刷新状态」');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '刷新状态失败，请检查 LinkHub 是否在运行');
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshDetection(): Promise<void> {
    setRefreshing(true);
    try {
      onRefreshRef.current?.();
      toast.success('已重新检测，请查看账号卡片上的身份状态');
    } finally {
      setRefreshing(false);
    }
  }

  async function logout(): Promise<void> {
    try {
      await store.dingtalkPersonalLogout();
      toast.success('已退出钉钉本人身份，收发会回到机器人（或演示模式）');
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
          message="这台电脑还没装钉钉官方登录工具"
          description="钉钉没有「网页登录一下就自动生效」的方式：本人身份收发需要在这台电脑上运行钉钉官方工具。装好并登录后，LinkHub 就能以你本人身份收发。"
        />
        <ol className="personal-modal__steps">
          <li>
            打开官方下载页，下载 Windows 版工具（<strong>dws.exe</strong>）：
            <div className="personal-modal__line">
              <Typography.Text className="personal-modal__link" copyable={{ text: DWS_DOWNLOAD_URL, tooltips: COPY_TOOLTIPS }}>
                {DWS_DOWNLOAD_URL}
              </Typography.Text>
            </div>
          </li>
          <li>
            把这个工具放到系统能找到的目录（例如 <code>C:\Users\你的用户名\.local\bin</code>），
            或让管理员在部署配置里写明它的位置（.env 写法）：
            <div className="personal-modal__line">
              <Command text={DWS_BIN_EXAMPLE} />
            </div>
          </li>
          <li>重新打开 LinkHub（让新配置生效），回到本页点「重新检测」。</li>
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
          description="钉钉消息会以你本人身份接收（消息范围由管理员设定），发送也以你本人发出。机器人通道保留为兜底，换账号只需重新登录。"
        />
        <div className="personal-modal__actions">
          <Button
            type="primary"
            icon={<LoginOutlined />}
            onClick={() => setReloginMode(true)}
          >
            重新登录（换账号）
          </Button>
          <Popconfirm
            title="注销钉钉本人身份？"
            description="退出后收发会回到机器人（或演示模式），可随时重新登录。"
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

  /** 未登录时的两种入口：浏览器（推荐）/ 设备码（远程） */
  function renderMethods(): ReactNode {
    const busy = phase === 'starting';
    return (
      <div className="personal-modal__methods">
        <div className="personal-modal__method">
          <Button
            type="primary"
            size="large"
            block
            icon={<GlobalOutlined />}
            loading={startingMode === 'browser'}
            disabled={busy && startingMode !== 'browser'}
            onClick={() => void startLogin('browser')}
            data-testid="login-browser"
          >
            用浏览器登录（推荐）
          </Button>
          <div className="personal-modal__method-hint">
            本机有浏览器时推荐：浏览器打开钉钉官方授权页，扫码 / 账号登录并确认后自动完成，
            <strong>不用手输设备码</strong>。
          </div>
        </div>

        <div className="personal-modal__method">
          <Button
            size="large"
            block
            icon={<MobileOutlined />}
            loading={startingMode === 'device'}
            disabled={busy && startingMode !== 'device'}
            onClick={() => void startLogin('device')}
            data-testid="login-device"
          >
            使用设备码登录（远程/无浏览器）
          </Button>
          <div className="personal-modal__method-hint">
            LinkHub 跑在服务器 / SSH / 容器里、本机没有浏览器时用：把授权链接发到另一台设备打开，
            在有效期内输入授权码；过期需「重新获取授权码」。
          </div>
        </div>

        <details className="personal-modal__details">
          <summary>终端手动登录（高级 / 开发者，可选）</summary>
          <div className="personal-modal__line">
            在运行 LinkHub 的机器终端执行：<Command text={user?.loginCommand ?? 'dws auth login'} />
          </div>
        </details>
      </div>
    );
  }

  /** 进行中的登录：展示授权链接 / 设备码 / 倒计时 / 刷新与切换入口 */
  function renderActive(info: ActiveLogin): ReactNode {
    const isDevice = info.mode === 'device';
    const remaining = info.expiresAt !== undefined ? info.expiresAt - now : undefined;
    const expired = isLoginExpired(info.expiresAt, now);
    const missingCode = isDevice && !info.code;
    const missingUrl = !info.url;
    const waiting = phase === 'waiting' || phase === 'starting';
    // 后端 instructions 与界面自身的提示可能重复：
    //  - device：instructions 里常含授权码/链接原文（下方已有大号展示）；
    //  - browser：「已尝试打开浏览器…」与上方短提示重复；
    //  - 启动失败：说明已在顶部错误 Alert。
    // 命中任一种就只保留界面自己的结构化展示，避免同一句话出现两遍。
    const instructionsText = info.instructions ?? '';
    const instructionsRedundant =
      phase === 'error'
      || Boolean(
        (info.code && instructionsText.includes(info.code))
        || (info.url && instructionsText.includes(info.url)),
      )
      || (info.mode === 'browser' && instructionsText.includes('已尝试打开浏览器'))
      || (info.mode === 'device' && instructionsText.includes('已启动钉钉设备码登录'));
    // 后端 instructions 已写清有效期时，不再重复我们的通用倒计时说明
    const ttlHintRedundant = /有效期|过期/.test(instructionsText);

    return (
      <div
        className="personal-modal__start"
        data-testid={`login-active-${info.mode}`}
      >
        <div className="personal-modal__start-title">
          {isDevice ? <MobileOutlined /> : <GlobalOutlined />}
          {isDevice ? '使用设备码登录（远程/无浏览器）' : '用浏览器登录（推荐）'}
        </div>
        <div className="personal-modal__start-text">
          {isDevice
            ? '请复制下面的授权链接，到另一台有浏览器的设备打开，并输入授权码完成钉钉登录。'
            : '已尝试在本机打开浏览器。如果没有弹出授权页，点下面的「打开授权页」；授权完成后本弹窗会自动刷新为已连接。'}
        </div>
        {info.instructions && !instructionsRedundant && (
          <div className="personal-modal__hint">{info.instructions}</div>
        )}
        {isDevice && !ttlHintRedundant && (
          <div className="personal-modal__hint">{DEVICE_CODE_TTL_HINT}</div>
        )}

        {expired && (
          <Alert
            type="warning"
            showIcon
            message="登录流程已过期"
            description={
              isDevice
                ? '授权码已过期，请点「重新获取授权码」后再输入；不要继续使用旧码，否则钉钉页面会提示「授权码无效或已过期」。'
                : '本次浏览器登录已超时，请点「重新发起」重新打开授权页。'
            }
          />
        )}
        {missingCode && !expired && (
          <Alert
            type="info"
            showIcon
            message="没有拿到设备码"
            description="上一次登录流程可能已被重置或已过期。点「刷新状态」同步，或点「重新获取授权码」。"
          />
        )}
        {missingUrl && (
          <Alert
            type="info"
            showIcon
            message="没有拿到授权链接"
            description="点「我已登录，刷新状态」同步登录流程，或重新发起登录。"          />
        )}

        {isDevice && (
          <div className="personal-modal__code-block">
            <div className="personal-modal__code-label">授权码</div>
            {info.code ? (
              <Typography.Text
                className={`personal-modal__code${expired ? ' personal-modal__code--expired' : ''}`}
                code
                copyable={expired ? false : { text: info.code, tooltips: COPY_CODE_TOOLTIPS }}
              >
                {info.code}
              </Typography.Text>
            ) : (
              <span className="personal-modal__hint">（未获取到授权码）</span>
            )}
            {remaining !== undefined &&
              (expired ? (
                <div className="personal-modal__countdown personal-modal__countdown--expired">
                  授权码已过期，请重新获取
                </div>
              ) : (
                <div className="personal-modal__countdown">
                  授权码有效期剩余 {formatCountdown(remaining)}
                </div>
              ))}
          </div>
        )}

        {info.url && (
          <div className="personal-modal__url-block">
            <div className="personal-modal__line">授权链接：</div>
            <div className="personal-modal__line personal-modal__line--url">
              <Button
                size="small"
                type="primary"
                icon={<LinkOutlined />}
                onClick={() => openAuthUrl(info.url)}
                data-testid="open-auth-url"
              >
                打开授权页
              </Button>
              <Typography.Text
                className="personal-modal__link"
                copyable={{ text: info.url, tooltips: COPY_URL_TOOLTIPS }}
              >
                {info.url}
              </Typography.Text>
            </div>
            <a
              className="personal-modal__raw-link"
              href={info.url}
              target="_blank"
              rel="noreferrer"
            >
              没反应？直接点这里打开授权链接
            </a>
          </div>
        )}

        <div className="personal-modal__hint">
          {isDevice
            ? '授权链接可以在另一台有浏览器的设备打开；设备码请在有效期内输入。'
            : '授权地址只能在运行 LinkHub 的这台电脑上打开；如果 LinkHub 跑在服务器 / 容器里，请改用设备码登录。'}
        </div>

        {popupBlocked && (
          <Alert
            type="warning"
            showIcon
            message="浏览器拦截了弹窗"
            description="请点上面的授权链接，或复制授权地址到本机浏览器打开（授权地址只在本次登录有效）。"
          />
        )}

        {info.command && (
          <div className="personal-modal__line">
            对应的终端命令（高级）：<Command text={info.command} />
          </div>
        )}

        {waiting && (
          <div className="personal-modal__waiting" role="status">
            <span className="personal-modal__pulse" aria-hidden="true" />
            正在自动检测登录状态（每 2 秒一次）…
          </div>
        )}
        {phase === 'timeout' && (
          <div className="personal-modal__hint">
            自动检测已停止：完成授权后点「我已登录，刷新状态」，或重新发起登录。
          </div>
        )}

        <div className="personal-modal__actions">
          <Button
            type="primary"
            icon={<LoginOutlined />}
            loading={refreshing}
            disabled={startingMode !== undefined}
            onClick={() => void checkNow()}
          >
            我已登录，刷新状态
          </Button>
          {isDevice ? (
            <>
              <Button
                icon={<GlobalOutlined />}
                loading={startingMode === 'browser'}
                disabled={startingMode === 'device'}
                onClick={() => void startLogin('browser', { force: true })}
              >
                改用浏览器登录
              </Button>
              <Button
                icon={<ReloadOutlined />}
                loading={startingMode === 'device'}
                disabled={startingMode === 'browser'}
                onClick={() => void startLogin('device', { force: true })}
              >
                重新获取授权码
              </Button>
            </>
          ) : (
            <>
              <Button
                icon={<MobileOutlined />}
                loading={startingMode === 'device'}
                disabled={startingMode === 'browser'}
                onClick={() => void startLogin('device', { force: true })}
              >
                改用设备码登录
              </Button>
              <Button
                icon={<ReloadOutlined />}
                loading={startingMode === 'browser'}
                disabled={startingMode === 'device'}
                onClick={() => void startLogin('browser', { force: true })}
              >
                重新发起
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  function renderLogin(): ReactNode {
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <WhyLogin />
        {user?.hint && <div className="personal-modal__hint">{user.hint}</div>}

        {phase === 'error' && (
          <Alert
            type="error"
            showIcon
            message="拉起登录失败"
            description={error || '请检查 LinkHub 是否在运行、本机工具是否可用，然后重试。'}
          />
        )}
        {phase === 'timeout' && !active && (
          <Alert
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            message="还没有检测到登录"
            description="请先在浏览器 / 设备完成钉钉授权；完成后点「我已登录，刷新状态」，或重新发起登录。"
          />
        )}

        {restoring && !active && (
          <div className="personal-modal__waiting" role="status">
            <span className="personal-modal__pulse" aria-hidden="true" />
            正在恢复上一次登录状态…
          </div>
        )}

        {active ? renderActive(active) : (!restoring && renderMethods())}

        {!active && (
          <div className="personal-modal__actions">
            <Button icon={<LoginOutlined />} loading={refreshing} onClick={() => void checkNow()}>
              我已登录，刷新状态
            </Button>
            <Button type="link" loading={refreshing} onClick={() => void refreshDetection()}>
              重新检测本机工具
            </Button>
          </div>
        )}
      </Space>
    );
  }

  let body: ReactNode;
  if (mockMode && user) {
    const mockAlert = (
      <Alert
        className="personal-modal__mock-alert"
        type="warning"
        showIcon
        message={
          linked
            ? '本人账号已登录，但钉钉当前仍是演示模式（不会真实收发）'
            : '钉钉当前是演示模式：可以先登录本人账号'
        }
        description={
          linked
            ? '登录本身已成功，但收发仍是模拟。请到「连接账号」页启用「仅用本人身份」（立即生效，无需重启），之后消息才会以本人身份真实收发。'
            : '没有企业机器人应用也能用本人身份：登录后到「连接账号」页点「用钉钉本人账号登录（推荐）」，会先切换身份模式（立即生效、无需重启），再用浏览器完成授权。演示模式下不会真实收发，也不会假成功。'
        }
      />
    );
    if (linked && !reloginMode) {
      body = <Space direction="vertical" size="middle" style={{ width: '100%' }}>{mockAlert}{renderLinked()}</Space>;
    } else if (unavailable) {
      body = renderInstall();
    } else {
      body = <Space direction="vertical" size="middle" style={{ width: '100%' }}>{mockAlert}{renderLogin()}</Space>;
    }
  } else if (!identity || !user) {
    body = (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="暂时读不到钉钉的连接状态"
          description="可能是 LinkHub 版本较旧，或服务暂时不可用；刷新后重试。"
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
      width={600}
      destroyOnHidden
      /** 内容较高：贴顶部摆放而不是垂直居中，避免上下留白不均、底部按钮被裁 */
      style={{ top: 48 }}
      styles={{ body: { maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' } }}
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
