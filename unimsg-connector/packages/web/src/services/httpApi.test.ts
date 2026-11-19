import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpApi } from './httpApi';
import { MsgStatus, Platform } from '../types';
import type { UnifiedMessage } from '../types';

const BASE = 'http://127.0.0.1:3001';
const TOKEN = 'dev-token';

function message(partial: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    traceId: 't-1',
    platform: Platform.FEISHU,
    externalId: 'e-1',
    sender: { id: 'u1', name: '张三' },
    type: 'text',
    body: 'hello world',
    status: MsgStatus.RECEIVED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function callArgs(fn: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  return fn.mock.calls[index] as unknown as [string, RequestInit];
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpApi', () => {
  it('list：解包信封、携带 Bearer 鉴权头、只下发 platform/status', async () => {
    const fn = mockFetch(jsonResponse({ ok: true, data: [message()] }));
    const api = new HttpApi(BASE, TOKEN);

    const list = await api.list({ platform: Platform.FEISHU, status: MsgStatus.RECEIVED, keyword: 'hello' });

    expect(list).toHaveLength(1);
    const [url, init] = callArgs(fn);
    // type/keyword/onlyReview 不下发给后端
    expect(url).toBe(`${BASE}/api/messages?platform=feishu&status=received`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('list：keyword 在本地过滤', async () => {
    const fn = mockFetch(
      jsonResponse({ ok: true, data: [message({ traceId: 'a', body: 'hello' }), message({ traceId: 'b', body: 'bye' })] }),
    );
    const api = new HttpApi(BASE, TOKEN);
    const list = await api.list({ keyword: 'hello' });
    expect(list.map((m) => m.traceId)).toEqual(['a']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('get：404 返回 undefined 而不是抛错', async () => {
    mockFetch(jsonResponse({ ok: false, error: 'not found' }, 404));
    const api = new HttpApi(BASE, TOKEN);
    expect(await api.get('missing')).toBeUndefined();
  });

  it('reply：POST text，解包 202 的 { message, taskId }', async () => {
    const fn = mockFetch(
      jsonResponse({ ok: true, message: message({ status: MsgStatus.REPLIED }), taskId: 't-1' }, 202),
    );
    const api = new HttpApi(BASE, TOKEN);

    const ack = await api.reply('t-1', '收到');

    expect(ack.taskId).toBe('t-1');
    expect(ack.message.status).toBe(MsgStatus.REPLIED);
    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/messages/t-1/reply`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ text: '收到' });
  });

  it('markDone：done 接口无消息体时，自动重取完整消息', async () => {
    const fn = mockFetch(
      jsonResponse({ ok: true }), // POST /done 只回 ok
      jsonResponse({ ok: true, data: message({ done: true }) }), // 重取 GET /messages/:id
    );
    const api = new HttpApi(BASE, TOKEN);

    const updated = await api.markDone('t-1');

    expect(updated.done).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(callArgs(fn, 0)[0]).toBe(`${BASE}/api/messages/t-1/done`);
    expect(callArgs(fn, 1)[0]).toBe(`${BASE}/api/messages/t-1`);
  });

  it('trace：解包 { data, log }', async () => {
    mockFetch(
      jsonResponse({
        ok: true,
        data: [message()],
        log: [{ traceId: 't-1', platform: 'feishu', status: 'received', event: 'received', at: new Date().toISOString() }],
      }),
    );
    const api = new HttpApi(BASE, TOKEN);
    const result = await api.trace('t-1');
    expect(result.data).toHaveLength(1);
    expect(result.log[0]?.event).toBe('received');
  });

  it('health：只保留计数字段，缺省补 0', async () => {
    mockFetch(jsonResponse({ ok: true, ts: '2026-11-03T00:00:00Z', received: 3, deduped: 1, sent: 1 }));
    const api = new HttpApi(BASE, TOKEN);
    const health = await api.health();
    expect(health).toEqual({ received: 3, deduped: 1, sent: 1, failed: 0, dlq: 0 });
  });

  it('health：透传后端 sentMock（模拟发送次数）', async () => {
    mockFetch(
      jsonResponse({ ok: true, received: 3, deduped: 1, sent: 2, sentMock: 1, failed: 0, dlq: 0 }),
    );
    const api = new HttpApi(BASE, TOKEN);
    const health = await api.health();
    expect(health.sent).toBe(2);
    expect(health.sentMock).toBe(1);
  });

  it('health：透传 startedAt / envFile（页面据此提示「.env 需重启」）', async () => {
    mockFetch(jsonResponse({
      ok: true,
      received: 1,
      deduped: 0,
      sent: 1,
      failed: 0,
      dlq: 0,
      startedAt: '2026-11-12T01:00:00.000Z',
      envFile: { path: 'C:\\proj\\unimsg-connector\\.env', mtime: '2026-11-12T01:05:00.000Z' },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const health = await api.health();
    expect(health.startedAt).toBe('2026-11-12T01:00:00.000Z');
    expect(health.envFile?.mtime).toBe('2026-11-12T01:05:00.000Z');
    expect(health.envFile?.path).toContain('.env');
  });

  it('health：旧后端没有新字段时不伪造（不提示重启）', async () => {
    mockFetch(jsonResponse({ ok: true, received: 0, deduped: 0, sent: 0, failed: 0, dlq: 0 }));
    const api = new HttpApi(BASE, TOKEN);
    const health = await api.health();
    expect(health.startedAt).toBeUndefined();
    expect(health.envFile).toBeUndefined();
  });

  it('health：envFile=null（无 .env）原样透传，不误报', async () => {
    mockFetch(jsonResponse({
      ok: true,
      received: 0,
      deduped: 0,
      sent: 0,
      failed: 0,
      dlq: 0,
      startedAt: '2026-11-12T01:00:00.000Z',
      envFile: null,
    }));
    const api = new HttpApi(BASE, TOKEN);
    const health = await api.health();
    expect(health.envFile).toBeNull();
  });

  it('accounts：解包四类数据源，保留邮箱嵌套账号与 mode/missing', async () => {
    const fn = mockFetch(
      jsonResponse({
        ok: true,
        data: [
          {
            platform: 'feishu',
            label: '飞书',
            configured: true,
            policy: 'auto',
            mode: 'real',
            canReceive: true,
            canSend: true,
            missing: [],
            warnings: ['未配置 FEISHU_ENCRYPT_KEY：仅支持未加密回调'],
            reason: '凭据齐全，auto → 真实接口',
          },
          {
            platform: 'mail',
            label: '邮箱',
            configured: true,
            policy: 'auto',
            mode: 'real',
            missing: [],
            issues: [{ level: 'warn', message: 'MAIL_WORK_PROVIDER=custom：请确认自定义 host' }],
            accounts: [
              {
                key: 'qq',
                label: 'QQ邮箱',
                address: 'me@qq.com',
                imapHost: 'imap.qq.com',
                smtpHost: 'smtp.qq.com',
                folders: ['INBOX'],
                mode: 'real',
              },
            ],
          },
        ],
      }),
    );
    const api = new HttpApi(BASE, TOKEN);
    const accounts = await api.accounts();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ platform: Platform.FEISHU, mode: 'real', canSend: true });
    // 能力缺口 / 配置问题也要原样透传给账号页
    expect(accounts[0]?.warnings?.[0]).toContain('FEISHU_ENCRYPT_KEY');
    expect(accounts[1]?.issues?.[0]).toMatchObject({ level: 'warn' });
    expect(accounts[1]?.accounts?.[0]).toMatchObject({
      key: 'qq',
      imapHost: 'imap.qq.com',
      folders: ['INBOX'],
    });
  });

  it('feishuOAuthStart：POST start 并返回授权 URL', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_x&state=s',
        redirectUri: 'http://localhost:3001/api/feishu/oauth/callback',
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const result = await api.feishuOAuthStart();

    expect(result.url).toContain('accounts.feishu.cn');
    expect(result.redirectUri).toContain('/api/feishu/oauth/callback');
    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/feishu/oauth/start`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('dingtalkPersonalLogin：POST login（透传 mode/force）并返回登录操作指引', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        started: true,
        mode: 'device',
        command: 'dws auth login --device',
        instructions: '在浏览器打开链接并输入设备码',
        url: 'https://login.dingtalk.com/device',
        code: 'ABCD-1234',
        expiresInSec: 900,
        expiresAt: '2026-11-12T10:15:00.000Z',
        loginId: 'login-1',
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const start = await api.dingtalkPersonalLogin({ mode: 'device', force: true });

    expect(start.mode).toBe('device');
    expect(start.code).toBe('ABCD-1234');
    expect(start.expiresInSec).toBe(900);
    expect(start.loginId).toBe('login-1');
    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/dingtalk/personal/login`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'device', force: true });
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('dingtalkPersonalLogin：不传参数时 body 为 {}，后端走 auto（优先浏览器 loopback）', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        started: true,
        mode: 'browser',
        command: 'dws auth login',
        instructions: '浏览器已打开授权页',
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    await api.dingtalkPersonalLogin();
    expect(JSON.parse(String(callArgs(fn)[1].body))).toEqual({});
  });

  it('dingtalkPersonalStatus：GET status，返回 authenticated 与登录中状态（可恢复弹窗）', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        available: true,
        version: 'v1.0.68-beta.1',
        authenticated: false,
        state: 'not_linked',
        hint: '未登录，请执行 dws auth login',
        loginCommand: 'dws auth login',
        loginInProgress: true,
        loginMode: 'device',
        loginUrl: 'https://login.dingtalk.com/oauth2/device',
        loginCode: 'REST-0001',
        loginExpiresAt: '2026-11-12T10:15:00.000Z',
        loginInstructions: '请继续完成上一次设备码登录。',
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const status = await api.dingtalkPersonalStatus();

    expect(status.authenticated).toBe(false);
    expect(status.loginCommand).toBe('dws auth login');
    expect(status.loginInProgress).toBe(true);
    expect(status.loginMode).toBe('device');
    expect(status.loginCode).toBe('REST-0001');
    expect(status.loginExpiresAt).toBe('2026-11-12T10:15:00.000Z');
    expect(callArgs(fn)[0]).toBe(`${BASE}/api/dingtalk/personal/status`);
  });

  it('dingtalkPersonalLogout：POST logout', async () => {
    const fn = mockFetch(jsonResponse({ ok: true, data: { ok: true, authenticated: false } }));
    const api = new HttpApi(BASE, TOKEN);

    await api.dingtalkPersonalLogout();

    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/dingtalk/personal/logout`);
    expect(init.method).toBe('POST');
  });

  it('accounts：原样透传 identity 身份视图（前端只渲染，不自行猜测）', async () => {
    mockFetch(jsonResponse({
      ok: true,
      data: [{
        platform: 'dingtalk',
        configured: true,
        mode: 'real',
        identity: {
          policy: 'auto',
          effectiveSend: 'user',
          effectiveReceive: 'user',
          user: {
            state: 'linked',
            linked: true,
            displayName: '陈晓',
            hint: '已连接',
            canLink: true,
            linkMethod: 'cli',
          },
          botAvailable: true,
          botHint: '机器人可用',
          receiveHint: '个人事件订阅',
          sendHint: '本人发送',
        },
      }],
    }));
    const api = new HttpApi(BASE, TOKEN);

    const accounts = await api.accounts();
    expect(accounts[0]?.identity?.effectiveSend).toBe('user');
    expect(accounts[0]?.identity?.user.displayName).toBe('陈晓');
  });

  it('401 映射为 ApiError（status=401）', async () => {
    mockFetch(jsonResponse({ ok: false, error: 'unauthorized' }, 401));
    const api = new HttpApi(BASE, 'bad-token');
    await expect(api.list()).rejects.toMatchObject({ name: 'ApiError', status: 401 });
  });

  it('登录接口的 401 透出后端原话，不清掉已有会话（旧口令错不该被踢下线）', async () => {
    const { setSession, resetSessionForTest } = await import('./session');
    resetSessionForTest();
    setSession({
      token: 'old-session',
      user: { id: 'u1', username: 'zhang', displayName: '张三', createdAt: '2026-01-01' },
    });
    mockFetch(jsonResponse({ ok: false, error: '用户名或口令不正确' }, 401));
    const api = new HttpApi(BASE, TOKEN);

    await expect(api.login({ username: 'zhang', password: 'wrong' })).rejects.toThrow('用户名或口令不正确');
    // 会话没有被清掉（登录失败的 401 不是"会话过期"）
    const session = await import('./session');
    expect(session.getSession()?.token).toBe('old-session');
    resetSessionForTest();
  });

  it('改口令的 401 透出“原口令不正确”，且不触发本地登出', async () => {
    const session = await import('./session');
    session.resetSessionForTest();
    session.setSession({
      token: 'live-session',
      user: { id: 'u1', username: 'zhang', displayName: '张三', createdAt: '2026-01-01' },
    });
    mockFetch(jsonResponse({ ok: false, error: '原口令不正确' }, 401));
    const api = new HttpApi(BASE, TOKEN);

    await expect(api.changePassword({ oldPassword: 'nope', newPassword: 'newpass123' })).rejects.toThrow('原口令不正确');
    expect(session.getSession()?.token).toBe('live-session');
    session.resetSessionForTest();
  });

  it('网络异常映射为 ApiError（status=0）', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fn);
    const api = new HttpApi(BASE, TOKEN);
    await expect(api.list()).rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });

  it('请求超时（AbortError）映射为可读的超时提示', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fn = vi.fn().mockRejectedValueOnce(abortErr);
    vi.stubGlobal('fetch', fn);
    const api = new HttpApi(BASE, TOKEN);
    await expect(api.list()).rejects.toMatchObject({
      name: 'ApiError',
      message: expect.stringContaining('超时'),
    });
  });
});

describe('授权中心 / 邮箱账号接口', () => {
  it('onboarding：GET /api/onboarding 解包并保留 steps 顺序字段', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        firstRun: true,
        dws: { available: true, source: 'tools', version: 'v1.0.68' },
        overall: { ready: 1, total: 4, needsAction: 3 },
        steps: [
          { id: 'mail', label: '邮箱', state: 'needs_user_auth', summary: '未添加邮箱', hints: [], actions: [] },
          { id: 'dingtalk', label: '钉钉', state: 'needs_install', summary: 'dws 未安装', hints: [], actions: [] },
        ],
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const view = await api.onboarding();

    expect(view.firstRun).toBe(true);
    expect(view.dws.source).toBe('tools');
    expect(view.steps.map((s) => s.id)).toEqual(['mail', 'dingtalk']);
    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/onboarding`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('onboarding：后端没有 data.steps 时抛中文错误（不把 undefined 传给页面）', async () => {
    mockFetch(jsonResponse({ ok: true, data: {} }));
    const api = new HttpApi(BASE, TOKEN);
    await expect(api.onboarding()).rejects.toThrow(/未返回授权中心数据/);
  });

  it('mailAccounts：兼容 data 数组 / data.accounts 包法，并过滤无 key 条目', async () => {
    const fn = mockFetch(
      jsonResponse({
        ok: true,
        data: [
          { key: 'local-1', maskedAddress: 'm***e@qq.com', source: 'file', provider: 'qq' },
          { key: 'env-1', address: 'z***n@163.com', source: 'env' },
          { address: 'broken@x.com', source: 'file' },
        ],
      }),
      jsonResponse({
        ok: true,
        data: { accounts: [{ key: 'local-2', source: 'file' }] },
      }),
    );
    const api = new HttpApi(BASE, TOKEN);

    const first = await api.mailAccounts();
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual({
      key: 'local-1',
      maskedAddress: 'm***e@qq.com',
      source: 'file',
      provider: 'qq',
    });
    expect(callArgs(fn)[0]).toBe(`${BASE}/api/mail/accounts`);

    const second = await api.mailAccounts();
    expect(second).toEqual([{ key: 'local-2', source: 'file' }]);
  });

  it('mailAccountTest：POST 请求体只含输入字段；兼容 imap/smtp 明细', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        ok: false,
        message: 'IMAP 登录失败：授权码无效',
        checks: { imap: { ok: false, message: '登录失败' }, smtp: { ok: true, message: '连接正常' } },
        details: ['请确认已开启 IMAP 服务'],
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const result = await api.mailAccountTest({
      provider: 'qq',
      address: 'me@qq.com',
      authCode: 'secret-code',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe('IMAP 登录失败：授权码无效');
    expect(result.details).toEqual(['IMAP：登录失败', 'SMTP：连接正常', '请确认已开启 IMAP 服务']);
    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/mail/accounts/test`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      provider: 'qq',
      address: 'me@qq.com',
      authCode: 'secret-code',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
    });
  });

  it('mailAccountCreate / mailAccountDelete：POST 落盘、DELETE 对 key 做 URL 编码', async () => {
    const fn = mockFetch(
      jsonResponse({ ok: true, data: { key: 'local-1' } }),
      jsonResponse({ ok: true }),
    );
    const api = new HttpApi(BASE, TOKEN);

    await api.mailAccountCreate({ provider: 'qq', address: 'me@qq.com', authCode: 'secret' });
    await api.mailAccountDelete('local/1');

    const [createUrl, createInit] = callArgs(fn, 0);
    expect(createUrl).toBe(`${BASE}/api/mail/accounts`);
    expect(createInit.method).toBe('POST');
    expect(JSON.parse(String(createInit.body))).toEqual({
      provider: 'qq',
      address: 'me@qq.com',
      authCode: 'secret',
    });

    const [deleteUrl, deleteInit] = callArgs(fn, 1);
    expect(deleteUrl).toBe(`${BASE}/api/mail/accounts/local%2F1`);
    expect(deleteInit.method).toBe('DELETE');
  });
});

describe('邮箱测试结果：后端真实形状（200 + ok:false + imap/smtp detail/hint）', () => {
  it('保留 200 响应里的失败明细与 hint，不把它当成网络/业务异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ok: false,
      address: 'm***e@qq.com',
      provider: 'qq',
      imap: { ok: false, detail: 'IMAP 登录失败：AUTHENTICATIONFAILED', hint: '请确认已开启 IMAP 并重新生成授权码' },
      smtp: { ok: true, detail: 'SMTP 登录成功' },
      checkedAt: '2026-11-12T06:40:00.000Z',
    })));
    const api = new HttpApi(BASE, TOKEN);

    const result = await api.mailAccountTest({ provider: 'qq', address: 'me@qq.com', authCode: 'x' });

    expect(result.ok).toBe(false);
    expect(result.details).toEqual([
      'IMAP：IMAP 登录失败：AUTHENTICATIONFAILED（请确认已开启 IMAP 并重新生成授权码）',
      'SMTP：SMTP 登录成功',
    ]);
  });
});

describe('平台应用配置 / 邮箱 verify 接口（白号 P0-1 / 邮箱 P0-3）', () => {
  it('getAppConfig：解包 data，FieldView 的 masked/source/envKey 与 platforms.missing 正确归一化', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        version: 1,
        identity: {
          feishu: { source: 'none', configured: false, envKey: 'FEISHU_IDENTITY', label: '身份' },
          dingtalk: { source: 'local', configured: true, value: 'user', envKey: 'DINGTALK_IDENTITY', label: '身份' },
        },
        modes: {
          feishu: { source: 'none', configured: false, value: 'mock' },
          mail: { source: 'local', configured: true, value: 'real' },
        },
        llm: { provider: { source: 'none', configured: false, envKey: 'LLM_PROVIDER', label: '提供方' } },
        platforms: {
          feishu: {
            configured: false,
            fields: {
              appId: { source: 'env', configured: true, masked: 'cli_****abcd', envKey: 'FEISHU_APP_ID', label: 'App ID' },
              appSecret: { source: 'none', configured: false, envKey: 'FEISHU_APP_SECRET', label: 'App Secret' },
            },
            missing: ['FEISHU_APP_SECRET', 'FEISHU_VERIFY_TOKEN'],
          },
          dingtalk: { configured: false, fields: {}, missing: [] },
          wecom: { configured: false, fields: {}, missing: [] },
        },
        restartRequired: true,
        envFile: { path: '.env', mtime: '2026-11-12T10:00:00.000Z' },
        settingsFile: { path: 'linkhub-config.json', present: true, mtime: '2026-11-12T10:05:00.000Z' },
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const view = await api.getAppConfig();

    expect(callArgs(fn)[0]).toBe(`${BASE}/api/app-config`);
    expect(view.identity.dingtalk).toBe('user');
    expect(view.identitySources?.dingtalk).toBe('local');
    expect(view.modes?.mail).toBe('real');
    expect(view.platforms.feishu.missing).toEqual(['FEISHU_APP_SECRET', 'FEISHU_VERIFY_TOKEN']);
    expect(view.platforms.feishu.fields.appId).toEqual({
      configured: true,
      display: 'cli_****abcd',
      source: 'env',
      key: 'FEISHU_APP_ID',
    });
    expect(view.platforms.feishu.fields.appSecret.configured).toBe(false);
    expect(view.restartRequired).toBe(true);
    expect(view.envFile?.path).toBe('.env');
    expect(view.settingsFile?.mtime).toBe('2026-11-12T10:05:00.000Z');
  });

  it('updateAppConfig：PUT 部分更新，解析 hotApplied / ignoredByEnv / warnings', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        saved: true,
        hotApplied: true,
        restartRequired: false,
        changedKeys: ['identity.dingtalk'],
        ignoredByEnv: ['FEISHU_APP_ID'],
        warnings: ['账号已保存但未验证'],
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const result = await api.updateAppConfig({ identity: { dingtalk: 'user' } });

    expect(result).toMatchObject({
      saved: true,
      hotApplied: true,
      restartRequired: false,
      changedKeys: ['identity.dingtalk'],
      ignoredByEnv: ['FEISHU_APP_ID'],
      warnings: ['账号已保存但未验证'],
    });
    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/app-config`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ identity: { dingtalk: 'user' } });
  });

  it('mailAccountVerify：POST :key/verify；失败 200 也能拿到 IMAP/SMTP 明细', async () => {
    const fn = mockFetch(jsonResponse({
      ok: false,
      verified: false,
      imap: { detail: 'AUTHENTICATIONFAILED', hint: '请重新生成授权码' },
      smtp: { detail: '连接成功' },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const result = await api.mailAccountVerify('local-1');

    expect(result.ok).toBe(false);
    expect(result.details).toEqual([
      'IMAP：AUTHENTICATIONFAILED（请重新生成授权码）',
      'SMTP：连接成功',
    ]);
    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/mail/accounts/local-1/verify`);
    expect(init.method).toBe('POST');
  });
});

describe('GET /api/app-config 契约对齐（二轮审计 P3 #8）', () => {
  it('settingsFile.mtime 允许 null：保留 path，不整体丢弃；stream 布尔 value 保留', async () => {
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: {
        identity: {},
        modes: {},
        llm: {},
        platforms: {
          feishu: {
            fields: {
              stream: { source: 'local', configured: true, value: true, envKey: 'FEISHU_STREAM', label: '长连接' },
            },
            missing: [],
          },
          dingtalk: { fields: {}, missing: [] },
          wecom: { fields: {}, missing: [] },
        },
        restartRequired: false,
        envFile: { path: '.env', mtime: null },
        settingsFile: { path: 'linkhub-config.json', present: false, mtime: null },
      },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const view = await api.getAppConfig();

    expect(callArgs(fn)[0]).toBe(`${BASE}/api/app-config`);
    expect(view.envFile).toEqual({ path: '.env', mtime: null });
    expect(view.settingsFile).toEqual({ path: 'linkhub-config.json', mtime: null });
    expect(view.platforms.feishu.fields.stream.value).toBe(true);
    expect(view.platforms.feishu.fields.stream.configured).toBe(true);
  });

  it('reanalyze：POST 正确端点，解包消息与 LLM 通道结论', async () => {
    const updated = message({ intent: '待办', intentSource: 'llm', aiProvider: '火山方舟' });
    const fn = mockFetch(jsonResponse({
      ok: true,
      data: updated,
      llm: { mode: 'real', reason: '真实大模型已就绪', providerLabel: '火山方舟' },
    }));
    const api = new HttpApi(BASE, TOKEN);

    const result = await api.reanalyze('t-1');

    const [url, init] = callArgs(fn);
    expect(url).toBe(`${BASE}/api/messages/t-1/reanalyze`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(result.message.intent).toBe('待办');
    expect(result.llm.mode).toBe('real');
    expect(result.llm.providerLabel).toBe('火山方舟');
  });

  it('reanalyze：旧后端只回 {ok:true} 时重取消息兜底', async () => {
    const fn = mockFetch(
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true, data: message({ intent: '咨询' }) }),
    );
    const api = new HttpApi(BASE, TOKEN);

    const result = await api.reanalyze('t-1');

    expect(result.message.intent).toBe('咨询');
    expect(result.llm.mode).toBe('mock');
    expect(callArgs(fn, 1)[0]).toBe(`${BASE}/api/messages/t-1`);
  });
});
