/**
 * 统一身份解析（本人 / 机器人 / 模拟）——单一事实来源。
 *
 * 消费方：`GET /api/accounts`（前端身份块）、启动日志、`/api/health`、doctor、发送路径校验。
 * 所有判断集中在这里，避免各入口各读一套 env 导致「账号页说本人、实际发出去是机器人」。
 *
 * 关键语义（契约 §1/§4/§5）：
 *  - 平台整体 `*_MODE=mock` → effectiveSend / effectiveReceive 一律为 'mock'，绝不冒充本人/机器人；
 *  - policy=auto 且本人身份不可用 → 回退机器人（hint 说明原因与修复命令）；
 *  - policy=user 时**绝不悄悄回退**：effective 仍为 'user'，发送会显式中文报错、接收启动报错；
 *  - 状态查询一律不阻塞请求：钉钉 dws 状态走 30s 缓存；未探测时返回「探测中」并后台预热。
 */
import {
  Platform,
  type IdentityPolicy,
  type IdentityRole,
  type PlatformIdentityView,
  type UserIdentityStatus,
} from '@unimsg/shared';
import { config, MODE_ENV_KEYS, modeOf, runtimeOf } from '../config';
import { feishuUserAuth } from '../connectors/feishuUserAuth';
import { dingtalkPersonalClient } from '../connectors/dingtalkPersonal';
import { peekSelfUserInfo } from '../connectors/feishuUserReceive';

/** 本次实际生效的身份；'mock' = 平台整体本地模拟 */
export type EffectiveRole = IdentityRole | 'mock';

export const IDENTITY_PLATFORMS: Platform[] = [Platform.FEISHU, Platform.DINGTALK];

export function identityPolicyOf(platform: Platform): IdentityPolicy {
  if (platform === Platform.FEISHU) return config.identity.feishu.policy;
  if (platform === Platform.DINGTALK) return config.identity.dingtalk.policy;
  return 'auto';
}

/**
 * 个人身份通道是否应真实工作（决定是否探测 dws、启动轮询/事件子进程、真实发送）。
 *
 * 规则：
 *  1) 平台 effective mode = real → 是；
 *  2) 平台 `*_MODE` 显式 = mock → 否（契约 §1：mock 时本人身份收发都不启动，绝不外呼）；
 *  3) 例外（钉钉常见场景）：`*_MODE=auto` 因**没有机器人凭据**而降级为 mock，但用户显式
 *     `DINGTALK_IDENTITY=user` → 允许本人身份真实工作（dws 自带 OAuth，不依赖机器人应用）。
 *     这样「只用本人账号、不配机器人」的部署也成立；all-Mock 无 .env 时 policy=auto 不触发探测。
 */
export function identityChannelsReal(platform: Platform): boolean {
  const rt = runtimeOf(platform);
  if (rt.mode === 'real') return true;
  if (rt.policy === 'mock') return false;
  return rt.policy === 'auto' && identityPolicyOf(platform) === 'user' && !rt.configured;
}

function formatTime(iso?: string): string {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知';
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 脱敏标识（账号页/日志里不出现完整 corpId/userId） */
export function maskIdentifier(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  if (!v) return undefined;
  if (v.length <= 4) return `${v.slice(0, 1)}***`;
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

/** 接收开关是否打开：true / auto（且 policy 不是固定机器人） */
export function receiveEnabled(policy: IdentityPolicy, toggle: 'auto' | boolean): boolean {
  if (toggle === true) return true;
  if (toggle === false) return false;
  return policy !== 'bot';
}

// ---------------------------------------------------------------------------
// 飞书本人身份
// ---------------------------------------------------------------------------

/**
 * 最近一次飞书本人接收轮询的错误（权限/授权类）。
 * 轮询器把可操作中文提示写进来，账号页 hint 直接展示——用户不用翻日志。
 */
let feishuReceiveError: string | undefined;

export function setFeishuReceiveError(message: string | undefined): void {
  feishuReceiveError = message;
}

export function getFeishuReceiveError(): string | undefined {
  return feishuReceiveError;
}

export function feishuUserIdentity(): UserIdentityStatus {
  const auth = feishuUserAuth();
  const st = auth.status();
  const conf = config.identity.feishu;
  const canLink = auth.canAuthorize();
  const self = peekSelfUserInfo();

  let state: UserIdentityStatus['state'];
  if (st.state === 'active' || st.state === 'refreshable') state = 'linked';
  else if (st.state === 'none') state = canLink ? 'not_linked' : 'unavailable';
  else if (st.state === 'expired') state = 'expired';
  else state = 'error';

  const detailParts: string[] = [];
  if (st.state === 'refreshable') detailParts.push('access_token 已过期，将用 refresh_token 自动续期');
  if (st.accessExpiresAt) detailParts.push(`令牌有效至 ${formatTime(st.accessExpiresAt)}`);
  if (conf.policy === 'bot') detailParts.push('FEISHU_IDENTITY=bot：固定机器人');

  const baseHint = feishuIdentityHint(state, canLink);
  const hint = state === 'linked' && feishuReceiveError
    ? `${baseHint}；本人接收轮询失败：${feishuReceiveError}`
    : baseHint;

  return {
    state,
    linked: state === 'linked',
    ...(self?.name ? { displayName: self.name } : {}),
    ...(detailParts.length > 0 ? { detail: detailParts.join('；') } : {}),
    ...(st.accessExpiresAt ?? st.refreshExpiresAt
      ? { expiresAt: (st.accessExpiresAt ?? st.refreshExpiresAt)! }
      : {}),
    hint,
    canLink,
    linkMethod: 'oauth',
  };
}

function feishuIdentityHint(state: UserIdentityStatus['state'], canLink: boolean): string {
  const policy = config.identity.feishu.policy;
  if (state === 'linked') {
    return policy === 'bot'
      ? '已连接飞书本人身份，但 FEISHU_IDENTITY=bot：当前固定用机器人收发；改成 auto 即可用本人'
      : '已连接飞书本人身份：发送以本人身份发出' + (receiveEnabled(policy, config.identity.feishu.receive) ? '，接收走用户轮询增量的可见会话' : '（本人接收已关闭）');
  }
  if (state === 'unavailable') {
    return '未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，无法连接飞书本人身份；请先在 .env 填写飞书自建应用凭据，然后到「平台账号」页点飞书卡片的「连接本人账号」';
  }
  if (state === 'expired') {
    return policy === 'user'
      ? '飞书本人身份授权已过期（FEISHU_IDENTITY=user）：发送会显式失败；请到「平台账号」页点「重新连接」'
      : '飞书本人身份授权已过期：请到「平台账号」页点「重新连接」；未重新连接前回退机器人收发';
  }
  if (state === 'error') {
    return '飞书本人身份状态异常（令牌文件损坏或其他应用残留）：请到「平台账号」页点「重新连接」';
  }
  // not_linked
  if (policy === 'user') {
    return 'FEISHU_IDENTITY=user 但尚未连接本人身份：发送会显式失败；请到「平台账号」页点「连接本人账号」完成授权';
  }
  if (!canLink) {
    return '未配置飞书应用凭据，无法连接本人身份；连接后即可用本人收发，免把机器人拉进每个群';
  }
  return '尚未连接飞书本人身份：当前用机器人收发；推荐连接本人账号（免把机器人拉进每个群），连接后自动切换为本人';
}

// ---------------------------------------------------------------------------
// 钉钉本人身份（dws）
// ---------------------------------------------------------------------------

/** 钉钉档案缓存（displayName / corp:user 脱敏），由 warmIdentityProbes 填充 */
let dingtalkProfileCache: { displayName?: string; detail?: string; at: number } | undefined;
const DINGTALK_PROFILE_TTL_MS = 5 * 60_000;

export function peekDingtalkProfile(): { displayName?: string; detail?: string } | undefined {
  if (!dingtalkProfileCache) return undefined;
  if (Date.now() - dingtalkProfileCache.at > DINGTALK_PROFILE_TTL_MS) return undefined;
  return {
    ...(dingtalkProfileCache.displayName ? { displayName: dingtalkProfileCache.displayName } : {}),
    ...(dingtalkProfileCache.detail ? { detail: dingtalkProfileCache.detail } : {}),
  };
}

export function dingtalkUserIdentity(): UserIdentityStatus {
  const conf = config.identity.dingtalk;
  const client = dingtalkPersonalClient();
  const loginCommand = client.loginCommand();
  const cached = client.lastKnownStatus();
  const profile = peekDingtalkProfile();
  const detailParts: string[] = [];
  if (cached?.version) detailParts.push(`dws ${cached.version}`);
  if (profile?.detail) detailParts.push(profile.detail);

  // 还没探测过：不阻塞请求，后台预热；状态如实标「探测中」（不假装未安装）
  if (!cached) {
    if (!identityChannelsReal(Platform.DINGTALK)) {
      return {
        state: 'unavailable',
        linked: false,
        hint: '当前钉钉为模拟模式（DINGTALK_MODE=mock，或 auto 未配机器人凭据且未显式 DINGTALK_IDENTITY=user）：'
          + '不会探测 dws、也不会启动本人身份收发',
        canLink: false,
        linkMethod: 'cli',
        loginCommand,
      };
    }
    void client.warmStatus().catch(() => undefined);
    return {
      state: 'unavailable',
      linked: false,
      hint: '正在后台探测 dws 状态（约 1–3 秒）：请稍后刷新；若持续如此，说明本机未安装 dws 或 DWS_BIN 配置不正确',
      canLink: false,
      linkMethod: 'cli',
      loginCommand,
    };
  }

  if (!cached.available) {
    return {
      state: 'unavailable',
      linked: false,
      ...(detailParts.length > 0 ? { detail: detailParts.join('；') } : {}),
      hint: cached.error
        ?? '未找到 dws 可执行文件：请安装钉钉官方 CLI（https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli），'
          + '或在 .env 把 DWS_BIN 指向 dws.exe 完整路径（离线演示可设 DWS_BIN=node scripts/fake-dws.mjs）',
      canLink: false,
      linkMethod: 'cli',
      loginCommand,
    };
  }

  if (cached.authenticated) {
    return {
      state: 'linked',
      linked: true,
      ...(profile?.displayName ? { displayName: profile.displayName } : {}),
      ...(detailParts.length > 0 ? { detail: detailParts.join('；') } : {}),
      hint: conf.policy === 'bot'
        ? '已登录钉钉本人身份，但 DINGTALK_IDENTITY=bot：当前固定用机器人收发；改成 auto 即可用本人'
        : '已登录钉钉本人身份：发送以本人身份发出'
          + (receiveEnabled(conf.policy, conf.receive) ? `，接收走 dws 个人事件（${conf.eventKinds.join(',')}）` : '（本人接收已关闭）'),
      canLink: true,
      linkMethod: 'cli',
      loginCommand,
    };
  }

  // 未登录：超时/网络错误 vs 明确未登录，给不同提示
  const errorText = cached.error ?? cached.message ?? '';
  const isNotLoggedIn = /未登录|not logged in|access token|secure data file/i.test(errorText) || !errorText;
  if (!isNotLoggedIn) {
    return {
      state: 'error',
      linked: false,
      ...(detailParts.length > 0 ? { detail: detailParts.join('；') } : {}),
      hint: `dws 状态探测失败：${errorText}`
        + (/doctor|自检/.test(errorText) ? '' : ' 可运行 pnpm run doctor --platform=dingtalk 自检。'),
      canLink: true,
      linkMethod: 'cli',
      loginCommand,
    };
  }
  return {
    state: 'not_linked',
    linked: false,
    ...(detailParts.length > 0 ? { detail: detailParts.join('；') } : {}),
    hint: conf.policy === 'user'
      ? 'DINGTALK_IDENTITY=user 但钉钉本人身份未登录：发送会显式失败；请到「平台账号」页点「连接本人账号」（或点「查看连接步骤」），也可终端执行 dws auth login'
      : '尚未登录钉钉本人身份：当前用机器人收发；推荐连接本人账号（免把机器人拉进每个群），登录后自动切换为本人',
    canLink: true,
    linkMethod: 'cli',
    loginCommand,
  };
}

// ---------------------------------------------------------------------------
// 平台身份视图
// ---------------------------------------------------------------------------

function isIdentityPlatform(platform: Platform): platform is Platform.FEISHU | Platform.DINGTALK {
  return platform === Platform.FEISHU || platform === Platform.DINGTALK;
}

/** 「不适用」视图：微信 / 邮箱没有本人身份通道，前端显示「不适用」 */
function inapplicableView(platform: Platform): PlatformIdentityView {
  const mode = modeOf(platform);
  const rt = runtimeOf(platform);
  return {
    policy: 'auto',
    effectiveSend: mode === 'mock' ? 'mock' : 'bot',
    effectiveReceive: mode === 'mock' ? 'mock' : 'bot',
    user: {
      state: 'unavailable',
      linked: false,
      hint: `${rt.label}不支持「本人身份」收发：该平台没有个人消息通道，直接用既有连接器/账号配置即可`,
      canLink: false,
      linkMethod: 'oauth',
    },
    botAvailable: rt.canSend,
    botHint: rt.canSend ? `${rt.label}通道可用` : `${rt.label}凭据不足：${rt.missing.join(' / ') || '未配置'}`,
    receiveHint: mode === 'mock' ? '本地模拟（不连真实平台）' : `${rt.label}既有接收通道`,
    sendHint: mode === 'mock' ? '模拟发送（界面标注「模拟发送」）' : `${rt.label}既有发送通道`,
  };
}

/** 一个平台的完整身份视图（/api/accounts、启动日志、doctor 共用） */
export function resolveIdentity(platform: Platform): PlatformIdentityView {
  if (!isIdentityPlatform(platform)) return inapplicableView(platform);

  const rt = runtimeOf(platform);
  const realChannels = identityChannelsReal(platform);
  const user = platform === Platform.FEISHU ? feishuUserIdentity() : dingtalkUserIdentity();
  const conf = platform === Platform.FEISHU ? config.identity.feishu : config.identity.dingtalk;
  const policy = conf.policy;
  const linked = user.linked;

  const effectiveSend: EffectiveRole = !realChannels
    ? 'mock'
    : policy === 'bot'
      ? 'bot'
      : policy === 'user'
        ? 'user'
        : linked
          ? 'user'
          : 'bot';
  const effectiveReceive: EffectiveRole = !realChannels
    ? 'mock'
    : policy === 'bot'
      ? 'bot'
      : linked && receiveEnabled(policy, conf.receive)
        ? 'user'
        : 'bot';

  // 「仅本人身份」部署（机器人通道因无凭据解析为 mock，但本人身份通道真实工作）：
  // 必须在 hint 里说清楚两条通道相互独立，避免把「模拟」误读成「本人身份也是假的」。
  const personalOnly = realChannels && rt.mode !== 'real';
  const personalOnlyPrefix = personalOnly
    ? '本人身份通道独立于机器人通道（机器人通道当前为 Mock）：'
    : '';

  return {
    policy,
    effectiveSend,
    effectiveReceive,
    user,
    botAvailable: rt.canSend,
    botHint: botHint(platform, rt.canSend, rt.canReceive, rt.missing),
    receiveHint: personalOnlyPrefix + receiveHint(platform, realChannels ? 'real' : 'mock', policy, linked, user.hint),
    sendHint: personalOnlyPrefix + sendHint(platform, realChannels ? 'real' : 'mock', policy, linked, rt.canSend, user.hint),
  };
}

function botHint(
  platform: Platform,
  canSend: boolean,
  canReceive: boolean,
  missing: string[],
): string {
  const label = platform === Platform.FEISHU ? '飞书机器人' : '钉钉机器人';
  if (canSend && canReceive) return `${label}通道可用（收发）`;
  if (canSend) return `${label}通道仅可发送：接收缺 ${missing.join(' / ') || '配置（可开启长连接）'}`;
  if (canReceive) return `${label}通道仅可接收：发送缺 ${missing.join(' / ') || '凭据'}`;
  return `${label}通道不可用：缺 ${missing.join(' / ') || '应用凭据'}（可运行 pnpm run doctor 自检）`;
}

function receiveHint(
  platform: Platform,
  mode: 'real' | 'mock',
  policy: IdentityPolicy,
  linked: boolean,
  unlinkedHint: string,
): string {
  if (mode === 'mock') return '本地模拟接收（不连真实平台）';
  const rt = runtimeOf(platform);
  if (policy === 'user' && !linked) return `已固定本人身份但未连接：本人接收不会启动（${unlinkedHint}）`;
  if (policy !== 'bot' && linked) {
    if (platform === Platform.FEISHU) {
      const s = Math.round(config.identity.feishu.pollMs / 1000);
      return `本人身份：飞书用户轮询（每 ${s}s 检查最多 ${config.identity.feishu.chatLimit} 个会话，延迟 5–30s，仅本人可见会话）`;
    }
    return `本人身份：dws 个人事件（${config.identity.dingtalk.eventKinds.join(',')}）；`
      + '如同时开启机器人 Stream，同一条消息可能各入库一次（平台消息 ID 体系不同，属平台限制），建议二选一';
  }
  if (platform === Platform.FEISHU) {
    return rt.canReceive
      ? `机器人接收：${config.platforms.feishu.stream ? '飞书长连接（WebSocket）' : 'HTTP 回调 /webhook/feishu'}`
      : '机器人接收未配置（缺 FEISHU_VERIFY_TOKEN 或未开 FEISHU_STREAM）';
  }
  return rt.canReceive
    ? `机器人接收：${config.dingtalkStream ? '钉钉 Stream 长连接' : 'HTTP 回调 /webhook/dingtalk'}`
    : '机器人接收未配置（缺 DINGTALK_AES_TOKEN / AES_KEY 或未开 DINGTALK_STREAM）';
}

function sendHint(
  platform: Platform,
  mode: 'real' | 'mock',
  policy: IdentityPolicy,
  linked: boolean,
  canSend: boolean,
  unlinkedHint: string,
): string {
  if (mode === 'mock') return '模拟发送（本地 Mock，界面标注「模拟发送」，不调用真实平台）';
  if (policy === 'user' && !linked) return `已固定本人身份但未连接：发送会显式失败（${unlinkedHint}）`;
  if (policy === 'bot') return '机器人身份发送（FEISHU_IDENTITY/DINGTALK_IDENTITY=bot）';
  if (linked) return '本人身份发送（用户授权有效）';
  const label = platform === Platform.FEISHU ? '飞书' : '钉钉';
  if (!canSend) return `${label}机器人通道凭据不足，发送会显式报错；连接本人身份后可绕过机器人凭据`;
  return '机器人身份发送（连接本人身份后自动切换为本人）';
}

// ---------------------------------------------------------------------------
// 发送校验（契约 §4）
// ---------------------------------------------------------------------------

const SEND_IDENTITY_LABEL: Record<Platform, string> = {
  [Platform.FEISHU]: '飞书',
  [Platform.DINGTALK]: '钉钉',
  [Platform.MAIL]: '邮箱',
  [Platform.WECHAT]: '微信',
};

/**
 * 请求的发送身份当前不可用（路由层据此回 400 而不是 404/500）。
 * message 直接给用户看：中文 + 下一步怎么做。
 */
export class IdentityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityUnavailableError';
  }
}

/** 该平台当前是否可「以本人身份发送」（sync：读缓存；配合 ensureIdentityProbed 使用） */
export function canSendAsUser(platform: Platform): boolean {
  if (!identityChannelsReal(platform)) return false;
  if (platform === Platform.FEISHU) {
    const state = feishuUserAuth().status().state;
    return state === 'active' || state === 'refreshable';
  }
  if (platform === Platform.DINGTALK) return dingtalkPersonalClient().lastKnownStatus()?.authenticated === true;
  return false;
}

/** 该平台当前是否可「以机器人身份发送」 */
export function canSendAsBot(platform: Platform): boolean {
  return runtimeOf(platform).canSend;
}

/**
 * 钉钉身份状态探测（模拟模式不探测）。
 *
 * 缓存说「已登录」→ 直接放行，省掉 1–3s 的 dws 调用；
 * 缓存说「未登录」或还没有缓存 → **必须再探一次**。
 *
 * 之前只要存在缓存就直接 return，导致一次瞬时失败（dws 读 token 存档被并发占用、
 * 或 token 刚到刷新点）会被永久固化成「未登录」，之后所有发送都被拦下，
 * 用户即便在终端重新登录也无效，只能重启后端。这是「明明登录了却发不出去」的根因。
 */
export async function ensureIdentityProbed(platform: Platform): Promise<void> {
  if (platform !== Platform.DINGTALK) return;
  if (!identityChannelsReal(platform)) return;
  const client = dingtalkPersonalClient();
  if (client.lastKnownStatus()?.authenticated) return;
  // 负结果强制重探（绕过 30s 缓存）：用户可能刚在终端/弹窗完成登录，
  // 沿用旧缓存会继续误拦；真未登录时多花 1–3s，反正这次发送也要失败。
  // authStatus 内部单飞，连点发送不会并发外呼。
  await client.authStatus({ force: true }).catch(() => undefined);
}

/**
 * 校验请求指定的身份当前是否可用；不可用抛中文错误（路由层转 400）。
 * 不传 identity 时不做校验（由连接器按 policy 解析）；平台整体模拟时跳过（Mock 不写 identity）。
 */
export function assertIdentityUsable(platform: Platform, requested: IdentityRole | undefined): void {
  if (!requested) return;
  const label = SEND_IDENTITY_LABEL[platform];
  // 平台根本不支持本人身份：无论是否 Mock，指定 identity 都是非法入参（400 中文）
  if (platform !== Platform.FEISHU && platform !== Platform.DINGTALK) {
    throw new IdentityUnavailableError(`${label}不支持指定发送身份：只有飞书 / 钉钉有「本人身份」通道，请去掉 identity 字段或改用支持的平台`);
  }
  // 平台整体模拟（显式 mock）时不校验身份可用性：Mock 不会写 delivery.identity，也不冒充真实身份
  if (!identityChannelsReal(platform)) return;
  if (requested === 'user') {
    if (canSendAsUser(platform)) return;
    const hint = resolveIdentity(platform).user.hint;
    const action = platform === Platform.FEISHU ? '请到「平台账号」页点「连接本人账号」' : '请到「平台账号」页点「连接本人账号」（未安装 dws 时点「查看连接步骤」）';
    throw new IdentityUnavailableError(
      `${label}本人身份未连接，无法以本人身份发送；${action}，或改用 identity=bot。${hint ? `（${hint}）` : ''}`,
    );
  }
  if (canSendAsBot(platform)) return;
  const rt = runtimeOf(platform);
  // 提示要可执行：本人身份未连接时，不能建议「改用 identity=user」（用户根本选不了），
  // 而是先让用户去连接；已连接时保留原建议（NEW-P2-3，小白阶段二实测）。
  const userReady = canSendAsUser(platform);
  throw new IdentityUnavailableError(
    `${label}机器人通道当前不可用（缺 ${rt.missing.join(' / ') || '应用凭据'}），无法以机器人身份发送；`
    + (userReady
      ? '请补齐凭据后重试，或改用 identity=user 以本人身份发送。'
      : '请补齐凭据后重试；如需改用本人身份，请先在「平台账号」页连接本人身份，再用 identity=user 发送。'),
  );
}

// ---------------------------------------------------------------------------
// 摘要 / 启动日志 / 预热
// ---------------------------------------------------------------------------

export interface IdentityHealthSummary {
  send: EffectiveRole;
  receive: EffectiveRole;
}

/** /api/health 用的身份摘要（不含慢调用：钉钉读缓存，未探测时触发后台预热） */
export function identitySummary(): Record<string, IdentityHealthSummary> {
  const out: Record<string, IdentityHealthSummary> = {};
  for (const platform of Object.values(Platform)) {
    // 只给「有本人/机器人概念」的平台。微信个人版与企业邮箱没有机器人身份，
    // 以前统一填 bot/bot 会被读成"微信也在用机器人"，评审时是误读源（P1）。
    if (!isIdentityPlatform(platform)) continue;
    const view = resolveIdentity(platform);
    out[platform] = { send: view.effectiveSend, receive: view.effectiveReceive };
  }
  return out;
}

function roleText(platform: Platform, role: EffectiveRole): string {
  if (role === 'mock') return '模拟';
  if (role === 'bot') return '机器人';
  return '本人';
}

function describeUser(user: UserIdentityStatus): string {
  if (user.displayName) return user.displayName;
  if (user.state === 'linked') return '已连接';
  if (user.state === 'not_linked') return '未连接';
  if (user.state === 'expired') return '已过期';
  if (user.state === 'error') return '异常';
  return '不可用';
}

/**
 * 预热身份探测（启动时调用，异步不阻塞 listen）：
 *  - 钉钉：探测 dws auth status（30s 缓存），已登录再取 profile 展示名；
 *  - 飞书：已连接时拉一次本人信息（账号页显示名），失败静默。
 */
export async function warmIdentityProbes(): Promise<void> {
  // 平台是模拟模式时不探测 dws（契约 §1 / §10.2：Mock 下不启动任何真实通道、不起子进程）
  if (identityChannelsReal(Platform.DINGTALK)) {
    const dt = dingtalkPersonalClient();
    const status = await dt.warmStatus().catch(() => undefined);
    if (status?.authenticated) {
      // 本人 openDingTalkId：个人事件里过滤「自己发出的消息」（取不到不影响接收，只少一层自环过滤）
      await dt.getSelfOpenDingtalkId().catch(() => undefined);
      try {
        const profiles = await dt.profiles();
        const first = profiles[0];
        // 注意：版本号由 dingtalkUserIdentity() 从 cached status 统一拼一次，
        // 这里只存档案信息，避免 detail 出现「dws vX；dws vX」重复（文档走查发现过）。
        const detailParts: string[] = [];
        const corp = maskIdentifier(first?.corpId);
        const uid = maskIdentifier(first?.userId);
        if (corp || uid) detailParts.push(`档案 ${corp ?? '?'}:${uid ?? '?'}（已脱敏）`);
        dingtalkProfileCache = {
          ...(first?.displayName ? { displayName: first.displayName } : {}),
          ...(detailParts.length > 0 ? { detail: detailParts.join('；') } : {}),
          at: Date.now(),
        };
      } catch {
        dingtalkProfileCache = { at: Date.now() };
      }
    }
  }
  // 飞书本人信息：只在真实模式且已连接时尝试（不触发额外授权流程）
  if (identityChannelsReal(Platform.FEISHU)) {
    const st = feishuUserAuth().status();
    if (st.state === 'active' || st.state === 'refreshable') {
      try {
        const { refreshSelfUserInfo } = await import('../connectors/feishuUserReceive');
        const token = await feishuUserAuth().accessToken();
        await refreshSelfUserInfo(token, { baseUrl: config.platforms.feishu.baseUrl });
      } catch {
        // 拉不到本人信息不影响收发，账号页仅少一个展示名
      }
    }
  }
}

/**
 * 启动日志里的身份行（契约 §6），返回多行字符串数组：
 * `[unimsg] 身份: 飞书=本人(收:用户轮询/发:本人) | 钉钉=机器人(收:机器人/发:机器人) | 微信=不适用 | 邮箱=不适用`
 * 不可用/固定本人但未连接时追加中文原因与修复命令。
 */
export function identityStartupLines(): string[] {
  const parts: string[] = [];
  const notes: string[] = [];
  for (const platform of Object.values(Platform)) {
    const view = resolveIdentity(platform);
    if (platform !== Platform.FEISHU && platform !== Platform.DINGTALK) {
      parts.push(`${runtimeOf(platform).label}=不适用`);
      continue;
    }
    const label = runtimeOf(platform).label;
    const mode = modeOf(platform);
    const userDesc = describeUser(view.user);
    const sendRole = roleText(platform, view.effectiveSend);
    const receiveRole = roleText(platform, view.effectiveReceive);
    parts.push(`${label}=${sendRole}(收:${receiveRole}/发:${sendRole})`);
    // 收集需要提示的情况
    if (mode === 'real' && view.policy === 'user' && !view.user.linked) {
      const envKey = platform === Platform.FEISHU ? 'FEISHU_IDENTITY' : 'DINGTALK_IDENTITY';
      notes.push(`[unimsg] 身份提示: ${label} 已固定本人身份（${envKey}=user）但${userDesc}：${view.user.hint}`);
    } else if (mode === 'real' && view.policy === 'auto' && !view.user.linked && view.user.canLink) {
      notes.push(`[unimsg] 身份提示: ${label} 当前用机器人收发；${view.user.hint}`);
    } else if (mode === 'real' && !view.user.canLink && view.user.state === 'unavailable') {
      notes.push(`[unimsg] 身份提示: ${label} ${view.user.hint}`);
    }
  }
  return [`[unimsg] 身份: ${parts.join(' | ')}`, ...notes];
}

/** 单测用：清空 profile / 接收错误缓存 */
export function resetIdentityCaches(): void {
  dingtalkProfileCache = undefined;
  feishuReceiveError = undefined;
}