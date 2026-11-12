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

/**
 * @param message 后端返回的中文错误
 * @param identity 该平台身份视图（可能没有，例如企业微信 / 邮箱 / Mock）
 */
export function formatSendError(
  message: string,
  identity?: Pick<PlatformIdentityView, 'user'> | null,
): string {
  if (!message) return message;
  // 已连接本人身份：后端建议是可执行的，保留原文
  if (identity?.user?.linked) return message;
  // 没有身份视图（企微 / 邮箱 / 旧后端）：不知道能力，不擅自改文案
  if (!identity) return message;
  if (!/改用\s*identity\s*=\s*user/i.test(message)) return message;

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
  return next;
}