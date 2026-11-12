/**
 * 「平台应用配置」弹窗（白号 P0-1）：
 *
 * 零凭据客户第一次使用时，唯一能走通的路是「在界面填应用凭据」——
 * 本弹窗把飞书 / 钉钉 / 企微 / AI 的凭据收在一处：
 *  - 已有值只显示脱敏信息 + 来源（.env / 本地配置），.env 显式配置不可覆盖；
 *  - secret 用 password 输入，保存后不回显；
 *  - 保存应用凭据 → 明确提示「需要重启」+ 重载命令 +「我已重启，重新检测」；
 *  - 钉钉「仅用本人身份」是身份模式切换：后端热应用，不需要重启。
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Input,
  Modal,
  Spin,
  Switch,
  Tabs,
  Tag,
} from 'antd';
import { LockOutlined, SettingOutlined } from '@ant-design/icons';
import type {
  AppConfigField,
  AppConfigPlatformId,
  AppConfigSaveResult,
  AppConfigUpdate,
  AppConfigView,
} from '../../services/api';
import { useAppState } from '../../hooks/useAppState';
import { store } from '../../store';
import { RestartNotice } from './RestartNotice';
import { interpretAppConfigSave } from './appConfigResult';
import {
  APP_CONFIG_GROUPS,
  humanizeMissingKeys,
  maxLengthOf,
  type AppConfigFieldDef,
  type AppConfigGroup,
  type AppConfigGroupDef,
} from './appConfigFields';

/** 表单里每个字段的路径：`<group>.<field>`，避免不同分组同名字段冲突 */
function fieldPath(group: AppConfigGroup, field: string): string {
  return `${group}.${field}`;
}

export function AppConfigModal({
  open,
  initialGroup = 'feishu',
  onClose,
  onSaved,
}: {
  open: boolean;
  /** 从某张平台卡打开时直接定位到对应分组 */
  initialGroup?: AppConfigGroup;
  onClose: () => void;
  /** 保存成功后通知页面刷新 onboarding / accounts */
  onSaved?: (result: AppConfigSaveResult) => void;
}) {
  const state = useAppState();
  const { message: toast } = AntApp.useApp();
  const [config, setConfig] = useState<AppConfigView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [activeGroup, setActiveGroup] = useState<AppConfigGroup>(initialGroup);
  const [values, setValues] = useState<Record<string, string>>({});
  const [personalOnly, setPersonalOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<AppConfigSaveResult | null>(null);
  const [applied, setApplied] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({});
    setError('');
    setFormError('');
    setSaveResult(null);
    setApplied(false);
    setActiveGroup(initialGroup);
    void loadConfig();
    // 只在打开时加载；initialGroup 变化由父组件通过重新打开传入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialGroup]);

  async function loadConfig(): Promise<void> {
    setLoading(true);
    try {
      const view = await store.loadAppConfig();
      setConfig(view);
      setPersonalOnly(view.identity?.dingtalk === 'user');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取平台应用配置失败，请确认后端已启动');
    } finally {
      setLoading(false);
    }
  }

  function existingField(group: AppConfigGroup, field: string): AppConfigField | undefined {
    if (!config) return undefined;
    if (group === 'llm') return config.llm[field];
    return config.platforms[group as AppConfigPlatformId]?.fields[field];
  }

  function isLockedByEnv(group: AppConfigGroup, field: string): boolean {
    return existingField(group, field)?.source === 'env';
  }

  function setField(group: AppConfigGroup, field: string, value: string): void {
    setValues((prev) => ({ ...prev, [fieldPath(group, field)]: value }));
    setFormError('');
  }

  function fieldValue(group: AppConfigGroup, field: string): string {
    return values[fieldPath(group, field)] ?? '';
  }

  /** 布尔开关当前值：用户改过优先；否则用后端回传的真实 value / display */
  function switchValue(group: AppConfigGroup, field: string): boolean {
    const raw = values[fieldPath(group, field)];
    if (raw !== undefined) return raw === 'true';
    const existing = existingField(group, field);
    if (typeof existing?.value === 'boolean') return existing.value;
    if (existing?.display === 'true') return true;
    if (existing?.display === 'false') return false;
    // 后端默认：未显式配置长连接时 FEISHU_STREAM/DINGTALK_STREAM 视为 true
    return field === 'stream';
  }

  /** 校验 + 拼 PUT payload（只提交用户填写的字段；.env 锁定的字段不会出现在 payload） */
  function buildPatch(): { patch: AppConfigUpdate; errors: string[] } {
    const errors: string[] = [];
    const platforms: NonNullable<AppConfigUpdate['platforms']> = {};
    let llmConfig: Record<string, string> | undefined;

    for (const group of APP_CONFIG_GROUPS) {
      const typed: Record<string, string | boolean> = {};
      for (const def of group.fields) {
        const path = fieldPath(group.id, def.key);
        if (def.type === 'switch') {
          // 开关：只有用户显式切换过才提交；锁定的 .env 字段不覆盖
          if (values[path] === undefined || isLockedByEnv(group.id, def.key)) continue;
          typed[def.key] = values[path] === 'true';
          continue;
        }
        const raw = fieldValue(group.id, def.key).trim();
        if (!raw || isLockedByEnv(group.id, def.key)) continue;
        const max = maxLengthOf(def.key);
        if (raw.length > max) {
          errors.push(`${group.label}「${def.label}」过长（最多 ${max} 个字符）`);
          continue;
        }
        typed[def.key] = raw;
      }
      if (group.id === 'llm') {
        const llmTyped = Object.fromEntries(
          Object.entries(typed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
        if (Object.keys(llmTyped).length > 0) llmConfig = llmTyped;
        continue;
      }
      if (Object.keys(typed).length === 0) continue;

      // 成对校验：新增一半、另一半既没填也没配 → 明确报错（已有配置可留空保持不变）
      const configured = (key: string): boolean =>
        Boolean(typed[key]) || Boolean(existingField(group.id, key)?.configured);
      if (group.id === 'feishu') {
        if ((typed.appId || typed.appSecret) && !(configured('appId') && configured('appSecret'))) {
          errors.push('飞书 App ID 与 App Secret 需要成对填写（已配置的一项可留空保持不变）。');
        }
      }
      if (group.id === 'dingtalk') {
        if ((typed.clientId || typed.clientSecret) && !(configured('clientId') && configured('clientSecret'))) {
          errors.push('钉钉 Client ID 与 Client Secret 需要成对填写（已配置的一项可留空保持不变）。');
        }
      }
      if (group.id === 'wecom') {
        const touched = Boolean(typed.corpId || typed.agentId || typed.secret);
        if (touched && !(configured('corpId') && configured('agentId') && configured('secret'))) {
          errors.push('企业微信需要同时填写 Corp ID、Agent ID 与 Secret（已配置的项可留空保持不变）。');
        }
      }
      platforms[group.id] = typed;
    }

    const identity: Record<string, string> = {};
    const currentDingtalk = String(config?.identity?.dingtalk ?? 'auto');
    if (personalOnly && currentDingtalk !== 'user') identity.dingtalk = 'user';
    if (!personalOnly && currentDingtalk === 'user' && config?.identitySources?.dingtalk !== 'env') {
      identity.dingtalk = 'auto';
    }

    if (Object.keys(platforms).length === 0 && Object.keys(identity).length === 0 && !llmConfig) {
      errors.push('还没有填写任何配置：请至少填写一个平台的凭据，或切换钉钉「仅用本人身份」。');
    }
    return {
      patch: {
        ...(Object.keys(platforms).length > 0 ? { platforms } : {}),
        ...(llmConfig ? { llm: llmConfig } : {}),
        ...(Object.keys(identity).length > 0 ? { identity } : {}),
      },
      errors,
    };
  }

  async function save(): Promise<void> {
    const { patch, errors } = buildPatch();
    if (errors.length > 0) {
      setFormError(errors[0]);
      toast.error(errors[0]);
      return;
    }
    setFormError('');
    setSaveResult(null);
    setApplied(false);
    setSaving(true);
    try {
      const identityOnly = Boolean(patch.identity) && !patch.platforms && !patch.llm && !patch.modes;
      const result = await store.saveAppConfig(patch);
      const outcome = interpretAppConfigSave(result, { identityOnly });
      setSaveResult(result);
      await loadConfig();
      onSaved?.(result);
      if (outcome.status === 'applied') {
        setApplied(true);
        toast.success(outcome.message);
      } else if (outcome.status === 'restart') {
        setApplied(false);
        toast.warning('已保存，需要重启 LinkHub 生效');
      } else if (outcome.status === 'ignored') {
        // .env 锁定 / 未热应用：绝不提示成功；具体被忽略的键在页面 Alert 中可见
        setApplied(false);
        if (result.saved === false) setFormError(outcome.message);
        toast.warning(outcome.message);
      } else {
        setApplied(false);
        setFormError(outcome.message);
        toast.error(outcome.message);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '保存平台应用配置失败，请稍后重试';
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function recheck(): Promise<void> {
    setRechecking(true);
    try {
      await store.refreshHealth();
      const view = await store.loadAppConfig();
      setConfig(view);
      if (view.restartRequired) {
        toast.warning('仍检测到配置未生效：请确认 LinkHub 已重启（或桌面版已重新加载）');
      } else {
        setConfig(view);
        setApplied(true);
        setSaveResult({ saved: true, restartRequired: false, changedKeys: [] });
        toast.success('重新检测完成：配置已生效');
        onSaved?.({ saved: true, restartRequired: false, changedKeys: [] });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重新检测失败，请稍后重试');
    } finally {
      setRechecking(false);
    }
  }

  const groups = useMemo(() => APP_CONFIG_GROUPS, []);

  function renderField(group: AppConfigGroupDef, def: AppConfigFieldDef): ReactNode {
    const existing = existingField(group.id, def.key);
    const locked = existing?.source === 'env';
    const inputId = `app-config-${fieldPath(group.id, def.key)}`;
    const configured = Boolean(existing?.configured);
    const note = existing?.configured && existing.display ? `当前：${existing.display}` : '';
    return (
      <div className="app-config-field" key={inputId}>
        <div className="app-config-field__head">
          <label htmlFor={inputId} className="app-config-field__label">
            {def.label}
            {def.optional && <span className="app-config-field__optional">（可选）</span>}
          </label>
          {configured ? (
            <Tag color={locked ? 'default' : 'blue'}>
              {locked ? '由部署配置固定（不可覆盖）' : existing?.source === 'local' ? '本地配置' : '已配置'}
            </Tag>
          ) : (
            <span className="app-config-field__note">未配置</span>
          )}
        </div>
        {def.type === 'switch' ? (
          <div className="app-config-field__switch-row">
            <Switch
              id={inputId}
              checked={switchValue(group.id, def.key)}
              disabled={locked}
              aria-label={def.label}
              onChange={(checked) => setField(group.id, def.key, checked ? 'true' : 'false')}
            />
            <span className="app-config-field__note">
              {switchValue(group.id, def.key) ? '已开启' : '已关闭'}
              {existing?.source === 'none' ? '（默认开启长连接；关闭需保存并重启）' : ''}
            </span>
          </div>
        ) : def.secret ? (
          <Input.Password
            id={inputId}
            value={fieldValue(group.id, def.key)}
            disabled={locked}
            autoComplete="new-password"
            placeholder={configured ? '已配置，留空保持不变' : def.placeholder ?? '粘贴凭据'}
            onChange={(e) => setField(group.id, def.key, e.target.value)}
          />
        ) : (
          <Input
            id={inputId}
            value={fieldValue(group.id, def.key)}
            disabled={locked}
            placeholder={configured ? '已配置，留空保持不变' : def.placeholder ?? ''}
            onChange={(e) => setField(group.id, def.key, e.target.value)}
          />
        )}
        {(note || def.note) && (
          <div className="app-config-field__note">
            {note}
            {note && def.note ? ' · ' : ''}
            {def.note}
          </div>
        )}
      </div>
    );
  }

  function renderPersonalOnly(): ReactNode {
    const mode = String(config?.identity?.dingtalk ?? 'auto');
    const source = config?.identitySources?.dingtalk;
    const locked = source === 'env';
    return (
      <div className="app-config-personal" data-testid="app-config-personal-only">
        <div className="app-config-personal__head">
          <strong>只想用本人身份？不需要钉钉应用</strong>
          <span>
            勾选后保存，会把身份模式切到「仅本人身份」——
            后端热应用、<strong>不需要重启</strong>；之后用「连接账号」页的「用钉钉本人账号登录」完成授权即可。
          </span>
        </div>
        <div className="app-config-personal__row">
          <Switch
            checked={personalOnly}
            disabled={locked}
            data-testid="app-config-personal-switch"
            onChange={setPersonalOnly}
          />
          <span>仅用本人身份（无需机器人凭据）</span>
          <Tag color={mode === 'user' ? 'success' : 'default'}>当前：{mode}</Tag>
          {locked && (
            <span className="app-config-field__note">
              <LockOutlined /> 由部署配置固定（身份策略），不可在此覆盖
            </span>
          )}
        </div>
      </div>
    );
  }

  function renderGroup(group: AppConfigGroupDef): ReactNode {
    const missing = group.id === 'llm' ? [] : humanizeMissingKeys(config?.platforms[group.id]?.missing);
    return (
      <div className="app-config-group">
        <p className="app-config-group__hint">{group.hint}</p>
        {missing.length > 0 && (
          <div className="app-config-group__missing">
            还缺：{missing.join('、')}（填写并保存后补齐；应用凭据需要重启 LinkHub 生效）
          </div>
        )}
        {group.id === 'dingtalk' && renderPersonalOnly()}
        <div className="app-config-fields">
          {group.fields.map((def) => renderField(group, def))}
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      title={
        <span className="app-config-title">
          <SettingOutlined /> 平台应用配置
        </span>
      }
      width={720}
      onCancel={onClose}
      destroyOnHidden
      footer={
        <div className="app-config-footer">
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存配置
          </Button>
        </div>
      }
    >
      {state.demoMode && (
        <Alert
          className="app-config-alert"
          type="info"
          showIcon
          message="当前是纯前端演示模式（Mock）"
          description="演示模式不会保存真实凭据；启动真实后端后再填写 App ID / Secret 等配置。"
        />
      )}

      {loading && !config ? (
        <div className="app-config-loading">
          <Spin />
          <span>正在读取平台应用配置…</span>
        </div>
      ) : error && !config ? (
        <Alert
          type="error"
          showIcon
          message="读取平台应用配置失败"
          description={error}
          action={
            <Button size="small" onClick={() => void loadConfig()}>
              重试
            </Button>
          }
        />
      ) : config ? (
        <>
          {formError && (
            <Alert
              className="app-config-alert"
              type="error"
              showIcon
              closable
              message={formError}
              onClose={() => setFormError('')}
            />
          )}

          {saveResult?.ignoredByEnv && saveResult.ignoredByEnv.length > 0 && (
            <Alert
              className="app-config-alert"
              type="warning"
              showIcon
              message="部分配置来自 .env，未被本次保存覆盖"
              description={`以下配置来自 .env，页面不能覆盖：${humanizeMissingKeys(saveResult.ignoredByEnv).join('、')}。如需修改，请改 .env 后重启。`}
            />
          )}

          {(saveResult?.restartRequired || applied) && (
            <RestartNotice
              applied={applied}
              rechecking={rechecking}
              onRecheck={() => void recheck()}
              appliedText="配置已生效：平台状态已重新检测，无需重启。"
            />
          )}

          {saveResult?.warnings && saveResult.warnings.length > 0 && (
            <Alert
              className="app-config-alert"
              type="warning"
              showIcon
              message="保存提示"
              description={
                <ul className="app-config-warnings">
                  {saveResult.warnings.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              }
            />
          )}

          <Tabs
            activeKey={activeGroup}
            onChange={(key) => setActiveGroup(key as AppConfigGroup)}
            items={groups.map((group) => ({
              key: group.id,
              label: group.label,
              children: renderGroup(group),
            }))}
          />

          <p className="app-config-footnote">
            已有值只显示脱敏信息；Secret / API Key 保存后不会回显。由部署配置固定的项优先且不可在界面覆盖。
          </p>
        </>
      ) : null}
    </Modal>
  );
}


