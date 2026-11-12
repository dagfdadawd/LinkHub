import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { PlatformIdentityView, UserIdentityStatus } from '@unimsg/shared';
import { ComposeModal } from './ComposeModal';
import { Platform } from '../../types';
import { services, store } from '../../store';

function setup() {
  const compose = vi.spyOn(store, 'compose').mockResolvedValue('trace-compose-1');
  const onClose = vi.fn();
  render(
    <AntApp>
      <ComposeModal open onClose={onClose} />
    </AntApp>,
  );
  return { compose, onClose };
}

/** 模拟后端 /api/accounts 下发的飞书身份视图（两种身份可用 / 仅一种 / Mock） */
function feishuIdentity(
  patch: Partial<PlatformIdentityView> = {},
  userPatch: Partial<UserIdentityStatus> = {},
): PlatformIdentityView {
  return {
    policy: 'auto',
    effectiveSend: 'user',
    effectiveReceive: 'user',
    user: {
      state: 'linked',
      linked: true,
      displayName: '陈晓',
      hint: '本人身份已连接',
      canLink: true,
      linkMethod: 'oauth',
      ...userPatch,
    },
    botAvailable: true,
    botHint: '机器人凭据齐全',
    receiveHint: '本人身份：飞书用户轮询（20s）',
    sendHint: '本人身份：user_access_token 发送',
    ...patch,
  };
}

function mockFeishuIdentity(identity: PlatformIdentityView) {
  vi.spyOn(services.api, 'accounts').mockResolvedValue([
    {
      platform: Platform.FEISHU,
      label: '飞书',
      configured: true,
      policy: 'auto',
      mode: 'real',
      canReceive: true,
      canSend: true,
      identity,
    },
  ]);
}

async function fillAndSend(conversationId = 'oc_demo_1', text = '请查收周报') {
  fireEvent.change(screen.getByLabelText('目标会话'), { target: { value: conversationId } });
  fireEvent.change(screen.getByLabelText('发送文本'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('compose-send'));
}

afterEach(() => vi.restoreAllMocks());

describe('ComposeModal（统一入口主动发送）', () => {
  it('可选平台/会话，提交文本并走 store.compose', async () => {
    const { compose } = setup();
    expect(screen.getByText('新建发送 · 向指定平台发送消息或文件')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('目标会话'), { target: { value: 'oc_demo_1' } });
    fireEvent.change(screen.getByLabelText('发送文本'), { target: { value: '请查收周报' } });
    expect(screen.getByTestId('compose-send')).toBeEnabled();
    fireEvent.click(screen.getByTestId('compose-send'));

    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).toMatchObject({
      platform: Platform.FEISHU,
      conversationId: 'oc_demo_1',
      text: '请查收周报',
    });
  });

  it('文本与附件都为空时禁止发送', () => {
    setup();
    expect(screen.getByTestId('compose-send')).toBeDisabled();
  });

  it('选邮箱平台时可切换发件邮箱，并随请求提交所选账号', async () => {
    // 测试环境可能指向真实后端；账号列表打桩，避免依赖本机服务
    vi.spyOn(services.api, 'accounts').mockResolvedValue([{
      platform: Platform.MAIL,
      configured: true,
      accounts: [
        { key: 'qq', label: 'QQ邮箱', address: 'me@qq.com', imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', folders: ['INBOX'] },
        { key: '163', label: '163邮箱', address: 'team@163.com', imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', folders: ['INBOX'] },
      ],
    }]);
    const { compose } = setup();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '目标平台' }));
    fireEvent.click(await screen.findByTitle('邮箱'));

    const mailSelect = await screen.findByRole('combobox', { name: '发件邮箱' });
    // 默认选中第一个已配置账号
    await screen.findByText('QQ邮箱（me@qq.com）');

    fireEvent.mouseDown(mailSelect);
    fireEvent.click(await screen.findByTitle('163邮箱（team@163.com）'));

    fireEvent.change(screen.getByLabelText('目标会话'), { target: { value: 'to@example.com' } });
    fireEvent.change(screen.getByLabelText('发送文本'), { target: { value: '请查收发件账号测试' } });
    fireEvent.click(screen.getByTestId('compose-send'));

    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).toMatchObject({
      platform: Platform.MAIL,
      conversationId: 'to@example.com',
      mailAccount: '163',
      text: '请查收发件账号测试',
    });
  });
});

describe('ComposeModal 发送身份（本人 / 机器人）', () => {
  it('两种身份都可用：出现单选并默认跟随后端 effectiveSend（本人），提交 identity=user', async () => {
    mockFeishuIdentity(feishuIdentity());
    const { compose } = setup();

    const userRadio = await screen.findByRole('radio', { name: /本人/ });
    expect(userRadio).toBeChecked();
    expect(screen.getByRole('radio', { name: '机器人' })).not.toBeChecked();
    expect(screen.getByText(/默认跟随后端策略（当前是本人）/)).toBeInTheDocument();

    await fillAndSend();
    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).toMatchObject({
      platform: Platform.FEISHU,
      identity: 'user',
    });
  });

  it('两种身份都可用：可手动改选机器人，提交 identity=bot', async () => {
    mockFeishuIdentity(feishuIdentity());
    const { compose } = setup();

    expect(await screen.findByRole('radio', { name: /本人/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '机器人' }));

    await fillAndSend();
    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).toMatchObject({ identity: 'bot' });
  });

  it('只有机器人可用：不给单选，明确提示「只能以机器人身份发送」并提交 bot', async () => {
    mockFeishuIdentity(
      feishuIdentity(
        { effectiveSend: 'bot', effectiveReceive: 'bot' },
        { state: 'not_linked', linked: false, displayName: undefined, hint: '本人账号未连接，点击账号页连接。' },
      ),
    );
    const { compose } = setup();

    expect(await screen.findByText('机器人发送')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/当前只能以机器人身份发送/)).toBeInTheDocument();

    await fillAndSend();
    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).toMatchObject({ identity: 'bot' });
  });

  it('只有本人可用：不给单选，说明机器人通道不可用并提交 user', async () => {
    mockFeishuIdentity(
      feishuIdentity({ botAvailable: false, botHint: '机器人凭据缺失' }),
    );
    const { compose } = setup();

    expect(await screen.findByText('本人发送')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/当前只能以本人身份发送/)).toBeInTheDocument();
    expect(screen.getByText(/机器人凭据缺失/)).toBeInTheDocument();

    await fillAndSend();
    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).toMatchObject({ identity: 'user' });
  });

  it('平台整体 Mock：标「模拟发送」，不能选身份，提交时不带 identity', async () => {
    mockFeishuIdentity(
      feishuIdentity(
        { effectiveSend: 'mock', effectiveReceive: 'mock' },
        { state: 'unavailable', linked: false, canLink: false },
      ),
    );
    const { compose } = setup();

    expect(await screen.findByText('模拟发送')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/当前平台是演示模式/)).toBeInTheDocument();

    await fillAndSend();
    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
    expect(compose.mock.calls[0][0]).not.toHaveProperty('identity');
  });

  it('NEW-P2-3：本人未连接时，后端「改用 identity=user」建议被替换成去连接的指引', async () => {
    mockFeishuIdentity(
      feishuIdentity(
        { effectiveSend: 'bot', effectiveReceive: 'bot' },
        { state: 'not_linked', linked: false, hint: '本人账号未连接。' },
      ),
    );
    const { compose } = setup();
    compose.mockRejectedValueOnce(
      new Error(
        '飞书机器人当前不可用：缺少 FEISHU_APP_ID / FEISHU_APP_SECRET。请补齐凭据后重试，或改用 identity=user 以本人身份发送',
      ),
    );

    // 等身份块渲染后再发送，确保 identity 已下发（catch 分支据此判断 linked）
    await screen.findByText('机器人发送');
    await fillAndSend();

    expect(
      await screen.findByText(/本人身份未连接，连接后可用本人身份发送/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/改用 identity=user/)).toBeNull();
    // 原始可执行的部分（补齐凭据）保留
    expect(screen.getByText(/请补齐凭据后重试/)).toBeInTheDocument();
  });

  it('NEW-P2-3：本人已连接时保留后端原建议（此时建议可执行）', async () => {
    mockFeishuIdentity(feishuIdentity({ effectiveSend: 'bot', effectiveReceive: 'user' }));
    const { compose } = setup();
    compose.mockRejectedValueOnce(
      new Error('请补齐机器人凭据后重试，或改用 identity=user 以本人身份发送'),
    );

    await screen.findByRole('radio', { name: '机器人' });
    await fillAndSend();

    expect(await screen.findByText(/本人身份发送/)).toBeInTheDocument();
    expect(screen.queryByText(/本人身份未连接，连接后可用本人身份发送/)).toBeNull();
  });
});


