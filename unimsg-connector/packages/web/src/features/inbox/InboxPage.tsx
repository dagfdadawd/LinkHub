import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as AntApp, Button, Input, Popover, Select, Skeleton } from 'antd';
import { CloseOutlined, FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { useAppState } from '../../hooks/useAppState';
import { useHotkeys } from '../../hooks/useHotkeys';
import { store } from '../../store';
import { filterMessages } from '../../store/appStore';
import { MsgStatus, Platform } from '../../types';
import { PLATFORM_META, STATUS_META, TYPE_LABEL } from '../../utils/format';
import { navigateWithMorph } from '../../utils/morph';
import {
  buildConversations,
  findConversation,
  type Conversation,
} from '../../utils/conversations';
import { injectSample, type InjectPlatform } from '../../services/demoSamples';
import { EmptyState } from '../../components/EmptyState';
import {
  FirstRunGuide,
  isEmptyFirstRun,
  readFirstRunDismissed,
  shouldShowFirstRun,
} from '../../components/FirstRunGuide';
import { OnboardingBanner } from '../../components/OnboardingBanner';
import { QuickStart } from '../../components/QuickStart';
import {
  isOnboarded,
  markOnboarded,
  shouldShowOnboardingBanner,
} from '../../utils/onboarding';
import { DetailPanel } from './DetailPanel';
import { ChannelTabs, CHANNEL_DEFS, type ChannelOption } from './ChannelTabs';
import { ConversationRow } from './ConversationRow';

const STATUS_OPTIONS = Object.values(MsgStatus).map((s) => ({
  value: s,
  label: STATUS_META[s].label,
}));

const TYPE_OPTIONS = (['text', 'image', 'file', 'todo'] as const).map((t) => ({
  value: t,
  label: TYPE_LABEL[t],
}));

/** 把焦点交给回复框；详情还没打开时先等一帧 */
function focusReplyComposer() {
  const focus = (): boolean => {
    const el = document.querySelector<HTMLTextAreaElement>('.composer textarea');
    if (!el) return false;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    return true;
  };
  if (!focus()) window.setTimeout(focus, 80);
}

export function InboxPage() {
  const state = useAppState();
  const navigate = useNavigate();
  const { traceId } = useParams();
  const [listCollapsed, setListCollapsed] = useState(false);
  const toast = AntApp.useApp().message;
  const injectSeq = useRef(0);
  /** 首启横幅：本地标记 + 后端 firstRun 任一触发；点过「去连接 / 稍后」后不再打扰 */
  const [onboarded, setOnboarded] = useState(() => isOnboarded());
  /** 首启 3 步引导是否已「知道了」（据此决定空态是否显示注入示例，避免双重引导） */
  const [firstRunDismissed, setFirstRunDismissed] = useState(() => readFirstRunDismissed());

  useEffect(() => {
    // 纯前端演示模式不需要拉授权中心（Mock 会如实返回演示状态，但横幅不显示）
    if (!state.demoMode) void store.refreshOnboarding();
  }, [state.demoMode]);

  const onboarding = state.onboarding;
  const showOnboarding = shouldShowOnboardingBanner({
    demoMode: state.demoMode,
    onboarded,
    firstRun: onboarding?.firstRun,
    ready: onboarding?.overall.ready,
    total: onboarding?.overall.total,
  });
  /** 从 onboarding steps 统一计算口径：管理员项 / 可自助项分开，不再硬编码平台数 */
  const needsAdminCount = onboarding?.steps?.filter(
    (step) => step.state === 'needs_admin' || step.state === 'needs_install',
  ).length ?? 0;
  const needsAuthCount = onboarding?.steps?.filter(
    (step) => step.state === 'needs_user_auth',
  ).length ?? 0;

  const dismissOnboarding = (): void => {
    markOnboarded();
    setOnboarded(true);
  };

  const openConnect = (): void => {
    markOnboarded();
    setOnboarded(true);
    navigate('/connect');
  };

  /** 横幅「先体验演示」：注入一条示例消息后收起横幅，不再重复打扰 */
  const demoFromOnboarding = (): void => {
    markOnboarded();
    setOnboarded(true);
    void handleInject();
  };

  const visible = useMemo(() => filterMessages(state.messages, state.filters), [state.messages, state.filters]);
  const selected = traceId ? state.messages.find((m) => m.traceId === traceId) : undefined;

  /**
   * 会话视图：列表按「人 / 群 / 邮件主题」聚合，不再一条消息一行。
   * 选中态用「URL 里的 traceId 属于哪个会话」反查，因此任何一条消息的深链都能定位到会话。
   */
  const conversations = useMemo(() => buildConversations(visible), [visible]);
  const allConversations = useMemo(() => buildConversations(state.messages), [state.messages]);
  const selectedConv = useMemo(
    () => findConversation(allConversations, traceId),
    [allConversations, traceId],
  );
  const imConversations = useMemo(() => conversations.filter((c) => c.kind === 'im'), [conversations]);
  const mailConversations = useMemo(
    () => conversations.filter((c) => c.kind === 'mail'),
    [conversations],
  );

  /**
   * 渠道数量：按「除平台外的其他筛选」计算。
   * 这样切到某个渠道时，其余渠道的数字不会因为自身筛选而坍缩；
   * 搜索/状态筛选变化时，数字又能跟着真实结果走。
   */
  const channelOptions = useMemo<ChannelOption[]>(() => {
    const base = filterMessages(state.messages, { ...state.filters, platform: undefined });
    const counts = new Map<Platform, number>();
    for (const m of base) counts.set(m.platform, (counts.get(m.platform) ?? 0) + 1);
    return CHANNEL_DEFS.map((def) => ({
      ...def,
      count: def.value ? (counts.get(def.value) ?? 0) : base.length,
    }));
  }, [state.messages, state.filters]);

  /**
   * 旧 traceId 失效时回退到列表（内存存储重启 / 消息被清空后很常见）。
   * 不替用户选中某一条，避免「我明明点的是 A，怎么打开了 B」。
   */
  useEffect(() => {
    if (state.loading || visible.length === 0) return;
    if (traceId && !selected) {
      navigate('/inbox', { replace: true });
    }
  }, [traceId, selected, visible, state.loading, navigate]);

  /** 打开会话：走共享元素转场；不支持的环境自动退化为普通跳转 */
  const openConversation = (id: string) => navigateWithMorph(navigate, `/inbox/${id}`);

  /** 空态一键注入：真实后端走 webhook（真实入站链路），Mock 模式走本地模拟 */
  const handleInject = async (platform?: InjectPlatform) => {
    try {
      if (state.demoMode) {
        await store.simulateIncoming();
        return;
      }
      // 真实后端：未指定平台时默认注入一条飞书示例（与首启 CTA 对应）
      const target = platform ?? Platform.FEISHU;
      const base = import.meta.env.VITE_API_BASE ?? '';
      await injectSample(target, injectSeq.current++, base);
      await store.refresh();
      toast.success(`已注入一条${PLATFORM_META[target].name}消息`);
    } catch (e) {
      toast.error(`注入失败：${e instanceof Error ? e.message : '未知错误'}`);
    }
  };

  /** 全部标为已读：只标记「当前筛选结果里的入站未读」，不动自己发出的消息 */
  const handleMarkAllRead = async () => {
    const ids = visible.filter((m) => m.direction !== 'out' && !m.readAt).map((m) => m.traceId);
    if (ids.length === 0) return;
    try {
      const changed = await store.markAllRead(ids);
      if (changed > 0) toast.success(`已把 ${changed} 条标为已读`);
    } catch (e) {
      toast.error(`标记失败：${e instanceof Error ? e.message : '未知错误'}`);
    }
  };

  const hasFilter =
    Boolean(state.filters.status) ||
    Boolean(state.filters.type) ||
    state.filters.onlyReview ||
    state.filters.onlyUnread ||
    Boolean(state.filters.keyword);

  /**
   * 已读规则：打开会话后停留 ≥800ms 才标已读，且只标该会话里的入站消息。
   * 键盘 j/k 上下浏览会把整个列表刷成已读，800ms 既过滤误触又不会「看完了还是未读」。
   */
  const selectedConvKey = selectedConv?.key;
  useEffect(() => {
    if (!selectedConv) return;
    const ids = selectedConv.messages
      .filter((m) => m.direction !== 'out' && !m.readAt)
      .map((m) => m.traceId);
    if (ids.length === 0) return;
    const timer = window.setTimeout(() => {
      void store.markAllRead(ids);
    }, 800);
    return () => window.clearTimeout(timer);
    // 只依赖会话键：同一会话里再来新消息不该重置计时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConvKey]);

  // 键盘流：j/k 在会话间移动、Enter 打开、r 回复、e 完成、Esc 收起详情
  const selectedIndex = selectedConv ? conversations.findIndex((c) => c.key === selectedConv.key) : -1;
  const openAt = (index: number) => {
    const target = conversations[Math.max(0, Math.min(conversations.length - 1, index))];
    if (target) openConversation(target.lastMessage.traceId);
  };

  useHotkeys({
    j: () => openAt(selectedIndex + 1),
    k: () => openAt(selectedIndex < 0 ? 0 : selectedIndex - 1),
    enter: () => {
      if (!traceId && conversations[0]) openConversation(conversations[0].lastMessage.traceId);
    },
    e: () => {
      if (selected && !selected.done) void store.markDone(selected.traceId);
    },
    r: () => focusReplyComposer(),
    Escape: () => {
      if (traceId) navigate('/inbox');
    },
  });

  const isEmptyInbox = isEmptyFirstRun({
    demoMode: state.demoMode,
    messageCount: state.messages.length,
    received: state.health?.received ?? 0,
  });
  // 首启 3 步引导是否正在展示（决定空态是否再叠加注入入口，避免三重引导）
  const firstRunVisible = shouldShowFirstRun({
    demoMode: state.demoMode,
    messageCount: state.messages.length,
    received: state.health?.received ?? 0,
    dismissed: firstRunDismissed,
  });

  const renderConversations = (list: Conversation[]) => (
    <div className="conv-list">
      {list.map((conv) => (
        <ConversationRow
          key={conv.key}
          conversation={conv}
          active={conv.key === selectedConv?.key}
          onSelect={openConversation}
        />
      ))}
    </div>
  );

  const listBody = state.loading ? (
    <div className="list-loading">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="list-loading__card">
          <Skeleton avatar active paragraph={{ rows: 2 }} />
        </div>
      ))}
    </div>
  ) : conversations.length === 0 ? (
    state.error ? (
      <EmptyState
        title="消息加载失败"
        description="按上方错误提示排查后端（是否启动、端口与 token 是否一致）后刷新页面重试。"
      />
    ) : isEmptyInbox ? (
      firstRunVisible ? (
        <EmptyState
          title="还没有收到消息"
          description="从上方「连接账号」开始连接，或点「先体验演示」注入一条示例消息。"
        />
      ) : (
        <QuickStart demoMode={state.demoMode} onInject={handleInject} />
      )
    ) : (
      <EmptyState
        title="没有匹配的会话"
        description="换一个渠道或状态，或者清空搜索条件。"
        action={
          <Button
            size="small"
            onClick={() => {
              store.resetFilters();
              navigate('/inbox');
            }}
          >
            清空筛选
          </Button>
        }
      />
    )
  ) : (
    <>
      {imConversations.length > 0 && (
        <section className="conv-group" aria-label="消息会话">
          <header className="conv-group__head">
            <span className="conv-group__title">消息</span>
            <span className="conv-group__count">{imConversations.length}</span>
            <span className="conv-group__spacer" />
            <button
              type="button"
              className="conv-group__action"
              disabled={visible.every((m) => m.direction === 'out' || m.readAt)}
              onClick={() => void handleMarkAllRead()}
            >
              全部标为已读
            </button>
          </header>
          {renderConversations(imConversations)}
        </section>
      )}

      {mailConversations.length > 0 && (
        <section className="conv-group" aria-label="邮件会话">
          <header className="conv-group__head">
            <span className="conv-group__title">邮件</span>
            <span className="conv-group__count">{mailConversations.length}</span>
          </header>
          {renderConversations(mailConversations)}
        </section>
      )}

      <div className="list-summary">
        <span>
          共 {conversations.length} 个会话 · {visible.length} 条消息
        </span>
        {hasFilter && (
          <button type="button" className="link-btn" onClick={() => store.resetFilters()}>
            清空筛选
          </button>
        )}
      </div>
    </>
  );

  return (
    <div className="inbox-page">
      {/* 个人版首启：先去「连接账号」把邮箱/钉钉/飞书/企微连上（点过即不再打扰） */}
      {showOnboarding && (
        <OnboardingBanner
          onOpen={openConnect}
          onDemo={demoFromOnboarding}
          onDismiss={dismissOnboarding}
          adminCount={needsAdminCount}
          selfServiceCount={needsAuthCount}
        />
      )}
      {/* 首启 3 步引导：真实后端 + 无消息时显示（组件内部含「知道了」记忆与严格显示条件） */}
      <FirstRunGuide
        demoMode={state.demoMode}
        messageCount={state.messages.length}
        received={state.health?.received ?? 0}
        accounts={state.accounts}
        connection={state.connection}
        apiBase={import.meta.env.VITE_API_BASE}
        loading={state.loading}
        error={state.error}
        needsAdminCount={needsAdminCount}
        needsAuthCount={needsAuthCount}
        onOpenConnect={() => navigate('/connect')}
        onDemo={() => void handleInject()}
        onDismiss={() => setFirstRunDismissed(true)}
      />
      <div
        className={`inbox${selectedConv ? ' inbox--detail' : ' inbox--list'}${
          selectedConv && listCollapsed ? ' is-collapsed' : ''
        }`}
      >
        <section className="list-pane" aria-label="会话列表">
          <div className="list-header">
            <div className="list-header__title-row">
              <h2 className="list-header__title">会话</h2>
              <span className="list-header__count">
                共 {conversations.length} 个会话 · {visible.length} 条消息
              </span>
            </div>

            {/* 关键词搜索：直接走既有 filters.keyword（与 ⌘K 命令面板同一套筛选） */}
            <Input
              className="list-search"
              size="middle"
              allowClear={{ clearIcon: <CloseOutlined /> }}
              prefix={<SearchOutlined className="list-search__icon" />}
              placeholder="搜索联系人、消息内容…"
              value={state.filters.keyword}
              onChange={(e) => store.setFilters({ keyword: e.target.value })}
              aria-label="搜索消息"
            />

            <ChannelTabs
              options={channelOptions}
              value={state.filters.platform}
              onChange={(platform) => store.setFilters({ platform })}
            />

            <div className="list-filters">
              <div className="list-quick" role="group" aria-label="阅读状态筛选">
                <button
                  type="button"
                  className={`quick-pill${!state.filters.onlyUnread && !state.filters.onlyReview ? ' is-active' : ''}`}
                  aria-pressed={!state.filters.onlyUnread && !state.filters.onlyReview}
                  onClick={() => store.setFilters({ onlyUnread: false, onlyReview: false })}
                >
                  全部
                </button>
                <button
                  type="button"
                  className={`quick-pill${state.filters.onlyUnread ? ' is-active' : ''}`}
                  aria-pressed={Boolean(state.filters.onlyUnread)}
                  onClick={() => store.setFilters({ onlyUnread: !state.filters.onlyUnread })}
                >
                  未读
                </button>
                <button
                  type="button"
                  className={`quick-pill${state.filters.onlyReview ? ' is-active' : ''}`}
                  aria-pressed={Boolean(state.filters.onlyReview)}
                  onClick={() => store.setFilters({ onlyReview: !state.filters.onlyReview })}
                >
                  待处理
                </button>
              </div>

              {/* 状态 / 类型筛选收进一个弹层：默认只占一个按钮的宽度，把垂直空间留给列表 */}
              <Popover
                trigger="click"
                placement="bottomRight"
                arrow={false}
                title="筛选条件"
                content={
                  <div className="list-filter-pop">
                    <label className="list-filter-pop__row">
                      <span>闭环状态</span>
                      <Select
                        size="small"
                        allowClear
                        placeholder="全部"
                        value={state.filters.status}
                        options={STATUS_OPTIONS}
                        onChange={(value) => store.setFilters({ status: value })}
                        style={{ width: 132 }}
                      />
                    </label>
                    <label className="list-filter-pop__row">
                      <span>消息类型</span>
                      <Select
                        size="small"
                        allowClear
                        placeholder="全部"
                        value={state.filters.type}
                        options={TYPE_OPTIONS}
                        onChange={(value) => store.setFilters({ type: value })}
                        style={{ width: 132 }}
                      />
                    </label>
                    <label className="list-filter-pop__row">
                      <span>只看待确认</span>
                      <Button
                        size="small"
                        type={state.filters.onlyReview ? 'primary' : 'default'}
                        onClick={() => store.setFilters({ onlyReview: !state.filters.onlyReview })}
                      >
                        {state.filters.onlyReview ? '已开启' : '未开启'}
                      </Button>
                    </label>
                    <div className="list-filter-pop__foot">
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => store.resetFilters()}
                      >
                        清空全部筛选
                      </button>
                    </div>
                  </div>
                }
              >
                <Button
                  size="small"
                  className={`list-filter-btn${hasFilter ? ' is-on' : ''}`}
                  icon={<FilterOutlined />}
                  aria-label="筛选条件"
                />
              </Popover>
            </div>
          </div>

          <div className={`list-scroll${selectedConv ? '' : ' list-scroll--grouped'}`}>{listBody}</div>
        </section>

        <section className="detail-pane" aria-label="会话详情">
          {state.loading ? (
            <div className="detail-loading">
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          ) : selectedConv ? (
            <DetailPanel
              key={selectedConv.key}
              message={selected ?? selectedConv.lastMessage}
              thread={selectedConv.messages}
              conversationTitle={selectedConv.title}
              listCollapsed={listCollapsed}
              onToggleList={() => setListCollapsed((v) => !v)}
            />
          ) : (
            <EmptyState title="选择一个会话" description="从左侧列表中点击任意会话，查看完整对话并直接回复。" />
          )}
        </section>
      </div>
    </div>
  );
}