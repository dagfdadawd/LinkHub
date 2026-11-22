/**
 * 状态流转操作条：只展示「能前进的下一步」，并可选同时给对方发回执。
 *
 * 为什么默认不发回执：状态首先是处理人自己的进度记录；系统消息发多了
 * 会把真实对话顶出视野。需要对方知道进度时，由用户显式勾选。
 */
import { useState } from 'react';
import { App as AntApp, Button, Checkbox, Tooltip } from 'antd';
import { MsgStatus } from '../../types';
import type { UnifiedMessage } from '../../types';
import { store } from '../../store';

/** 只允许前进；failed 是失败旁路，可作为重试起点回到 processing */
const NEXT: Partial<Record<MsgStatus, MsgStatus[]>> = {
  [MsgStatus.RECEIVED]: [MsgStatus.PROCESSING],
  [MsgStatus.PROCESSING]: [MsgStatus.REPLIED],
  [MsgStatus.REPLIED]: [MsgStatus.SENT],
  [MsgStatus.SENT]: [MsgStatus.SYNCED],
  [MsgStatus.FAILED]: [MsgStatus.PROCESSING],
};

const LABEL: Record<string, string> = {
  [MsgStatus.PROCESSING]: '标记处理中',
  [MsgStatus.REPLIED]: '标记已回复',
  [MsgStatus.SENT]: '标记已发送',
  [MsgStatus.SYNCED]: '标记已同步',
};

export function StatusActions({ message }: { message: UnifiedMessage }) {
  const { message: toast } = AntApp.useApp();
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);

  const nexts = NEXT[message.status] ?? [];
  if (nexts.length === 0) return null;

  async function go(next: MsgStatus): Promise<void> {
    setBusy(true);
    try {
      const result = await store.changeStatus(message.traceId, { status: next, notify });
      // 回执是「这一次」的显式选择：用完即复位，避免下次流转无意中又带上回执
      setNotify(false);
      if (result.notified) {
        toast.success(
          result.notifyMode === 'mock'
            ? '状态已更新，回执已模拟发出（本地 Mock）'
            : '状态已更新，回执已发到原平台',
        );
      } else if (result.notifyReason) {
        toast.warning(`状态已更新，但回执未发出：${result.notifyReason}`);
      } else {
        toast.success('状态已更新');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '状态更新失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="status-actions" data-testid="status-actions">
      <span className="status-actions__label">处理状态</span>
      {nexts.map((next) => (
        <Button key={next} size="small" loading={busy} onClick={() => void go(next)}>
          {LABEL[next] ?? next}
        </Button>
      ))}
      <Tooltip title="勾选后，这次状态变更会作为一条系统消息发回原平台会话">
        <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)}>
          同时给对方发回执
        </Checkbox>
      </Tooltip>
    </div>
  );
}
