import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as AntApp, Button, Select, Skeleton } from 'antd';
import { FilterOutlined } from '@ant-design/icons';
import { useAppState } from '../../hooks/useAppState';
import { useHotkeys } from '../../hooks/useHotkeys';
import { store } from '../../store';
import { filterMessages } from '../../store/appStore';
import { MsgStatus, Platform } from '../../types';
import type { UnifiedMessage } from '../../types';
import { PLATFORM_META, STATUS_META, TYPE_LABEL } from '../../utils/format';
import { navigateWithMorph } from '../../utils/morph';
import { injectSample, type InjectPlatform } from '../../services/demoSamples';
import { EmptyState } from '../../components/EmptyState';
import { FirstRunGuide, isEmptyFirstRun } from '../../components/FirstRunGuide';
import { QuickStart } from '../../components/QuickStart';
import { MessageCard } from './MessageCard';
import { DetailPanel } from './DetailPanel';
import { ChannelTabs, CHANNEL_DEFS, type ChannelOption } from './ChannelTabs';
import { MessageGroup, MarkAllReadAction } from './MessageGroup';

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

  const visible = useMemo(() => filterMessages(state.messages, state.filters), [state.messages, state.filters]);
  const selected = traceId ? state.messages.find((m) => m.traceId === traceId) : undefined;

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

  // 分组按当前筛选结果切分：渠道、搜索、分页改动后计数自然对齐
  const unreadList = useMemo(() => visible.filter((m) => !m.readAt), [visible]);
  const readList = useMemo(() => visible.filter((m) => m.readAt), [visible]);

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

  /** 打开详情：走共享元素转场（卡片长大成详情）；不支持的环境自动退化为普通跳转 */
  const openMessage = (id: string) => navigateWithMorph(navigate, `/inbox/${id}`);

  /** 空态一键注入：真实后端走 webhook（真实入站链路），Mock 模式走本地模拟 */
  const handleInject = async (platform?: InjectPlatform) => {
    try {
      if (state.demoMode || !platform) {
        await store.simulateIncoming();
        return;
      }
      const base = import.meta.env.VITE_API_BASE ?? '';
      await injectSample(platform, injectSeq.current++, base);
      await store.refresh();
      toast.success(`已注入一条${PLATFORM_META[platform].name}消息`);
    } catch (e) {
      toast.error(`注入失败：${e instanceof Error ? e.message : '未知错误'}`);
    }
  };

  /** 全部标为已读：只标记「当前筛选结果里的未读」，不动其他渠道 */
  const handleMarkAllRead = async () => {
    const ids = unreadList.map((m) => m.traceId);
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
    Boolean(state.filters.keyword);

  /**
   * 已读规则：打开详情后停留 ≥800ms 才标已读。
   * 键盘 j/k 上下浏览会把整列表刷成已读，800ms 既过滤误触又不会「看完了还是未读」。
   */
  useEffect(() => {
    if (!selected || selected.readAt) return;
    const id = selected.traceId;
    const timer = window.setTimeout(() => {
      void store.markRead(id, true);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [selected?.traceId, selected?.readAt]);

  // 键盘流：j/k 上下、Enter 打开、r 回复、e 完成、Esc 收起详情
  const selectedIndex = traceId ? visible.findIndex((m) => m.traceId === traceId) : -1;
  const openAt = (index: number) => {
    const target = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (target) openMessage(target.traceId);
  };

  useHotkeys({
    j: () => openAt(selectedIndex + 1),
    k: () => openAt(selectedIndex < 0 ? 0 : selectedIndex - 1),
    enter: () => {
      if (!traceId && visible[0]) openMessage(visible[0].traceId);
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

  const renderCard = (message: UnifiedMessage, variant: 'row' | 'compact') => (
    <MessageCard
      key={message.traceId}
      message={message}
      active={message.traceId === traceId}
      variant={variant}
      onSelect={openMessage}
      onReply={(id) => {
        openMessage(id);
        focusReplyComposer();
      }}
      onDone={(id) => void store.markDone(id)}
      onTrace={(id) => navigate(`/trace/${id}`)}
    />
  );

  const listBody = state.loading ? (
    <div className="list-loading">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="list-loading__card">
          <Skeleton avatar active paragraph={{ rows: 2 }} />
        </div>
      ))}
    </div>
  ) : visible.length === 0 ? (
    state.error ? (
      <EmptyState
        title="消息加载失败"
        description="按上方错误提示排查后端（是否启动、端口与 token 是否一致）后刷新页面重试。"
      />
    ) : isEmptyInbox ? (
      <QuickStart demoMode={state.demoMode} onInject={handleInject} />
    ) : (
      <EmptyState
        title="没有匹配的消息"
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
  ) : traceId ? (
    /* 详情打开后：列表收窄成「时间轴 + 平台色点」的紧凑流 */
    <div className="list-stream">{visible.map((m) => renderCard(m, 'compact'))}</div>
  ) : (
    <>
      <MessageGroup
        title="未读"
        count={unreadList.length}
        tone="unread"
        action={<MarkAllReadAction disabled={unreadList.length === 0} onClick={() => void handleMarkAllRead()} />}
      >
        {unreadList.length === 0 ? (
          <p className="msg-group__empty">没有未读消息</p>
        ) : (
          unreadList.map((m) => renderCard(m, 'row'))
        )}
      </MessageGroup>

      <MessageGroup title="已读" count={readList.length} tone="read" collapsible defaultOpen={false}>
        {readList.length === 0 ? (
          <p className="msg-group__empty">还没有已读消息</p>
        ) : (
          readList.map((m) => renderCard(m, 'row'))
        )}
      </MessageGroup>

      <div className="list-summary">
        <span>
          共 {visible.length} 条消息，已读 {readList.length} 条
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
        onOpenAccounts={() => navigate('/accounts')}
      />
      <div
        className={`inbox${traceId ? ' inbox--detail' : ' inbox--list'}${
          traceId && listCollapsed ? ' is-collapsed' : ''
        }`}
      >
        <section className="list-pane" aria-label="消息列表">
          <div className="list-header">
            <ChannelTabs
              options={channelOptions}
              value={state.filters.platform}
              onChange={(platform) => store.setFilters({ platform })}
            />

            <div className="list-header__tools">
              <Select
                size="small"
                allowClear
                placeholder="状态"
                value={state.filters.status}
                options={STATUS_OPTIONS}
                onChange={(value) => store.setFilters({ status: value })}
                style={{ width: 96 }}
              />
              <Select
                size="small"
                allowClear
                placeholder="类型"
                value={state.filters.type}
                options={TYPE_OPTIONS}
                onChange={(value) => store.setFilters({ type: value })}
                style={{ width: 88 }}
              />
              <Button
                size="small"
                type={state.filters.onlyReview ? 'primary' : 'default'}
                icon={<FilterOutlined />}
                onClick={() => store.setFilters({ onlyReview: !state.filters.onlyReview })}
              >
                需确认
              </Button>
            </div>
          </div>

          <div className={`list-scroll${traceId ? '' : ' list-scroll--grouped'}`}>{listBody}</div>
        </section>

        <section className="detail-pane" aria-label="消息详情">
          {state.loading ? (
            <div className="detail-loading">
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          ) : selected ? (
            <DetailPanel
              key={selected.traceId}
              message={selected}
              listCollapsed={listCollapsed}
              onToggleList={() => setListCollapsed((v) => !v)}
            />
          ) : (
            <EmptyState title="选择一条消息" description="从左侧列表中点击任意消息，查看详情并直接回复。" />
          )}
        </section>
      </div>
    </div>
  );
}