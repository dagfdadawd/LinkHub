/**
 * 飞书 OAuth 回来后的反馈（P1-6）。
 *
 * 问题：点「连接本人账号」后授权页在另一个标签/整页打开；用假 App ID 时飞书页只显示
 * 裸错误码（如 20028），回到 LinkHub 没有任何提示，用户不知道失败在哪。
 *
 * 做法：点授权前在 sessionStorage 写一个 pending 标记；回到账号页（focus / 页面重载）
 * 时读标记：
 *  - 账号已变成「本人已连接」→ 清标记 + 成功 toast；
 *  - 仍是未连接 → 展示中文提示（常见原因 + 配置步骤），提供「重新发起授权」。
 *
 * 纯函数 + 可注入 storage，便于单测；storage 不可用（隐私模式）时静默降级。
 */
export const FEISHU_OAUTH_PENDING_KEY = 'linkhub.feishuOAuthPending';
/** 标记最长存活 10 分钟：超时视为用户早已放弃，不再打扰 */
export const FEISHU_OAUTH_PENDING_MAX_AGE_MS = 10 * 60_000;

export type OAuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface FeishuOAuthPending {
  startedAt: number;
}

/** 默认 sessionStorage；隐私模式 / SSR 下可能抛错，返回 undefined */
export function defaultOAuthStorage(): OAuthStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

/** 发起授权前写入 pending 标记（失败不阻塞主流程） */
export function markFeishuOAuthPending(storage: OAuthStorage | undefined, now = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(FEISHU_OAUTH_PENDING_KEY, JSON.stringify({ startedAt: now }));
  } catch {
    // 存储不可用：授权仍可进行，只是回来后没有提示
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
    return { startedAt };
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

/** 授权未完成时给用户看的中文解释（不甩错误码，给下一步） */
export const FEISHU_OAUTH_UNFINISHED_HINT =
  '授权未完成。最常见原因：飞书应用还没发布/未加入可用范围、重定向 URL 与飞书后台不一致、'
  + '用户身份权限未开通（im:message、im:message:readonly 等）。飞书页面上的错误码（如 20028）'
  + '多半指向这几项配置。';

/** 授权失败时给用户看的配置步骤清单（前端不跳外链，直接内联，避免文档路径失效） */
export const FEISHU_OAUTH_CHECKLIST: string[] = [
  '飞书开放平台 → 安全设置：重定向 URL 与 .env 的 FEISHU_REDIRECT_URI 完全一致（含协议、端口、路径）',
  '权限管理：开通用户身份权限 im:message、im:message:readonly、im:message.p2p_msg:get_as_user、im:message.group_msg:get_as_user',
  '版本管理与发布：应用需发布/上架，且当前账号在「可用范围」内',
  '改完 .env 后必须重启后端，再回本页重新授权',
  '完整图文步骤见 docs/personal-identity.md「飞书」一节',
];