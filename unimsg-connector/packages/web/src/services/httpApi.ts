/**
 * 真实后端适配器：实现 MessageApi，对接 packages/server 的 REST 接口。
 *
 * 与 MockApi 的三点差异全部封装在本文件内，页面与 store 零感知：
 *  1. 信封解包：后端统一返回 { ok, data, ... }，这里统一取出 data；
 *  2. 入口鉴权：所有请求携带 Authorization: Bearer <API_TOKEN>；
 *  3. markDone：后端 done 接口只回 {ok:true}（完整消息走 WS 广播），
 *     这里在 POST 成功后重取一次消息返回，双保险兜住状态一致性。
 *
 * 筛选约定：后端 /api/messages 仅支持 platform/status 两个查询参数，
 * type / keyword / onlyReview 在本地补齐（与 AppStore 的本地过滤一致）。
 */
import type {
  ComposeAck, ComposeRequest, OutboundAttachment, SendCapabilities,
} from '@unimsg/shared';
import type { TraceEntry, UnifiedMessage } from '../types';
import type {
  AccountInfo,
  DingtalkLoginStart,
  DingtalkPersonalStatus,
  FeishuOAuthStart,
  HealthInfo,
  MessageApi,
  MessageFilter,
  ReplyAck,
  TraceResult,
} from './api';
import { sortMessages } from '../utils/format';

/** 后端业务错误：携带 HTTP 状态码，便于上层按 401/404 等分类处理 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class HttpApi implements MessageApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, private readonly token: string, timeoutMs = 8_000) {
    // 去掉末尾斜杠，避免拼出 //api 这种双斜杠路径
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    // 请求超时兜底：后端/网络异常时不让 UI 永久 loading
    this.timeoutMs = timeoutMs;
  }

  async list(filter?: MessageFilter): Promise<UnifiedMessage[]> {
    const params = new URLSearchParams();
    if (filter?.platform) params.set('platform', filter.platform);
    if (filter?.status) params.set('status', filter.status);
    const qs = params.toString();
    const body = await this.request<{ data?: UnifiedMessage[] }>(`/api/messages${qs ? `?${qs}` : ''}`);

    let items = body.data ?? [];
    // 后端不支持的筛选维度在本地补齐
    if (filter?.type) items = items.filter((m) => m.type === filter.type);
    if (filter?.onlyReview) items = items.filter((m) => Boolean(m.needsReview));
    if (filter?.keyword) {
      const k = filter.keyword.trim().toLowerCase();
      items = items.filter(
        (m) =>
          m.body.toLowerCase().includes(k) ||
          m.sender.name.toLowerCase().includes(k) ||
          m.traceId.toLowerCase().includes(k) ||
          (m.intent ?? '').toLowerCase().includes(k),
      );
    }
    return sortMessages(items);
  }

  async get(id: string): Promise<UnifiedMessage | undefined> {
    try {
      const body = await this.request<{ data?: UnifiedMessage }>(`/api/messages/${encodeURIComponent(id)}`);
      return body.data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return undefined;
      throw e;
    }
  }

  async reply(id: string, text: string, attachments?: OutboundAttachment[]): Promise<ReplyAck> {
    // 后端返回 202 { ok, message, taskId }，入队即返回，sent/synced 走 WS 推送
    const body = await this.request<{ message: UnifiedMessage; taskId: string }>(
      `/api/messages/${encodeURIComponent(id)}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
      },
    );
    return { message: body.message, taskId: body.taskId };
  }

  async compose(req: ComposeRequest): Promise<ComposeAck> {
    const body = await this.request<{ message: UnifiedMessage; taskId: string }>(
      '/api/messages/compose',
      { method: 'POST', body: JSON.stringify(req) },
    );
    return { message: body.message, taskId: body.taskId };
  }

  async capabilities(): Promise<SendCapabilities[]> {
    const body = await this.request<{ data?: SendCapabilities[] }>('/api/capabilities');
    return body.data ?? [];
  }

  async feishuOAuthStart(): Promise<FeishuOAuthStart> {
    const body = await this.request<{ data?: FeishuOAuthStart }>(
      '/api/feishu/oauth/start',
      { method: 'POST', body: '{}' },
    );
    if (!body.data?.url) throw new ApiError('后端未返回飞书授权地址', 0);
    return body.data;
  }

  async dingtalkPersonalLogin(): Promise<DingtalkLoginStart> {
    // 后端会立即返回（后台拉起 dws 登录），不会阻塞 HTTP 线程
    const body = await this.request<{ data?: DingtalkLoginStart }>(
      '/api/dingtalk/personal/login',
      { method: 'POST', body: '{}' },
    );
    if (!body.data) throw new ApiError('后端未返回钉钉登录指引', 0);
    return body.data;
  }

  async dingtalkPersonalStatus(): Promise<DingtalkPersonalStatus> {
    const body = await this.request<{ data?: DingtalkPersonalStatus }>(
      '/api/dingtalk/personal/status',
    );
    if (!body.data) throw new ApiError('后端未返回钉钉身份状态', 0);
    return body.data;
  }

  async dingtalkPersonalLogout(): Promise<void> {
    await this.request('/api/dingtalk/personal/logout', { method: 'POST', body: '{}' });
  }

  async markDone(id: string): Promise<UnifiedMessage> {
    // 后端只回 {ok:true}；完整消息同时经 WS 广播，这里重取一次作为兜底（幂等）
    await this.request(`/api/messages/${encodeURIComponent(id)}/done`, { method: 'POST', body: '{}' });
    const updated = await this.get(id);
    if (!updated) throw new ApiError('资源不存在', 404);
    return updated;
  }

  async trace(id: string): Promise<TraceResult> {
    const body = await this.request<{ data?: UnifiedMessage[]; log?: TraceEntry[] }>(
      `/api/messages/trace/${encodeURIComponent(id)}`,
    );
    return { data: body.data ?? [], log: body.log ?? [] };
  }

  async accounts(): Promise<AccountInfo[]> {
    const body = await this.request<{ data?: AccountInfo[] }>('/api/accounts');
    return body.data ?? [];
  }

  async health(): Promise<HealthInfo> {
    // /api/health 为公共接口，返回 { ok, ts, received, deduped, sent, failed, dlq, sentMock?, startedAt?, envFile? }
    const body = await this.request<Partial<HealthInfo>>('/api/health');
    return {
      received: body.received ?? 0,
      deduped: body.deduped ?? 0,
      sent: body.sent ?? 0,
      failed: body.failed ?? 0,
      dlq: body.dlq ?? 0,
      // 仅在后端返回时透传：旧后端没有该字段时不要伪装成 0 次模拟发送
      ...(typeof body.sentMock === 'number' ? { sentMock: body.sentMock } : {}),
      // 指标口径与「.env 改动需重启」提示依赖这两个字段；旧后端缺失时前端不提示
      ...(typeof body.startedAt === 'string' ? { startedAt: body.startedAt } : {}),
      ...(body.envFile === null || (body.envFile && typeof body.envFile === 'object')
        ? { envFile: body.envFile as { path: string; mtime: string } | null }
        : {}),
    };
  }

  /** 统一请求入口：鉴权头 + 超时控制 + 信封解包 + 错误码映射 */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        throw new ApiError('请求超时，请检查后端服务状态', 0);
      }
      // 网络层异常（后端未启动 / 断网 / CORS 拒绝）
      throw new ApiError('无法连接后端服务，请确认服务已启动', 0);
    } finally {
      clearTimeout(timer);
    }

    const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;

    if (res.status === 401) throw new ApiError('未授权：API Token 无效或缺失', 401);
    if (res.status === 404) throw new ApiError('资源不存在', 404);
    if (!res.ok) throw new ApiError(String(body?.error ?? `请求失败（HTTP ${res.status}）`), res.status);
    if (body && body.ok === false) throw new ApiError(String(body.error ?? '业务处理失败'), res.status);

    return (body ?? {}) as T;
  }
}
