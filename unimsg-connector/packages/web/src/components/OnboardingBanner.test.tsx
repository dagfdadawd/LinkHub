import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OnboardingBanner } from './OnboardingBanner';

describe('OnboardingBanner（白号首启横幅）', () => {
  it('主 CTA 去连接账号 + 次 CTA 先体验演示 + 稍后再说', () => {
    const onOpen = vi.fn();
    const onDemo = vi.fn();
    const onDismiss = vi.fn();
    render(<OnboardingBanner onOpen={onOpen} onDemo={onDemo} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: '去连接账号' }));
    fireEvent.click(screen.getByRole('button', { name: /先体验演示/ }));
    fireEvent.click(screen.getByRole('button', { name: '稍后再说' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDemo).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('按实际状态动态措辞：管理员项与可自助项分开描述', () => {
    render(<OnboardingBanner onOpen={() => {}} onDismiss={() => {}} adminCount={2} selfServiceCount={1} />);
    expect(screen.getByText(/其中 2 项需管理员开通、1 项可自己登录\/添加/)).toBeInTheDocument();
    expect(screen.queryByText(/连接一次即可/)).not.toBeInTheDocument();
  });

  it('没有管理员项时不吓唬客户：写「连接一次即可」', () => {
    render(<OnboardingBanner onOpen={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/连接一次即可/)).toBeInTheDocument();
  });
});
