import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { PlatformIdentityView, UserIdentityStatus } from '@unimsg/shared';
import {
  DINGTALK_SUCCESS_TOAST,
  DWS_BIN_EXAMPLE,
  DWS_DOWNLOAD_URL,
  PersonalIdentityModal,
  activeFromStatus,
  formatCountdown,
  isLoginExpired,
  parseExpiresAt,
} from './PersonalIdentityModal';
import type { DingtalkLoginStart, DingtalkPersonalStatus } from '../../services/api';
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
      hint: '未登录：点下面的登录方式，用钉钉官方授权页登录本机 dws。',
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

function linkedIdentity(): PlatformIdentityView {
  return identityView(
    { effectiveSend: 'user', effectiveReceive: 'user' },
    { state: 'linked', linked: true, displayName: '钉钉 · 陈晓', hint: '本人身份已连接。' },
  );
}

function statusBase(patch: Partial<DingtalkPersonalStatus> = {}): DingtalkPersonalStatus {
  return {
    available: true,
    authenticated: false,
    hint: '未登录',
    loginCommand: 'dws auth login',
    ...patch,
  };
}

function deviceStart(patch: Partial<DingtalkLoginStart> = {}): DingtalkLoginStart {
  return {
    started: true,
    mode: 'device',
    command: 'dws auth login --device',
    instructions: '请打开授权链接并输入下面的授权码完成登录。',
    url: 'https://login.dingtalk.com/oauth2/device',
    code: 'ABCD-1234',
    expiresInSec: 900,
    loginId: 'login-device-1',
    ...patch,
  };
}

function browserStart(patch: Partial<DingtalkLoginStart> = {}): DingtalkLoginStart {
  return {
    started: true,
    mode: 'browser',
    command: 'dws auth login',
    instructions: '浏览器已打开钉钉授权页，请在浏览器里完成登录。',
    url: 'https://login.dingtalk.com/oauth2/auth?redirect_uri=http://127.0.0.1:60520/callback',
    expiresInSec: 900,
    loginId: 'login-browser-1',
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
        pollTimeoutMs={300}
        countdownIntervalMs={20}
        {...props}
      />
    </AntApp>,
  );
  return { onClose, onRefresh };
}

/** fake timers 下推进微任务 + 定时器 */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
    expect(screen.queryByRole('button', { name: /用浏览器登录/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /使用设备码登录/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重新检测/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('未登录：两种方式按钮齐全；浏览器登录 POST {mode:"browser"} 并展示授权链接与兜底提示', async () => {
    const login = vi.spyOn(store, 'dingtalkPersonalLogin').mockResolvedValue(browserStart());
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(statusBase());
    renderModal();

    expect(await screen.findByRole('button', { name: /用浏览器登录（推荐）/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /使用设备码登录（远程\/无浏览器）/ }),
    ).toBeInTheDocument();
    // why 文案：普通用户最关心的「不用拉机器人进群」
    expect(screen.getByText(/不用把机器人拉进群/)).toBeInTheDocument();
    expect(screen.getByText(/不接触你的密码/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /用浏览器登录（推荐）/ }));
    await waitFor(() => expect(login).toHaveBeenCalledWith({ mode: 'browser' }));

    expect(await screen.findByTestId('login-active-browser')).toBeInTheDocument();
    expect(screen.getByText(/已尝试在本机打开浏览器/)).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1 回调/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /直接点这里打开授权链接/ })).toHaveAttribute(
      'href',
      expect.stringContaining('login.dingtalk.com'),
    );
  });

  it('设备码：展示授权码与有效期倒计时，过期后置灰并提供「重新获取授权码」（fake timers）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const login = vi
      .spyOn(store, 'dingtalkPersonalLogin')
      .mockResolvedValueOnce(deviceStart({ expiresInSec: 3 }))
      .mockResolvedValueOnce(deviceStart({ code: 'WXYZ-5678', expiresInSec: 900, loginId: 'login-device-2' }));
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(statusBase());
    renderModal();
    await flush(10);

    fireEvent.click(screen.getByRole('button', { name: /使用设备码登录（远程\/无浏览器）/ }));
    await flush(10);
    expect(login).toHaveBeenCalledWith({ mode: 'device' });

    expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
    expect(screen.getByText(/授权码有效期剩余/)).toBeInTheDocument();

    // 有效期 3 秒，推进 3.5 秒后进入过期态
    await flush(3_500);
    expect(screen.getByText('授权码已过期，请重新获取')).toBeInTheDocument();
    expect(screen.getByText(/登录流程已过期/)).toBeInTheDocument();
    expect(screen.getByText(/不要继续使用旧码/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /重新获取授权码/ }));
    await flush(10);
    await waitFor(() => expect(login).toHaveBeenLastCalledWith({ mode: 'device', force: true }));
    expect(screen.getByText('WXYZ-5678')).toBeInTheDocument();
    // 新码恢复倒计时，不再是过期态
    expect(screen.queryByText('授权码已过期，请重新获取')).toBeNull();
    expect(screen.getByText(/授权码有效期剩余/)).toBeInTheDocument();
  });

  it('打开弹窗从 /status 恢复进行中的设备码登录（不重新生成、不调 login）', async () => {
    const login = vi.spyOn(store, 'dingtalkPersonalLogin');
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(
      statusBase({
        loginInProgress: true,
        loginMode: 'device',
        loginUrl: 'https://login.dingtalk.com/oauth2/device',
        loginCode: 'REST-0001',
        loginInstructions: '请继续完成上一次设备码登录。',
        loginExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    );
    renderModal();

    expect(await screen.findByText('REST-0001')).toBeInTheDocument();
    expect(screen.getByText(/请继续完成上一次设备码登录/)).toBeInTheDocument();
    expect(screen.getByText(/授权码有效期剩余/)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('恢复时 loginCode 为空：给出「刷新状态 / 重新获取」而不是空白', async () => {
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(
      statusBase({
        loginInProgress: true,
        loginMode: 'device',
        loginUrl: 'https://login.dingtalk.com/oauth2/device',
        loginExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    renderModal();

    expect(await screen.findByText('没有拿到设备码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /我已登录，刷新状态/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新获取授权码/ })).toBeInTheDocument();
  });

  it('授权成功（status.authenticated）：自动关闭 + 刷新账号页 + 统一 toast', async () => {
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(
      statusBase({ authenticated: true, displayName: '陈晓' }),
    );
    const { onClose, onRefresh } = renderModal();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onRefresh).toHaveBeenCalled();
    expect(await screen.findByText(DINGTALK_SUCCESS_TOAST)).toBeInTheDocument();
  });

  it('授权链接被浏览器拦截：展示可点击链接与提示，不静默失败', async () => {
    vi.spyOn(store, 'dingtalkPersonalLogin').mockResolvedValue(browserStart());
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(statusBase());
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: /用浏览器登录（推荐）/ }));
    expect(await screen.findByTestId('login-active-browser')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('open-auth-url'));
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('login.dingtalk.com'),
      '_blank',
      'noopener',
    );
    expect(await screen.findByText('浏览器拦截了弹窗')).toBeInTheDocument();
    // 原生链接始终可见，被拦截也能继续
    expect(screen.getByRole('link', { name: /直接点这里打开授权链接/ })).toBeInTheDocument();
  });

  it('浏览器模式可改用设备码（force 重新发起）', async () => {
    const login = vi
      .spyOn(store, 'dingtalkPersonalLogin')
      .mockResolvedValueOnce(browserStart())
      .mockResolvedValueOnce(deviceStart({ loginId: 'login-device-switch' }));
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(statusBase());
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: /用浏览器登录（推荐）/ }));
    expect(await screen.findByTestId('login-active-browser')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /改用设备码登录/ }));

    await waitFor(() => expect(login).toHaveBeenLastCalledWith({ mode: 'device', force: true }));
    expect(await screen.findByTestId('login-active-device')).toBeInTheDocument();
    expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
  });

  it('自动轮询：用户在浏览器 / 终端完成登录后，弹窗自动识别并关闭', async () => {
    let authed = false;
    vi.spyOn(store, 'dingtalkPersonalStatus').mockImplementation(async () =>
      statusBase({ authenticated: authed, displayName: authed ? '陈晓' : undefined }),
    );
    const { onClose, onRefresh } = renderModal({ pollTimeoutMs: 2_000 });
    authed = true;

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('轮询超时：提示还没检测到登录，并保留「我已登录，刷新状态」', async () => {
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(statusBase());
    renderModal({ pollTimeoutMs: 60 });

    expect(await screen.findByText('还没有检测到登录', {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /我已登录，刷新状态/ })).toBeInTheDocument();
  });

  it('已连接本人账号：展示 dws 档案名与注销入口，注销后刷新并关闭', async () => {
    const logout = vi.spyOn(store, 'dingtalkPersonalLogout').mockResolvedValue();
    const identity = linkedIdentity();
    const { onClose, onRefresh } = renderModal({ identity });

    expect(screen.getByText(/已连接本人账号/)).toBeInTheDocument();
    expect(screen.getByText('钉钉 · 陈晓')).toBeInTheDocument();
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

  it('已连接时点「重新登录」先出现两种登录方式，再选浏览器登录', async () => {
    const login = vi.spyOn(store, 'dingtalkPersonalLogin').mockResolvedValue(browserStart());
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(
      statusBase({ authenticated: true, displayName: '陈晓' }),
    );
    renderModal({ identity: linkedIdentity() });

    fireEvent.click(screen.getByRole('button', { name: /重新登录（换账号）/ }));
    expect(await screen.findByRole('button', { name: /用浏览器登录（推荐）/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /用浏览器登录（推荐）/ }));
    await waitFor(() => expect(login).toHaveBeenCalledWith({ mode: 'browser' }));
  });

  it('启动失败（started=false）：不假装在等待，展示可操作提示（可重试 / 终端命令）', async () => {
    vi.spyOn(store, 'dingtalkPersonalLogin').mockResolvedValue(
      browserStart({
        started: false,
        instructions: '当前 dws 版本不支持该登录方式，请在本机终端执行 dws auth login 完成浏览器授权。',
      }),
    );
    vi.spyOn(store, 'dingtalkPersonalStatus').mockResolvedValue(statusBase());
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: /用浏览器登录（推荐）/ }));

    expect(await screen.findByText('拉起登录失败')).toBeInTheDocument();
    expect(screen.getByText(/当前 dws 版本不支持该登录方式/)).toBeInTheDocument();
  });

  it('平台 Mock 模式：明确提示无法登录真实账号，不提供登录按钮', () => {
    renderModal({ mockMode: true });
    expect(screen.getByText(/当前平台通道是 Mock 模拟，无法登录真实钉钉账号/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /用浏览器登录/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /使用设备码登录/ })).toBeNull();
  });

  it('后端未返回身份状态：给出刷新按钮，不假装已连接', () => {
    const { onRefresh } = renderModal({ identity: undefined });
    expect(screen.getByText('后端还没有返回钉钉身份状态')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /刷新状态/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('钉钉登录状态工具函数', () => {
  const NOW = 1_800_000_000_000;

  it('parseExpiresAt：优先 expiresAt，其次 expiresInSec；非法值不返回', () => {
    expect(parseExpiresAt({ expiresAt: '2026-11-12T10:00:00.000Z' }, NOW)).toBe(
      Date.parse('2026-11-12T10:00:00.000Z'),
    );
    expect(parseExpiresAt({ expiresInSec: 30 }, NOW)).toBe(NOW + 30_000);
    expect(parseExpiresAt({ expiresAt: 'not-a-date', expiresInSec: 30 }, NOW)).toBe(NOW + 30_000);
    expect(parseExpiresAt({}, NOW)).toBeUndefined();
    expect(parseExpiresAt({ expiresInSec: 0 }, NOW)).toBeUndefined();
  });

  it('formatCountdown：m:ss（向上取整，不显示负值）', () => {
    expect(formatCountdown(900_000)).toBe('15:00');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(500)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5_000)).toBe('0:00');
  });

  it('isLoginExpired：无有效期时永不过期', () => {
    expect(isLoginExpired(undefined, NOW)).toBe(false);
    expect(isLoginExpired(NOW + 1, NOW)).toBe(false);
    expect(isLoginExpired(NOW, NOW)).toBe(true);
    expect(isLoginExpired(NOW - 1, NOW)).toBe(true);
  });

  it('activeFromStatus：不在登录中返回 undefined；按 loginMode/code 恢复字段', () => {
    expect(activeFromStatus(statusBase({ loginInProgress: false }))).toBeUndefined();
    const device = activeFromStatus(
      statusBase({
        loginInProgress: true,
        loginMode: 'device',
        loginUrl: 'https://login.dingtalk.com/device',
        loginCode: 'CODE-1',
        loginInstructions: '继续授权',
        loginExpiresAt: new Date(NOW + 60_000).toISOString(),
      }),
      NOW,
    );
    expect(device).toMatchObject({
      mode: 'device',
      url: 'https://login.dingtalk.com/device',
      code: 'CODE-1',
      instructions: '继续授权',
      expiresAt: NOW + 60_000,
    });

    const browser = activeFromStatus(
      statusBase({ loginInProgress: true, loginMode: 'browser', loginUrl: 'https://login.example' }),
      NOW,
    );
    expect(browser).toMatchObject({ mode: 'browser', url: 'https://login.example' });
    expect(browser?.expiresAt).toBeUndefined();

    // 后端只给 loginExpiresInSec（按后端时钟算好）时也能恢复倒计时
    const bySeconds = activeFromStatus(
      statusBase({
        loginInProgress: true,
        loginMode: 'device',
        loginCode: 'CODE-2',
        loginExpiresInSec: 120,
      }),
      NOW,
    );
    expect(bySeconds?.expiresAt).toBe(NOW + 120_000);
  });
});
