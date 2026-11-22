import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AccountCard, accountConclusion, capabilityWarning, doctorCommand, DoctorPanel, sendBreakdown } from './AccountsPage';
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

/**
 * D2 评审后：长警告 / doctor 自检命令 / 缺失变量收进「详情」折叠区（默认收起），
 * 断言这些内容前必须先展开对应平台的详情。
 */
function openDetails(platform: Platform) {
  fireEvent.click(screen.getByTestId(`details-toggle-${platform}`));
}

describe('AccountCard 基础信息', () => {
  it('邮箱平台展示多账号、地址、IMAP/SMTP 与监听目录，mode Tag 为真实接口', () => {
    render(<AccountCard account={accountOf(Platform.MAIL)} />);

    expect(screen.getByText('邮箱')).toBeInTheDocument();
    expect(screen.getByText('QQ邮箱')).toBeInTheDocument();
    expect(screen.getByText('me@qq.com')).toBeInTheDocument();
    expect(screen.getByText('imap.qq.com')).toBeInTheDocument();
    expect(screen.getByText('smtp.qq.com')).toBeInTheDocument();
    expect(screen.getByText(/收信文件夹：INBOX、Junk/)).toBeInTheDocument();
    expect(screen.getAllByText('真实连接').length).toBeGreaterThan(0);
    // D2 评审：配置问题（issues）收进「详情」折叠区，默认收起不占卡片密度
    expect(screen.queryByText(/MAIL_WORK_PROVIDER=custom/)).not.toBeInTheDocument();
    openDetails(Platform.MAIL);
    // 展开后 warn / error 逐条可见，长文案完整不截断
    expect(screen.getByText(/MAIL_WORK_PROVIDER=custom/)).toBeInTheDocument();
    expect(screen.getByText(/MAIL_HR_AUTH_CODE/)).toBeInTheDocument();
    expect(screen.getByText(/该账号已跳过/)).toBeInTheDocument();
  });

  it('微信 RPA 卡片：如实标演示通道 + 展示 RPA 依赖告警，mock 下不谎报能收', () => {
    render(<AccountCard account={accountOf(Platform.WECHAT)} />);

    expect(screen.getByText('已配置')).toBeInTheDocument();
    expect(screen.getByText('演示模式（未连接）')).toBeInTheDocument();
    // D2 评审：RPA 依赖告警（长警告）收进「详情」折叠区，默认收起
    openDetails(Platform.WECHAT);
    // 如实说明这条通道靠什么跑，不把 RPA 说成官方 API
    expect(screen.getByText(/微信个人版无官方 API，走 RPA 通道/)).toBeInTheDocument();
    // P0：mock 不采集真实微信消息 → 必须如实显示「不可接收」，不能两侧都打勾
    expect(screen.getByText(/不采集真实微信消息/)).toBeInTheDocument();
    // 能力缺口 chip 仍在卡片默认层（不随折叠隐藏）
    expect(screen.getByText('不可接收')).toBeInTheDocument();
    // 发送在 mock 下是可用的（模拟发送），不应误报「不可发送」
    expect(screen.queryByText('不可发送')).not.toBeInTheDocument();
  });

  it('健康平台：如实标「已配置（未验证）」并给可复制的 doctor 自检命令', () => {
    const { container } = render(<AccountCard account={accountOf(Platform.FEISHU)} />);

    // P1-1：变量齐了 ≠ 平台连得通，不能只显示得像「已经连上」
    expect(screen.getByText('已配置（未验证）')).toBeInTheDocument();
    expect(screen.getByText('真实连接')).toBeInTheDocument();
    expect(screen.getByText('凭据齐全，auto → 真实接口')).toBeInTheDocument();
    // D2 评审：doctor 自检命令收进「详情」折叠区，默认收起、展开后可复制
    expect(screen.queryByTestId('verify-feishu')).toBeNull();
    openDetails(Platform.FEISHU);
    expect(screen.getByTestId('verify-feishu')).toBeInTheDocument();
    expect(screen.getByText('pnpm run doctor --platform=feishu')).toBeInTheDocument();
    expect(screen.getByText(/变量齐了 ≠ 平台能连通/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制自检命令' })).toBeInTheDocument();
    expect(container.querySelector('.account-card__alerts')).toBeNull();
  });

  it('Mock 平台不出现「未验证 / doctor」块（没有真实连通性可验证）', () => {
    render(<AccountCard account={accountOf(Platform.DINGTALK)} />);
    expect(screen.queryByTestId('verify-dingtalk')).toBeNull();
    // D2 评审：没有任何技术细节时不显示「详情」入口，默认层保持干净
    expect(screen.queryByTestId('details-toggle-dingtalk')).toBeNull();
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
    expect(within(block).getByText(/身份设置：自动（本人优先）/)).toBeInTheDocument();
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
    expect(within(block).getByText(/身份设置：仅机器人/)).toBeInTheDocument();
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
    expect(within(block).getAllByText('演示')).toHaveLength(2);
    expect(within(block).getByText(/当前平台通道是「演示模式」/)).toBeInTheDocument();
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
    expect(within(block).queryByText(/当前平台通道是「演示模式」/)).toBeNull();
    expect(within(block).getByRole('button', { name: /重新登录/ })).toBeInTheDocument();
    expect(screen.getAllByText('演示模式（未连接）').length).toBeGreaterThan(0);
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

  it('doctorCommand：四平台（飞书/钉钉/微信/邮箱）各自生成可复制命令', () => {
    expect(doctorCommand(Platform.FEISHU)).toBe('pnpm run doctor --platform=feishu');
    expect(doctorCommand(Platform.DINGTALK)).toBe('pnpm run doctor --platform=dingtalk');
    expect(doctorCommand(Platform.WECHAT)).toBe('pnpm run doctor --platform=wechat');
    expect(doctorCommand(Platform.MAIL)).toBe('pnpm run doctor --platform=mail');
  });

  it('accountConclusion：一句话结论优先后端 reason，缺失时按通道 / 配置兜底（D2）', () => {
    expect(accountConclusion(accountOf(Platform.FEISHU))).toBe('凭据齐全，auto → 真实接口');
    // 无 reason 的 mock 通道：如实说「演示模式」，不冒充真实
    expect(accountConclusion({ ...accountOf(Platform.WECHAT), reason: undefined })).toBe(
      '当前是演示模式：不会真实收发',
    );
    // 未配置：结论直接指向下一步（去哪配、配完要重启）
    expect(
      accountConclusion({ ...accountOf(Platform.WECHAT), configured: false, reason: undefined }),
    ).toBe('还没配置：到「平台应用配置」填写凭据，保存后重新打开 LinkHub');
  });
});

describe('NEW-P2-1：卡片摘要能力 chip 与身份块口径一致（不打架）', () => {
  it('本人身份已连接且生效：机器人通道不可用也不显示「不可接收/不可发送」', () => {
    const identity = identityView(
      { effectiveSend: 'user', effectiveReceive: 'user' },
      { state: 'linked', linked: true, displayName: '陈晓', canLink: true },
    );
    render(
      <AccountCard
        account={{ ...dingtalkAccount(identity), canReceive: false, canSend: false }}
        actionsEnabled
        onDingtalkConnect={() => {}}
      />,
    );

    // 摘要不再出现与身份块矛盾的「不可接收」
    expect(screen.queryByText('不可接收')).toBeNull();
    expect(screen.queryByText('不可发送')).toBeNull();
    const block = screen.getByTestId('identity-block-dingtalk');
    expect(within(block).getAllByText('本人')).toHaveLength(2);
  });

  it('本人未连接 + 机器人通道不可用：保留「不可接收/不可发送」如实提示', () => {
    const identity = identityView(); // effective=bot, linked=false
    render(<AccountCard account={{ ...feishuAccount(identity), canReceive: false, canSend: false }} />);

    expect(screen.getByText('不可接收')).toBeInTheDocument();
    expect(screen.getByText('不可发送')).toBeInTheDocument();
  });

  it('P2-5：邮箱已添加本地账号但通道仍是演示模式时，卡头写「已添加账号」而不是「未配置」', () => {
    const mail = accountOf(Platform.MAIL);
    render(
      <AccountCard
        account={{
          ...mail,
          mode: 'mock',
          configured: false,
          accounts: [
            {
              key: 'whitetest',
              label: 'QQ 邮箱',
              address: 'w******@qq.com',
              imapHost: 'imap.qq.com',
              smtpHost: 'smtp.qq.com',
              folders: ['INBOX'],
              mode: 'mock',
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(/已添加 1 个账号（演示模式）/)).toBeInTheDocument();
    expect(screen.getByText(/已添加 1 个账号（未验证）/)).toBeInTheDocument();
    expect(screen.queryByText('演示模式（未连接）')).toBeNull();
  });

  it('Mock / 无身份视图：能力 chip 保持原口径，不显示「本人可收」这类不实信息', () => {
    const mockIdentity = identityView(
      { effectiveSend: 'mock', effectiveReceive: 'mock' },
      { state: 'unavailable', linked: false, canLink: false },
    );
    expect(capabilityWarning('receive', false, mockIdentity)).toBe('不可接收');
    expect(capabilityWarning('send', false, mockIdentity)).toBe('不可发送');
    expect(capabilityWarning('receive', false, undefined)).toBe('不可接收');
    // 能力正常时不显示 chip
    expect(capabilityWarning('receive', true, mockIdentity)).toBeUndefined();
    expect(capabilityWarning('send', true, undefined)).toBeUndefined();
  });
});


describe('身份策略固定「仅本人」但未登录（二轮复验 P2-4）', () => {
  it('显示「本人身份（未登录）」，不再出现「发送 本人 / 不可接收」的矛盾状态', () => {
    const identity = identityView(
      { policy: 'user', effectiveSend: 'user', effectiveReceive: 'mock' },
      { state: 'not_linked', linked: false, canLink: true, linkMethod: 'cli' },
    );
    render(<AccountCard account={dingtalkAccount(identity, 'mock')} actionsEnabled onDingtalkConnect={() => {}} />);

    const block = screen.getByTestId('identity-block-dingtalk');
    expect(within(block).getByText('本人身份（未登录）')).toBeInTheDocument();
    expect(within(block).getByText(/不会以本人身份收发/)).toBeInTheDocument();
    expect(within(block).queryByRole('button', { name: /^(接收|发送)$/ })).toBeNull();
  });
});

describe('DoctorPanel 一键自检结果（评审 P1-9）', () => {
  const report = {
    generatedAt: '2026-11-22T12:00:00.000Z',
    checks: [
      { group: 'env', id: 'env:feishu', title: '飞书凭据', status: 'PASS' as const, detail: '凭据齐全' },
      {
        group: 'feishu',
        id: 'feishu:send',
        title: '飞书真实发送',
        status: 'FAIL' as const,
        detail: '发送失败：无效的 app_secret',
        hint: '检查 App Secret 后重试',
      },
      { group: 'mail', id: 'mail:imap', title: '邮箱 IMAP', status: 'SKIP' as const, detail: '未配置邮箱账号' },
    ],
  };

  it('三条结论各自配色展示：计数汇总正确，FAIL 的 hint 全量可见', () => {
    render(<DoctorPanel report={report} />);
    expect(screen.getByTestId('doctor-panel')).toBeInTheDocument();
    expect(screen.getByText('1 通过 · 1 失败 · 1 跳过')).toBeInTheDocument();
    expect(screen.getByText('飞书真实发送')).toBeInTheDocument();
    expect(screen.getByText('发送失败：无效的 app_secret')).toBeInTheDocument();
    expect(screen.getByText('检查 App Secret 后重试')).toBeInTheDocument();
    expect(screen.getByText('未配置邮箱账号')).toBeInTheDocument();
    const failRow = screen.getByText('飞书真实发送').closest('.doctor-panel__row');
    expect(failRow).toHaveClass('doctor-panel__row--fail');
  });

  it('空报告：面板可渲染且计数为 0（不崩）', () => {
    render(<DoctorPanel report={{ generatedAt: '2026-11-22T12:00:00.000Z', checks: [] }} />);
    expect(screen.getByText('0 通过 · 0 失败 · 0 跳过')).toBeInTheDocument();
  });
});
