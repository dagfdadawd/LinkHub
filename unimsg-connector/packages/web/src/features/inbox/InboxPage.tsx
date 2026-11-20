import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { App as AntApp, Button, Input, Modal, Popover, Select, Skeleton } from 'antd';
import { CloseOutlined, FilterOutlined, SearchOutlined, SyncOutlined } from '@ant-design/icons';
import { useAppState } from '../../hooks/useAppState';
import { useHotkeys } from '../../hooks/useHotkeys';
import { store, services } from '../../store';
import { filterMessages } from '../../store/appStore';
import { useSession } from '../../services/session';
import type { MessageApi } from '../../services/api';
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
import { DEMO_GROUP_MESSAGES, mentionsMe } from '../preview/demoGroupMessages';

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

/**
 * 名录补名：老消息入库时平台没给会话名（飞书单聊常见），
 * 用 /api/contacts 拿到的「会话 ID → 名字」把标题补成人话；拿不到就保持原样。
 */
interface DirectoryInfo {
  name: string;
  type?: 'p2p' | 'group';
}

/**
 * 用品名录修正会话的**名字和类型**。
 *
 * 钉钉个人事件既没有会话名、类型也只能靠 event_type 猜（实测把群判成了单聊），
 * 而 `dws chat +chat-list` 两样都有。这里以名录为准，猜错的地方就地纠正。
 */
function withContactNames(
  list: import('../../utils/conversations').Conversation[],
  directory: Map<string, DirectoryInfo>,
) {
  if (directory.size === 0) return list;
  return list.map((c) => {
    if (!c.conversationId) return c;
    const hit = directory.get(`${c.platform}:${c.conversationId}`);
    if (!hit) return c;
    /**
     * 会话名以**平台会话名录为准**。
     *
     * 之前只替换"空 / 群聊 / 裸 ID"的标题，结果单聊一直是发送者名（例如会话里有几个人
     * 说话时，标题会跟着最后一条消息的发送者变），和手机上的会话名对不上。
     */
    const nextTitle = hit.name || c.title;
    // 类型以名录为准（事件里的推断经常错）
    const nextType = hit.type ?? c.conversationType;
    if (nextTitle === c.title && nextType === c.conversationType) return c;
    return { ...c, title: nextTitle, conversationType: nextType };
  });
}

export function InboxPage() {
  const state = useAppState();
  /** 当前登录账号：空态文案据此区分「没消息」和「消息还没归属给你」 */
  const session = useSession();
  const navigate = useNavigate();
  const { traceId } = useParams();
  /** 群消息视图预览：/inbox?preview=groups 时用假数据展示「频道标签 + @我置顶」 */
  const [searchParams] = useSearchParams();
  const previewMode = searchParams.get('preview') === 'groups';
  /** 频道条的视觉样式：soft(胶囊) / underline(下划线) / quiet(纯文本) */
  const previewTabStyle = (searchParams.get('tabstyle') ?? 'quiet') as 'soft' | 'underline' | 'quiet';
  /** 预览里的频道：全部 / 单聊 / @我 / 群消息 */
  const [previewChannel, setPreviewChannel] = useState<'all' | 'direct' | 'at' | 'group'>('all');
  const [listCollapsed, setListCollapsed] = useState(false);
  const toast = AntApp.useApp().message;
  const injectSeq = useRef(0);
  /** 首启横幅：本地标记 + 后端 firstRun 任一触发；点过「去连接 / 稍后」后不再打扰 */
  const [onboarded, setOnboarded] = useState(() => isOnboarded());
  /** 首启 3 步引导是否已「知道了」（据此决定空态是否显示注入示例，避免双重引导） */
  const [firstRunDismissed, setFirstRunDismissed] = useState(() => readFirstRunDismissed());

  /**
   * 微信「按需拉取」对话框（微信 4.x 没有可访问性控件树，只能拖选复制）。
   * 会话名由人确认：4.x 从外部读不到当前会话标题，猜一个名字会导致消息挂错会话。
   */
  const [pullOpen, setPullOpen] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullConv, setPullConv] = useState(() => localStorage.getItem('linkhub.wechat.pullConv') ?? '');
  const [pullSelf, setPullSelf] = useState(() => localStorage.getItem('linkhub.wechat.selfName') ?? '');
  const [pullType, setPullType] = useState<'p2p' | 'group'>(
    () => (localStorage.getItem('linkhub.wechat.pullType') === 'group' ? 'group' : 'p2p'),
  );

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

  const previewMessages = previewMode ? DEMO_GROUP_MESSAGES : state.messages;
  const visible = useMemo(
    () => (previewMode ? previewMessages : filterMessages(state.messages, state.filters)),
    [previewMode, previewMessages, state.messages, state.filters],
  );
  const selected = traceId ? state.messages.find((m) => m.traceId === traceId) : undefined;

  /**
   * 会话视图：列表按「人 / 群 / 邮件主题」聚合，不再一条消息一行。
   * 选中态用「URL 里的 traceId 属于哪个会话」反查，因此任何一条消息的深链都能定位到会话。
   */
  const conversations = useMemo(() => buildConversations(visible), [visible]);
  const sourceMessages = previewMode ? DEMO_GROUP_MESSAGES : state.messages;
  const allConversations = useMemo(() => buildConversations(sourceMessages), [sourceMessages]);

  /** 会话 ID → 可读名字（飞书本人会话名录）；旧后端没有该接口时为空表，不影响使用 */
  const [contactNames, setContactNames] = useState<Map<string, DirectoryInfo>>(new Map());
  /** 名录读取失败的平台原因：用于提示「为什么会话名是群聊」，而不是静默降级 */
  const [directoryIssues, setDirectoryIssues] = useState<Array<{ platform: string; reason: string }>>([]);
  useEffect(() => {
    // 单测会 mock 掉 store 模块（没有 services/api），这里做能力探测而不是硬依赖
    const api = (services as { api?: MessageApi } | undefined)?.api;
    if (typeof api?.contacts !== 'function') return;
    let alive = true;
    void Promise.all(
      [Platform.FEISHU, Platform.DINGTALK].map((p) => api.contacts(p).catch(() => undefined)),
    ).then((list) => {
      if (!alive) return;
      const map = new Map<string, DirectoryInfo>();
      const issues: Array<{ platform: string; reason: string }> = [];
      for (const dir of list) {
        if (!dir?.available) {
          // 只有飞书「本来就有会话名录能力」，读不到才是真问题（多半是本人账号未授权）。
          // 钉钉 / 微信的「只能发给已有会话」是该平台的常态能力，不是故障，
          // 放进这个横幅会变成每次打开收件箱都弹的假告警，所以这里只收飞书。
          if (dir?.platform === Platform.FEISHU && dir?.reason) {
            issues.push({ platform: String(dir.platform), reason: dir.reason });
          }
          continue;
        }
        for (const item of dir.items) {
          map.set(`${dir.platform}:${item.id}`, { name: item.name, type: item.type });
        }
      }
      if (map.size > 0) setContactNames(map);
      setDirectoryIssues(issues);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 预览模式：把会话按频道分组，并算出 @我 的数量。
   * 只在 /inbox?preview=groups 生效，正常使用完全不走这段逻辑。
   */
  const previewBuckets = useMemo(() => {
    if (!previewMode) return { all: [], direct: [], group: [], at: [] as typeof conversations };
    const isGroup = (c: typeof conversations[number]) => c.conversationType === 'group';
    const hasAt = (c: typeof conversations[number]) =>
      c.messages.some((m) => mentionsMe(String(m.body ?? '')));
    const direct = conversations.filter((c) => c.kind === 'im' && !isGroup(c));
    const group = conversations.filter((c) => isGroup(c));
    const at = conversations.filter((c) => hasAt(c));
    return { all: conversations, direct, group, at };
  }, [previewMode, conversations]);

  const previewList = useMemo(() => {
    if (!previewMode) return conversations;
    if (previewChannel === 'direct') return previewBuckets.direct;
    if (previewChannel === 'group') return previewBuckets.group;
    if (previewChannel === 'at') return previewBuckets.at;
    // 「全部」：@我 的会话排最前，其次单聊，最后群
    const atKeys = new Set(previewBuckets.at.map((c) => c.key));
    return [
      ...previewBuckets.at,
      ...conversations.filter((c) => !atKeys.has(c.key) && previewBuckets.direct.some((d) => d.key === c.key)),
      ...conversations.filter((c) => !atKeys.has(c.key) && previewBuckets.group.some((g) => g.key === c.key)),
      ...conversations.filter(
        (c) => !atKeys.has(c.key)
          && !previewBuckets.direct.some((d) => d.key === c.key)
          && !previewBuckets.group.some((g) => g.key === c.key),
      ),
    ];
  }, [previewMode, previewChannel, conversations, previewBuckets]);

  const namedConversations = useMemo(
    () => withContactNames(conversations, contactNames),
    [conversations, contactNames],
  );
  const namedAllConversations = useMemo(
    () => withContactNames(allConversations, contactNames),
    [allConversations, contactNames],
  );
  const selectedConv = useMemo(
    () => findConversation(namedAllConversations, traceId),
    [namedAllConversations, traceId],
  );
  const imConversations = useMemo(
    () => (previewMode ? previewList.filter((c) => c.kind === 'im') : namedConversations.filter((c) => c.kind === 'im')),
    [previewMode, previewList, namedConversations],
  );
  const mailConversations = useMemo(
    () => namedConversations.filter((c) => c.kind === 'mail'),
    [namedConversations],
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

  /** 微信 4.x 按需拉取：把当前会话可视区的消息拉进来（拖选复制，拿原文，零 OCR 误差） */
  const handleWechatPull = async () => {
    const conversation = pullConv.trim();
    if (!conversation) {
      toast.error('请先填会话名：要和微信里显示的完全一致（4.x 从外部读不到当前会话标题）');
      return;
    }
    const selfName = pullSelf.trim();
    setPulling(true);
    try {
      const r = await services.api.wechatPull({
        conversation,
        conversationType: pullType,
        ...(selfName ? { selfName } : {}),
      });
      localStorage.setItem('linkhub.wechat.pullConv', conversation);
      localStorage.setItem('linkhub.wechat.pullType', pullType);
      if (selfName) localStorage.setItem('linkhub.wechat.selfName', selfName);
      await store.refresh();
      const parts = [`解析 ${r.parsed} 条`, `新增 ${r.forwarded} 条`];
      if (r.duplicates) parts.push(`已存在 ${r.duplicates} 条`);
      if (r.failed?.length) parts.push(`失败 ${r.failed.length} 条`);
      toast.success(`已从「${conversation}」拉取：${parts.join(' · ')}`);
      if (r.conversationVerified === false) {
        toast.warning('4.x 读不到当前会话标题，请确认微信里打开的就是目标会话；挂错会话请删除后重拉');
      }
      if (r.warning) toast.warning(r.warning);
      if (r.failed?.length) toast.error(`有 ${r.failed.length} 条未入库：${r.failed[0]?.error ?? ''}`);
      setPullOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '拉取失败');
    } finally {
      setPulling(false);
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

  /**
   * 名录不可用提示：钉钉/飞书的名字来自平台接口，登录态过期时只能显示「群聊」。
   * 静默降级会让用户以为程序坏了，所以直接把原因和该做什么摆出来。
   */
  // 飞书只有在真实模式下才有「本人会话名录」这回事；mock 模式根本不读平台，
  // 此时提示「未授权」只会变成每次进收件箱都弹的假告警，所以按模式收口。
  const directoryBanner = directoryIssues.length > 0 && state.health?.modes?.feishu === 'real' ? (
    <div className="list-notice" role="status">
      <div className="list-notice__title">飞书会话名暂时读不到</div>
      <div className="list-notice__body">
        {directoryIssues.map((it) => (
          <div key={it.platform}>{it.reason}</div>
        ))}
      </div>
    </div>
  ) : null;

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
      session ? (
        <EmptyState
          title="这个账号下还没有消息"
          description="历史消息如果还没归属到你，请到「设置 → 账号 → 数据归属」点「认领无主的历史消息」。"
        />
      ) : firstRunVisible ? (
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
      {/* 个人版首启：先去「连接账号」把邮箱/钉钉/飞书/微信连上（点过即不再打扰） */}
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

            {/* 预览模式用假数据，平台渠道计数会失真 → 直接隐藏，避免误导 */}
            {!previewMode && (
              <ChannelTabs
                options={channelOptions}
                value={state.filters.platform}
                onChange={(platform) => store.setFilters({ platform })}
              />
            )}

            {previewMode && (
              <div className="pv-tabs pv-tabs--inline" data-style={previewTabStyle} data-testid="preview-channels">
                {([
                  ['all', '全部', previewBuckets.all.length],
                  ['direct', '单聊', previewBuckets.direct.length],
                  ['at', '@我', previewBuckets.at.length],
                  ['group', '群消息', previewBuckets.group.length],
                ] as const).map(([id, label, count]) => (
                  <button
                    type="button"
                    key={id}
                    className={`pv-tab${previewChannel === id ? ' pv-tab--active' : ''}`}
                    onClick={() => setPreviewChannel(id)}
                  >
                    {label}
                    <span className="pv-tab__count">{count}</span>
                  </button>
                ))}
              </div>
            )}

            {/* 微信 4.x：没有可访问性控件树，只能「按需拉取」（拖选复制）。
                只在选中微信渠道时出现，不打扰其它平台的常规使用。 */}
            {state.filters.platform === Platform.WECHAT && (
              <div className="wechat-pull">
                <Button size="small" icon={<SyncOutlined />} onClick={() => setPullOpen(true)}>
                  从微信拉取当前会话
                </Button>
                <span className="wechat-pull__hint">
                  4.x 无可访问控件树，靠选中复制读原文；只覆盖当前打开的会话
                </span>
              </div>
            )}

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
                  onClick={() =>
                    store.setFilters({
                      onlyUnread: !state.filters.onlyUnread,
                      // 「未读」与「待处理」是同一组单选：点一个必须清掉另一个，
                      // 否则两个胶囊会同时高亮，筛选条件也会互相叠加成空结果。
                      onlyReview: false,
                    })
                  }
                >
                  未读
                </button>
                <button
                  type="button"
                  className={`quick-pill${state.filters.onlyReview ? ' is-active' : ''}`}
                  aria-pressed={Boolean(state.filters.onlyReview)}
                  onClick={() =>
                    store.setFilters({
                      onlyReview: !state.filters.onlyReview,
                      onlyUnread: false,
                    })
                  }
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

          {directoryBanner}

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

      <Modal
        open={pullOpen}
        title="从微信拉取当前会话"
        okText="开始拉取"
        cancelText="取消"
        confirmLoading={pulling}
        onOk={() => void handleWechatPull()}
        onCancel={() => setPullOpen(false)}
        destroyOnHidden
      >
        <div className="wechat-pull-modal">
          <p className="wechat-pull-modal__lead">
            微信 4.x 不暴露控件树，读不到消息列表。桥会：把微信窗口置前 → 在消息区拖选 →
            Ctrl+C → 解析原文。拉取期间会短暂抢焦点，结束后自动还原剪贴板与焦点。
          </p>
          <label className="wechat-pull-modal__label" htmlFor="wechat-pull-conv">
            会话名（必填，要和微信里显示的一致）
          </label>
          <Input
            id="wechat-pull-conv"
            value={pullConv}
            onChange={(e) => setPullConv(e.target.value)}
            placeholder="例如：项目群 / 张三"
            maxLength={60}
          />
          <label className="wechat-pull-modal__label" htmlFor="wechat-pull-type">
            会话类型（群聊不选会被存成单聊）
          </label>
          <Select
            id="wechat-pull-type"
            value={pullType}
            onChange={(v) => setPullType(v)}
            style={{ width: '100%' }}
            options={[
              { value: 'p2p', label: '单聊（联系人）' },
              { value: 'group', label: '群聊' },
            ]}
          />
          <label className="wechat-pull-modal__label" htmlFor="wechat-pull-self">
            你的微信昵称（可选，用来过滤自己发的消息）
          </label>
          <Input
            id="wechat-pull-self"
            value={pullSelf}
            onChange={(e) => setPullSelf(e.target.value)}
            placeholder="例如：阿彬（不填则自己发的也可能被当成入站）"
            maxLength={60}
          />
          <p className="wechat-pull-modal__note">
            只拉「当前在微信里打开的那个会话」的可视区消息；滚出屏幕的历史拉不到。
          </p>
        </div>
      </Modal>
    </div>
  );
}
