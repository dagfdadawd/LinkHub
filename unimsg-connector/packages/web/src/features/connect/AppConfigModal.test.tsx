import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { AppConfigView } from '../../services/api';

const hoisted = vi.hoisted(() => ({
  store: {
    loadAppConfig: vi.fn(),
    saveAppConfig: vi.fn(),
    refreshHealth: vi.fn(async () => {}),
  },
}));

vi.mock('../../hooks/useAppState', () => ({
  useAppState: () => ({
    demoMode: false,
    accounts: [],
    health: null,
    error: null,
    connection: 'connected',
    messages: [],
    onboarding: null,
  }),
}));
vi.mock('../../store', () => ({ store: hoisted.store }));

import { AppConfigModal } from './AppConfigModal';

function config(patch: Partial<AppConfigView> = {}): AppConfigView {
  return {
    identity: { dingtalk: 'auto' },
    platforms: {
      feishu: {
        fields: {
          appId: { configured: true, display: 'cli_****abcd', source: 'env', key: 'FEISHU_APP_ID' },
          appSecret: { configured: true, display: '已配置', source: 'env', key: 'FEISHU_APP_SECRET' },
          verifyToken: { configured: false, source: 'none', key: 'FEISHU_VERIFY_TOKEN' },
          encryptKey: { configured: false, source: 'none', key: 'FEISHU_ENCRYPT_KEY' },
        },
        missing: [],
      },
      dingtalk: {
        fields: {
          clientId: { configured: false, source: 'none', key: 'DINGTALK_CLIENT_ID' },
          clientSecret: { configured: false, source: 'none', key: 'DINGTALK_CLIENT_SECRET' },
        },
        missing: ['DINGTALK_CLIENT_ID'],
      },
      wecom: { fields: {}, missing: [] },
    },
    llm: {
      provider: { configured: false, source: 'none', key: 'LLM_PROVIDER' },
    },
    restartRequired: false,
    envFile: { path: '.env', mtime: '2026-11-12T10:00:00.000Z' },
    settingsFile: null,
    ...patch,
  };
}

function renderModal() {
  const onSaved = vi.fn();
  render(
    <AntApp>
      <AppConfigModal open initialGroup="feishu" onClose={() => {}} onSaved={onSaved} />
    </AntApp>,
  );
  return { onSaved };
}

async function openDingtalkTab() {
  fireEvent.click(await screen.findByRole('tab', { name: '钉钉' }));
}

beforeEach(() => {
  hoisted.store.loadAppConfig.mockResolvedValue(config());
  hoisted.store.saveAppConfig.mockResolvedValue({
    saved: true,
    restartRequired: true,
    changedKeys: ['platforms.feishu.appId'],
  });
});

afterEach(() => vi.restoreAllMocks());

describe('AppConfigModal（平台应用配置，白号 P0-1）', () => {
  it('字段分组与脱敏展示：.env 来源不可覆盖，secret 输入框为空且为 password', async () => {
    renderModal();

    expect(await screen.findByLabelText('App ID')).toBeInTheDocument();
    expect(screen.getAllByText('由部署配置固定（不可覆盖）').length).toBeGreaterThan(0);
    expect(screen.getByText('当前：cli_****abcd')).toBeInTheDocument();
    // env 已配置的字段锁定，不能在界面覆盖运维配置
    expect(screen.getByLabelText('App ID')).toBeDisabled();
    // secret 不回显明文，输入框是 password 且留空
    const secret = screen.getByLabelText('App Secret');
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveValue('');
  });

  it('保存应用凭据：PUT 只带填写的字段；需要重启时显示常驻重启提示，重检后提示已生效', async () => {
    hoisted.store.loadAppConfig.mockResolvedValue(config());
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: true,
      restartRequired: true,
      changedKeys: ['platforms.dingtalk.clientId'],
    });
    renderModal();
    await openDingtalkTab();

    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'ding-123' } });
    fireEvent.change(screen.getByLabelText('Client Secret'), { target: { value: 'secret-456' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(hoisted.store.saveAppConfig).toHaveBeenCalledTimes(1));
    expect(hoisted.store.saveAppConfig).toHaveBeenCalledWith({
      platforms: { dingtalk: { clientId: 'ding-123', clientSecret: 'secret-456' } },
    });
    expect((await screen.findAllByText(/需要重启 LinkHub 生效/)).length).toBeGreaterThan(0);

    // 模拟「已重启」：再拉配置时 restartRequired=false
    hoisted.store.loadAppConfig.mockResolvedValue(config());
    fireEvent.click(screen.getByRole('button', { name: /我已重启，重新检测/ }));
    expect(await screen.findByText('配置已生效', {}, { timeout: 5000 })).toBeInTheDocument();
  }, 15000);

  it('钉钉「仅用本人身份」：保存 identity=user，热应用成功后提示「无需重启」', async () => {
    hoisted.store.loadAppConfig.mockResolvedValue(
      config({
        platforms: {
          feishu: { fields: {}, missing: [] },
          dingtalk: { fields: {}, missing: [] },
          wecom: { fields: {}, missing: [] },
        },
      }),
    );
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: true,
      restartRequired: false,
      hotApplied: true,
      changedKeys: ['identity.dingtalk'],
    });
    renderModal();
    await openDingtalkTab();

    fireEvent.click(screen.getByTestId('app-config-personal-switch'));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() =>
      expect(hoisted.store.saveAppConfig).toHaveBeenCalledWith({ identity: { dingtalk: 'user' } }),
    );
    expect(await screen.findByText(/已立即生效（无需重启）/)).toBeInTheDocument();
    expect(screen.queryByText(/需要重启 LinkHub 生效/)).not.toBeInTheDocument();
  });

  it('成对校验：只填 App ID 不填 App Secret 时给中文错误且不保存', async () => {
    hoisted.store.loadAppConfig.mockResolvedValue(
      config({
        platforms: {
          feishu: { fields: {}, missing: [] },
          dingtalk: { fields: {}, missing: [] },
          wecom: { fields: {}, missing: [] },
        },
      }),
    );
    renderModal();

    fireEvent.change(await screen.findByLabelText('App ID'), { target: { value: 'cli_new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    expect((await screen.findAllByText(/需要成对填写/)).length).toBeGreaterThan(0);
    expect(hoisted.store.saveAppConfig).not.toHaveBeenCalled();
  });

  it('ignoredByEnv：展示「来自 .env 未被覆盖」提示', async () => {
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: true,
      restartRequired: true,
      changedKeys: [],
      ignoredByEnv: ['FEISHU_APP_ID'],
    });
    renderModal();
    await openDingtalkTab();
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'ding-1' } });
    fireEvent.change(screen.getByLabelText('Client Secret'), { target: { value: 'secret-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    expect(await screen.findByText(/部分配置来自 .env，未被本次保存覆盖/)).toBeInTheDocument();
  });
});

describe('AppConfigModal 保存结果判定（二轮审计 P1-2）', () => {
  it('saved:false + ignoredByEnv：不得提示成功，明确列出 .env 锁定的键', async () => {
    hoisted.store.loadAppConfig.mockResolvedValue(config());
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: false,
      restartRequired: false,
      hotApplied: false,
      ignoredByEnv: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'],
      changedKeys: ['platforms.dingtalk.clientId'],
    });
    renderModal();
    await openDingtalkTab();
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'ding-1' } });
    fireEvent.change(screen.getByLabelText('Client Secret'), { target: { value: 'secret-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    expect(
      (await screen.findAllByText(/以下配置来自 \.env，页面不能覆盖：钉钉 Client ID/)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/已保存并立即生效/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已立即生效/)).not.toBeInTheDocument();
  });

  it('identity-only 但 hotApplied:false：提示「未生效」，不出现成功文案', async () => {
    hoisted.store.loadAppConfig.mockResolvedValue(config());
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: true,
      restartRequired: false,
      hotApplied: false,
      changedKeys: ['identity.dingtalk'],
    });
    renderModal();
    await openDingtalkTab();
    fireEvent.click(screen.getByTestId('app-config-personal-switch'));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    expect(await screen.findByText(/身份模式未生效/)).toBeInTheDocument();
    expect(screen.queryByText(/已立即生效（无需重启）/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已保存并立即生效/)).not.toBeInTheDocument();
  });

  it('stream 开关：默认开启，关闭后按布尔值保存（不是字符串）', async () => {
    hoisted.store.loadAppConfig.mockResolvedValue(
      config({
        platforms: {
          feishu: { fields: {}, missing: [] },
          dingtalk: { fields: {}, missing: [] },
          wecom: { fields: {}, missing: [] },
        },
      }),
    );
    hoisted.store.saveAppConfig.mockResolvedValue({
      saved: true,
      restartRequired: true,
      changedKeys: ['platforms.dingtalk.stream'],
    });
    renderModal();
    await openDingtalkTab();
    // source=none 时默认开启长连接；点一下关闭，提交必须是布尔 false
    fireEvent.click(screen.getByRole('switch', { name: '使用长连接（Stream）' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() =>
      expect(hoisted.store.saveAppConfig).toHaveBeenCalledWith({
        platforms: { dingtalk: { stream: false } },
      }),
    );
  });
});

