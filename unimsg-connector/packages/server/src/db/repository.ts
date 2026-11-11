/**
 * 数据层（仓储模式）。
 *
 * 默认【纯内存】：零依赖跑起来，本地演示 / 单测无任何副作用。
 * 传入 `persistFile`（或设置 DATA_DIR / DATA_FILE）后启用【文件快照】：
 * 消息、闭环日志、幂等表、死信队列在每次变更后原子落盘，重启自动恢复。
 * 这补上了原先「重启即清空 → 全链路回放不可复现」的缺口，
 * 让独立部署（Docker 挂载卷）后赛题要求的「每一步可追踪、可回放」依然成立。
 *
 * 后续接 Postgres 时只需新增一个实现同一接口的 PgRepository，业务代码一行不改。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { UnifiedMessage, TraceEntry, Platform, MsgStatus } from '@unimsg/shared';

export interface DlqEntry {
  platform: Platform;
  payload: unknown;
  reason: string;
  at: string;
}

export interface MessageRepository {
  save(msg: UnifiedMessage): void;
  get(id: string): UnifiedMessage | undefined;
  /** 按 (platform, externalId) 查重，支撑幂等 */
  findByExternal(platform: Platform, externalId: string): UnifiedMessage | undefined;
  list(filter?: { platform?: Platform; status?: MsgStatus }): UnifiedMessage[];
  update(id: string, patch: Partial<UnifiedMessage>): UnifiedMessage | undefined;
  appendTrace(e: TraceEntry): void;
  getLoopLog(traceId: string): TraceEntry[];
  pushDlq(e: DlqEntry): void;
  listDlq(): DlqEntry[];
}

interface Snapshot {
  version: 1;
  savedAt: string;
  messages: UnifiedMessage[];
  externals: Array<[string, string]>;
  traces: Array<[string, TraceEntry[]]>;
  dlq: DlqEntry[];
}

export class InMemoryRepository implements MessageRepository {
  private byId = new Map<string, UnifiedMessage>();
  private byExternal = new Map<string, string>(); // `${platform}:${externalId}` -> traceId
  private traces = new Map<string, TraceEntry[]>();
  private dlq: DlqEntry[] = [];

  /** @param persistFile 快照文件绝对路径；空串 = 纯内存模式 */
  constructor(private readonly persistFile = '') {
    if (persistFile) this.load();
  }

  private load(): void {
    if (!existsSync(this.persistFile)) return;
    try {
      const snap = JSON.parse(readFileSync(this.persistFile, 'utf8')) as Snapshot;
      if (snap.version !== 1 || !Array.isArray(snap.messages)) {
        console.warn(`[repo] 快照版本不兼容，忽略并从空状态启动：${this.persistFile}`);
        return;
      }
      this.byId = new Map(snap.messages.map((m) => [m.traceId, m]));
      this.byExternal = new Map(snap.externals ?? []);
      this.traces = new Map(snap.traces ?? []);
      this.dlq = snap.dlq ?? [];
      console.log(`[repo] 已恢复闭环数据：${this.byId.size} 条消息 · ${snap.savedAt}`);
    } catch (e) {
      // 快照损坏不能拖垮启动：宁可从空状态起来，也不要现场演示打不开
      console.warn(`[repo] 快照读取失败，从空状态启动：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 先写临时文件再原子 rename，避免容器被强杀时留下半截 JSON */
  private persist(): void {
    if (!this.persistFile) return;
    try {
      mkdirSync(dirname(this.persistFile), { recursive: true });
      const snap: Snapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        messages: [...this.byId.values()],
        externals: [...this.byExternal.entries()],
        traces: [...this.traces.entries()],
        dlq: this.dlq,
      };
      const tmp = `${this.persistFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(snap), 'utf8');
      renameSync(tmp, this.persistFile);
    } catch (e) {
      console.warn(`[repo] 快照写入失败（不影响本次运行）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  save(msg: UnifiedMessage): void {
    this.byId.set(msg.traceId, msg);
    this.byExternal.set(`${msg.platform}:${msg.externalId}`, msg.traceId);
    if (!this.traces.has(msg.traceId)) this.traces.set(msg.traceId, []);
    this.persist();
  }

  get(id: string): UnifiedMessage | undefined {
    return this.byId.get(id);
  }

  findByExternal(platform: Platform, externalId: string): UnifiedMessage | undefined {
    const id = this.byExternal.get(`${platform}:${externalId}`);
    return id ? this.byId.get(id) : undefined;
  }

  list(filter?: { platform?: Platform; status?: MsgStatus }): UnifiedMessage[] {
    let items = [...this.byId.values()];
    if (filter?.platform) items = items.filter((i) => i.platform === filter.platform);
    if (filter?.status) items = items.filter((i) => i.status === filter.status);
    return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  update(id: string, patch: Partial<UnifiedMessage>): UnifiedMessage | undefined {
    const cur = this.byId.get(id);
    if (!cur) return undefined;
    const next: UnifiedMessage = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.byId.set(id, next);
    this.persist();
    return next;
  }

  appendTrace(e: TraceEntry): void {
    const arr = this.traces.get(e.traceId) ?? [];
    arr.push(e);
    this.traces.set(e.traceId, arr);
    this.persist();
  }

  getLoopLog(traceId: string): TraceEntry[] {
    return this.traces.get(traceId) ?? [];
  }

  pushDlq(e: DlqEntry): void {
    this.dlq.push(e);
    this.persist();
  }

  listDlq(): DlqEntry[] {
    return [...this.dlq];
  }
}
