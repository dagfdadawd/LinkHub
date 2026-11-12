/**
 * 服务入口：装配依赖 → 创建应用 → 挂 WebSocket → 监听端口。
 */
import http from 'node:http';
import { Platform } from '@unimsg/shared';
import { createApp, formatListenError, parseCorsOrigins } from './app';
import { config, modeOf } from './config';
import { DEFAULT_DEV_TOKEN, apiTokenWarning, productionTokenBlocker, resolveApiToken } from './middlewares/auth';
import { InMemoryRepository } from './db/repository';
import { connectors } from './connectors/registry';
import { maskAddress } from './services/account';
import { LlmService } from './services/llm';
import { OcrService } from './services/ocr';
import { RateLimiter } from './services/rateLimiter';
import { MessageService } from './services/message';
import { startDingtalkStream } from './stream/dingtalkStream';
import { startFeishuStream } from './stream/feishuStream';
import { reloadMailPoller, startMailPoller, stopMailPoller } from './stream/mailPoller';
import { initMailAccounts } from './services/mailAccounts';
import {
  IDENTITY_CHANNELS_RECONCILE_MS,
  initIdentityChannels,
  reconcileIdentityChannels,
} from './services/identityChannels';
import { identityStartupLines, warmIdentityProbes } from './services/identity';
import { maybeAutoEnableDingtalkPersonalIdentity } from './services/personalIdentity';
import { dingtalkPersonalClient } from './connectors/dingtalkPersonal';
import { initWs, wsBroadcast } from './ws';

// 空 API_TOKEN 视同未配置 → 回退 dev-token（绝不因此关闭鉴权）
const effectiveToken = resolveApiToken(config.apiToken);

// 生产环境安全闸门：拒绝把默认演示令牌带到线上（宁可启动失败，也不裸奔）。
// 传原始 env 值，便于区分「API_TOKEN 没填/空串」与「还写着 dev-token」。
const tokenBlocker = productionTokenBlocker(process.env.API_TOKEN, process.env.NODE_ENV);
if (tokenBlocker) {
  console.error(`[unimsg] ${tokenBlocker}`);
  process.exit(1);
}

// DATA_DIR/DATA_FILE 存在时启用文件快照：容器重启后收件箱与全链路回放仍可复现
const repo = new InMemoryRepository(config.dataFile);
const svc = new MessageService(
  repo,
  connectors,
  new LlmService(),
  new OcrService(),
  new RateLimiter(config.sendMaxRetry, config.retryBaseMs),
  wsBroadcast,
);

/**
 * 邮箱账号「运行时导入」初始化：
 *  - 启动时把本地文件（DATA_DIR/mail-accounts.json 或 .linkhub-mail-accounts.json）并入 config.mail.accounts；
 *  - 运行期增删账号 → 热加载：已有轮询器则立刻补跑一轮；启动时因无账号没起来的话，按需拉起（仅真实模式）。
 * 个人版用户因此不需要改 .env / 重启后端。
 */
const mailAccountsStore = initMailAccounts({
  onChange: () => {
    // P0-3：账号增删/验证后 config.runtime[MAIL] 已重算；据此启停/热加载轮询，无需重启
    const mailReal = config.runtime[Platform.MAIL].mode === 'real';
    if (!mailReal || config.mail.accounts.length === 0) {
      stopMailPoller();
      return;
    }
    if (!reloadMailPoller('邮箱账号变更')) {
      // 典型场景：启动时没有任何可用账号 → startMailPoller 当时直接跳过；运行中账号可用后按需启动。
      startMailPoller(svc);
    }
  },
});
void mailAccountsStore;

const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS);
const app = createApp(svc, { corsOrigins });
const server = http.createServer(app);
const wss = initWs(server);

/** 启动时把"每个平台现在走真实还是 Mock、缺什么"打印成人话 */
function logRuntime(): void {
  const rows = Object.values(Platform).map((p) => {
    const r = config.runtime[p];
    const cap = `${r.canReceive ? '收✓' : '收✗'} ${r.canSend ? '发✓' : '发✗'}`;
    return `${r.label}=${r.mode}(${r.policy}) ${cap}`;
  });
  console.log(`[unimsg] 运行模式: ${rows.join(' | ')}`);
  for (const p of Object.values(Platform)) {
    const r = config.runtime[p];
    for (const w of r.warnings) console.warn(`[unimsg] ${r.label}: ${w}`);
  }
  for (const w of config.modeWarnings) console.warn(`[unimsg] 配置提示: ${w}`);
  const missing = Object.values(Platform)
    .map((p) => ({ r: config.runtime[p], names: config.runtime[p].missing }))
    .filter((x) => x.r.mode === 'real' && x.r.missing.length > 0);
  for (const x of missing) {
    console.warn(`[unimsg] ${x.r.label} 真实模式缺配置: ${x.names.join(' / ')}（可运行 pnpm run doctor 自检）`);
  }
  if (config.mail.accounts.length > 0) {
    // 地址脱敏后再打印：日志会被贴进 issue/截图，绝不暴露完整邮箱
    console.log(`[unimsg] 邮箱账号: ${config.mail.accounts.map((a) => `${a.label}<${maskAddress(a.address)}>[${a.folders.join(',')}]`).join(' / ')}`);
  }
  // 大模型也如实标注通道：real 才真正调用，mock 是内置规则（绝不打印 Key）
  console.log(
    config.llm.mode === 'real'
      ? `[unimsg] 大模型: ${config.llm.model} @ ${config.llm.endpoint}（真实调用，超时 ${config.llm.timeoutMs}ms）`
      : `[unimsg] 大模型: 规则识别（${config.llm.reason}）`,
  );
  console.log('[unimsg] 自检: pnpm run doctor（凭据/网络/出口IP/修复建议一文看清）');
}

/**
 * 监听地址：不填 = Node 默认（等价监听所有网卡，Docker / 局域网演示保持原行为）；
 * 需要收紧暴露面时设 SERVER_HOST=127.0.0.1，只允许本机访问。
 */
const listenHost = process.env.SERVER_HOST?.trim() || undefined;
const displayHost = !listenHost || listenHost === '0.0.0.0' || listenHost === '::'
  ? '127.0.0.1'
  : listenHost;

// 端口占用/权限不足等启动失败必须说人话，而不是甩一段英文调用栈。
// 注意 ws 库会把 http server 的 'error' 转发到 WebSocketServer，两边都要挂监听，
// 否则会变成 unhandled 'error' 的英文栈。
const onListenError = (err: NodeJS.ErrnoException): void => {
  console.error(formatListenError(err, config.port));
  process.exit(1);
};
server.on('error', onListenError);
wss.on('error', onListenError);

server.listen(config.port, listenHost, () => {
  const store = config.dataFile ? `file-snapshot(${config.dataFile})` : 'memory';
  console.log(`[unimsg] server listening on ${listenHost ?? '0.0.0.0'}:${config.port} (store=${store})`);
  console.log(`[unimsg] 本机访问: http://${displayHost}:${config.port}`);
  if (config.webDist) console.log(`[unimsg] 同源托管前端: ${config.webDist}`);
  console.log(`[unimsg] auth=Bearer ${effectiveToken === DEFAULT_DEV_TOKEN ? 'dev-token(默认/空值回退)' : '***'}`);
  const tokenWarning = apiTokenWarning(config.apiToken);
  if (tokenWarning) {
    console.warn('[unimsg] ============================================================');
    console.warn(`[unimsg] ⚠️ 安全警告：${tokenWarning}`);
    console.warn('[unimsg] ============================================================');
  }
  if (corsOrigins) {
    console.log(`[unimsg] CORS 白名单: ${corsOrigins.join(', ')}（未列出的浏览器 Origin 会被 403）`);
  }
  logRuntime();
});

if (config.dingtalkStream) {
  if (modeOf(Platform.DINGTALK) === 'real') {
    startDingtalkStream(svc).catch((e) => {
      console.error('[stream] 启动失败:', e instanceof Error ? e.message : e);
    });
  } else {
    console.log('[stream] 钉钉当前为 Mock 模式，跳过 Stream 长连接（DINGTALK_MODE=real 才会连）');
  }
}

if (config.platforms.feishu.stream) {
  if (modeOf(Platform.FEISHU) === 'real') {
    startFeishuStream(svc).catch((e) => {
      console.error('[feishu-stream] 启动失败:', e instanceof Error ? e.message : e);
    });
  } else {
    console.log('[feishu-stream] 飞书当前为 Mock 模式，跳过长连接（FEISHU_MODE=real 才会连）');
  }
}

startMailPoller(svc);

// ---------------------------------------------------------------------------
// 本人身份通道（飞书用户轮询 / 钉钉 dws 个人事件）
//
// 由 IdentityChannelsCoordinator 统一按「当前身份是否可用」start/stop：
//  - 启动 warm 之后 align 一次；运行中完成登录（浏览器授权成功）也会自动启动接收通道；
//  - 平台为模拟模式 / 未连接本人身份 → 不起任何真实通道（契约 §1、§10.2）；
//  - 30–60s 兜底 reconcile：登录可能在本机终端外部完成，没有回调可依赖。
// ---------------------------------------------------------------------------
const identityChannels = initIdentityChannels(svc);

void (async () => {
  await warmIdentityProbes().catch((e) => {
    console.warn('[unimsg] 身份探测失败（不影响其他平台）：', e instanceof Error ? e.message : e);
  });
  for (const line of identityStartupLines()) console.log(line);
  // ① 启动 warm 之后对齐一次
  await identityChannels.reconcile();
  // 登录子进程结束（通常是浏览器授权成功）→ 若尚无机器人凭据且身份策略为 auto，
  // 自动热应用「仅本人身份」（未完成授权/未登录则什么都不改），再对齐接收通道
  dingtalkPersonalClient().setLoginFinishedHandler(() => {
    void (async () => {
      await maybeAutoEnableDingtalkPersonalIdentity('dws 登录会话结束').catch(() => undefined);
      reconcileIdentityChannels('钉钉登录会话结束');
    })();
  });
  // ⑥ 兜底定时 reconcile（unref：不阻塞进程退出）
  const timer = setInterval(() => reconcileIdentityChannels('定时对齐'), IDENTITY_CHANNELS_RECONCILE_MS);
  timer.unref?.();
})().catch((e) => {
  console.error('[unimsg] 本人身份通道启动失败（其他平台不受影响）：', e instanceof Error ? e.message : e);
});

/** 优雅关闭：先停个人身份子进程/轮询（Windows 下 taskkill 树），再关 HTTP/WS，绝不残留子进程 */
let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[unimsg] 收到 ${reason}，正在停止本人身份接收器与子进程…`);
  try {
    stopMailPoller();
    await identityChannels.stopAll();
    dingtalkPersonalClient().dispose();
  } catch (e) {
    console.warn('[unimsg] 停止身份接收器时出错（继续关闭）：', e instanceof Error ? e.message : e);
  }
  server.close(() => process.exit(0));
  // 兜底：5s 内没退干净就强制退出（例如平台长连接卡住）
  const forced = setTimeout(() => process.exit(0), 5_000);
  forced.unref?.();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
