/**
 * 飞书 20029 共享帮助面板（账号页 / 授权中心共用）的组件级测试：
 * 只看一件事——用户卡在飞书授权页时，面板有没有直接告诉他「把哪个地址填到哪里」。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { FeishuOAuthHelp } from './FeishuOAuthHelp';
import {
  FEISHU_OAUTH_REDIRECT_URI_FALLBACK,
  FEISHU_OAUTH_UNFINISHED_TITLE,
} from './feishuOAuthFeedback';

const REDIRECT_URI = 'http://localhost:3901/api/feishu/oauth/callback';

function renderHelp(patch: Partial<Parameters<typeof FeishuOAuthHelp>[0]> = {}) {
  const props = {
    unfinished: true,
    onReconnect: vi.fn(),
    onDismiss: vi.fn(),
    ...patch,
  };
  render(
    <AntApp>
      <FeishuOAuthHelp {...props} />
    </AntApp>,
  );
  return props;
}

describe('FeishuOAuthHelp（20029 自解释面板）', () => {
  it('结论先行：标题写 20029，正文写清 安全设置 → 重定向 URL，并列出其余原因', () => {
    renderHelp({ redirectUri: REDIRECT_URI });

    expect(screen.getByText(FEISHU_OAUTH_UNFINISHED_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/打开 飞书开放平台 → 你的应用 → 开发配置 → 安全设置 → 重定向 URL/)).toBeInTheDocument();
    expect(screen.getByTestId('feishu-oauth-unfinished').textContent).toContain('20027');
    expect(screen.getByTestId('feishu-oauth-unfinished').textContent).toContain('offline_access');
    expect(screen.getByTestId('feishu-oauth-unfinished').textContent).toContain('20010');
  });

  it('展示本次真实回调地址 + 复制按钮 + 飞书开放平台入口', () => {
    renderHelp({ redirectUri: REDIRECT_URI });

    expect(screen.getByTestId('feishu-oauth-redirect-uri')).toHaveTextContent(REDIRECT_URI);
    expect(screen.getByRole('button', { name: /复制地址/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /打开飞书开放平台/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新授权/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /我知道了/ })).toBeInTheDocument();
  });

  it('拿不到回调地址：不空白也不编造，换成兜底文案且不出现复制按钮', () => {
    renderHelp();

    expect(screen.getByTestId('feishu-oauth-redirect-uri-fallback')).toHaveTextContent(
      FEISHU_OAUTH_REDIRECT_URI_FALLBACK,
    );
    expect(screen.queryByRole('button', { name: /复制地址/ })).not.toBeInTheDocument();
    // 20029 说明仍在，用户不会看到一块空白
    expect(screen.getByText(FEISHU_OAUTH_UNFINISHED_TITLE)).toBeInTheDocument();
  });

  it('剪贴板不可用：降级为提示手动复制，不假装复制成功', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('denied'); }) },
      configurable: true,
    });
    renderHelp({ redirectUri: REDIRECT_URI });

    fireEvent.click(screen.getByRole('button', { name: /复制地址/ }));
    expect(await screen.findByText(/自动复制失败，请手动选中上面的回调地址复制/)).toBeInTheDocument();
  });

  it('重新授权 / 我知道了按钮回调父级动作', () => {
    const { onReconnect, onDismiss } = renderHelp({ redirectUri: REDIRECT_URI });
    fireEvent.click(screen.getByRole('button', { name: /重新授权/ }));
    fireEvent.click(screen.getByRole('button', { name: /我知道了/ }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('未完成状态为 false 且无弹窗拦截：不渲染任何面板', () => {
    renderHelp({ unfinished: false });
    expect(screen.queryByTestId('feishu-oauth-unfinished')).not.toBeInTheDocument();
    expect(screen.queryByText(FEISHU_OAUTH_UNFINISHED_TITLE)).not.toBeInTheDocument();
  });
});
