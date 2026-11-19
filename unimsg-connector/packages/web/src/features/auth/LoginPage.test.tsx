import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { LoginPage } from './LoginPage';
import { getSession, resetSessionForTest } from '../../services/session';

const api = vi.hoisted(() => ({
  register: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  authStatus: vi.fn(),
}));

vi.mock('../../store', () => ({
  services: { api },
  store: { refresh: vi.fn() },
}));

function renderPage() {
  render(
    <AntApp>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </AntApp>,
  );
}

beforeEach(() => {
  resetSessionForTest();
  window.sessionStorage.clear();
  api.register.mockReset();
  api.login.mockReset();
  api.authStatus.mockReset();
  api.authStatus.mockResolvedValue({
    requireLogin: true,
    hasUsers: false,
    registration: { open: true, requireCode: false },
    machineOwner: null,
    user: null,
  });
});

describe('LoginPage 账号闭环入口', () => {
  it('默认是登录态：提交用户名口令后写入会话', async () => {
    api.login.mockResolvedValue({
      user: { id: 'u1', username: 'zhang', displayName: '张三', createdAt: '2026-01-01' },
      token: 'session-token',
    });
    renderPage();

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'zhang' } });
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));
    expect(api.login.mock.calls[0][0]).toEqual({ username: 'zhang', password: 'secret123' });
    await waitFor(() => expect(getSession()?.user.username).toBe('zhang'));
    expect(getSession()?.token).toBe('session-token');
  });

  it('切到注册：带显示名提交，成功后同样是已登录', async () => {
    api.register.mockResolvedValue({
      user: { id: 'u2', username: 'lisi', displayName: '李四', createdAt: '2026-01-01' },
      token: 'session-token-2',
    });
    renderPage();

    fireEvent.click(screen.getByRole('tab', { name: '注册' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'lisi' } });
    fireEvent.change(screen.getByLabelText('显示名（可选）'), { target: { value: '李四' } });
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText('确认口令'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(api.register).toHaveBeenCalledTimes(1));
    expect(api.register.mock.calls[0][0]).toMatchObject({ username: 'lisi', displayName: '李四' });
    await waitFor(() => expect(getSession()?.user.displayName).toBe('李四'));
  });

  it('注册后先显示一次性恢复码，确认后才进收件箱', async () => {
    api.register.mockResolvedValue({
      user: { id: 'u3', username: 'wang', displayName: '王五', createdAt: '2026-01-01' },
      token: 'session-3',
      recoveryCode: 'A1B2-C3D4-E5F6',
    });
    renderPage();

    fireEvent.click(screen.getByRole('tab', { name: '注册' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'wang' } });
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText('确认口令'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByTestId('auth-submit'));

    expect(await screen.findByTestId('recovery-code')).toHaveTextContent('A1B2-C3D4-E5F6');
    // 会话已经建立（注册即登录），但页面停在恢复码上等用户确认
    expect(getSession()?.user.username).toBe('wang');
    fireEvent.click(screen.getByRole('button', { name: /我已保存/ }));
  });

  it('后端拒绝时把原话显示出来，不写入会话', async () => {
    api.login.mockRejectedValue(new Error('用户名或口令不正确'));
    renderPage();

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'zhang' } });
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('auth-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或口令不正确');
    expect(getSession()).toBeNull();
  });
});