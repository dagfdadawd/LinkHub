import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AccountCard, doctorCommand, sendBreakdown } from './AccountsPage';
import { ACCOUNTS } from '../../services/mock/fixtures';
import { Platform } from '../../types';
import type { PlatformIdentityView, UserIdentityStatus } from '@unimsg/shared';

function accountOf(platform: Platform) {
  const account = ACCOUNTS.find((a) => a.platform === platform);
  if (!account) throw new Error(`fixture 缺少平台：${platform}`);
  return account;
}

/** 构造一份后端 /api/accounts 会下发的身份视图（测试用，字段与 shared 契约一致） */
export function identityView(
  patch: Partial<PlatformIdentityView> = {},
  userPatch: Partial<UserIdentityStatus> = {},
): PlatformIdentityView {
  return {
    policy: 'auto',
    effectiveSend: 'bot',
    effectiveReceive: 'bot',
    user: {
      state: 'not_linked',
      linked: false,
      hint: '未连接本人账号，当前以机器人收发；点「连接本人账号」开始。',
      canLink: true,
      linkMethod: 'oauth',
      ...userPatch,
    },
    botAvailable: true,
    botHint: '机器人凭据齐全，可继续兜底',
    receiveHint: '机器人长连接（webhook）',
    sendHint: '机器人接口发送',
    ...patch,
  };
}

function feishuAccount(identity: PlatformIdentityView, mode: 'real' | 'mock' = 'real') {
  return { ...accountOf(Platform.FEISHU), identity, mode };
}

function dingtalkAccount(identity: PlatformIdentityView, mode: 'real' | 'mock' = 'real') {
  return { ...accountOf(Platform.DINGTALK), identity, mode };
}

describe('AccountCard 基础信息', () => {
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

  it('健康平台：如实标「已配置（未验证）」并给可复制的 doctor 自检命令', () => {
    const { container } = render(<AccountCard account={accountOf(Platform.FEISHU)} />);

    // P1-1：变量齐了 ≠ 平台连得通，不能只显示得像「已经连上」
    expect(screen.getByText('已配置（未验证）')).toBeInTheDocument();
    expect(screen.getByText('真实接口')).toBeInTheDocument();
    expect(screen.getByText('凭据齐全，auto → 真实接口')).toBeInTheDocument();
    expect(screen.getByTestId('verify-feishu')).toBeInTheDocument();
    expect(screen.getByText('pnpm run doctor --platform=feishu')).toBeInTheDocument();
    expect(screen.getByText(/变量齐了 ≠ 平台能连通/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制自检命令' })).toBeInTheDocument();
    expect(container.querySelector('.account-card__alerts')).toBeNull();
  });

  it('Mock 平台不出现「未验证 / doctor」块（没有真实连通性可验证）', () => {
    render(<AccountCard account={accountOf(Platform.DINGTALK)} />);
    expect(screen.queryByTestId('verify-dingtalk')).toBeNull();
    expect(screen.getByText('已配置')).toBeInTheDocument();
  });
});

describe('身份块（谁在收、谁在发）', () => {
  it('飞书未连接本人：接收/发送都标「机器人」，说明为什么登录、下一步点哪里', () => {
    const onConnect = vi.fn();
    render(
      <AccountCard
        account={feishuAccount(identityView())}
        actionsEnabled
        onFeishuConnect={onConnect}
      />,
    );

    const block = screen.getByTestId('identity-block-feishu');
    expect(within(block).getByText('身份 · 谁在收、谁在发')).toBeInTheDocument();
    // 两枚身份 Tag 都是机器人；策略变量名可追溯
    expect(within(block).getAllByText('机器人')).toHaveLength(2);
    expect(within(block).getByText('FEISHU_IDENTITY=auto')).toBeInTheDocument();
    expect(within(block).getByText('机器人长连接（webhook）')).toBeInTheDocument();
    expect(within(block).getByText('机器人接口发送')).toBeInTheDocument();
    // 小白用户最关心的「为什么登录、不用拉群」
    expect(within(block).getByText(/登录你自己的飞书账号后/)).toBeInTheDocument();
    expect(within(block).getByText(/不需要把机器人拉进每个群/)).toBeInTheDocument();
    expect(within(block).getByText(/机器人通道可用（兜底）/)).toBeInTheDocument();
    expect(within(block).getByText(/未连接本人账号/)).toBeInTheDocument();

    fireEvent.click(within(block).getByRole('button', { name: /连接本人账号/ }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('飞书已连接本人：两枚 Tag 变「本人」，展示授权用户名与重新授权按钮（无注销）', () => {
    const identity = identityView(
      { effectiveSend: 'user', effectiveReceive: 'user', receiveHint: '本人身份：飞书用户轮询（20s）', sendHint: '本人身份：user_access_token 发送' },
      { state: 'linked', linked: true, displayName: '陈晓', canLink: true, hint: '本人身份已连接。' },
    );
    render(<AccountCard account={feishuAccount(identity)} actionsEnabled onFeishuConnect={() => {}} />);

    const block = screen.getByTestId('identity-block-feishu');
    expect(within(block).getAllByText('本人')).toHaveLength(2);
    expect(within(block).getByText(/已连接：陈晓/)).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: /重新授权/ })).toBeInTheDocument();
    expect(within(block).queryByRole('button', { name: /注销/ })).toBeNull();
    // 已连接后不再显示「为什么登录」
    expect(within(block).queryByText(/登录你自己的飞书账号后/)).toBeNull();
  });

  it('DINGTALK_IDENTITY=bot：固定机器人，不提供连接按钮', () => {
    const identity = identityView(
      { policy: 'bot' },
      { hint: 'DINGTALK_IDENTITY=bot：固定以机器人收发。', canLink: true },
    );
    render(<AccountCard account={dingtalkAccount(identity)} actionsEnabled onDingtalkConnect={() => {}} />);

    const block = screen.getByTestId('identity-block-dingtalk');
    expect(within(block).getByText('DINGTALK_IDENTITY=bot')).toBeInTheDocument();
    expect(within(block).queryByRole('button', { name: /连接本人账号/ })).toBeNull();
  });

  it('钉钉本人已连接：展示 dws 档案名、重新登录与注销入口', () => {
    const onConnect = vi.fn();
    const onLogout = vi.fn();
    const identity = identityView(
      {
        effectiveSend: 'user',
        effectiveReceive: 'user',
      },
      {
        state: 'linked',
        linked: true,
        canLink: true,
        displayName: '钉钉 · 陈晓',
        detail: 'dws v1.0.68',
        hint: '本人身份已连接。',
        linkMethod: 'cli',
      },
    );
    render(
      <AccountCard
        account={dingtalkAccount(identity)}
        actionsEnabled
        onDingtalkConnect={onConnect}
        onDingtalkLogout={onLogout}
      />,
    );

    const block = screen.getByTestId('identity-block-dingtalk');
    expect(within(block).getByText(/已连接：钉钉 · 陈晓/)).toBeInTheDocument();
    expect(within(block).getByText(/dws v1.0.68/)).toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: /重新登录/ }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(within(block).getByRole('button', { name: /注销/ })).toBeInTheDocument();
  });

  it('钉钉未安装 dws：按钮改为「查看连接步骤」并说明安装前置', () => {
    const onConnect = vi.fn();
    const identity = identityView({}, {
      state: 'unavailable',
      linked: false,
      canLink: false,
      hint: '未检测到 dws，请先安装钉钉工作台 CLI。',
      linkMethod: 'cli',
    });
    render(<AccountCard account={dingtalkAccount(identity)} actionsEnabled onDingtalkConnect={onConnect} />);

    const block = screen.getByTestId('identity-block-dingtalk');
    expect(within(block).getByRole('button', { name: /查看连接步骤/ })).toBeInTheDocument();
    expect(within(block).getByText(/未检测到 dws/)).toBeInTheDocument();
  });

  it('平台整体 Mock：接收/发送都显示「模拟」，不冒充本人或机器人真实通道', () => {
    const identity = identityView(
      { effectiveSend: 'mock', effectiveReceive: 'mock' },
      { state: 'unavailable', canLink: false },
    );
    render(<AccountCard account={dingtalkAccount(identity, 'mock')} actionsEnabled />);

    const block = screen.getByTestId('identity-block-dingtalk');
    expect(within(block).getAllByText('模拟')).toHaveLength(2);
    expect(within(block).getByText(/当前平台通道是「Mock 模拟」/)).toBeInTheDocument();
    expect(within(block).queryByRole('button')).toBeNull();
    // Mock 下不再说「机器人通道可用」——当前根本不会调用真实通道
    expect(within(block).queryByText(/机器人通道/)).toBeNull();
  });

  it('「仅本人身份」部署：机器人通道 Mock 但本人身份真实可用，不误标成模拟', () => {
    const identity = identityView(
      { effectiveSend: 'user', effectiveReceive: 'user' },
      { state: 'linked', linked: true, displayName: '陈晓', hint: '本人身份已连接。', linkMethod: 'cli' },
    );
    render(<AccountCard account={dingtalkAccount(identity, 'mock')} actionsEnabled onDingtalkConnect={() => {}} />);

    const block = screen.getByTestId('identity-block-dingtalk');
    // 账号卡片 Tag 仍如实写「Mock 模拟」（机器人通道），但身份块不能被误标成模拟
    expect(within(block).getAllByText('本人')).toHaveLength(2);
    expect(within(block).queryByText(/当前平台通道是「Mock 模拟」/)).toBeNull();
    expect(within(block).getByRole('button', { name: /重新登录/ })).toBeInTheDocument();
    expect(screen.getAllByText('Mock 模拟').length).toBeGreaterThan(0);
  });

  it('纯前端演示模式（actionsEnabled=false）：不渲染连接按钮，避免点了没有后端', () => {
    render(<AccountCard account={feishuAccount(identityView())} actionsEnabled={false} />);
    const block = screen.getByTestId('identity-block-feishu');
    expect(within(block).queryByRole('button', { name: /连接本人账号/ })).toBeNull();
    // 仍如实展示当前身份与未连接原因，只是不给无效操作入口
    expect(within(block).getAllByText('机器人')).toHaveLength(2);
    expect(within(block).getByText(/未连接本人账号/)).toBeInTheDocument();
  });
});

describe('账号页工具函数（指标口径 / 自检命令）', () => {
  it('sendBreakdown：health.sent 含 Mock，拆成「共 / 真实 / 模拟」', () => {
    expect(sendBreakdown(3, 3)).toEqual({ total: 3, real: 0, mock: 3 });
    expect(sendBreakdown(5, 2)).toEqual({ total: 5, real: 3, mock: 2 });
    expect(sendBreakdown(0, 0)).toEqual({ total: 0, real: 0, mock: 0 });
    // 旧后端 sentMock 缺失 / 脏数据不产生负数
    expect(sendBreakdown(2, undefined)).toEqual({ total: 2, real: 2, mock: 0 });
    expect(sendBreakdown(2, 5)).toEqual({ total: 2, real: 0, mock: 2 });
    expect(sendBreakdown(undefined, 3)).toEqual({ total: 0, real: 0, mock: 0 });
  });

  it('doctorCommand：四平台各自生成可复制命令', () => {
    expect(doctorCommand(Platform.FEISHU)).toBe('pnpm run doctor --platform=feishu');
    expect(doctorCommand(Platform.DINGTALK)).toBe('pnpm run doctor --platform=dingtalk');
    expect(doctorCommand(Platform.WECOM)).toBe('pnpm run doctor --platform=wecom');
    expect(doctorCommand(Platform.MAIL)).toBe('pnpm run doctor --platform=mail');
  });
});