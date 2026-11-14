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
/** 图片回声的窗口更短：回推很快，窗口太长会误吞对方紧接着发来的图 */
const MEDIA_ECHO_WINDOW_MS = 60_000;
/** 登记表上限：只保留最近若干条，避免长时间运行无限增长 */
const MAX_SENT_RECORDS = 200;

export interface SentRecord {
  platform: string;
  conversationId?: string;
  /** 归一化后的文本（去首尾空白 + 折叠内部空白） */
  text: string;
  /**
   * 本次发送带上的文件名（原样，不含目录）。
   * 纯附件消息没有文本，只能靠文件名认回声——否则自己发的文件会被
   * 平台回推进来，在聊天里多出一条 `[文件] xxx fileId: …` 的乱码消息。
   */
  fileNames?: string[];
  /**
   * 本次发送内联了几张图片。
   * 图片消息回推时只有 `[图片消息](mediaId=…)`，既没有文本也没有文件名，
   * 只能靠「刚发过带图消息」这一点认出来，否则聊天里会把同一张图再显示一遍。
   */
  mediaCount?: number;
  /** 已被消费过的媒体回声不再重复匹配（一次发送只吞一条回推） */
  mediaConsumed?: boolean;
  at: number;
  traceId?: string;
}

export interface EchoMatchInput {
  platform: string;
  conversationId?: string;
  text: string;
  /** 本次回推消息的附件名（用于纯附件消息的回声识别） */
  fileNames?: string[];
  /** 这条回推是不是「只有媒体、没有正文」的图片消息（用于图片回声） */
  mediaOnly?: boolean;
  now?: number;
}

/** 文件名归一：去目录、去首尾空白、小写（Windows 大小写不敏感，平台回推可能改大小写） */
function normalizeFileName(name: string): string {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.trim().toLowerCase();
}

export function normalizeEchoText(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    // 发送时写的是 Markdown 内联图（本地路径），钉钉回推时会变成 [图片消息](mediaId=…)。
    // 不做这一步归一化，带图回复的回声永远匹配不上，聊天里会多出一条乱码消息。
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[(?:图片|文件)消息\]\s*\(\s*mediaId=[^)]*\)/gi, ' ')
    // 文件消息的另一套回推模板：[文件] 名称 fileId: xxx 注意：如需下载使用 dws drive download 命令下载
    .replace(/\[(?:文件|图片|视频|语音)\][^\n]*?fileId\s*[:：]\s*\S+(?:\s*注意\s*[:：][^\n]*)?/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
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
  const files = (input.fileNames ?? []).map(normalizeFileName).filter(Boolean);
  // 纯附件消息没有文本：只看文件名，否则永远判不出回声
  if (!text && files.length === 0 && !input.mediaOnly) return undefined;
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const rec = sent[i];
    if (rec.platform !== input.platform) continue;
    if (now - rec.at > ECHO_WINDOW_MS || now < rec.at - ECHO_WINDOW_MS) continue;
    if (rec.conversationId && input.conversationId && rec.conversationId !== input.conversationId) continue;
    const textHit = Boolean(text) && rec.text === text;
    const fileHit = files.length > 0
      && (rec.fileNames ?? []).some((n) => files.includes(normalizeFileName(n)));
    /**
     * 图片回声：回推只有 `[图片消息](mediaId=…)`，归一化后文本为空、也没有文件名。
     * 用「刚发过带图消息」认一次，并立刻标记已消费——一次发送只吞一条回推，
     * 避免把对方紧接着发来的图也误吞。
     */
    const mediaHit = Boolean(input.mediaOnly)
      && !rec.mediaConsumed
      && (rec.mediaCount ?? 0) > 0
      && now - rec.at <= MEDIA_ECHO_WINDOW_MS;
    if (!textHit && !fileHit && !mediaHit) continue;
    if (mediaHit) rec.mediaConsumed = true;
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