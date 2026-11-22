/**
 * 自动回复规则仓库（赛题 A 官方闭环：「自动或人工回复」里的「自动」那一半）。
 *
 * 纯存储组件：只管规则的增删改查、匹配与命中统计，不感知消息服务——
 * 由调用方（接线层）在收到消息时调用 match() 拿到命中的规则并回写 replyText。
 *
 * 匹配刻意做得朴素（与 shared 里 AutoRule 的注释同一原则）：
 * platform 过滤 + keyword 不区分大小写包含 + priority 升序。
 * keyword 为空 = 该平台的兜底规则；platform 未设置 = 所有平台。
 * 不用正则 / 语义匹配：规则要能在答辩现场一句话解释清楚。
 *
 * 持久化：persistFile 非空时构造即读；每次变更后原子写
 * （先写 `${file}.tmp` 再 rename，进程中途被杀也不会留下半截 JSON）。
 * 文件缺失或 JSON 损坏时静默降级为空仓库（console.warn，不抛错）——
 * 一份损坏的规则文件不能挡住整个服务启动。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Platform, type AutoRule, type AutoRuleInput } from '@unimsg/shared';

/** replyText 上限：自动回复也是一条正文，与人工回复同一量级 */
const REPLY_TEXT_MAX = 2000;
/** keyword 上限：关键词是一小段话，不是一篇正文 */
const KEYWORD_MAX = 128;
/** priority 范围：0 最先匹配 */
export const AUTO_RULE_PRIORITY_MIN = 0;
export const AUTO_RULE_PRIORITY_MAX = 1000;
export const AUTO_RULE_PRIORITY_DEFAULT = 100;

const ALL_PLATFORMS = Object.values(Platform) as string[];

/** 校验并归一化平台字段；未传返回 undefined（= 所有平台） */
function normalizePlatform(raw: unknown): Platform | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !ALL_PLATFORMS.includes(raw)) {
    throw new Error(`platform 必须是 ${ALL_PLATFORMS.join(' / ')} 之一`);
  }
  return raw as Platform;
}

/** 校验并归一化 keyword：trim 后为空 = 兜底规则（存 undefined） */
function normalizeKeyword(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('keyword 必须是字符串');
  const kw = raw.trim();
  if (kw.length === 0) return undefined;
  if (kw.length > KEYWORD_MAX) throw new Error(`keyword 不能超过 ${KEYWORD_MAX} 字符`);
  return kw;
}

/** 校验 replyText：trim 后非空且 <=2000（自动回复总得有话可回） */
function normalizeReplyText(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('replyText 不能为空：自动回复需要至少一句回复内容');
  }
  const text = raw.trim();
  if (text.length > REPLY_TEXT_MAX) {
    throw new Error(`replyText 不能超过 ${REPLY_TEXT_MAX} 字符`);
  }
  return text;
}

/** 校验 priority：0..1000 的有限数字，默认 100（数字越小越先匹配） */
function normalizePriority(raw: unknown): number {
  if (raw === undefined || raw === null) return AUTO_RULE_PRIORITY_DEFAULT;
  if (typeof raw !== 'number' || !Number.isFinite(raw)
    || raw < AUTO_RULE_PRIORITY_MIN || raw > AUTO_RULE_PRIORITY_MAX) {
    throw new Error(
      `priority 必须是 ${AUTO_RULE_PRIORITY_MIN}..${AUTO_RULE_PRIORITY_MAX} 之间的数字`,
    );
  }
  return raw;
}

/** 校验 enabled：缺省 true；显式传入必须是布尔 */
function normalizeEnabled(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'boolean') throw new Error('enabled 必须是布尔值');
  return raw;
}

/** 把 AutoRuleInput 校验成 AutoRule 的非生成字段（id/hitCount/createdAt 等由仓库生成） */
function normalizeInput(input: AutoRuleInput): Pick<AutoRule, 'platform' | 'keyword' | 'replyText' | 'priority' | 'enabled'> {
  return {
    platform: normalizePlatform(input.platform),
    keyword: normalizeKeyword(input.keyword),
    replyText: normalizeReplyText(input.replyText),
    priority: normalizePriority(input.priority),
    enabled: normalizeEnabled(input.enabled),
  };
}

/** 磁盘上的存档形状（版本号留个口子，未来加字段不至于读崩） */
interface AutoRuleFile {
  version: 1;
  rules: AutoRule[];
}

export class AutoRuleStore {
  private readonly rules: AutoRule[] = [];
  private readonly persistFile?: string;

  /** pending 写入期间不再重复发起写盘（同步 fs 实际不会重入，防御性保留） */
  private saving = false;

  constructor(persistFile?: string) {
    const file = persistFile?.trim();
    if (file) this.persistFile = file;
    if (this.persistFile) this.load();
  }

  // ---------- 持久化 ----------

  /** 构造时读取；文件缺失/损坏静默降级为空仓库，绝不抛错挡启动 */
  private load(): void {
    const file = this.persistFile!;
    if (!existsSync(file)) return;
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AutoRuleFile> | AutoRule[];
      // 兼容两种存档：带版本号的对象 / 裸数组
      const list = Array.isArray(parsed) ? parsed : parsed.rules;
      if (!Array.isArray(list)) {
        console.warn(`[autoReply] 规则文件格式不正确，已按空规则启动：${file}`);
        return;
      }
      for (const r of list) {
        // 逐条宽容恢复：单条字段缺失就补默认，不因为一条脏数据丢掉整个库；
        // 但 replyText 缺失/为空的条目必须跳过——它是自动回复的最低要求
        if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
        if (typeof r.replyText !== 'string' || r.replyText.trim().length === 0) continue;
        this.rules.push({
          id: r.id,
          platform: r.platform,
          keyword: r.keyword,
          replyText: typeof r.replyText === 'string' ? r.replyText : '',
          priority: typeof r.priority === 'number' ? r.priority : AUTO_RULE_PRIORITY_DEFAULT,
          enabled: r.enabled !== false,
          hitCount: typeof r.hitCount === 'number' ? r.hitCount : 0,
          ...(typeof r.lastHitAt === 'string' ? { lastHitAt: r.lastHitAt } : {}),
          createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
        });
      }
    } catch (e) {
      console.warn(
        `[autoReply] 规则文件读取失败（JSON 损坏？），已按空规则启动：${file}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }

  /** 原子写：先写 `${file}.tmp` 再 rename；目录不存在自动创建 */
  private persist(): void {
    const file = this.persistFile;
    if (!file || this.saving) return;
    this.saving = true;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const payload: AutoRuleFile = { version: 1, rules: this.rules };
      writeFileSync(`${file}.tmp`, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      // 降级对齐 InMemoryRepository.persist：磁盘错误（文件被占用/磁盘满）只告警不抛出。
      // persist 在接入热路径上被 recordHit 调用——抛出去会让 webhook 回 500（平台重推），
      // 且消息已被 autoReplied 去重挡住，重推也永远不会再自动回复。内存态保持正确，仅丢落盘。
      console.warn(
        `[autoReply] 规则落盘失败（内存态不受影响）：${file}（${e instanceof Error ? e.message : String(e)}）`,
      );
    } finally {
      this.saving = false;
    }
  }

  // ---------- CRUD ----------

  list(): AutoRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  create(input: AutoRuleInput): AutoRule {
    const normalized = normalizeInput(input);
    const rule: AutoRule = {
      id: randomUUID(),
      ...normalized,
      hitCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.rules.push(rule);
    this.persist();
    return { ...rule };
  }

  update(id: string, patch: Partial<AutoRuleInput>): AutoRule | undefined {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return undefined;
    // 只应用显式提供的字段：没传的字段保持原值
    const next: Pick<AutoRule, 'platform' | 'keyword' | 'replyText' | 'priority' | 'enabled'> = {
      platform: rule.platform,
      keyword: rule.keyword,
      replyText: rule.replyText,
      priority: rule.priority,
      enabled: rule.enabled,
    };
    if ('platform' in patch) next.platform = normalizePlatform(patch.platform);
    if ('keyword' in patch) next.keyword = normalizeKeyword(patch.keyword);
    if ('replyText' in patch) next.replyText = normalizeReplyText(patch.replyText);
    if ('priority' in patch) next.priority = normalizePriority(patch.priority);
    if ('enabled' in patch) next.enabled = normalizeEnabled(patch.enabled);
    rule.platform = next.platform;
    rule.keyword = next.keyword;
    rule.replyText = next.replyText;
    rule.priority = next.priority;
    rule.enabled = next.enabled;
    this.persist();
    return { ...rule };
  }

  remove(id: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    this.rules.splice(idx, 1);
    this.persist();
    return true;
  }

  // ---------- 匹配与命中 ----------

  /**
   * 返回第一条命中的规则：
   *  - 只考虑 enabled；
   *  - 规则未设置 platform = 对所有平台生效；
   *  - 规则 keyword 为空 = 该平台兜底（任何正文都命中）；
   *  - 否则 keyword 不区分大小写做 includes；
   *  - 排序 priority 升序、再 createdAt 升序，返回第一条。
   */
  match(platform: Platform, text: string): AutoRule | undefined {
    const candidates = this.rules
      .filter((r) => r.enabled)
      .filter((r) => r.platform === undefined || r.platform === platform)
      .filter((r) => {
        if (!r.keyword) return true; // keyword 为空 = 兜底规则
        return text.toLowerCase().includes(r.keyword.toLowerCase());
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
      });
    const hit = candidates[0];
    return hit ? { ...hit } : undefined;
  }

  /** 记录一次命中：hitCount+1、lastHitAt=当前时间并落盘（看板据此举证「规则真的在用」） */
  recordHit(id: string): AutoRule | undefined {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return undefined;
    rule.hitCount += 1;
    rule.lastHitAt = new Date().toISOString();
    this.persist();
    return { ...rule };
  }
}
