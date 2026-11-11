import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AccountCard } from './AccountsPage';
import { ACCOUNTS } from '../../services/mock/fixtures';
import { Platform } from '../../types';
import type { FeishuIdentityInfo } from '../../services/api';

function accountOf(platform: Platform) {
  const account = ACCOUNTS.find((a) => a.platform === platform);
  if (!account) throw new Error(`fixture 缺少平台：${platform}`);
  return account;
}

describe('AccountCard', () => {
  it('邮箱平台展示多账号、地址、IMAP/SMTP 与监听目录，mode Tag 为真实接口', () => {
    render(<AccountCard account={accountOf(Platform.MAIL)} />);

    expect(screen.getByText('邮箱')).toBeInTheDocument();
    expect(screen.getByText('QQ邮箱')).toBeInTheDocument();
    expect(screen.getByText('me@qq.com')).toBeInTheDocument();
    expect(screen.getByText('imap.qq.com')).toBeInTheDocument();
    expect(screen.getByText('smtp.qq.com')).toBeInTheDocument();
    expect(screen.getByText(/监听目录：INBOX、Junk/)).toBeInTheDocument();
    expect(screen.getAllByText('真实接口').length).toBeGreaterThan(0);
    // 配置问题（issues）逐条展示：warn / error 都可见
    expect(screen.getByText(/MAIL_WORK_PROVIDER=custom/)).toBeInTheDocument();
    expect(screen.getByText(/MAIL_HR_AUTH_CODE/)).toBeInTheDocument();
    expect(screen.getByText(/该账号已跳过/)).toBeInTheDocument();
  });

  it('部分配置平台展示 Mock 模拟 Tag、缺失变量与能力缺口告警（warnings）', () => {
    render(<AccountCard account={accountOf(Platform.WECOM)} />);

    expect(screen.getByText('Mock 模拟')).toBeInTheDocument();
    expect(screen.getByText('未配置')).toBeInTheDocument();
    expect(screen.getByText(/WECOM_SECRET、WECOM_AGENT_ID/)).toBeInTheDocument();
    expect(screen.getByText('不可发送')).toBeInTheDocument();
    expect(screen.queryByText('不可接收')).not.toBeInTheDocument();
    // 可替换性关键提示：能收不能发 + 企微可信 IP 限制
    expect(screen.getByText(/只能收不能发：缺少 WECOM_SECRET \/ WECOM_AGENT_ID/)).toBeInTheDocument();
    expect(screen.getByText(/企业微信要求发信出口 IP 在企业可信 IP 内/)).toBeInTheDocument();
  });

  it('健康平台只展示状态与原因，不渲染空告警区块', () => {
    const { container } = render(<AccountCard account={accountOf(Platform.FEISHU)} />);

    expect(screen.getByText('已配置')).toBeInTheDocument();
    expect(screen.getByText('真实接口')).toBeInTheDocument();
    expect(screen.getByText('凭据齐全，auto → 真实接口')).toBeInTheDocument();
    expect(container.querySelector('.account-card__alerts')).toBeNull();
  });

  it('飞书未授权：展示机器人身份与连接按钮，点击触发授权回调', () => {
    const identity: FeishuIdentityInfo = {
      sendAs: 'auto',
      effective: 'bot',
      tokenState: 'none',
      configured: false,
      hint: '未连接用户身份，当前以机器人发送；连接后自动切换为本人',
    };
    const onConnect = vi.fn();
    render(
      <AccountCard
        account={{ ...accountOf(Platform.FEISHU), feishuIdentity: identity }}
        showFeishuConnect
        onFeishuConnect={onConnect}
      />,
    );

    expect(screen.getByTestId('feishu-identity')).toBeInTheDocument();
    expect(screen.getByText('发送身份')).toBeInTheDocument();
    expect(screen.getByText('机器人')).toBeInTheDocument();
    expect(screen.getByText(/未连接用户身份/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /连接飞书用户身份/ }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('FEISHU_SEND_AS=user 未连接：标签明确为本人（未连接），仍提供连接按钮', () => {
    const identity: FeishuIdentityInfo = {
      sendAs: 'user',
      effective: 'user',
      tokenState: 'none',
      configured: false,
      hint: '未连接用户身份，发送会失败；请点击「连接飞书用户身份」',
    };
    render(
      <AccountCard
        account={{ ...accountOf(Platform.FEISHU), feishuIdentity: identity }}
        showFeishuConnect
        onFeishuConnect={() => {}}
      />,
    );

    expect(screen.getByText('本人（未连接）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /连接飞书用户身份/ })).toBeInTheDocument();
  });

  it('飞书已授权：展示本人、过期时间与重新授权按钮', () => {
    const identity: FeishuIdentityInfo = {
      sendAs: 'auto',
      effective: 'user',
      tokenState: 'active',
      configured: true,
      accessExpiresAt: '2026-11-11T10:00:00.000Z',
      refreshExpiresAt: '2026-11-18T10:00:00.000Z',
      hint: '发送身份：本人（用户授权有效）',
    };
    render(
      <AccountCard
        account={{ ...accountOf(Platform.FEISHU), feishuIdentity: identity }}
        showFeishuConnect
        onFeishuConnect={() => {}}
      />,
    );

    expect(screen.getByText('本人（用户授权）')).toBeInTheDocument();
    expect(screen.getByText(/access 至/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新授权/ })).toBeInTheDocument();
  });

  it('飞书 Mock 模式不渲染发送身份块（避免“本人”与模拟通道混淆）', () => {
    const identity: FeishuIdentityInfo = {
      sendAs: 'auto',
      effective: 'user',
      tokenState: 'active',
      configured: true,
      hint: '发送身份：本人（用户授权有效）',
    };
    render(
      <AccountCard
        account={{ ...accountOf(Platform.FEISHU), mode: 'mock', feishuIdentity: identity }}
        showFeishuConnect
        onFeishuConnect={() => {}}
      />,
    );

    expect(screen.queryByTestId('feishu-identity')).toBeNull();
  });

  it('FEISHU_SEND_AS=bot 时不显示授权按钮', () => {
    const identity: FeishuIdentityInfo = {
      sendAs: 'bot',
      effective: 'bot',
      tokenState: 'none',
      configured: false,
      hint: 'FEISHU_SEND_AS=bot：固定以机器人身份发送',
    };
    render(
      <AccountCard
        account={{ ...accountOf(Platform.FEISHU), feishuIdentity: identity }}
        showFeishuConnect
        onFeishuConnect={() => {}}
      />,
    );

    expect(screen.getByText('机器人')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /连接飞书用户身份|重新授权/ })).toBeNull();
  });
});
