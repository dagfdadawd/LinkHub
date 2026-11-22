/**
 * 跨平台转发弹窗：把当前消息推到另一个平台的目标会话。
 *
 * 后端复用 compose 的完整出站链路（限流 / 退避 / trace / 状态回流），
 * 这里只负责收集目标与说明；目标会话留空时由后端沿用该平台最近的会话。
 */
import { useEffect, useState } from 'react';
import { App as AntApp, Form, Input, Modal, Select } from 'antd';
import { PLATFORM_META, platformMeta } from '../../utils/format';
import { Platform } from '../../types';
import type { UnifiedMessage } from '../../types';
import { store } from '../../store';

export interface ForwardModalProps {
  message: UnifiedMessage;
  open: boolean;
  onClose: () => void;
}

export function ForwardModal({ message, open, onClose }: ForwardModalProps) {
  const { message: toast } = AntApp.useApp();
  const [form] = Form.useForm<{
    platform: Platform;
    conversationId?: string;
    note?: string;
  }>();
  const [busy, setBusy] = useState(false);

  // 默认选一个与来源不同的平台：转发到同平台没有意义
  const defaultTarget = Object.values(Platform).find((p) => p !== message.platform) ?? Platform.FEISHU;

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ platform: defaultTarget, conversationId: '', note: '' });
    }
  }, [open, defaultTarget, form]);

  async function submit(): Promise<void> {
    let values: { platform: Platform; conversationId?: string; note?: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      const ack = await store.forward(message.traceId, {
        platform: values.platform,
        ...(values.conversationId?.trim() ? { conversationId: values.conversationId.trim() } : {}),
        ...(values.note?.trim() ? { note: values.note.trim() } : {}),
      });
      toast.success(`已转发到${PLATFORM_META[values.platform].name}（traceId ${ack.message.traceId.slice(0, 8)}…）`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '转发失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="转发到其他平台"
      okText="转发"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <p className="forward-modal__hint">
        正文会带上「[转发自 {platformMeta(message.platform).name}]」标记，原消息不受影响。
      </p>
      <Form form={form} layout="vertical" className="forward-form" preserve={false}>
        <Form.Item
          name="platform"
          label="目标平台"
          rules={[{ required: true, message: '请选择目标平台' }]}
        >
          <Select
            options={Object.values(Platform).map((p) => ({
              value: p,
              label: PLATFORM_META[p].name,
              disabled: p === message.platform,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="conversationId"
          label="目标会话（选填）"
          extra="留空则沿用该平台最近的会话；邮箱请填收件人地址。"
        >
          <Input placeholder="例如 ou_xxx / 群 ID / someone@example.com" allowClear />
        </Form.Item>
        <Form.Item name="note" label="附加说明（选填）">
          <Input.TextArea rows={2} maxLength={200} showCount placeholder="放在转发正文最前面的一句话" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
