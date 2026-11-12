/**
 * 飞书「本人身份」接收轮询器。
 *
 * 官方没有个人消息推送事件，只能定时拉：`im/v1/chats` 列会话 → 对每个会话按
 * `start_time`（秒）+ 升序拉增量 → 映射为 UnifiedMessage 交给消息中枢入库。
 *
 * 水位与首轮策略（对齐 stream/mailPoller.ts 的成熟做法）：
 *  - 水位文件默认 `unimsg-connector/.feishu-user-receive.json`（已 gitignore），
 *    结构 `{version:1, selfOpenId, chats:{<chatId>: <最后消息 create_time 毫秒>}}`，原子写；
 *  - 首轮 `FEISHU_USER_BACKFILL_HOURS=0`：只把每个会话水位设为「当前时间」，**不灌历史**；
 *    >0：从 N 小时前开始拉（演示回溯用）；
 *  - 水位只按「实际处理到的最后一条消息」推进（毫秒），拉取时下取整到秒并允许边界重复
 *    （同一条消息由 externalId 幂等去重），绝不因为秒级取整漏消息；
 *  - 每轮最多检查 FEISHU_USER_CHAT_LIMIT 个会话，按「最久没检查」排序轮转；
 *  - 单会话失败只 warn（同类错误只报一次），不中断其他会话；权限/授权错误把中文修复提示
 *    写进身份视图 hint（契约 §3.2）。
 *
 * 注意：轮询天然有 5–30s 延迟，且只能读到「用户本人可见」的会话，这两点在文档与 UI 如实标注。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Platform, type UnifiedMessage } from '@unimsg/shared';
import { config } from '../config';
import { MessageService } from '../services/message';
import { feishuUserAuth } from '../connectors/feishuUserAuth';
import {
  FeishuUserReceiveError,
  fetchChatMessages,
  fetchUserChats,
  mapFeishuUserMessage,
  refreshSelfUserInfo,
  type FeishuChat,
  type FeishuSelfUserInfo,
  type FeishuUserReceiveOptions,
} from '../connectors/feishuUserReceive';
import { setFeishuReceiveError } from '../services/identity';

export const FEISHU_USER_STATE_VERSION = 1;
/** 请求间最小间隔：飞书按接口 QPS 限流，串行 + 100ms 足够温和 */
export const REQUEST_GAP_MS = 100;

export interface FeishuUserReceiveState {
  version: typeof FEISHU_USER_STATE_VERSION;
  /** 授权用户 open_id：用于过滤自己发的消息（拿不到时跳过过滤并告警） */
  selfOpenId?: string;
  /** `<chatId>` → 最后处理的 create_time（毫秒） */
  chats: Record<string, number>;
}

export interface LoadStateResult {
  state: FeishuUserReceiveState;
  exists: boolean;
  restored: number;
  error?: string;
}

function emptyState(): FeishuUserReceiveState {
  return { version: FEISHU_USER_STATE_VERSION, chats: {} };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 读取水位文件：缺失 → 空状态（首轮立基线）；
 * JSON 损坏/结构不对 → 返回空状态 + error（调用方 warn 后重建，绝不崩溃）；
 * 个别条目非法 → 忽略该条 + error，其余照常恢复。
 */
export function loadUserReceiveState(file: string): LoadStateResult {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: emptyState(), exists: false, restored: 0 };
    }
    return { state: emptyState(), exists: true, restored: 0, error: `读取失败：${errMessage(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { state: emptyState(), exists: true, restored: 0, error: `JSON 解析失败：${errMessage(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: emptyState(), exists: true, restored: 0, error: '内容不是 JSON 对象' };
  }
  const obj = parsed as Record<string, unknown>;
  const chats: Record<string, number> = {};
  let invalid = 0;
  const rawChats = obj.chats;
  if (rawChats && typeof rawChats === 'object' && !Array.isArray(rawChats)) {
    for (const [chatId, value] of Object.entries(rawChats as Record<string, unknown>)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (typeof chatId === 'string' && chatId.trim() && Number.isFinite(n) && n > 0) {
        chats[chatId] = Math.floor(n);
      } else {
        invalid += 1;
      }
    }
  }
  const state: FeishuUserReceiveState = {
    version: FEISHU_USER_STATE_VERSION,
    ...(typeof obj.selfOpenId === 'string' && obj.selfOpenId.trim() ? { selfOpenId: obj.selfOpenId.trim() } : {}),
    chats,
  };
  return invalid > 0
    ? { state, exists: true, restored: Object.keys(chats).length, error: `${invalid} 条水位非法，已忽略` }
    : { state, exists: true, restored: Object.keys(chats).length };
}

/** 原子写水位文件：先写同目录 tmp 再 rename，进程中途退出不会留下半截 JSON */
export function saveUserReceiveState(file: string, state: FeishuUserReceiveState): void {
  const payload = {
    version: FEISHU_USER_STATE_VERSION,
    ...(state.selfOpenId ? { selfOpenId: state.selfOpenId } : {}),
    chats: Object.fromEntries(
      Object.entries(state.chats).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 单轮调度（纯逻辑，可单测）
// ---------------------------------------------------------------------------

export interface ChatPollPlan {
  /** 首轮需要「立基线」的会话：只记当前时间为水位，不拉历史 */
  baseline: FeishuChat[];
  /** 需要拉增量的会话（按最久未检查优先，数量受 chatLimit 限制） */
  fetch: { chat: FeishuChat; sinceMs: number }[];
}

/**
 * 决定本轮对哪些会话做什么：
 *  - 从未见过的会话 → 首轮基线（backfillHours=0）或回溯拉取（>0）；
 *  - 见过的会话 → 从水位拉增量；
 *  - 总数超过 chatLimit 时按水位升序（最久没检查的优先）轮转，保证公平。
 */
export function planChatPolling(
  chats: FeishuChat[],
  state: FeishuUserReceiveState,
  opts: { now: number; chatLimit: number; backfillHours: number },
): ChatPollPlan {
  const now = opts.now;
  const baseline: FeishuChat[] = [];
  const candidates: { chat: FeishuChat; sinceMs: number; known: boolean }[] = [];
  for (const chat of chats) {
    const mark = state.chats[chat.chatId];
    if (typeof mark === 'number' && mark > 0) {
      candidates.push({ chat, sinceMs: mark, known: true });
    } else if (opts.backfillHours > 0) {
      candidates.push({ chat, sinceMs: now - opts.backfillHours * 3600_000, known: true });
    } else {
      baseline.push(chat);
    }
  }
  // 基线也要受 chatLimit 限制（会话特别多时分多轮立基线），按 chatId 稳定排序
  baseline.sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0));
  const baselinePicked = baseline.slice(0, Math.max(0, opts.chatLimit));

  // 增量会话按水位升序轮转（最久没检查的优先）
  candidates.sort((a, b) => a.sinceMs - b.sinceMs || (a.chat.chatId < b.chat.chatId ? -1 : 1));
  const remaining = Math.max(0, opts.chatLimit - baselinePicked.length);
  const fetch = candidates.slice(0, remaining).map((c) => ({ chat: c.chat, sinceMs: c.sinceMs }));
  return { baseline: baselinePicked, fetch };
}

export interface PollUserOnceResult {
  /** 本轮立基线的会话数 */
  baselined: number;
  /** 本轮实际拉取增量的会话数 */
  fetchedChats: number;
  /** 拉回的消息条数（含重复） */
  fetchedMessages: number;
  /** 新入库条数（去重后） */
  added: number;
  /** 幂等查重命中条数 */
  duplicates: number;
  /** 跳过（自己发的/撤回/系统/未知类型）条数 */
  skipped: number;
  /** 发生错误的会话数 */
  failedChats: number;
}

export interface PollUserOnceDeps {
  state: FeishuUserReceiveState;
  /** 取 user_access_token（会自动续期；失败抛中文错误） */
  getToken: () => Promise<string>;
  ingest: (msg: UnifiedMessage) => Promise<{ duplicate: boolean }>;
  /** 单测注入 */
  fetchChats?: typeof fetchUserChats;
  fetchMessages?: typeof fetchChatMessages;
  getSelfInfo?: (token: string) => Promise<FeishuSelfUserInfo | undefined>;
  fetchOptions?: FeishuUserReceiveOptions;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  chatLimit: number;
  backfillHours: number;
  /** 每入库一条回调（日志用） */
  onMessage?: (msg: UnifiedMessage) => void;
  /** 单会话/单请求错误回调（默认 console.warn） */
  onError?: (scope: string, e: unknown) => void;
}

/**
 * 跑一轮：列会话 → 立基线/拉增量 → 映射 → 入库。
 * 全部 I/O 走注入函数，单测可离线覆盖分页、基线、回溯、过滤、权限错误、水位推进。
 */
export async function pollFeishuUserOnce(deps: PollUserOnceDeps): Promise<PollUserOnceResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const fetchChats = deps.fetchChats ?? fetchUserChats;
  const fetchMessages = deps.fetchMessages ?? fetchChatMessages;
  const onError = deps.onError ?? ((scope, e) => console.warn(`[feishu-user] ${scope}：${errMessage(e)}`));
  const result: PollUserOnceResult = {
    baselined: 0, fetchedChats: 0, fetchedMessages: 0, added: 0, duplicates: 0, skipped: 0, failedChats: 0,
  };

  const token = await deps.getToken();
  const fetchOpts: FeishuUserReceiveOptions = { ...deps.fetchOptions, baseUrl: config.platforms.feishu.baseUrl };

  // 本人 open_id：用于过滤自己发的消息。拿不到时降级为「不过滤 + 告警」（宁可噪音也不误丢）
  const selfInfo = deps.getSelfInfo
    ? await deps.getSelfInfo(token).catch(() => undefined)
    : await refreshSelfUserInfo(token, fetchOpts).catch(() => undefined);
  if (selfInfo?.openId) deps.state.selfOpenId = selfInfo.openId;

  const list = await fetchChats(token, { ...fetchOpts, maxChats: Math.max(200, deps.chatLimit * 10) });
  const plan = planChatPolling(list.chats, deps.state, {
    now: now(),
    chatLimit: deps.chatLimit,
    backfillHours: deps.backfillHours,
  });

  // 1) 立基线：只记水位，不拉历史
  for (const chat of plan.baseline) {
    deps.state.chats[chat.chatId] = now();
    result.baselined += 1;
  }

  // 2) 增量拉取
  for (const item of plan.fetch) {
    if (result.fetchedChats > 0) await sleep(REQUEST_GAP_MS);
    try {
      const startTimeSec = Math.floor(item.sinceMs / 1000);
      const batch = await fetchMessages(token, item.chat.chatId, { ...fetchOpts, startTimeSec });
      result.fetchedChats += 1;
      result.fetchedMessages += batch.messages.length;
      let maxMark = item.sinceMs;
      for (const raw of batch.messages) {
        const msg = mapFeishuUserMessage(raw, item.chat, deps.state.selfOpenId, { now });
        if (!msg) {
          result.skipped += 1;
          continue;
        }
        const r = await deps.ingest(msg);
        if (r.duplicate) result.duplicates += 1;
        else {
          result.added += 1;
          deps.onMessage?.(msg);
        }
        const t = Number(raw.create_time);
        if (Number.isFinite(t) && t > maxMark) maxMark = t;
      }
      // 水位只推进到「实际处理到的最后一条」；空批次不动水位
      if (maxMark > item.sinceMs) deps.state.chats[item.chat.chatId] = maxMark;
    } catch (e) {
      result.failedChats += 1;
      onError(`会话 ${item.chat.chatId}（${item.chat.name ?? '未命名'}）`, e);
      if (e instanceof FeishuUserReceiveError && (e.kind === 'permission' || e.kind === 'auth')) {
        // 权限/授权问题：直接写进身份视图 hint，用户点开账号页就能看到修复方式
        setFeishuReceiveError(e.message);
        throw e; // 同类错误已无法自愈，本轮直接结束（下一轮会重试）
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 生产轮询循环
// ---------------------------------------------------------------------------

export interface FeishuUserPollerHandle {
  stop(): void;
}

/**
 * 启动飞书本人身份轮询（由 index.ts 在启动时调用）。
 * 不满足条件时打印一行中文原因并返回 null（绝不静默）。
 */
export function startFeishuUserPoller(svc: MessageService): FeishuUserPollerHandle | null {
  const conf = config.identity.feishu;
  const stateFile = conf.stateFile;

  // 延迟 import 会形成环，这里直接依赖 config.runtime（identity 服务在调用时才计算视图）
  // 为了避免循环依赖，identity 的判断通过动态导入在首次轮询前完成
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const reportedErrors = new Set<string>();

  const loaded = loadUserReceiveState(stateFile);
  const state = loaded.state;
  if (loaded.error) {
    console.warn(`[feishu-user] 水位文件异常，已忽略损坏部分（${stateFile}）：${loaded.error}`);
  }
  if (loaded.restored > 0) {
    console.log(`[feishu-user] 已从水位文件恢复 ${loaded.restored} 个会话水位（${stateFile}）`);
  } else if (!loaded.exists && !loaded.error) {
    console.log(`[feishu-user] 未找到水位文件（${stateFile}），首轮只建立会话基线${conf.backfillHours > 0 ? `，并回溯最近 ${conf.backfillHours} 小时` : '，不导入历史消息'}`);
  }

  const persist = (): void => {
    try {
      saveUserReceiveState(stateFile, state);
    } catch (e) {
      console.warn(`[feishu-user] 水位文件写入失败（轮询继续，仅影响重启续传）：${errMessage(e)}`);
    }
  };

  const pollOnce = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await pollFeishuUserOnce({
        state,
        getToken: () => feishuUserAuth().accessToken(),
        ingest: (msg) => svc.ingestUnified(Platform.FEISHU, msg),
        now: Date.now,
        chatLimit: conf.chatLimit,
        backfillHours: conf.backfillHours,
        onMessage: (msg) => {
          console.log(
            `[feishu-user] 本人账号收到消息：${msg.conversation?.type === 'p2p' ? '单聊' : '群聊'}`
            + `${msg.conversation?.title ? `「${msg.conversation.title}」` : ''} · 发送者=${msg.sender.name} · 类型=${msg.type}`,
          );
        },
        onError: (scope, e) => {
          const message = errMessage(e);
          // 同类错误只报一次，避免每 20s 刷屏
          const key = `${scope}#${message}`;
          if (reportedErrors.has(key)) return;
          reportedErrors.add(key);
          console.warn(`[feishu-user] ${scope} 拉取失败：${message}`);
        },
      });
      if (result.baselined > 0) {
        console.log(`[feishu-user] 已建立 ${result.baselined} 个会话基线（${stateFile}），历史消息不入库`);
        persist();
      }
      if (result.fetchedChats > 0 || result.added > 0) persist();
      if (result.added > 0 || result.duplicates > 0 || result.skipped > 0) {
        console.log(
          `[feishu-user] 本轮：检查 ${result.fetchedChats} 个会话，拉取 ${result.fetchedMessages} 条，`
          + `新入库 ${result.added} 条，重复 ${result.duplicates} 条，跳过 ${result.skipped} 条`,
        );
      }
      if (result.failedChats === 0) setFeishuReceiveError(undefined);
    } catch (e) {
      const message = errMessage(e);
      const key = `round#${message}`;
      if (!reportedErrors.has(key)) {
        reportedErrors.add(key);
        console.warn(`[feishu-user] 本轮轮询终止：${message}`);
      }
      if (e instanceof FeishuUserReceiveError && (e.kind === 'permission' || e.kind === 'auth')) {
        setFeishuReceiveError(e.message);
      }
    } finally {
      running = false;
    }
  };

  // 身份条件检查（延迟到调用期，避免模块加载顺序问题）
  void (async () => {
    const { resolveIdentity, identityChannelsReal } = await import('../services/identity');
    if (stopped) return;
    if (!identityChannelsReal(Platform.FEISHU)) {
      console.log('[feishu-user] 飞书当前为模拟模式或凭据不足，跳过本人身份轮询（FEISHU_MODE=real 或识别到本人身份后才启动）');
      return;
    }
    const view = resolveIdentity(Platform.FEISHU);
    if (view.effectiveReceive !== 'user') {
      console.log(`[feishu-user] 本次接收身份为「${view.effectiveReceive === 'bot' ? '机器人' : '模拟'}」，跳过本人身份轮询；${view.user.hint}`);
      return;
    }
    if (feishuUserAuth().status().state === 'none') {
      console.warn('[feishu-user] 本人身份接收已启用但尚未授权：请到「平台账号」页点「连接本人账号」完成授权（授权后无需重启，下一轮自动开始）');
    }
    console.log(
      `[feishu-user] 本人身份轮询已启动：每 ${Math.round(conf.pollMs / 1000)}s 检查最多 ${conf.chatLimit} 个会话`
      + `（延迟 5–30s；仅本人可见会话；水位文件 ${stateFile}）`,
    );
    void pollOnce();
    timer = setInterval(() => void pollOnce(), conf.pollMs);
    timer.unref?.();
  })();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      console.log('[feishu-user] 本人身份轮询已停止');
    },
  };
}