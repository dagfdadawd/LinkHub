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
    // 客户视图不出现内部环境变量名（P2-2）
    expect(text).not.toContain('FEISHU_APP_ID');
    expect(text).toContain('飞书 App ID');
  });

  it('本人身份已连接：保留后端建议逻辑，但内部键名换成客户语言', () => {
    const text = formatSendError(backendText, identity(true));
    expect(text).not.toContain('FEISHU_APP_ID');
    expect(text).toContain('飞书 App ID');
    expect(text).toContain('本人身份发送');
  });

  it('没有身份视图（微信 / 邮箱 / 旧后端）：不擅自改写逻辑，只做术语替换', () => {
    expect(formatSendError(backendText, undefined)).not.toContain('FEISHU_APP_ID');
    expect(formatSendError(backendText, null)).toContain('飞书 App ID');
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
describe('平台原始 JSON 报错 → 中文可操作结论', () => {
  const feishuExternal =
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id HTTP 400: '
    + '{"code":230027,"msg":"Lack of necessary permissions, ext=no permission to operate external chats.",'
    + '"error":{"log_id":"20261113134203DCCFB29DC52A2259D81A","troubleshooter":"排查建议查看"}}';
  const feishuUnknown =
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id HTTP 400: '
    + '{"code":234999,"msg":"something odd happened on the platform side that is quite long to explain",'
    + '"error":{"log_id":"abcdef"}}';

  it('飞书 230027（外部会话无权限）：给出中文结论与下一步，不再甩一整段 JSON', () => {
    const text = formatSendError(feishuExternal, identity(true));
    expect(text).toContain('外部会话');
    expect(text).toContain('230027');
    expect(text).toContain('飞书开放平台');
    expect(text).not.toContain('Lack of necessary permissions');
    expect(text).not.toContain('log_id');
  });

  it('未收录的飞书错误码：给通用结论 + 错误码，保留排查入口', () => {
    const text = formatSendError(feishuUnknown, identity(true));
    expect(text).toContain('234999');
    expect(text).toContain('全链路回放');
    expect(text).not.toContain('log_id');
  });

  it('短文案 / 非 JSON 报错不受影响（原有行为保持不变）', () => {
    const short = '真实发送失败：飞书返回 10003 invalid param';
    expect(formatSendError(short, identity(true))).toBe(short);
  });
});
