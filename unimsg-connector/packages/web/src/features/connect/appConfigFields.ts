/**
 * 平台应用凭据字段定义（前端唯一来源）：
 *  - 字段键与 PUT /api/app-config 的 payload 对齐；
 *  - label 用普通客户能看懂的中文，envKey 只用于「也可写 .env」提示，不直接堆在界面上；
 *  - secret 类字段用 password 输入、保存后不回显。
 */
import type { AppConfigPlatformId } from '../../services/api';

export type AppConfigGroup = AppConfigPlatformId | 'llm';

export interface AppConfigFieldDef {
  key: string;
  label: string;
  /** secret 类字段：password 输入 + 保存后不回显 */
  secret?: boolean;
  /** 可选字段（不填不影响主线） */
  optional?: boolean;
  placeholder?: string;
  /** 布尔开关（如 stream 长连接）；保存时提交 true/false */
  type?: 'text' | 'switch';
  /** 对应 .env 键名（仅提示用） */
  envKey?: string;
  note?: string;
}

export interface AppConfigGroupDef {
  id: AppConfigGroup;
  label: string;
  /** 分组说明（普通客户语言） */
  hint: string;
  fields: AppConfigFieldDef[];
}

export const APP_CONFIG_GROUPS: AppConfigGroupDef[] = [
  {
    id: 'feishu',
    label: '飞书',
    hint: '飞书自建应用的凭据：在飞书开放平台「凭证与基础信息」里获取 App ID / App Secret。长连接模式可不填 Verify Token / Encrypt Key（事件订阅才需要）。',
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxxxxxxxxx', envKey: 'FEISHU_APP_ID' },
      { key: 'appSecret', label: 'App Secret', secret: true, envKey: 'FEISHU_APP_SECRET' },
      {
        key: 'verifyToken',
        label: 'Verification Token',
        optional: true,
        envKey: 'FEISHU_VERIFY_TOKEN',
        note: '长连接可不填；用 Webhook 接收事件时必填。',
      },
      {
        key: 'encryptKey',
        label: 'Encrypt Key',
        secret: true,
        optional: true,
        envKey: 'FEISHU_ENCRYPT_KEY',
        note: '事件加密用；长连接可不填。',
      },
      {
        key: 'stream',
        label: '使用长连接（Stream）',
        optional: true,
        type: 'switch',
        envKey: 'FEISHU_STREAM',
        note: '推荐开启：无需公网 Webhook 地址；关闭则走事件订阅。',
      },
    ],
  },
  {
    id: 'dingtalk',
    label: '钉钉',
    hint: '钉钉企业内部应用凭据（机器人收发用）。只想用本人身份？不需要钉钉应用，勾选下方「仅用本人身份」并保存即可。',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: 'dingxxxxxxxx', envKey: 'DINGTALK_CLIENT_ID' },
      { key: 'clientSecret', label: 'Client Secret', secret: true, envKey: 'DINGTALK_CLIENT_SECRET' },
      { key: 'robotCode', label: 'Robot Code', optional: true, envKey: 'DINGTALK_ROBOT_CODE' },
      {
        key: 'aesToken',
        label: 'AES Token',
        optional: true,
        envKey: 'DINGTALK_AES_TOKEN',
        note: '接收机器人事件（Stream/Webhook）时用。',
      },
      {
        key: 'aesKey',
        label: 'AES Key',
        secret: true,
        optional: true,
        envKey: 'DINGTALK_AES_KEY',
        note: '接收机器人事件（Stream/Webhook）时用。',
      },
      {
        key: 'stream',
        label: '使用长连接（Stream）',
        optional: true,
        type: 'switch',
        envKey: 'DINGTALK_STREAM',
        note: '推荐开启：无需公网 Webhook 地址；关闭则走事件订阅。',
      },
    ],
  },
  {
    id: 'wechat',
    label: '微信（RPA）',
    hint: '微信个人版无官方收发 API，通过本机 RPA 桥（scripts/wechat-rpa）接入。A 形态下（后端与微信同机）这里可以切真实模式、检测/启动/停止本机桥；仍需本机已安装 Python 并登录微信。',
    fields: [
      {
        key: 'bridgeUrl',
        label: 'RPA 桥地址',
        placeholder: 'http://127.0.0.1:8787',
        optional: true,
        envKey: 'WECHAT_BRIDGE_URL',
        note: '默认 http://127.0.0.1:8787；同机一般不用改。改了桥端口才需要同步这里。',
      },
    ],
  },
  {
    id: 'llm',
    label: 'AI 模型（可选）',
    hint: '配置后「AI 辅助」会调用你的模型生成意图与回复草稿；不配置或调用失败时走本地关键词规则，不影响收发。这里填的是「协议类型」，不是厂商中文名。保存后必须重启后端才生效；历史消息可在详情页点「重新生成」用新配置重算。',
    fields: [
      {
        key: 'provider',
        label: '协议类型',
        optional: true,
        placeholder: 'openai',
        envKey: 'LLM_PROVIDER',
        note: '填 openai 即可：火山方舟 / DeepSeek / 通义千问 / 智谱 / MiMo 都是 OpenAI 兼容协议，厂商靠下面的 Base URL 区分。填厂商名也能自动识别；填 mock 则走内置规则。',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        secret: true,
        optional: true,
        envKey: 'LLM_API_KEY',
        note: '只保存在本机服务端，不会下发到浏览器。',
      },
      {
        key: 'baseUrl',
        label: 'API Base URL',
        optional: true,
        placeholder: 'https://ark.cn-beijing.volces.com/api/v3',
        envKey: 'LLM_ENDPOINT',
        note: 'OpenAI 兼容端点（一般带 /v1 或 /api/v3）；旧的 LLM_BASE_URL 也兼容。端点与模型必须属于同一家服务商。',
      },
      {
        key: 'model',
        label: '模型 ID',
        optional: true,
        placeholder: 'doubao-seed-1-6-250615',
        envKey: 'LLM_MODEL',
        note: '必须填控制台里的「模型 ID」而不是显示名，且该模型已在控制台开通；否则接口会返回 404 并回退规则。',
      },
    ],
  },
];

export function findAppConfigGroup(id: AppConfigGroup): AppConfigGroupDef | undefined {
  return APP_CONFIG_GROUPS.find((group) => group.id === id);
}

/** 缺失环境变量键名 → 客户能看懂的名字（未知键原样展示，便于报给管理员） */
export const MISSING_KEY_LABELS: Record<string, string> = {
  FEISHU_APP_ID: '飞书 App ID',
  FEISHU_APP_SECRET: '飞书 App Secret',
  FEISHU_VERIFY_TOKEN: '飞书 Verification Token',
  FEISHU_ENCRYPT_KEY: '飞书 Encrypt Key',
  FEISHU_IDENTITY: '飞书身份策略',
  FEISHU_STREAM: '飞书长连接',
  FEISHU_USER_RECEIVE: '飞书本人身份接收',
  DINGTALK_CLIENT_ID: '钉钉 Client ID',
  DINGTALK_CLIENT_SECRET: '钉钉 Client Secret',
  DINGTALK_ROBOT_CODE: '钉钉 Robot Code',
  DINGTALK_AES_TOKEN: '钉钉 AES Token',
  DINGTALK_AES_KEY: '钉钉 AES Key',
  DINGTALK_IDENTITY: '钉钉身份策略',
  DINGTALK_STREAM: '钉钉长连接',
  WECHAT_BRIDGE_URL: '微信 RPA 桥地址',
  WECHAT_MODE: '微信运行模式',
  MAIL_ADDRESS: '邮箱地址',
  MAIL_AUTH_CODE: '邮箱授权码',
  OPENAI_API_KEY: 'AI API Key',
  LLM_API_KEY: 'AI API Key',
};

export function humanizeMissingKey(key: string): string {
  return MISSING_KEY_LABELS[key] ?? key;
}

export function humanizeMissingKeys(keys?: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return keys
    .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    .map((key) => humanizeMissingKey(key.trim()));
}

/** 字段长度上限（保存前简单校验；后端仍会做最终校验，上限必须与后端一致） */
export function maxLengthOf(field: string): number {
  if (field === 'appId' || field === 'clientId' || field === 'corpId') return 128;
  if (field === 'agentId' || field === 'model') return 128;
  if (field === 'robotCode') return 128;
  if (field === 'provider') return 64;
  if (field === 'verifyToken') return 512;
  if (field === 'baseUrl') return 512;
  return 512;
}
