/**
 * 前端 ↔ 后端契约自检（可复用）。
 *
 * 目的：把 HttpApi / WsRealtime 对后端形状的所有假设变成可执行断言，
 * 防止后端改动后前端「静默错位」。不管理后端进程，需先启动 server。
 *
 * 覆盖：health 计数字段 + 四平台实际通道 modes、accounts 的
 * mode/policy/missing/canReceive/canSend 与邮箱多账号、reply 后的
 * delivery.mode 投递方式、trace 闭环日志、WS 握手。
 *
 * 用法：
 *   pnpm --filter @unimsg/server start            # 另开终端
 *   node scripts/verify-contract.mjs [baseUrl] [token]
 *
 * 默认 baseUrl=http://127.0.0.1:3001，token=dev-token（与后端 API_TOKEN 一致）
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
const token = process.argv[3] ?? 'dev-token';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` | ${extra}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
}

async function req(method, path, { body, auth = true, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { status: res.status, data };
}

async function waitReady(timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      // 服务尚未起来
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`后端未在 ${timeoutMs / 1000}s 内就绪：${base}`);
}

async function checkWebSocket() {
  if (typeof WebSocket === 'undefined') {
    console.log('SKIP  WebSocket（当前 Node 未提供全局 WebSocket，请在浏览器联调时验证）');
    return;
  }
  await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      check('WS /ws 握手收到 connected', ok, msg);
      try {
        ws.close();
      } catch {
        // 已关闭
      }
      resolve();
    };
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data));
        if (parsed.type === 'connected') finish(true, 'connected');
      } catch {
        // 忽略非 JSON 帧
      }
    };
    ws.onerror = () => finish(false, '连接错误');
    ws.onclose = (ev) => finish(false, `关闭码 ${ev.code}`);
    setTimeout(() => finish(false, '3s 超时'), 3_000);
  });
}

async function main() {
  await waitReady();

  // 1. health（公共接口，HttpApi 解包后取计数字段与平台通道）
  const health = await req('GET', '/api/health', { auth: false });
  check('GET /api/health → {ok} + 计数字段', health.status === 200 && health.data?.ok === true);
  for (const key of ['received', 'deduped', 'sent', 'failed', 'dlq', 'sentMock']) {
    check(`health 含 ${key}`, key in (health.data ?? {}));
  }
  // 本次实际通道必须公开可见：评审 curl 一下就知道哪些平台是真接口、哪些是 Mock
  const modes = health.data?.modes ?? {};
  check('health 含 modes（各平台实际通道）', Object.keys(modes).length > 0);
  for (const platform of ['feishu', 'dingtalk', 'wechat', 'mail']) {
    check(
      `health.modes.${platform} ∈ real|mock`,
      modes[platform] === 'real' || modes[platform] === 'mock',
      String(modes[platform]),
    );
  }

  // 2. 灌一条飞书消息（webhook 走平台签名，不用 Bearer）
  const payload = {
    schema: '2.0',
    event: {
      message: {
        message_id: `om_contract_${Date.now()}`,
        message_type: 'text',
        content: JSON.stringify({ text: '契约自检消息' }),
        sender: { sender_id: { user_id: 'u_contract' } },
      },
    },
  };
  const hook = await req('POST', '/api/webhook/feishu', {
    body: payload,
    auth: false,
    headers: { 'x-signature': 'mock' },
  });
  check('POST /api/webhook/feishu → {ok}', hook.status === 200 && hook.data?.ok === true);

  // 3. 鉴权：无 token 必须 401
  const noAuth = await req('GET', '/api/messages', { auth: false });
  check('GET /api/messages 无 token → 401', noAuth.status === 401);

  // 4. list 信封
  const list = await req('GET', '/api/messages');
  const messages = list.data?.data ?? [];
  check('GET /api/messages → {ok, data: []}', list.status === 200 && Array.isArray(messages));
  check('list 至少 1 条消息', messages.length >= 1, `count=${messages.length}`);
  const id = messages[0]?.traceId;
  check('消息含 traceId', Boolean(id));

  // 5. accounts 信封 + 契约形状（HttpApi.accounts / 账号页逐项依赖）
  const accounts = await req('GET', '/api/accounts');
  const accountList = accounts.data?.data ?? [];
  check(
    'GET /api/accounts → {ok, data: [...]}',
    accounts.status === 200 &&
      accounts.data?.ok === true &&
      Array.isArray(accountList) &&
      accountList.length > 0,
    `count=${accountList.length}`,
  );
  // 每项都必须带「本次实际通道 / 策略 / 缺失变量 / 收发能力」——账号页据此打 Tag 与告警
  for (const field of ['mode', 'policy', 'missing', 'canReceive', 'canSend']) {
    check(
      `accounts 每项含 ${field}`,
      accountList.length > 0 && accountList.every((a) => field in a),
    );
  }
  check('accounts 每项 mode ∈ real|mock', accountList.every((a) => a.mode === 'real' || a.mode === 'mock'));
  check(
    'accounts 每项 policy ∈ auto|real|mock',
    accountList.every((a) => ['auto', 'real', 'mock'].includes(a.policy)),
  );
  check('accounts 每项 missing 为数组', accountList.every((a) => Array.isArray(a.missing)));
  check(
    'accounts 四平台齐全',
    ['feishu', 'dingtalk', 'wechat', 'mail'].every((p) => accountList.some((a) => a.platform === p)),
    accountList.map((a) => a.platform).join(','),
  );
  // 邮箱是多账号数据源：mail 项必须带 accounts 数组，前端账号页展示每个邮箱明细
  const mailAccount = accountList.find((a) => a.platform === 'mail');
  check('accounts 含 mail 且带 accounts 数组', Boolean(mailAccount) && Array.isArray(mailAccount?.accounts));
  if (Array.isArray(mailAccount?.accounts) && mailAccount.accounts.length > 0) {
    for (const field of ['key', 'address', 'imapHost', 'smtpHost', 'folders']) {
      check(`mail.accounts[] 每项含 ${field}`, mailAccount.accounts.every((m) => field in m));
    }
    check(
      'mail.accounts[] 每项 mode ∈ real|mock',
      mailAccount.accounts.every((m) => m.mode === 'real' || m.mode === 'mock'),
    );
  }

  // 5.1 本人身份视图（飞书 / 钉钉）：账号页身份块直接渲染这份数据，
  // 字段缺失或枚举漂移会让「谁在收、谁在发」显示空白/错误。
  const IDENTITY_FIELDS = [
    'policy', 'effectiveSend', 'effectiveReceive', 'user',
    'botAvailable', 'botHint', 'receiveHint', 'sendHint',
  ];
  const USER_FIELDS = ['state', 'linked', 'hint', 'canLink', 'linkMethod'];
  for (const platform of ['feishu', 'dingtalk']) {
    const account = accountList.find((a) => a.platform === platform);
    const identity = account?.identity;
    check(`accounts.${platform} 含 identity 身份视图`, Boolean(identity));
    if (!identity) continue;
    for (const field of IDENTITY_FIELDS) {
      check(`accounts.${platform}.identity 含 ${field}`, field in identity);
    }
    check(
      `accounts.${platform}.identity.effectiveSend ∈ user|bot|mock`,
      ['user', 'bot', 'mock'].includes(identity.effectiveSend),
      String(identity.effectiveSend),
    );
    check(
      `accounts.${platform}.identity.effectiveReceive ∈ user|bot|mock`,
      ['user', 'bot', 'mock'].includes(identity.effectiveReceive),
      String(identity.effectiveReceive),
    );
    for (const field of USER_FIELDS) {
      check(`accounts.${platform}.identity.user 含 ${field}`, field in (identity.user ?? {}));
    }
    // Mock 平台不得声称本人/机器人真实通道（契约 §1）
    if (account.mode === 'mock') {
      check(
        `accounts.${platform} Mock 模式 effectiveSend/Receive 均为 mock`,
        identity.effectiveSend === 'mock' && identity.effectiveReceive === 'mock',
      );
    }
  }

  // 5.2 钉钉本人身份登录状态（只读，不触发登录）：账号页 2s 轮询依赖它
  const dtStatus = await req('GET', '/api/dingtalk/personal/status');
  check(
    'GET /api/dingtalk/personal/status → {ok, data:{available,authenticated,hint}}',
    dtStatus.status === 200 &&
      dtStatus.data?.ok === true &&
      typeof dtStatus.data?.data?.available === 'boolean' &&
      typeof dtStatus.data?.data?.authenticated === 'boolean' &&
      typeof dtStatus.data?.data?.hint === 'string',
  );

  if (!id) return;

  // 6. reply 202 回执（HttpApi.reply 依赖 message + taskId）
  const reply = await req('POST', `/api/messages/${encodeURIComponent(id)}/reply`, {
    body: { text: '契约自检回复' },
  });
  check('POST reply → 202 {ok, message, taskId}', reply.status === 202 && Boolean(reply.data?.taskId));
  check('reply 回执状态为 replied', reply.data?.message?.status === 'replied');

  // 7. 异步回写推进到 synced（WS 场景的最终态），并核对 delivery 投递方式
  let status = '';
  let finalMessage;
  for (let i = 0; i < 20; i += 1) {
    const one = await req('GET', `/api/messages/${encodeURIComponent(id)}`);
    finalMessage = one.data?.data;
    status = finalMessage?.status ?? '';
    if (status === 'synced' || status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  check('回写后状态推进到 synced', status === 'synced', `status=${status}`);
  // Mock / 真实都必须如实写 delivery.mode，前端据此标注「模拟发送（未调用真实平台）」
  check(
    'reply 后消息含 delivery.mode ∈ real|mock',
    ['real', 'mock'].includes(finalMessage?.delivery?.mode),
    String(finalMessage?.delivery?.mode),
  );
  check('reply 后消息含 delivery.at（ISO 时间）', typeof finalMessage?.delivery?.at === 'string');

  // 8. done 只回 {ok}（HttpApi.markDone 必须重取，验证前提）
  const done = await req('POST', `/api/messages/${encodeURIComponent(id)}/done`, { body: {} });
  check('POST done → {ok} 且无消息体', done.status === 200 && done.data?.ok === true && !('data' in (done.data ?? {})));

  // 9. trace 信封（HttpApi.trace 依赖 data + log）
  const trace = await req('GET', `/api/messages/trace/${encodeURIComponent(id)}`);
  const events = (trace.data?.log ?? []).map((e) => e.event);
  check('GET trace → {ok, data, log}', trace.status === 200 && Array.isArray(trace.data?.log));
  for (const ev of ['received', 'replied', 'sent', 'synced']) {
    check(`trace 含 ${ev}`, events.includes(ev), events.join(','));
  }

  // 9.5 人工处理动作 / 自动回复 / 看板 / 通用接入 / 诊断（2026-11 新增契约）
  // 注意：全部用 mock 安全路径（不带 notify=true、不触发真实外发），
  // 与既有 reply 断言同风险口径——本脚本应在本地/mock 服务上运行。
  // 状态/优先级/转发都用「本次 ingest 的新消息」：第 7 节的 id 已经 synced，再测前进会被判倒退。
  if (id) {
    // 通用接入：首推 duplicate=false，重推 duplicate=true；traceId 撞键 400
    const ingestBody = {
      platform: 'feishu',
      externalId: `ext_contract_${Date.now()}`,
      body: '契约自检：外部采集器消息',
      sender: { id: 'collector', name: '采集器' },
    };
    const ig1 = await req('POST', '/api/ingest', { body: ingestBody });
    check(
      'POST ingest → 202 {ok, data:{message, duplicate:false}}',
      ig1.status === 202 && ig1.data?.data?.duplicate === false && typeof ig1.data?.data?.message?.traceId === 'string',
    );
    const ig2 = await req('POST', '/api/ingest', { body: ingestBody });
    check('POST ingest 重推 → duplicate:true', ig2.status === 202 && ig2.data?.data?.duplicate === true);
    const igClash = await req('POST', '/api/ingest', {
      body: { ...ingestBody, externalId: `ext_contract_clash_${Date.now()}`, traceId: id },
    });
    check('POST ingest traceId 撞既有消息 → 400', igClash.status === 400 && igClash.data?.ok === false);
    const freshId = ig1.data?.data?.message?.traceId;

    if (freshId) {
      // 状态流转（不带回执）：前进成功 + 倒退 400
      const st = await req('PATCH', `/api/messages/${encodeURIComponent(freshId)}/status`, {
        body: { status: 'processing' },
      });
      check(
        'PATCH status → 200 {ok, data:{message, notified:false}}',
        st.status === 200 &&
          st.data?.ok === true &&
          st.data?.data?.message?.status === 'processing' &&
          st.data?.data?.notified === false,
        JSON.stringify(st.data?.data)?.slice(0, 80),
      );
      const stBack = await req('PATCH', `/api/messages/${encodeURIComponent(freshId)}/status`, {
        body: { status: 'received' },
      });
      check('PATCH status 倒退 → 400 {ok:false,error}', stBack.status === 400 && stBack.data?.ok === false);

      // 优先级：{ok, data:{message, old, source:'manual'}}
      const pr = await req('PATCH', `/api/messages/${encodeURIComponent(freshId)}/priority`, {
        body: { priority: 'urgent' },
      });
      check(
        'PATCH priority → 200 {ok, data:{message.priority, old, source}}',
        pr.status === 200 &&
          pr.data?.data?.message?.priority === 'urgent' &&
          pr.data?.data?.message?.prioritySource === 'manual' &&
          typeof pr.data?.data?.old === 'string',
      );
      const prBad = await req('PATCH', `/api/messages/${encodeURIComponent(freshId)}/priority`, {
        body: { priority: 'sooner' },
      });
      check('PATCH priority 非法值 → 400', prBad.status === 400);

      // 跨平台转发（202 + 来源标记；正文由后端拼接，前端 ForwardModal 依赖）
      const fwd = await req('POST', `/api/messages/${encodeURIComponent(freshId)}/forward`, {
        body: { platform: 'dingtalk' },
      });
      check(
        'POST forward → 202 {ok, message.platform, body 含 [转发自 feishu]}',
        fwd.status === 202 &&
          fwd.data?.message?.platform === 'dingtalk' &&
          String(fwd.data?.message?.body ?? '').includes('[转发自 feishu]'),
      );
    }

    // 自动回复规则 CRUD：POST 201 → GET 可见 → PATCH 清空 keyword → DELETE
    // （keyword 用带时间戳的随机串，避免命中任何消息触发真实外发）
    const ruleKey = `zz-contract-${Date.now()}`;
    const ruleCreate = await req('POST', '/api/auto-rules', {
      body: { keyword: ruleKey, replyText: '契约自检规则', priority: 500, enabled: false },
    });
    check(
      'POST auto-rules → 201 {ok, data:{id, hitCount:0}}',
      ruleCreate.status === 201 && typeof ruleCreate.data?.data?.id === 'string' && ruleCreate.data?.data?.hitCount === 0,
    );
    const ruleId = ruleCreate.data?.data?.id;
    if (ruleId) {
      const ruleList = await req('GET', '/api/auto-rules');
      check(
        'GET auto-rules → {ok, data:[...]} 含新建规则',
        ruleList.status === 200 && Array.isArray(ruleList.data?.data) && ruleList.data.data.some((r) => r.id === ruleId),
      );
      const ruleClear = await req('PATCH', `/api/auto-rules/${encodeURIComponent(ruleId)}`, {
        body: { keyword: '' },
      });
      check(
        'PATCH auto-rules keyword="" → 清空为兜底',
        ruleClear.status === 200 && !ruleClear.data?.data?.keyword,
        String(ruleClear.data?.data?.keyword),
      );
      const ruleDel = await req('DELETE', `/api/auto-rules/${encodeURIComponent(ruleId)}`);
      check('DELETE auto-rules → {ok:true}', ruleDel.status === 200 && ruleDel.data?.ok === true);
    }

    // 统计看板（全局聚合口径；avgHandleSeconds 允许 null）
    const stats = await req('GET', '/api/stats/overview');
    check(
      'GET stats/overview → {ok, data:{totals, byPlatform×4, rules}}',
      stats.status === 200 &&
        typeof stats.data?.data?.totals?.messages === 'number' &&
        Array.isArray(stats.data?.data?.byPlatform) &&
        stats.data.data.byPlatform.length === 4 &&
        typeof stats.data?.data?.rules?.total === 'number' &&
        (stats.data?.data?.avgHandleSeconds === null || typeof stats.data?.data?.avgHandleSeconds === 'number'),
    );

    // 只读诊断摘要：四平台通道齐全
    const diag = await req('GET', '/api/doctor/summary');
    check(
      'GET doctor/summary → {ok, data.platforms×4}',
      diag.status === 200 && Array.isArray(diag.data?.data?.platforms) && diag.data.data.platforms.length === 4,
    );
  }

  // 10. WS 握手
  await checkWebSocket();
}

main()
  .catch((e) => {
    console.error(`FAIL  契约自检异常：${e instanceof Error ? e.message : String(e)}`);
    failed += 1;
  })
  .finally(() => {
    console.log(`\n契约自检：${passed} PASS / ${failed} FAIL`);
    // 不用 process.exit()：Windows + Node 24 下若 fetch/WebSocket 句柄还在关闭中，
    // 强制退出会触发 libuv 断言（0xC0000409，退出码 -1073740791），让 CI/脚本误判。
    // 设置 exitCode 让进程自然收尾；10s 兜底防挂死。
    const code = failed > 0 ? 1 : 0;
    process.exitCode = code;
    const watchdog = setTimeout(() => process.exit(code), 10_000);
    watchdog.unref?.();
  });
