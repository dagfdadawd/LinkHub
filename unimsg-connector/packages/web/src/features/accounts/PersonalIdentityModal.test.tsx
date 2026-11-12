import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { PlatformIdentityView, UserIdentityStatus } from '@unimsg/shared';
import { PersonalIdentityModal, DWS_BIN_EXAMPLE, DWS_DOWNLOAD_URL } from './PersonalIdentityModal';
import { store } from '../../store';

function identityView(
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
      hint: '未登录：点「开始登录」用钉钉官方授权页登录本机 dws。',
      canLink: true,
      linkMethod: 'cli',
      loginCommand: 'dws auth login',
      ...userPatch,
    },
    botAvailable: true,
    botHint: '机器人凭据齐全，可继续兜底',
    receiveHint: '个人事件订阅',
    sendHint: '本人发送',
    ...patch,
  };
}

function renderModal(props: Partial<Parameters<typeof PersonalIdentityModal>[0]> = {}) {
  const onClose = vi.fn();
  const onRefresh = vi.fn();
  render(
    <AntApp>
      <PersonalIdentityModal
        open
        identity={identityView()}
        onClose={onClose}
        onRefresh={onRefresh}
        pollIntervalMs={5}
        pollTimeoutMs={500}
        {...props}
      />
    </AntApp>,
  );
  return { onClose, onRefresh };
}

afterEach(() => vi.restoreAllMocks());

describe('PersonalIdentityModal（钉钉本人账号连接引导）', () => {
  it('dws 未安装：展示下载链接、DWS_BIN 写法与「重新检测」，不展示登录按钮', () => {
    const identity = identityView({}, {
      state: 'unavailable',
      canLink: false,
      hint: '未检测到 dws：请先安装 DingTalk Workspace CLI。',
    });
    const { onRefresh } = renderModal({ identity });

    expect(screen.getByText('本机还没有安装 dws（钉钉工作台 CLI）')).toBeInTheDocument();
    expect(screen.getByText(DWS_DOWNLOAD_URL)).toBeInTheDocument();
    expect(screen.getByText(DWS_BIN_EXAMPLE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /开始登录/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重新检测/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('未登录：说明为什么登录 + 开始登录后展示操作指引与设备码，轮询到已登录自动关闭', async () => {
    let authed = false;
    const login = vi.spyOn(store, 'dingtalkPersonalLogin').mockImplementation(async () => {
      authed = true;
      return {
        started: true,
        mode: 'device',
        command: 'dws auth login --device',
        instructions: '请在浏览器打开授权链接并输入设备码完成登录。',
        url: 'https://login.dingtalk.com/device',
        code: 'ABCD-1234',
      };
    });
    const status = vi.spyOn(store, 'dingtalkPersonalStatus').mockImplementation(async () => ({
      available: true,
      authenticated: authed,
      displayName: authed ? '陈晓' : undefined,
      hint: authed ? '已登录' : '未登录',
    }));
    const { onClose, onRefresh } = renderModal();

    // why 文案：普通用户最关心的「不用拉机器人进群」
    expect(screen.getByText(/不用把机器人拉进群/)).toBeInTheDocument();
    expect(screen.getByText(/不接触你的密码/)).toBeInTheDocument();
    expect(screen.getByText('dws auth login')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /开始登录/ }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('请在浏览器打开授权链接并输入设备码完成登录。')).toBeInTheDocument();
    expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
    expect(screen.getByText(/login.dingtalk.com/)).toBeInTheDocument();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onRefresh).toHaveBeenCalled();
    expect(status).toHaveBeenCalled();
  });

  it('自动轮询：用户在终端自己完成登录后，弹窗自动识别并关闭', async () => {
    vi.spyOn(store, 'dingtalkPersonalLogin');
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue({
      available: true,
      authenticated: true,
      displayName: '陈晓',
      hint: '已登录',
    });
    const { onClose, onRefresh } = renderModal();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('轮询超时：提示还没检测到登录，并保留「我已登录，刷新状态」', async () => {
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue({
      available: true,
      authenticated: false,
      hint: '未登录',
    });
    renderModal({ pollTimeoutMs: 60 });

    expect(await screen.findByText('还没有检测到登录', {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /我已登录，刷新状态/ })).toBeInTheDocument();
  });

  it('已连接本人账号：展示 dws 档案名与注销入口，注销后刷新并关闭', async () => {
    const logout = vi.spyOn(store, 'dingtalkPersonalLogout').mockResolvedValue();
    const identity = identityView(
      { effectiveSend: 'user', effectiveReceive: 'user' },
      {
        state: 'linked',
        linked: true,
        displayName: '钉钉 · 陈晓',
        detail: 'dws v1.0.68',
        expiresAt: '2026-12-01T00:00:00.000Z',
        hint: '本人身份已连接。',
      },
    );
    const { onClose, onRefresh } = renderModal({ identity });

    expect(screen.getByText(/已连接本人账号/)).toBeInTheDocument();
    expect(screen.getByText('钉钉 · 陈晓')).toBeInTheDocument();
    expect(screen.getByText(/dws v1\.0\.68/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新登录（换账号）/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /注\s*销/ }));
    await screen.findByText('注销钉钉本人身份？');
    const confirm = await waitFor(() => {
      const el = document.querySelector('.ant-popconfirm');
      if (!el) throw new Error('popconfirm 未渲染');
      return el as HTMLElement;
    });
    fireEvent.click(within(confirm).getByRole('button', { name: /注\s*销/ }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('已连接时点「重新登录」会重新拉起登录流程并展示指引', async () => {
    const login = vi.spyOn(store, 'dingtalkPersonalLogin').mockResolvedValue({
      started: true,
      mode: 'browser',
      command: 'dws auth login',
      instructions: '浏览器已打开钉钉授权页，请完成授权。',
    });
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue({
      available: true,
      authenticated: false,
      hint: '未登录',
    });
    const identity = identityView(
      { effectiveSend: 'user', effectiveReceive: 'user' },
      { state: 'linked', linked: true, displayName: '陈晓', hint: '已连接' },
    );
    renderModal({ identity, pollTimeoutMs: 40 });

    fireEvent.click(screen.getByRole('button', { name: /重新登录（换账号）/ }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/浏览器已打开钉钉授权页/)).toBeInTheDocument();
  });

  it('平台 Mock 模式：明确提示无法登录真实账号，不提供登录按钮', () => {
    renderModal({ mockMode: true });
    expect(screen.getByText(/当前平台通道是 Mock 模拟，无法登录真实钉钉账号/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /开始登录/ })).toBeNull();
  });

  it('后端未返回身份状态：给出刷新按钮，不假装已连接', () => {
    const { onRefresh } = renderModal({ identity: undefined });
    expect(screen.getByText('后端还没有返回钉钉身份状态')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /刷新状态/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});