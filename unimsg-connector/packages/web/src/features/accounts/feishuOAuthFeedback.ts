/**
 * 飞书 OAuth 回来后的反馈（P1-6 + 20029 自解释）。
 *
 * 问题：点「连接本人账号」后授权页在另一个标签/整页打开；飞书那边卡在
 * `20029 重定向 URL 有误`（桌面版后端跑在随机端口 3901–3930，不可能等于飞书后台
 * 登记的 localhost:3001），回到 LinkHub 却只看到泛泛的「授权未完成」，
 * 用户不知道该把哪个地址填到哪里。
 *
 * 做法：点授权前在 sessionStorage 写 pending 标记，拿到授权地址后顺手记住后端本次
 * 下发的 redirectUri；回到账号页（focus / 页面重载）仍是未连接时，用真实回调地址 +
 * 20029 修复步骤告诉用户「把哪个地址填到哪里」，而不是让用户对着错误码猜。
 *
 * 纯函数 + 可注入 storage，便于单测；storage 不可用（隐私模式）时静默降级。
 */
export const FEISHU_OAUTH_PENDING_KEY = 'linkhub.feishuOAuthPending';
/** 标记最长存活 10 分钟：超时视为用户早已放弃，不再打扰 */
export const FEISHU_OAUTH_PENDING_MAX_AGE_MS = 10 * 60_000;

export type OAuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface FeishuOAuthPending {
  startedAt: number;
  /** 本次授权实际使用的回调地址（后端 /api/feishu/oauth/start 下发，刷新后仍可展示） */
  redirectUri?: string;
}

/** 默认 sessionStorage；隐私模式 / SSR 下可能抛错，返回 undefined */
export function defaultOAuthStorage(): OAuthStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

/** 合法回调地址：只接受 http(s)，避免把脏数据展示给用户 */
function normalizeRedirectUri(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const uri = value.trim();
  return /^https?:\/\//i.test(uri) ? uri : undefined;
}

/** 发起授权前写入 pending 标记（失败不阻塞主流程）；重新发起时清掉上一次的回调地址 */
export function markFeishuOAuthPending(storage: OAuthStorage | undefined, now = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(FEISHU_OAUTH_PENDING_KEY, JSON.stringify({ startedAt: now }));
  } catch {
    // 存储不可用：授权仍可进行，只是回来后没有提示
  }
}

/**
 * 拿到授权地址后，把本次真实回调地址补记到 pending 标记里。
 * 作用：页面刷新 / 从授权中心切到账号页后，20029 面板仍能显示「到底该填哪个地址」。
 */
export function saveFeishuOAuthRedirectUri(
  storage: OAuthStorage | undefined,
  redirectUri: string | undefined,
  now = Date.now(),
): void {
  const uri = normalizeRedirectUri(redirectUri);
  if (!storage || !uri) return;
  try {
    const raw = storage.getItem(FEISHU_OAUTH_PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<FeishuOAuthPending> | null) : undefined;
    const startedAt = Number(parsed?.startedAt);
    // 标记被人为清掉 / 损坏时补一个：记住地址本身比标记时序更重要
    storage.setItem(
      FEISHU_OAUTH_PENDING_KEY,
      JSON.stringify({ startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : now, redirectUri: uri }),
    );
  } catch {
    // 忽略：存不下地址时仍可授权，只是未完成面板退回兜底文案
  }
}

/** 读取 pending 标记；过期/损坏时清掉并返回 undefined */
export function readFeishuOAuthPending(
  storage: OAuthStorage | undefined,
  now = Date.now(),
  maxAgeMs = FEISHU_OAUTH_PENDING_MAX_AGE_MS,
): FeishuOAuthPending | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(FEISHU_OAUTH_PENDING_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<FeishuOAuthPending> | null;
    const startedAt = Number(parsed?.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      storage.removeItem(FEISHU_OAUTH_PENDING_KEY);
      return undefined;
    }
    if (now - startedAt > maxAgeMs) {
      storage.removeItem(FEISHU_OAUTH_PENDING_KEY);
      return undefined;
    }
    const redirectUri = normalizeRedirectUri(parsed?.redirectUri);
    return redirectUri ? { startedAt, redirectUri } : { startedAt };
  } catch {
    return undefined;
  }
}

export function clearFeishuOAuthPending(storage: OAuthStorage | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(FEISHU_OAUTH_PENDING_KEY);
  } catch {
    // 忽略：清不掉也不影响下一次授权
  }
}

/** 飞书开放平台应用列表：拿不到 appId 就开通用地址，不编造 deep link */
export const FEISHU_OPEN_PLATFORM_URL = 'https://open.feishu.cn/app';

/** 未完成面板标题：结论先行，把飞书页面上的真实错误码写出来 */
export const FEISHU_OAUTH_UNFINISHED_TITLE = '飞书授权未完成：最常见是 20029 重定向 URL 有误';

/** 20029 的修复正文：把「哪个地址填到哪里」一次说清 */
export const FEISHU_OAUTH_REDIRECT_GUIDE =
  '飞书开放平台只认已登记的回调地址。请打开 飞书开放平台 → 你的应用 → 开发配置 → '
  + '安全设置 → 重定向 URL，把下面这个地址原样添加（含端口、路径，不加结尾斜杠），'
  + '保存后回 LinkHub 重试。测试应用保存即生效，正式应用需重新发布版本。';

/** 拿不到本次回调地址（刷新 / state 丢失）时的兜底：不编造地址，告诉用户点哪里会得到 */
export const FEISHU_OAUTH_REDIRECT_URI_FALLBACK = '点「重新授权」后这里会显示本次的真实回调地址';

export interface FeishuOAuthReason {
  /** 飞书错误码；「应用未发布」这类没有错误码，前端不编造 */
  code?: string;
  title: string;
  /** 一句话原因 */
  reason: string;
  /** 可操作动作 */
  action: string;
}

/** 20029 之外的常见失败原因：每条一句话 + 可操作动作，不让用户对着错误码猜 */
export const FEISHU_OAUTH_COMMON_REASONS: FeishuOAuthReason[] = [
  {
    code: '20027',
    title: '权限不足',
    reason: '应用的用户身份权限缺 offline_access / im:resource。',
    action: '到 开发配置 → 权限管理 → 用户身份权限 勾选这两项（要发消息再勾 im:message.send_as_user），保存并发布版本。',
  },
  {
    code: '20010',
    title: '不在应用可用范围',
    reason: '你的飞书账号不在这个应用的可用范围内。',
    action: '让企业管理员在 版本管理与发布 → 可用范围 里把你的账号加进去。',
  },
  {
    title: '应用未发布 / 测试应用未启用',
    reason: '改完配置没有发布新版本，或测试应用没有启用。',
    action: '测试应用在开发配置里启用后保存即生效；正式应用需到 版本管理与发布 创建并发布版本。',
  },
  {
    title: '授权码过期 / 已被使用',
    reason: '授权页停留太久，或同一个授权链接被重复使用。',
    action: '回 LinkHub 点「重新授权」拿新链接，10 分钟内完成授权。',
  },
];
