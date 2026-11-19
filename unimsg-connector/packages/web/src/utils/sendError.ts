/**
 * 发送失败提示的「按能力分支」文案（NEW-P2-3）。
 *
 * 后端同步拦截时会给建议：「…请补齐凭据后重试，或改用 identity=user 以本人身份发送」。
 * 但如果本人身份还没连接，这条建议用户根本做不到（Compose 里没有可选身份）。
 * 这里做一次纯文本改写：本人未连接 → 换成「去连接本人账号」的可执行下一步；
 * 已连接 → 原样保留后端建议。
 *
 * 只处理文本，不臆造错误原因；不认识的内容一律原样返回。
 */
import type { PlatformIdentityView } from '@unimsg/shared';

/** 未连接本人身份时替换掉的建议文案（可执行版本） */
export const USER_IDENTITY_UNLINKED_HINT =
  '本人身份未连接，连接后可用本人身份发送（到「平台账号」页连接本人账号）';

/** 客户视图不暴露内部键名：错误提示里的技术词翻成人话 */
const TECH_WORD_REPLACEMENTS: Array<[RegExp, string]> = [
  [/FEISHU_APP_ID/g, '飞书 App ID'],
  [/FEISHU_APP_SECRET/g, '飞书 App Secret'],
  [/DINGTALK_CLIENT_ID/g, '钉钉 Client ID'],
  [/DINGTALK_CLIENT_SECRET/g, '钉钉 Client Secret'],
  [/WECHAT_BRIDGE_URL/g, '微信 RPA 桥地址'],
  [/DINGTALK_IDENTITY/g, '钉钉身份策略'],
  [/FEISHU_IDENTITY/g, '飞书身份策略'],
  [/identity\s*=\s*user/gi, '本人身份'],
  [/\bconversationId\b/gi, '会话 ID'],
];

/**
 * 平台错误码 → 中文可操作解释。
 *
 * 只收录「见到了原始报文但用户看不懂」的高频错误；未命中一律原样返回，
 * 绝不臆造原因。完整报文仍可在「全链路回放」里看到，所以这里可以只给结论。
 */
const PLATFORM_ERROR_HINTS: Record<string, string> = {
  '230027':
    '飞书拒绝发送：这个会话是「外部会话」（对方属于其他企业），当前应用没有对外部会话发消息的权限。'
    + '请管理员在飞书开放平台为该应用开通外部会话相关权限后重试；也可以改为在内部群/内部单聊里回复。',
  '230002':
    '飞书拒绝发送：机器人不在这个会话里（可能已被移出群）。'
    + '请先把机器人拉回该会话，或改用本人身份回复。',
  '230013':
    '飞书拒绝发送：当前身份对这个会话没有发送权限（可能不是群成员，或权限被回收）。',
  '99991672':
    '飞书拒绝发送：应用缺少所需权限范围。请管理员在飞书开放平台补充对应权限并重新发布应用。',
  '21001':
    '飞书拦截：所在租户策略不允许该操作。需要租户管理员解除限制后再试。',
};

/** 从原始报文里认出平台 + 错误码 */
function extractPlatformError(
  message: string,
): { platform: 'feishu' | 'dingtalk' | 'wechat'; code?: string } | undefined {
  const isJson = /"code"\s*:\s*\d+/.test(message);
  const feishu = /open\.feishu\.cn|feishu/i.test(message);
  if (feishu && isJson) {
    const m = message.match(/"code"\s*:\s*(\d{4,6})/);
    return { platform: 'feishu', code: m?.[1] };
  }
  return undefined;
}

/**
 * 把平台原始 JSON 报错压成一句可执行的中文；认不出就返回 undefined（调用方保持原文）。
 * 只在「报文很长 + 能识别平台」时介入，避免把普通中文错误也改写掉。
 */
export function explainPlatformError(message: string): string | undefined {
  if (!message || message.length < 80) return undefined;
  const found = extractPlatformError(message);
  if (!found) return undefined;
  const hint = found.code ? PLATFORM_ERROR_HINTS[found.code] : undefined;
  if (hint) return `${hint}（错误码 ${found.code}，完整报文见「全链路回放」）`;
  if (!found.code) return undefined;
  return `平台拒绝了这次发送（错误码 ${found.code}）。完整报文见「全链路回放」，可据此联系平台管理员排查。`;
}

/** 把内部键名/技术写法换成客户能读懂的词（只替换已知词，不臆造原因） */
export function polishSendError(message: string): string {
  const explained = explainPlatformError(message);
  if (explained) return explained;
  return TECH_WORD_REPLACEMENTS.reduce((text, [pattern, label]) => text.replace(pattern, label), message);
}

/**
 * @param message 后端返回的中文错误
 * @param identity 该平台身份视图（可能没有，例如微信 / 邮箱 / Mock）
 */
export function formatSendError(
  message: string,
  identity?: Pick<PlatformIdentityView, 'user'> | null,
): string {
  if (!message) return message;
  // 已连接本人身份：后端建议是可执行的，保留其逻辑但把内部键名换成客户语言
  if (identity?.user?.linked) return polishSendError(message);
  // 没有身份视图（微信 / 邮箱 / 旧后端）：不知道能力，不擅自改逻辑，只做术语替换
  if (!identity) return polishSendError(message);
  if (!/改用\s*identity\s*=\s*user/i.test(message)) return polishSendError(message);

  // 先处理「，或改用 identity=user …」（保留前面的分隔标点）
  let next = message.replace(
    /([，,；;])\s*或?\s*改用\s*identity\s*=\s*user[^。；;\n]*/gi,
    `$1${USER_IDENTITY_UNLINKED_HINT}`,
  );
  // 句子开头 / 没有前置标点的写法
  if (next === message) {
    next = message.replace(
      /或?\s*改用\s*identity\s*=\s*user[^。；;\n]*/gi,
      USER_IDENTITY_UNLINKED_HINT,
    );
  }
  return polishSendError(next);
}
