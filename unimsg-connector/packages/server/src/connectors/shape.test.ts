/**
 * 字段集合一致性测试（契约护栏）：
 *
 * 三个 IM 平台的适配器把各自的样例事件归一化成 UnifiedMessage 后，
 * 必须落在同一个字段集合上——既要有闭环/展示必需的公共字段，
 * 也不允许适配器偷偷塞 UnifiedMessage 之外的「平台专属字段」
 * （否则前端 / 统计 / 回放会各认各的，契约就散了）。
 *
 * 刻意不做「字段值完全相等」断言：LinkHub 的可选字段很多（dueAt / priority /
 * receivedAs…），适配器按平台能力取舍是合法的，等值断言会误伤。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, type PlatformConnector, type UnifiedMessage } from '@unimsg/shared';
import { feishuConnector } from './feishu';
import { dingtalkConnector } from './dingtalk';
import { wechatConnector } from './wechat';
import { feishuSample, dingtalkSample, wechatSample } from './samples';

/** 三个平台归一化结果都必须有的公共字段（闭环与前端展示的最小集） */
const REQUIRED_FIELDS = [
  'traceId',
  'platform',
  'externalId',
  'sender',
  'type',
  'body',
  'status',
  'createdAt',
  'updatedAt',
] as const;

/**
 * UnifiedMessage 的已知字段白名单（与 packages/shared/src/message.ts 的
 * UnifiedMessage 接口一一对应；shared 增删字段时这里同步维护，
 * 适配器出现白名单之外的字段一律报错——防止平台专属字段漏进统一契约）。
 */
const UNIFIED_MESSAGE_FIELDS: readonly string[] = [
  // 标识与来源
  'traceId',
  'platform',
  'externalId',
  'sender',
  'conversation',
  // 内容
  'type',
  'body',
  'attachments',
  // AI 建议（intent 家族）
  'intent',
  'intentSource',
  'aiProvider',
  'aiModel',
  'aiConfidence',
  'aiPrecision',
  'replyDraft',
  // 回复与引用
  'quoteRef',
  'reply',
  'replies',
  'replyAttachments',
  // 待办
  'done',
  'dueAt',
  'todoTitle',
  // 身份 / 阅读 / 方向 / 归属
  'receivedAs',
  'readAt',
  'direction',
  'ownerId',
  'sendIdentity',
  // 优先级
  'priority',
  'prioritySource',
  // OCR
  'needsReview',
  // 状态机与时间
  'status',
  'createdAt',
  'updatedAt',
  // 发送结果（后端内部 / 投递信息）
  'platformReply',
  'mailMeta',
  'delivery',
  'failureReason',
];

const KNOWN_FIELDS = new Set<string>(UNIFIED_MESSAGE_FIELDS);

interface PlatformCase {
  label: string;
  connector: PlatformConnector;
  sample: unknown;
  expectedPlatform: Platform;
}

const CASES: PlatformCase[] = [
  { label: '飞书', connector: feishuConnector, sample: feishuSample, expectedPlatform: Platform.FEISHU },
  { label: '钉钉', connector: dingtalkConnector, sample: dingtalkSample, expectedPlatform: Platform.DINGTALK },
  { label: '微信', connector: wechatConnector, sample: wechatSample, expectedPlatform: Platform.WECHAT },
];

test('三平台样例事件归一化后都包含同一组必需字段', () => {
  for (const { label, connector, sample } of CASES) {
    const m = connector.receive(sample);
    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        Object.hasOwn(m, field),
        `${label} 缺少必需字段 ${field}（实际键：${Object.keys(m).join(', ')}）`,
      );
    }
  }
});

test('必需字段的类型约束：platform 对号、status 合法、时间可解析', () => {
  for (const { label, connector, sample, expectedPlatform } of CASES) {
    const m = connector.receive(sample);
    assert.equal(m.platform, expectedPlatform, `${label} platform 归一化错误`);
    assert.equal(typeof m.traceId, 'string');
    assert.ok(m.traceId.length > 0, `${label} traceId 非空`);
    assert.equal(typeof m.type, 'string');
    assert.equal(typeof m.status, 'string');
    assert.ok(!Number.isNaN(Date.parse(m.createdAt)), `${label} createdAt 是可解析时间`);
    assert.ok(!Number.isNaN(Date.parse(m.updatedAt)), `${label} updatedAt 是可解析时间`);
  }
});

test('sender：三平台都是对象且 id/name 均为 string（允许空串但必须是 string）', () => {
  for (const { label, connector, sample } of CASES) {
    const m = connector.receive(sample);
    assert.ok(typeof m.sender === 'object' && m.sender !== null, `${label} sender 必须是对象`);
    assert.equal(typeof m.sender.id, 'string', `${label} sender.id 必须是 string`);
    assert.equal(typeof m.sender.name, 'string', `${label} sender.name 必须是 string`);
  }
});

test('externalId 与 body 非空（幂等键与正文是闭环的最低要求）', () => {
  for (const { label, connector, sample } of CASES) {
    const m = connector.receive(sample);
    assert.ok(typeof m.externalId === 'string' && m.externalId.length > 0, `${label} externalId 非空`);
    assert.ok(typeof m.body === 'string' && m.body.length > 0, `${label} body 非空`);
  }
});

test('三平台字段并集不超过 UnifiedMessage 已知字段集合（防平台专属字段漏进契约）', () => {
  const produced = new Set<string>();
  for (const { connector, sample } of CASES) {
    const m: UnifiedMessage = connector.receive(sample);
    for (const key of Object.keys(m)) produced.add(key);
  }
  const unknown = [...produced].filter((key) => !KNOWN_FIELDS.has(key));
  assert.deepEqual(
    unknown,
    [],
    `适配器产出了 UnifiedMessage 之外的字段：${unknown.join(', ')}`
      + '；请去掉它，或先在 packages/shared/src/message.ts 的 UnifiedMessage 里正式定义',
  );
});
