/**
 * 优先级选择器：显示当前优先级，点开可人工改。
 *
 * 设计取舍：AI / 规则只给默认值，人工随时能改；改动由后端写一条
 * `priority` 闭环事件（old→new），形成可举证的反馈样本。
 * 没有判定时显示「未判定」而不是假装「普通」——界面上不编造 AI 结论。
 */
import { App as AntApp, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { FlagOutlined } from '@ant-design/icons';
import { PRIORITY_LABELS } from '../../types';
import type { Priority, UnifiedMessage } from '../../types';
import { store } from '../../store';

const ORDER: Priority[] = ['urgent', 'normal', 'low'];

export function PrioritySelect({ message }: { message: UnifiedMessage }) {
  const { message: toast } = AntApp.useApp();

  async function change(next: Priority): Promise<void> {
    if (next === message.priority) return;
    try {
      const result = await store.setPriority(message.traceId, next);
      toast.success(`优先级已改为「${PRIORITY_LABELS[result.message.priority ?? next]}」`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '优先级修改失败，请重试');
    }
  }

  const items: MenuProps['items'] = ORDER.map((p) => ({
    key: p,
    label: `${PRIORITY_LABELS[p]}${p === message.priority ? '（当前）' : ''}`,
    disabled: p === message.priority,
  }));

  return (
    <Dropdown
      menu={{ items, onClick: ({ key }) => void change(key as Priority) }}
      trigger={['click']}
      placement="bottomLeft"
    >
      <button
        type="button"
        className={`chip chip--priority${message.priority ? ` chip--priority-${message.priority}` : ''}`}
        aria-label="修改优先级"
        data-testid="priority-select"
        title={message.prioritySource === 'manual' ? '人工设定' : '点击修改优先级'}
      >
        <FlagOutlined aria-hidden="true" />
        {message.priority ? PRIORITY_LABELS[message.priority] : '未判定'}
      </button>
    </Dropdown>
  );
}
