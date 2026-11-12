import { describe, expect, it } from 'vitest';
import { USER_IDENTITY_UNLINKED_HINT, formatSendError } from './sendError';
import type { PlatformIdentityView } from '@unimsg/shared';

function identity(linked: boolean): Pick<PlatformIdentityView, 'user'> {
  return {
    user: {
      state: linked ? 'linked' : 'not_linked',
      linked,
      hint: '',
      canLink: true,
      linkMethod: 'cli',
    },
  };
}

describe('formatSendError（按身份能力分支的失败提示）', () => {
  const backendText =
    '飞书机器人当前不可用：缺少 FEISHU_APP_ID / FEISHU_APP_SECRET。请补齐凭据后重试，或改用 identity=user 以本人身份发送';

  it('本人身份未连接：把做不到的 identity=user 建议换成可执行的「去连接」', () => {
    const text = formatSendError(backendText, identity(false));
    expect(text).not.toContain('identity=user');
    expect(text).toContain('请补齐凭据后重试');
    expect(text).toContain(USER_IDENTITY_UNLINKED_HINT);
    expect(text).toContain('连接本人账号');
  });

  it('本人身份已连接：保留后端原建议（此时建议可执行）', () => {
    expect(formatSendError(backendText, identity(true))).toBe(backendText);
  });

  it('没有身份视图（企微 / 邮箱 / 旧后端）：不擅自改写', () => {
    expect(formatSendError(backendText, undefined)).toBe(backendText);
    expect(formatSendError(backendText, null)).toBe(backendText);
  });

  it('错误里没有 identity=user 建议：原样返回', () => {
    const text = '真实发送失败：飞书返回 10003 invalid param';
    expect(formatSendError(text, identity(false))).toBe(text);
  });

  it('句子开头 / 无前置标点的写法也能正确替换，不留重复标点', () => {
    const text = '当前机器人不可用。改用 identity=user 以本人身份发送';
    const out = formatSendError(text, identity(false));
    expect(out).not.toContain('identity=user');
    expect(out).toContain(USER_IDENTITY_UNLINKED_HINT);
    expect(out).not.toContain('。本人身份未连接，连接后可用本人身份发送（到「平台账号」页连接本人账号）发');
  });
});