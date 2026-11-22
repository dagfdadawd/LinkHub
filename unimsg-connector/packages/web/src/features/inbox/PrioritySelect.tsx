/**
 * 优先级选择器：显示当前优先级，点开可人工改。
 *
 * 设计取舍：AI / 规则只给默认值，人工随时能改；改动由后端写一条
 * `priority` 闭环事件（old→new），形成可举证的反馈样本。
 * 没有判定时显示「未判定」而不是假装「普通」——界面上不编造 AI 结论。
 *
 * 作用对象是「会话里未完成入站消息中最紧急的一条」（见 `priorityTargetOf`），
 * 不是用户碰巧点开的那条历史消息：改完必须能在会话列表看到红色「紧急」徽标
 * 并且置顶，否则这个按钮就只是摆设。
 */
import { App as AntApp, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { FlagOutlined } from '@ant-design/icons';
import { PRIORITY_LABELS } from '../../types';
import type { Priority, UnifiedMessage } from '../../types';
import { store } from '../../store';

const ORDER: Priority[] = ['urgent', 'normal', 'low'];

/** 改完之后会发生什么：按钮不能「点了没反应」，效果要当场说清 */
const EFFECT_HINT: Record<Priority, string> = {
  urgent: '已标记为「紧急」：该会话置顶并显示红色徽标，同时进入「紧急」筛选',
  normal: '已标记为「普通」：会话不再置顶，也不再进入「紧急」筛选',
  low: '已标记为「不急」：显示灰色「不急」标记，不再进入「紧急」筛选',
};

export function PrioritySelect({ message }: { message: UnifiedMessage }) {
  const { message: toast } = AntApp.useApp();

  async function change(next: Priority): Promise<void> {
    if (next === message.priority) return;
    try {
      const result = await store.setPriority(message.traceId, next);
      toast.success(EFFECT_HINT[result.message.priority ?? next]);
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
        aria-label="修改会话优先级"
        data-testid="priority-select"
        title={
          message.prioritySource === 'manual'
            ? '人工设定的会话优先级（点击修改）'
            : '会话优先级（取未完成消息里最紧急的一条，点击修改）'
        }
      >
        <FlagOutlined aria-hidden="true" />
        {message.priority ? PRIORITY_LABELS[message.priority] : '未判定'}
      </button>
    </Dropdown>
  );
}
