import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Alert, App as AntApp, Avatar, Button, Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import {
  ApiOutlined,
  CheckSquareOutlined,
  DownOutlined,
  HistoryOutlined,
  InboxOutlined,
  LinkOutlined,
  MoonOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  SunOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useAppState } from '../hooks/useAppState';
import { store } from '../store';
import { ConnectionDot } from '../components/ConnectionDot';
import { PlatformGlyph } from '../components/PlatformGlyph';
import { footerShortLabel, footerState } from '../utils/footerState';
import { clamp } from '../utils/format';
import { formatSendError } from '../utils/sendError';
import { initialOf, useProfile } from '../features/settings/profile';
import { usePreferences } from '../features/settings/preferences';
import { SettingsModal } from '../features/settings/SettingsModal';
import { ComposeModal } from '../features/compose/ComposeModal';
import { CommandPalette } from '../components/CommandPalette';
import { useTheme } from './ThemeProvider';
import { Platform } from '../types';
import type { UnifiedMessage } from '../types';
import { PLATFORM_META } from '../utils/format';
import { conversationKey } from '../utils/conversations';
import { ensureNotificationPermission, showSystemNotification } from '../services/notify';

/** 错误排查提示：后端未启动 / 端口不一致 / token 不一致是最常见的三类首启问题 */
const ERROR_HINTS =
  '排查：后端是否已启动（pnpm --filter @unimsg/server start）；VITE_API_BASE 是否指向正确端口；token 是否与后端 API_TOKEN 一致';

/** 顶栏标题：小号 eyebrow + 大标题，Apple 式信息层级 */
function pageMeta(pathname: string): { eyebrow: string; title: string } {
  if (pathname.startsWith('/todos')) return { eyebrow: 'TASKS', title: '待办' };
  if (pathname.startsWith('/trace')) return { eyebrow: 'TRACE', title: '全链路回放' };
  if (pathname.startsWith('/accounts')) return { eyebrow: 'ACCOUNTS', title: '平台账号' };
  if (pathname.startsWith('/connect')) return { eyebrow: 'CONNECT', title: '连接账号' };
  return { eyebrow: 'INBOX', title: '收件箱' };
}

/** ≤640px 时渲染底部导航；测试环境 matchMedia 返回 false，不会产生重复文案 */
function useIsCompact(): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 640px)');
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);

  return compact;
}

/**
 * 导航项：图标 + 常驻文字（不用 hover 才知道是什么）+ 可选计数。
 * 选中态只换底色与字色，不做发光/描边——参考图里导航是安静的。
 */
function SideLink({
  to,
  icon,
  label,
  count,
  onNavigate,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  count?: number;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      onClick={onNavigate}
      className={({ isActive }) => `side-link${isActive ? ' is-active' : ''}`}
    >
      <span className="side-link__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="side-link__label">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="side-link__count">{count > 99 ? '99+' : count}</span>
      )}
    </NavLink>
  );
}

export function AppShell() {
  const state = useAppState();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const { mode, toggle } = useTheme();
  const footer = footerState(state.demoMode, state.connection, state.error);
  const page = pageMeta(location.pathname);
  const compact = useIsCompact();
  const profile = useProfile();
  const prefs = usePreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  /**
   * 发送失败要「上浮」到用户眼前：之前失败原因只在回放日志里，
   * 用户看到消息变成「发送失败」却不知道原因。这里用 error toast 带一句可读原因，
   * 并提供「查看详情」直接跳到该消息（详情页同样展示失败原因 + 重试按钮）。
   */
  const sendFailure = state.sendFailure;
  useEffect(() => {
    if (!sendFailure) return;
    // 失败原因若带「改用 identity=user」建议，要按该平台本人身份是否已连接来分支（NEW-P2-3）
    const snapshot = store.getSnapshot();
    const failedMessage = snapshot.messages.find((m) => m.traceId === sendFailure.traceId);
    const failedAccount = failedMessage
      ? snapshot.accounts.find((a) => a.platform === failedMessage.platform)
      : undefined;
    const readableReason = sendFailure.reason
      ? formatSendError(sendFailure.reason, failedAccount?.identity)
      : '';
    const reason = readableReason
      ? clamp(readableReason, 60)
      : '具体原因见消息详情或全链路回放';
    message.error(
      <span className="failure-toast">
        <span>发送失败：{reason}</span>
        <Button
          type="link"
          size="small"
          className="failure-toast__link"
          onClick={() => {
            store.dismissSendFailure();
            navigate(`/inbox/${sendFailure.traceId}`);
          }}
        >
          查看详情
        </Button>
      </span>,
      8,
    );
    // 已弹出即清掉，避免同一次失败在重渲染时重复提示
    store.dismissSendFailure();
  }, [sendFailure, message, navigate]);

  // 偏好落到 <html data-*> 上，交给 CSS 生效（密度 / 动效）
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = prefs.density;
    root.dataset.motion = prefs.motion;
  }, [prefs.density, prefs.motion]);

  const counts = useMemo(() => {
    // 收件箱角标 = 未读数（阅读状态），不再用「未终结条数」——
    // 那个口径会让人误以为「角标 4 但其实都看过了」。
    // 自己发出的消息（含钉钉回声）不算未读：会话列表里它们不产生角标。
    const inbox = state.messages.filter((m) => m.direction !== 'out' && !m.readAt).length;
    const todos = state.messages.filter((m) => m.type === 'todo' && !m.done).length;
    // 接入平台分组：按平台统计当前收件箱里的条数（真实数据，不写死）
    const perPlatform = new Map<Platform, number>();
    for (const m of state.messages) {
      perPlatform.set(m.platform, (perPlatform.get(m.platform) ?? 0) + 1);
    }
    return { inbox, todos, perPlatform };
  }, [state.messages]);

  /**
   * 新消息提醒：应用内 toast + 系统通知（Windows / macOS 通知中心）。
   *  - 只提醒「入站」：自己发出的消息与钉钉回声永不弹窗；
   *  - 首屏已有历史不提醒，只有真正新到的才算；
   *  - 同一会话本批多条合并为一条通知，最多提醒 3 个会话，避免刷屏。
   */
  const seenInbound = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (state.loading) return;
    const inbound = state.messages.filter((m) => m.direction !== 'out');
    if (seenInbound.current === null) {
      seenInbound.current = new Set(inbound.map((m) => m.traceId));
      return;
    }
    const seen = seenInbound.current;
    const fresh = inbound.filter((m) => !seen.has(m.traceId) && !m.readAt);
    for (const m of inbound) seen.add(m.traceId);
    if (fresh.length === 0) return;

    const byConv = new Map<string, UnifiedMessage[]>();
    for (const m of fresh) {
      const key = conversationKey(m);
      const list = byConv.get(key);
      if (list) list.push(m);
      else byConv.set(key, [m]);
    }

    void (async () => {
      await ensureNotificationPermission();
      let shown = 0;
      for (const [key, list] of byConv) {
        if (shown >= 3) break;
        shown += 1;
        const last = list[list.length - 1];
        const title =
          last.conversation?.type === 'group' && last.conversation.title
            ? last.conversation.title
            : last.sender.name;
        const body = clamp(last.body, 40);
        showSystemNotification({ title, count: list.length, body, tag: key });
        // 应用内兜底：系统通知被拒或被专注助手拦截时，至少应用里能看见
        message.info(`${title}：${body}`);
      }
    })();
  }, [state.messages, state.loading, message]);

  // ⌘K / Ctrl+K 打开命令面板（顶层监听，输入框内也生效）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const demoMenu: MenuProps = {
    items: [
      { key: 'incoming', icon: <InboxOutlined />, label: '模拟平台推送一条新消息' },
      { key: 'fail', icon: <ThunderboltOutlined />, label: '让下一次回复失败（演示 DLQ）' },
      { type: 'divider' },
      { key: 'reset', icon: <ReloadOutlined />, label: '重置筛选条件' },
    ],
    onClick: async ({ key }) => {
      if (key === 'incoming') {
        await store.simulateIncoming();
        message.success('已模拟一条平台推送');
      } else if (key === 'fail') {
        store.armFailure();
        message.warning('下一次回复将演示失败：状态会变为「发送失败」');
      } else if (key === 'reset') {
        store.resetFilters();
        navigate('/inbox');
      }
    },
  };

  /** 平台导航：点一下 = 进收件箱 + 把渠道筛选切到该平台（复用既有筛选能力，不是新造的假入口） */
  const openPlatform = (platform: Platform) => {
    store.setFilters({ platform });
    navigate('/inbox');
  };
  const activePlatform =
    location.pathname.startsWith('/inbox') ? state.filters.platform : undefined;

  const platformNav = useMemo(
    () =>
      [Platform.FEISHU, Platform.DINGTALK, Platform.WECOM, Platform.MAIL].map((platform) => ({
        platform,
        name:
          platform === Platform.WECOM ? '企微' : PLATFORM_META[platform].name,
        count: counts.perPlatform.get(platform) ?? 0,
      })),
    [counts.perPlatform],
  );

  return (
    <div className="app-shell">
      <aside className="side">
        <div className="side__brand">
          <button
            className="side__logo"
            type="button"
            aria-label="返回收件箱"
            onClick={() => navigate('/inbox')}
          >
            <span aria-hidden="true">L</span>
          </button>
          <span className="side__brand-text">
            <strong>LinkHub</strong>
            <small>统一消息中心</small>
          </span>
        </div>

        <nav className="side__nav" aria-label="主导航">
          <div className="side__group">
            <SideLink to="/inbox" icon={<InboxOutlined />} label="收件箱" count={counts.inbox} />
            <SideLink to="/todos" icon={<CheckSquareOutlined />} label="待办" count={counts.todos} />
            <SideLink to="/trace" icon={<HistoryOutlined />} label="全链路回放" />
          </div>

          <div className="side__group">
            <span className="side__group-label">接入平台</span>
            {platformNav.map((item) => {
              const active = activePlatform === item.platform;
              return (
                <button
                  key={item.platform}
                  type="button"
                  className={`side-link side-link--platform${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => openPlatform(item.platform)}
                >
                  <span className={`side-link__icon side-link__icon--glyph is-${item.platform}`} aria-hidden="true">
                    <PlatformGlyph platform={item.platform} size={14} />
                  </span>
                  <span className="side-link__label">{item.name}</span>
                  <span className="side-link__count">{item.count}</span>
                </button>
              );
            })}
          </div>

          <div className="side__group">
            <SideLink to="/connect" icon={<LinkOutlined />} label="连接账号" />
            <SideLink to="/accounts" icon={<ApiOutlined />} label="平台账号" />
          </div>
        </nav>

        <div className="side__foot">
          <button
            className="side-link side-link--plain"
            type="button"
            aria-label="个人设置"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="side-link__icon" aria-hidden="true">
              <SettingOutlined />
            </span>
            <span className="side-link__label">设置</span>
          </button>

          <Tooltip title={`${footer.badge} · ${footer.text}`} placement="right">
            <span
              className={`side-status side-status--${footer.tone === 'ok' ? 'ok' : footer.tone}`}
              role="status"
              aria-label={`${footer.badge}：${footer.text}`}
            >
              <span className="side-status__dot" />
              <span className="side-status__text">{footerShortLabel(footer)}</span>
            </span>
          </Tooltip>
        </div>
      </aside>

      <div className="app-body">
        <div className="cmdbar">
          <div className="cmdbar__lead">
            <span className="cmdbar__eyebrow">{page.eyebrow}</span>
            <h1 className="cmdbar__title">{page.title}</h1>
          </div>

          <div className="cmdbar__actions">
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => setComposeOpen(true)}
              aria-label="新建发送"
              data-testid="open-compose"
            >
              新建发送
            </Button>

            <button
              className="search-trigger"
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="打开命令面板"
            >
              <SearchOutlined />
              <span className="search-trigger__label">搜索</span>
              <kbd className="kbd">⌘K</kbd>
            </button>

            <Tooltip title={state.demoMode ? '服务连接状态（演示模式）' : '服务连接状态（本地后端 + 实时推送）'}>
              <span>
                <ConnectionDot status={state.connection} />
              </span>
            </Tooltip>

            <Tooltip title={mode === 'dark' ? '切换到明色' : '切换到暗色'}>
              <button
                className="icon-btn"
                type="button"
                onClick={() => toggle()}
                aria-label="切换明暗主题"
              >
                {mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
              </button>
            </Tooltip>

            {state.demoMode && (
              <Dropdown menu={demoMenu} trigger={['click']}>
                <button className="demo-btn" type="button">
                  <ThunderboltOutlined /> 演示 <DownOutlined className="demo-btn__caret" />
                </button>
              </Dropdown>
            )}

            <Tooltip title={`${profile.name} · 个人设置`}>
              <button
                className="avatar-btn"
                type="button"
                aria-label="打开个人设置"
                onClick={() => setSettingsOpen(true)}
              >
                <Avatar
                  size={30}
                  className="brand-avatar"
                  style={{ background: profile.tone }}
                  src={profile.avatarUrl ?? undefined}
                >
                  {initialOf(profile.name)}
                </Avatar>
              </button>
            </Tooltip>
          </div>
        </div>

        <main className="app-main">
          {state.error && (
            <Alert
              style={{ margin: '12px 24px 0' }}
              type="error"
              showIcon
              closable
              message="数据加载异常"
              description={
                <div className="alert-detail">
                  <div>{state.error}</div>
                  <div className="alert-detail__hint">{ERROR_HINTS}</div>
                </div>
              }
              onClose={() => store.dismissError()}
            />
          )}
          <div className="app-content">
            <Outlet />
          </div>
        </main>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {compact && (
        <nav className="mobile-nav" aria-label="移动端导航">
          <NavLink
            to="/inbox"
            className={({ isActive }) => `mobile-nav__item${isActive ? ' is-active' : ''}`}
          >
            <InboxOutlined />
            <span>收件箱</span>
          </NavLink>
          <NavLink
            to="/connect"
            className={({ isActive }) => `mobile-nav__item${isActive ? ' is-active' : ''}`}
          >
            <LinkOutlined />
            <span>连接</span>
          </NavLink>
          <NavLink
            to="/todos"
            className={({ isActive }) => `mobile-nav__item${isActive ? ' is-active' : ''}`}
          >
            <CheckSquareOutlined />
            <span>待办</span>
          </NavLink>
          <NavLink
            to="/trace"
            className={({ isActive }) => `mobile-nav__item${isActive ? ' is-active' : ''}`}
          >
            <HistoryOutlined />
            <span>回放</span>
          </NavLink>
          <NavLink
            to="/accounts"
            className={({ isActive }) => `mobile-nav__item${isActive ? ' is-active' : ''}`}
          >
            <ApiOutlined />
            <span>账号</span>
          </NavLink>
        </nav>
      )}
    </div>
  );
}