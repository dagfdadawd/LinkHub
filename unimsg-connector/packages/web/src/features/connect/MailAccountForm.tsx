/**
 * 邮箱添加表单（个人版核心）：服务商预设 → 邮箱地址 → 授权码 → 测试 → 保存。
 *
 * 安全：
 *  - 授权码用 password 输入（可点眼睛显示），只在提交时发给本机后端；
 *  - 不写 localStorage、不进 URL、不进日志；测试连接后端只做登录自检、不落盘。
 */
import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
} from 'antd';
import {
  ExportOutlined,
  LinkOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { MailAccountInput, MailAccountTestResult } from '../../services/api';
import { store } from '../../store';
import { MAIL_PROVIDERS, findMailProvider } from './mailProviders';

export interface MailFormValues {
  provider: string;
  address: string;
  authCode: string;
  label?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

/** 表单值 → 接口请求体：去空格、只带非空字段（避免把空字符串写到后端配置） */
export function buildMailAccountInput(values: MailFormValues): MailAccountInput {
  const preset = findMailProvider(values.provider);
  const imapHost = values.imapHost?.trim();
  const smtpHost = values.smtpHost?.trim();
  return {
    provider: values.provider,
    address: values.address.trim(),
    authCode: values.authCode.trim(),
    ...(values.label?.trim() ? { label: values.label.trim() } : preset ? { label: preset.label } : {}),
    ...(imapHost ? { imapHost } : {}),
    ...(typeof values.imapPort === 'number' ? { imapPort: values.imapPort } : {}),
    ...(smtpHost ? { smtpHost } : {}),
    ...(typeof values.smtpPort === 'number' ? { smtpPort: values.smtpPort } : {}),
  };
}

export function MailAccountForm({
  onSaved,
  onCancel,
}: {
  /** 保存成功后刷新授权中心 / 账号页并收起表单 */
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<MailFormValues>();
  const provider = Form.useWatch('provider', form);
  const preset = findMailProvider(provider);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<MailAccountTestResult | null>(null);

  /** 切换服务商：自动带出官方 IMAP/SMTP 预设，用户仍可在高级设置里覆盖 */
  function applyProvider(value: string): void {
    const next = findMailProvider(value);
    if (!next) return;
    form.setFieldsValue({
      imapHost: next.imapHost,
      imapPort: next.imapPort,
      smtpHost: next.smtpHost,
      smtpPort: next.smtpPort,
    });
    setResult(null);
  }

  async function validateValues(): Promise<MailFormValues | undefined> {
    try {
      return await form.validateFields();
    } catch {
      return undefined;
    }
  }

  async function handleTest(): Promise<void> {
    const values = await validateValues();
    if (!values) return;
    setTesting(true);
    setResult(null);
    try {
      const res = await store.mailAccountTest(buildMailAccountInput(values));
      setResult(res);
      if (res.ok) message.success(res.message ?? '邮箱连接测试通过');
      else message.error(res.message ?? '邮箱连接测试失败，请检查授权码与服务器地址');
    } catch (e) {
      const failure: MailAccountTestResult = {
        ok: false,
        message: e instanceof Error ? e.message : '测试连接失败，请检查后端服务',
      };
      setResult(failure);
      message.error(failure.message ?? '测试连接失败');
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(): Promise<void> {
    const values = await validateValues();
    if (!values) return;
    setSaving(true);
    try {
      await store.mailAccountCreate(buildMailAccountInput(values));
      message.success('邮箱账号已保存，收件箱会在下一轮轮询中同步（不需要重启后端）');
      form.resetFields();
      form.setFieldsValue({
        provider: 'qq',
        imapHost: 'imap.qq.com',
        imapPort: 993,
        smtpHost: 'smtp.qq.com',
        smtpPort: 465,
      });
      setResult(null);
      onSaved?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存邮箱账号失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mail-form" data-testid="mail-account-form">
      {preset && (
        <div className="mail-form__help">
          <span>{preset.helpText}</span>
          {preset.helpUrl && (
            <a href={preset.helpUrl} target="_blank" rel="noreferrer">
              打开设置页
              <ExportOutlined />
            </a>
          )}
        </div>
      )}

      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          provider: 'qq',
          imapHost: 'imap.qq.com',
          imapPort: 993,
          smtpHost: 'smtp.qq.com',
          smtpPort: 465,
        }}
        onValuesChange={(changed) => {
          if (String(changed.provider ?? '')) applyProvider(String(changed.provider));
        }}
      >
        <div className="mail-form__grid">
          <Form.Item
            name="provider"
            label="服务商"
            rules={[{ required: true, message: '请选择邮箱服务商' }]}
          >
            <Select
              options={MAIL_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
              placeholder="选择邮箱服务商"
            />
          </Form.Item>
          <Form.Item
            name="address"
            label="邮箱地址"
            rules={[
              { required: true, message: '请填写邮箱地址' },
              { type: 'email', message: '邮箱地址格式不正确' },
            ]}
          >
            <Input placeholder="you@qq.com" autoComplete="username" />
          </Form.Item>
        </div>

        <Form.Item
          name="authCode"
          label="授权码"
          extra="授权码不是邮箱登录密码：在服务商网页版「设置 → 账户 / 安全」里开启 IMAP 并生成；点右侧眼睛图标可显示。"
          rules={[{ required: true, message: '请填写邮箱授权码（不是登录密码）' }]}
        >
          <Input.Password placeholder="粘贴邮箱授权码" autoComplete="off" />
        </Form.Item>

        <Collapse
          ghost
          size="small"
          className="mail-form__advanced"
          items={[
            {
              key: 'advanced',
              label: '高级设置（IMAP / SMTP 服务器）',
              // 折叠时也保持字段注册：测试连接 / 保存需要平台预设的服务器与端口
              forceRender: true,
              children: (
                <div className="mail-form__grid">
                  <Form.Item
                    name="imapHost"
                    label="IMAP 服务器"
                    rules={
                      provider === 'custom'
                        ? [{ required: true, message: '请填写 IMAP 服务器地址' }]
                        : []
                    }
                  >
                    <Input placeholder="imap.example.com" />
                  </Form.Item>
                  <Form.Item name="imapPort" label="IMAP 端口">
                    <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item
                    name="smtpHost"
                    label="SMTP 服务器"
                    rules={
                      provider === 'custom'
                        ? [{ required: true, message: '请填写 SMTP 服务器地址' }]
                        : []
                    }
                  >
                    <Input placeholder="smtp.example.com" />
                  </Form.Item>
                  <Form.Item name="smtpPort" label="SMTP 端口">
                    <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
              ),
            },
          ]}
        />
      </Form>

      {result && (
        <Alert
          className="mail-form__result"
          data-testid="mail-test-result"
          type={result.ok ? 'success' : 'error'}
          showIcon
          message={result.ok ? '连接测试通过' : '连接测试失败'}
          description={
            <div>
              {result.message && <div>{result.message}</div>}
              {result.details && result.details.length > 0 && (
                <ul className="mail-form__checks">
                  {result.details.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          }
        />
      )}

      <div className="mail-form__actions">
        <Button
          icon={<ThunderboltOutlined />}
          loading={testing}
          onClick={() => void handleTest()}
        >
          测试连接
        </Button>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={saving}
          onClick={() => void handleSave()}
        >
          保存账号
        </Button>
        {onCancel && (
          <Button type="text" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
      <div className="mail-form__note">
        <LinkOutlined /> 保存后立即生效（不需要重启）；授权码只发送给本机后端，不会写进浏览器存储。
      </div>
    </div>
  );
}