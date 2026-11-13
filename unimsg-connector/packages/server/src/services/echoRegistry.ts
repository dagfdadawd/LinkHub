/**
 * 本人消息识别（钉钉个人事件回声处理）。
 *
 * 背景：钉钉个人事件会把「自己刚发出的消息」重新推送一遍。官方的 `dws contact user
 * get-self` 只返回 userId / orgUserName，**不返回 openDingTalkId**，所以没法像飞书那样
 * 按 sender open_id 直接过滤（见 docs/personal-identity.md §5.6 的已知限制）。
 *
 * 这里用两条互补的规则，不改平台、不改接口契约：
 *  1. **回声匹配**：我们自己发出去的消息会登记 (会话 + 归一化文本 + 时间)。
 *     个人事件里出现同会话、同文本、且在时间窗内的消息 → 判定为自己的回声，
 *     不再入库（那条内容已经作为 response 的 reply 挂在原消息上）。
 *  2. **本人 ID 学习**：命中回声时顺手把该事件的 `sender_open_dingtalk_id` 记为「本人」并持久化。
 *     之后**你在手机钉钉上直接发**的消息（没有发送记录可匹配）也能被识别成 direction=out，
 *     渲染在会话右侧，不会顶起未读。
 *
 * 进程内是纯内存 Map / Set；学习到的 ID 落盘（DATA_DIR 可用时），重启不丢。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config';

/** 回声判定时间窗：发送成功到事件回推通常 1~5 秒，留 120 秒足够宽松又不误伤 */
export const ECHO_WINDOW_MS = 120_000;
/** 登记表上限：只保留最近若干条，避免长时间运行无限增长 */
const MAX_SENT_RECORDS = 200;

export interface SentRecord {
  platform: string;
  conversationId?: string;
  /** 归一化后的文本（去首尾空白 + 折叠内部空白） */
  text: string;
  at: number;
  traceId?: string;
}

export interface EchoMatchInput {
  platform: string;
  conversationId?: string;
  text: string;
  now?: number;
}

export function normalizeEchoText(text: string): string {
  return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
}

const sent: SentRecord[] = [];

/** 登记一条「刚发出」的消息（只对真实发送有意义；Mock 不会产生回声） */
export function rememberSent(record: SentRecord): void {
  sent.push(record);
  if (sent.length > MAX_SENT_RECORDS) sent.splice(0, sent.length - MAX_SENT_RECORDS);
}

/**
 * 匹配回声：同平台 + 同会话 + 同文本 + 时间窗内。
 * 只按文本去重是错误的（同一句话发两次是合法的），必须三者同时命中。
 */
export function matchEcho(input: EchoMatchInput): SentRecord | undefined {
  const now = input.now ?? Date.now();
  const text = normalizeEchoText(input.text);
  if (!text) return undefined;
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const rec = sent[i];
    if (rec.platform !== input.platform) continue;
    if (now - rec.at > ECHO_WINDOW_MS || now < rec.at - ECHO_WINDOW_MS) continue;
    if (rec.conversationId && input.conversationId && rec.conversationId !== input.conversationId) continue;
    if (rec.text !== text) continue;
    return rec;
  }
  return undefined;
}

/** 已学习的本人 ID（按平台隔离：目前只有钉钉需要） */
const selfIds = new Map<string, Set<string>>();

function selfFile(): string {
  const stateFile = config.dataFile;
  if (stateFile) return join(dirname(stateFile), 'self-identity.json');
  return join(process.cwd(), '.linkhub-self-identity.json');
}

let loaded = false;

function loadSelfIds(): void {
  if (loaded) return;
  loaded = true;
  // 单测进程不读写本机真实文件：避免开发机的本人 ID 污染测试结果
  if (config.underTest) return;
  try {
    const file = selfFile();
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [platform, ids] of Object.entries(raw)) {
      if (!Array.isArray(ids)) continue;
      selfIds.set(platform, new Set(ids.filter((v): v is string => typeof v === 'string' && v.length > 0)));
    }
  } catch {
    // 文件损坏不影响收消息：只是少了「本人 ID」这一层过滤
  }
}

function persistSelfIds(): void {
  if (config.underTest) return;
  try {
    const file = selfFile();
    mkdirSync(dirname(file), { recursive: true });
    const out: Record<string, string[]> = {};
    for (const [platform, ids] of selfIds) out[platform] = [...ids];
    writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  } catch {
    // 落盘失败不阻断业务（内存里仍然生效）
  }
}

/** 记住一个「本人」ID（命中回声时调用），幂等 */
export function learnSelfId(platform: string, id: string | undefined): boolean {
  loadSelfIds();
  const value = (id ?? '').trim();
  if (!value) return false;
  const set = selfIds.get(platform) ?? new Set<string>();
  if (set.has(value)) return false;
  set.add(value);
  selfIds.set(platform, set);
  persistSelfIds();
  return true;
}

export function isSelfId(platform: string, id: string | undefined): boolean {
  loadSelfIds();
  const value = (id ?? '').trim();
  if (!value) return false;
  return selfIds.get(platform)?.has(value) ?? false;
}

/** 已学习到的本人 ID（启动时用它把历史消息补标成 direction=out） */
export function learnedSelfIds(platform: string): string[] {
  loadSelfIds();
  return [...(selfIds.get(platform) ?? [])];
}

/** 单测用：清空内存状态 */
export function resetEchoState(): void {
  sent.length = 0;
  selfIds.clear();
  loaded = true;
}