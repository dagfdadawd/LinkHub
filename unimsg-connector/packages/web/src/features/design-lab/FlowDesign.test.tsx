/**
 * 「查看全部」弹窗接线测试。
 *
 * 入口在消息卡片底部，点开必须真的出现一个可筛选、可点选的窗口；
 * 旧行为只是弹一条「所有消息已加载」的 toast，等于假入口。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FlowDesign } from './FlowDesign';
import { useDesignWorkspace } from './model';

function Harness() {
  const workspace = useDesignWorkspace();
  return <FlowDesign workspace={workspace} />;
}

async function openAllMessages() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: /查看全部/ }));
  const dialog = screen.getByRole('dialog', { name: '全部消息' });
  return { user, dialog };
}

const rowsOf = (dialog: HTMLElement) => within(dialog).getAllByRole('button', { name: /^打开消息：/ });
const chips = (dialog: HTMLElement) => within(within(dialog).getByRole('group', { name: '按渠道筛选' }));

describe('浮光 · 查看全部弹窗', () => {
  it('点「查看全部」打开窗口，列出全部消息', async () => {
    const { dialog } = await openAllMessages();
    expect(within(dialog).getByText(/四个渠道/)).toBeInTheDocument();
    expect(rowsOf(dialog)).toHaveLength(6);
    expect(within(dialog).getByText('林晓然')).toBeInTheDocument();
    expect(within(dialog).getByText('ArchDaily')).toBeInTheDocument();
  });

  it('按渠道筛选只保留该平台的消息', async () => {
    const { user, dialog } = await openAllMessages();
    await user.click(chips(dialog).getByRole('button', { name: /钉钉/ }));
    expect(rowsOf(dialog)).toHaveLength(1);
    expect(within(dialog).getByText('陈墨')).toBeInTheDocument();
  });

  it('搜索发送人后只剩匹配项，清空筛选可恢复', async () => {
    const { user, dialog } = await openAllMessages();
    const search = within(dialog).getByRole('textbox', { name: '搜索全部消息' });
    await user.type(search, '周奕');
    expect(rowsOf(dialog)).toHaveLength(1);
    expect(within(dialog).getByText('周奕')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '不存在的关键词');
    expect(within(dialog).getByText('没有找到相关消息')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '清空筛选' }));
    expect(rowsOf(dialog)).toHaveLength(6);
  });

  it('点一条消息后关闭窗口并切换到该消息详情', async () => {
    const { user, dialog } = await openAllMessages();
    await user.click(within(dialog).getByRole('button', { name: /打开消息：周奕/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Q4_联合活动方案_Final\.pdf/)).toBeInTheDocument();
  });

  it('点关闭按钮 / 按 Esc 都能关掉窗口', async () => {
    const { user, dialog } = await openAllMessages();
    await user.click(within(dialog).getByRole('button', { name: '关闭全部消息窗口' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /查看全部/ }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('重新打开时回到「全部渠道 + 空搜索」，不残留上次筛选', async () => {
    const { user, dialog } = await openAllMessages();
    await user.click(chips(dialog).getByRole('button', { name: /邮箱/ }));
    expect(rowsOf(dialog)).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: '关闭全部消息窗口' }));

    await user.click(screen.getByRole('button', { name: /查看全部/ }));
    const reopened = screen.getByRole('dialog', { name: '全部消息' });
    expect(rowsOf(reopened)).toHaveLength(6);
  });
});