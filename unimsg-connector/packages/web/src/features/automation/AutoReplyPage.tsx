/**
 * 自动回复规则管理。
 *
 * 规则只做「关键词 + 平台」两件事，刻意不用正则/语义匹配：
 * 答辩现场要能一句话解释清楚「客户说『在吗』就自动回『在的，请说』」。
 * 命中后走与人工回复完全相同的回写链路（限流 / 重试 / trace / 状态回流）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch,
  Table, Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import { Platform } from '../../types';
import type { AutoRule, AutoRuleInput } from '../../types';
import { PLATFORM_META, formatDateTime, platformMeta } from '../../utils/format';
import { store } from '../../store';

export function AutoReplyPage() {
  const { message: toast } = AntApp.useApp();
  const [rules, setRules] = useState<AutoRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AutoRule | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<AutoRuleInput>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await store.refreshAutoRules());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '规则加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate(): void {
    form.setFieldsValue({ platform: undefined, keyword: '', replyText: '', priority: 100, enabled: true });
    setEditing('new');
  }

  function openEdit(rule: AutoRule): void {
    form.setFieldsValue({
      platform: rule.platform,
      keyword: rule.keyword ?? '',
      replyText: rule.replyText,
      priority: rule.priority,
      enabled: rule.enabled,
    });
    setEditing(rule);
  }

  async function submit(): Promise<void> {
    let values: AutoRuleInput;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const input: AutoRuleInput = {
      // 平台/关键词总是显式提交：服务端按「key 是否出现」判断部分更新，
      // omit 会让「改成所有平台 / 改成兜底规则」静默失败（旧值原样保留）。
      // null / 空串在服务端 = 清空（normalizePlatform(null)→未设置、keyword 空→兜底）。
      platform: values.platform ?? null,
      keyword: values.keyword?.trim() ?? '',
      replyText: values.replyText.trim(),
      // InputNumber 清空时值是 null：Number(null)=0 会把规则顶到最高优先级，必须排除
      ...(values.priority != null ? { priority: Number(values.priority) } : {}),
      enabled: values.enabled ?? true,
    };
    setSaving(true);
    try {
      if (editing === 'new') await store.createAutoRule(input);
      else if (editing) await store.updateAutoRule(editing.id, input);
      toast.success(editing === 'new' ? '规则已创建' : '规则已更新');
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(rule: AutoRule, enabled: boolean): Promise<void> {
    try {
      await store.updateAutoRule(rule.id, { enabled });
      setRules((list) => list.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '切换失败，请重试');
    }
  }

  async function remove(rule: AutoRule): Promise<void> {
    try {
      await store.deleteAutoRule(rule.id);
      toast.success('规则已删除');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败，请重试');
    }
  }

  const columns: ColumnsType<AutoRule> = [
    {
      title: '平台',
      dataIndex: 'platform',
      width: 110,
      render: (p?: Platform) => (p ? <Tag>{platformMeta(p).name}</Tag> : <Tag>全部平台</Tag>),
    },
    {
      title: '关键词',
      dataIndex: 'keyword',
      width: 160,
      render: (kw?: string) => (kw ? <span className="mono">{kw}</span> : <span className="auto-reply-page__hint">（兜底：该平台任意消息）</span>),
    },
    { title: '回复内容', dataIndex: 'replyText', ellipsis: true },
    { title: '优先级', dataIndex: 'priority', width: 90 },
    {
      title: '命中',
      dataIndex: 'hitCount',
      width: 150,
      render: (hits: number, rule) => (
        <span>
          {hits} 次
          {rule.lastHitAt && <span className="auto-reply-page__hint"> · {formatDateTime(rule.lastHitAt)}</span>}
        </span>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (enabled: boolean, rule) => (
        <Switch size="small" checked={enabled} onChange={(v) => void toggle(rule, v)} aria-label="启用规则" />
      ),
    },
    {
      title: '操作',
      width: 140,
      render: (_, rule) => (
        <Space size="small">
          <Button size="small" type="link" onClick={() => openEdit(rule)}>编辑</Button>
          <Popconfirm title="删除这条规则？" okText="删除" cancelText="取消" onConfirm={() => void remove(rule)}>
            <Button size="small" type="link" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="page auto-reply-page">
      <div className="page__head">
        <div>
          <h1 className="page__title">自动回复</h1>
          <p className="auto-reply-page__sub">
            命中规则的消息会自动回复一次；回复走与人工回复相同的出站链路，可在全链路回放里逐步核对。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} data-testid="create-rule">
          新建规则
        </Button>
      </div>

      {error ? (
        <Alert type="warning" showIcon message={error} />
      ) : (
        <Table<AutoRule>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={rules}
          pagination={false}
          locale={{
            emptyText: '还没有规则：不配置时不会自动回复，所有消息都由人工处理。',
          }}
        />
      )}

      <Modal
        open={editing !== null}
        title={editing === 'new' ? '新建自动回复规则' : '编辑自动回复规则'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="platform" label="适用平台" extra="留空 = 所有平台">
            <Select
              allowClear
              placeholder="所有平台"
              options={Object.values(Platform).map((p) => ({ value: p, label: PLATFORM_META[p].name }))}
            />
          </Form.Item>
          <Form.Item
            name="keyword"
            label="关键词"
            extra="正文包含该词即命中（不区分大小写）；留空 = 该平台的兜底规则。"
          >
            <Input maxLength={128} placeholder="例如：在吗" allowClear />
          </Form.Item>
          <Form.Item
            name="replyText"
            label="回复内容"
            rules={[{ required: true, message: '请填写回复内容' }]}
          >
            <Input.TextArea rows={3} maxLength={2000} showCount placeholder="例如：在的，请说" />
          </Form.Item>
          <Form.Item name="priority" label="匹配优先级" extra="数字越小越先匹配（0–1000）">
            <InputNumber min={0} max={1000} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
