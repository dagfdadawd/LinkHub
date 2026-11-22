/**
 * AutoRuleStore 单元测试：匹配（优先级 / 兜底 / 平台过滤 / 大小写 / 禁用）、
 * create 校验（中文错误）、update/remove、recordHit、持久化（临时文件 round-trip、
 * 坏文件静默降级、原子写不留 .tmp、目录自动创建）。不触网、不依赖消息服务。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Platform } from '@unimsg/shared';
import { AutoRuleStore } from './autoReply';
import { makeTempDir } from '../utils/tempDir';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(name: string): string {
  const dir = makeTempDir('linkhub-auto-reply-');
  dirs.push(dir);
  return join(dir, name);
}

/** 临时替换 console.warn：既不让坏文件用例污染测试输出，又能断言确实告警过 */
function captureWarn(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  return { warnings, restore: () => { console.warn = original; } };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

test('match：priority 升序优先，数字小的先命中', () => {
  const store = new AutoRuleStore();
  store.create({ keyword: '发票', replyText: '低优先', priority: 500 });
  const high = store.create({ keyword: '发票', replyText: '高优先', priority: 10 });
  const hit = store.match(Platform.FEISHU, '请开发票');
  assert.ok(hit);
  assert.equal(hit.id, high.id);
  assert.equal(hit.replyText, '高优先');
});

test('match：同优先级按 createdAt 升序（先建的先命中）', async () => {
  const store = new AutoRuleStore();
  const first = store.create({ keyword: '报价', replyText: '先建', priority: 100 });
  await wait(5); // 保证 createdAt（毫秒精度）不同
  store.create({ keyword: '报价', replyText: '后建', priority: 100 });
  const hit = store.match(Platform.DINGTALK, '给我个报价');
  assert.ok(hit);
  assert.equal(hit.id, first.id);
});

test('match：keyword 为空 = 该平台兜底规则，任何正文都命中', () => {
  const store = new AutoRuleStore();
  const fallback = store.create({ platform: Platform.WECHAT, replyText: '兜底', priority: 900 });
  const hit = store.match(Platform.WECHAT, '随便说点什么 xyz');
  assert.ok(hit);
  assert.equal(hit.id, fallback.id);
});

test('match：平台过滤——规则限定平台后不响应其他平台', () => {
  const store = new AutoRuleStore();
  store.create({ platform: Platform.FEISHU, keyword: '会议', replyText: '飞书专用' });
  assert.ok(store.match(Platform.FEISHU, '明天开会吗 会议'));
  assert.equal(store.match(Platform.DINGTALK, '明天开会吗 会议'), undefined);
});

test('match：platform 未设置 = 所有平台生效', () => {
  const store = new AutoRuleStore();
  const rule = store.create({ keyword: 'thanks', replyText: '不客气' });
  for (const p of [Platform.FEISHU, Platform.DINGTALK, Platform.WECHAT, Platform.MAIL]) {
    const hit = store.match(p, 'big thanks!');
    assert.ok(hit, `平台 ${p} 应命中全局规则`);
    assert.equal(hit.id, rule.id);
  }
});

test('match：keyword 不区分大小写做 includes', () => {
  const store = new AutoRuleStore();
  store.create({ keyword: 'Refund', replyText: '退款流程见文档' });
  assert.ok(store.match(Platform.MAIL, 'I want a REFUND please'));
  assert.ok(store.match(Platform.MAIL, 'please refund my order'));
  assert.equal(store.match(Platform.MAIL, 'just a question'), undefined);
});

test('match：禁用规则不参与匹配（即使优先级最高）', () => {
  const store = new AutoRuleStore();
  store.create({ keyword: '发票', replyText: '已停用', priority: 1, enabled: false });
  const active = store.create({ keyword: '发票', replyText: '在用', priority: 100 });
  const hit = store.match(Platform.FEISHU, '开个发票');
  assert.ok(hit);
  assert.equal(hit.id, active.id);
});

test('match：同优先级只按 createdAt 决胜（先建的兜底规则也会赢，不给关键词规则加分）', () => {
  const store = new AutoRuleStore();
  // 任务书只规定 priority 升序、再 createdAt 升序，返回第一条：
  // 兜底规则先建且同优先级 → 按规范兜底赢；想让关键词规则优先就调低它的 priority
  store.create({ platform: Platform.FEISHU, replyText: '兜底', priority: 100 });
  store.create({ platform: Platform.FEISHU, keyword: '密码', replyText: '关键词', priority: 100 });
  const hit = store.match(Platform.FEISHU, '我的密码忘了');
  assert.ok(hit);
  assert.equal(hit.replyText, '兜底');

  // 调低关键词规则优先级后，关键词规则赢
  const keyword = store.list().find((r) => r.keyword === '密码')!;
  store.update(keyword.id, { priority: 99 });
  assert.equal(store.match(Platform.FEISHU, '我的密码忘了')!.replyText, '关键词');
});

// ---------------------------------------------------------------------------
// create 校验
// ---------------------------------------------------------------------------

test('create：默认值——priority=100、enabled=true、hitCount=0、id/createdAt 生成', () => {
  const store = new AutoRuleStore();
  const rule = store.create({ replyText: '你好' });
  assert.equal(rule.priority, 100);
  assert.equal(rule.enabled, true);
  assert.equal(rule.hitCount, 0);
  assert.match(rule.id, /^[0-9a-f-]{36}$/i);
  assert.ok(!Number.isNaN(Date.parse(rule.createdAt)));
});

test('create 校验：replyText 空 / 纯空白 / 超长都要抛中文错误', () => {
  const store = new AutoRuleStore();
  assert.throws(() => store.create({ replyText: '' }), /replyText 不能为空/);
  assert.throws(() => store.create({ replyText: '   \n\t ' }), /replyText 不能为空/);
  assert.throws(() => store.create({ replyText: 'x'.repeat(2001) }), /replyText 不能超过 2000/);
  // 恰好 2000 应通过
  assert.ok(store.create({ replyText: 'x'.repeat(2000) }));
});

test('create 校验：keyword 超 128 抛错；keyword 空串归一为兜底', () => {
  const store = new AutoRuleStore();
  assert.throws(() => store.create({ replyText: 'ok', keyword: 'k'.repeat(129) }), /keyword 不能超过 128/);
  assert.ok(store.create({ replyText: 'ok', keyword: 'k'.repeat(128) }));
  const catchAll = store.create({ replyText: 'ok', keyword: '   ' });
  assert.equal(catchAll.keyword, undefined);
});

test('create 校验：priority 超范围 / 非数字抛错', () => {
  const store = new AutoRuleStore();
  assert.throws(() => store.create({ replyText: 'ok', priority: -1 }), /priority/);
  assert.throws(() => store.create({ replyText: 'ok', priority: 1001 }), /priority/);
  assert.throws(() => store.create({ replyText: 'ok', priority: Number.NaN }), /priority/);
  assert.throws(() => store.create({ replyText: 'ok', priority: '100' as unknown as number }), /priority/);
  assert.equal(store.create({ replyText: 'ok', priority: 0 }).priority, 0);
  assert.equal(store.create({ replyText: 'ok', priority: 1000 }).priority, 1000);
});

test('create 校验：platform 非法值抛中文错误；enabled 非布尔抛错', () => {
  const store = new AutoRuleStore();
  assert.throws(() => store.create({ replyText: 'ok', platform: 'slack' as never }), /platform 必须是/);
  assert.throws(() => store.create({ replyText: 'ok', enabled: 'yes' as never }), /enabled 必须是布尔/);
  assert.equal(store.create({ replyText: 'ok', platform: Platform.MAIL }).platform, Platform.MAIL);
});

// ---------------------------------------------------------------------------
// update / remove / recordHit
// ---------------------------------------------------------------------------

test('update：部分字段更新，未传字段保持原值；不存在返回 undefined', () => {
  const store = new AutoRuleStore();
  const rule = store.create({ keyword: '发票', replyText: '原文案', priority: 200 });
  const updated = store.update(rule.id, { priority: 5, enabled: false });
  assert.ok(updated);
  assert.equal(updated.priority, 5);
  assert.equal(updated.enabled, false);
  assert.equal(updated.keyword, '发票', '未传的 keyword 保持原值');
  assert.equal(updated.replyText, '原文案');
  assert.equal(store.update('no-such-id', { priority: 1 }), undefined);
});

test('update：keyword 传空串 = 清空为兜底规则；非法 patch 抛中文错误', () => {
  const store = new AutoRuleStore();
  const rule = store.create({ keyword: '发票', replyText: '原文案' });
  const cleared = store.update(rule.id, { keyword: '' });
  assert.ok(cleared);
  assert.equal(cleared.keyword, undefined);
  assert.throws(() => store.update(rule.id, { priority: 9999 }), /priority/);
  assert.throws(() => store.update(rule.id, { replyText: '  ' }), /replyText 不能为空/);
});

test('update：replyText 超长抛错且原值不被破坏', () => {
  const store = new AutoRuleStore();
  const rule = store.create({ replyText: '原文案' });
  assert.throws(() => store.update(rule.id, { replyText: 'x'.repeat(2001) }), /replyText 不能超过 2000/);
  const cur = store.list().find((r) => r.id === rule.id)!;
  assert.equal(cur.replyText, '原文案');
});

test('remove：存在返回 true 并删除；再删返回 false', () => {
  const store = new AutoRuleStore();
  const rule = store.create({ replyText: '待删' });
  assert.equal(store.list().length, 1);
  assert.equal(store.remove(rule.id), true);
  assert.equal(store.list().length, 0);
  assert.equal(store.remove(rule.id), false);
});

test('recordHit：hitCount+1、lastHitAt 为当前 ISO；不存在返回 undefined', () => {
  const store = new AutoRuleStore();
  const rule = store.create({ replyText: '你好' });
  const hit = store.recordHit(rule.id);
  assert.ok(hit);
  assert.equal(hit.hitCount, 1);
  assert.ok(typeof hit.lastHitAt === 'string' && !Number.isNaN(Date.parse(hit.lastHitAt)));
  const again = store.recordHit(rule.id);
  assert.equal(again!.hitCount, 2);
  assert.equal(store.recordHit('no-such-id'), undefined);
});

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

test('持久化 round-trip：新仓库读到同一份规则（含命中统计）', () => {
  const file = tempFile('rules.json');
  const a = new AutoRuleStore(file);
  const r1 = a.create({ platform: Platform.FEISHU, keyword: '发票', replyText: '收到', priority: 10 });
  a.create({ platform: Platform.DINGTALK, keyword: '报价', replyText: '稍后', priority: 20 });
  a.recordHit(r1.id);
  a.recordHit(r1.id);

  const b = new AutoRuleStore(file);
  assert.equal(b.list().length, 2);
  const loaded = b.list().find((r) => r.id === r1.id)!;
  assert.equal(loaded.keyword, '发票');
  assert.equal(loaded.replyText, '收到');
  assert.equal(loaded.priority, 10);
  assert.equal(loaded.platform, Platform.FEISHU);
  assert.equal(loaded.hitCount, 2);
  assert.ok(loaded.lastHitAt);
  // 加载后的仓库匹配逻辑不变
  assert.equal(b.match(Platform.FEISHU, '开个发票')!.id, r1.id);
});

test('持久化：remove/update 也落盘', () => {
  const file = tempFile('rules-mutation.json');
  const a = new AutoRuleStore(file);
  const keep = a.create({ replyText: '保留' });
  const gone = a.create({ replyText: '删除' });
  a.remove(gone.id);
  a.update(keep.id, { priority: 7 });

  const b = new AutoRuleStore(file);
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].id, keep.id);
  assert.equal(b.list()[0].priority, 7);
});

test('坏文件静默降级：JSON 损坏 / 格式不对时按空规则启动并 console.warn，不抛错', () => {
  const broken = tempFile('broken.json');
  writeFileSync(broken, '{ this is not json !!!', 'utf8');
  const w1 = captureWarn();
  let store: AutoRuleStore;
  try {
    store = new AutoRuleStore(broken);
  } finally {
    w1.restore();
  }
  assert.equal(store.list().length, 0);
  assert.equal(w1.warnings.length, 1);
  assert.match(w1.warnings[0], /规则文件读取失败/);

  const wrongShape = tempFile('wrong-shape.json');
  writeFileSync(wrongShape, JSON.stringify({ hello: 'world' }), 'utf8');
  const w2 = captureWarn();
  let store2: AutoRuleStore;
  try {
    store2 = new AutoRuleStore(wrongShape);
  } finally {
    w2.restore();
  }
  assert.equal(store2.list().length, 0);
  assert.match(w2.warnings.join(''), /格式不正确/);
});

test('坏文件降级后仍可写入：降级不锁死仓库', () => {
  const file = tempFile('broken-then-write.json');
  writeFileSync(file, 'garbage!!!', 'utf8');
  const w = captureWarn();
  try {
    const store = new AutoRuleStore(file);
    const rule = store.create({ replyText: '降级后新建' });
    assert.equal(store.list().length, 1);
    // 重新打开应读到新建的规则（坏内容已被合法存档覆盖）
    const reloaded = new AutoRuleStore(file);
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.list()[0].id, rule.id);
  } finally {
    w.restore();
  }
});

test('文件缺失：静默按空规则启动（不 warn 不抛错），首次变更即建文件', () => {
  const file = tempFile('not-exist.json');
  const w = captureWarn();
  let store: AutoRuleStore;
  try {
    store = new AutoRuleStore(file);
    assert.equal(store.list().length, 0);
    assert.equal(w.warnings.length, 0, '文件缺失是正常初态，不该告警');
    store.create({ replyText: '第一条' });
  } finally {
    w.restore();
  }
  assert.ok(existsSync(file));
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).rules.length === 1);
});

test('原子写：变更后不留 .tmp 残留，落盘内容是合法 JSON', () => {
  const file = tempFile('atomic.json');
  const store = new AutoRuleStore(file);
  store.create({ replyText: '原子写' });
  assert.equal(existsSync(`${file}.tmp`), false, 'rename 后不应残留 .tmp');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.rules.length, 1);
});

test('目录不存在自动 mkdir -p：persistFile 在多级新目录下也能落盘', () => {
  const dir = makeTempDir('linkhub-auto-reply-mkdir-');
  dirs.push(dir);
  const file = join(dir, 'a', 'b', 'c', 'rules.json');
  const store = new AutoRuleStore(file);
  const rule = store.create({ replyText: '深层目录' });
  assert.ok(existsSync(file));
  const reloaded = new AutoRuleStore(file);
  assert.equal(reloaded.list()[0].id, rule.id);
});

test('未传 persistFile：纯内存仓库可用，且不影响持久化仓库', () => {
  const store = new AutoRuleStore();
  store.create({ replyText: '内存' });
  assert.equal(store.list().length, 1);
  // 空串 / 空白等价于不持久化
  const blank = new AutoRuleStore('   ');
  blank.create({ replyText: 'blank' });
  assert.equal(blank.list().length, 1);
});

test('mkdirSync 兼容：persistFile 指向已存在的目录也不报错', () => {
  const dir = makeTempDir('linkhub-auto-reply-existing-');
  dirs.push(dir);
  const file = join(dir, 'rules.json');
  mkdirSync(dir, { recursive: true });
  const store = new AutoRuleStore(file);
  assert.ok(store.create({ replyText: '已存在目录' }));
});
