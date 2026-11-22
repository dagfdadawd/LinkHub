/**
 * Express 应用工厂：健康检查（公共）、Webhook（平台验签）、业务接口（Bearer 鉴权）。
 *
 * 启动体验相关（CORS 白名单 / 监听错误人话提示）也放在这里：
 * 都是无副作用的纯函数，index.ts 与单测共用，避免为了测试去 import 有启动副作用的入口文件。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import cors from 'cors';
import { MessageService } from './services/message';
import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { webhookRouter } from './routes/webhook';
import { messagesRouter } from './routes/messages';
import { feishuOAuthCallbackRouter, feishuOAuthRouter } from './routes/feishuOAuth';
import { dingtalkPersonalRouter } from './routes/dingtalkPersonal';
import { onboardingRouter } from './routes/onboarding';
import { wechatPullRouter } from './routes/wechatPull';
import { wechatBridgeRouter } from './routes/wechatBridge';
import { mailAccountsRouter } from './routes/mailAccounts';
import { appConfigRouter } from './routes/appConfig';
import { contactsRouter } from './routes/contacts';
import { autoRulesRouter } from './routes/autoRules';
import { ingestRouter } from './routes/ingest';
import { statsRouter } from './routes/stats';
import { diagnosticsRouter } from './routes/diagnostics';
import { doctorRouter, type DoctorRouterDeps } from './routes/doctor';
import type { AutoRuleStore } from './services/autoReply';
import type { StatsSource } from './services/stats';
import { apiAuth, ownerOnly } from './middlewares/auth';
import { config } from './config';

/**
 * 解析 CORS_ORIGINS（逗号分隔）。不填/全是空白 → null，表示保持 `*` 全放行（兼容本地演示）。
 * 例：CORS_ORIGINS=http://localhost:5173,https://demo.example.com
 */
export function parseCorsOrigins(raw: string | undefined): string[] | null {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * 白名单模式下，带 Origin 的跨域请求必须是名单内的才放行；
 * 没有 Origin 的请求（curl / 服务端到服务端 / 同源）一律放行，否则会误伤现有调用方。
 */
function corsWhitelistGuard(origins: string[] | null): RequestHandler {
  return (req, res, next) => {
    if (!origins) return next(); // 未配置白名单：保持原 * 行为
    const origin = req.headers.origin;
    if (!origin) return next();
    if (origins.includes(origin)) return next();
    res.status(403).json({
      ok: false,
      error: `Origin 不在 CORS 白名单内：${origin}（如需放行，请在 .env 的 CORS_ORIGINS 中追加，逗号分隔）`,
    });
  };
}

/** 请求体解析失败（畸形 JSON / 超大）时给可读 JSON，而不是 Express 默认的 HTML 报错页 */
function bodyErrorHandler(limitMb: number): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const type = (err as { type?: string } | undefined)?.type;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: '请求体不是合法 JSON（检查 Content-Type 与 JSON 语法）' });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ ok: false, error: `请求体超过 ${limitMb}MB 限制（可减小附件或调大 MAX_UPLOAD_MB）` });
      return;
    }
    next(err);
  };
}

export interface CreateAppOptions {
  /**
   * CORS 白名单：传数组 = 只放行这些 Origin；传 null = 保持 `*`；
   * 不传 = 读取环境变量 CORS_ORIGINS（不填等价 null）。
   */
  corsOrigins?: string[] | null;
  /** JSON 请求体上限（MB），默认取 config.maxUploadMb，覆盖 base64 附件开销 */
  jsonLimitMb?: number;
  /** 前端构建产物目录：传入后同源托管静态资源与 SPA 路由，实现单端口独立部署 */
  webDist?: string;
  /** 自动回复规则存储：传入才挂 /auto-rules 管理接口 */
  autoRules?: AutoRuleStore;
  /** 统计看板数据源：传入才挂 /stats/overview */
  statsSource?: StatsSource;
  /**
   * 一键自检路由依赖（单测注入抛错桩用）。
   *
   * 为什么必须在 createApp 内部挂载：createApp 末尾有「未匹配 /api → 404」兜底，
   * 应用创建后再 `app.use('/api', doctorRouter())` 会排在兜底之后，永远走不到（恒 404）。
   */
  doctor?: DoctorRouterDeps;
}

export function createApp(svc: MessageService, options: CreateAppOptions = {}) {
  const origins = options.corsOrigins !== undefined
    ? options.corsOrigins
    : parseCorsOrigins(process.env.CORS_ORIGINS);
  const limitMb = options.jsonLimitMb ?? config.maxUploadMb;
  const webDist = options.webDist ?? config.webDist;

  const app = express();
  app.use(corsWhitelistGuard(origins));
  // 白名单模式只回显名单内的 Origin；未配置则沿用 `*`（本地演示/旧调用方零改动）。
  // 附件下载要读 Content-Disposition 里的中文文件名，跨端口运行时必须显式 expose。
  app.use(cors({
    ...(origins ? { origin: origins } : {}),
    exposedHeaders: ['Content-Disposition'],
  }));
  app.use(express.json({ limit: `${limitMb}mb` }));

  app.use('/api', healthRouter(svc)); // 公共
  app.use('/api', webhookRouter(svc)); // 平台验签
  app.use('/api', feishuOAuthCallbackRouter()); // 公共 OAuth 回调（浏览器跳转，无 Bearer）
  // 必须挂在任何 apiAuth 之前：否则「先有令牌才能登录」成死循环
  app.use('/api', authRouter(svc)); // 公共：注册/登录/当前用户/登出
  app.use('/api', apiAuth, messagesRouter(svc)); // Bearer 鉴权
  app.use('/api', apiAuth, feishuOAuthRouter()); // Bearer 鉴权：发起飞书用户授权
  app.use('/api', apiAuth, dingtalkPersonalRouter()); // Bearer 鉴权：钉钉本人身份（dws 登录/状态/注销）
  app.use('/api', apiAuth, onboardingRouter()); // Bearer 鉴权：授权中心/首次使用向导聚合视图
  app.use('/api', apiAuth, mailAccountsRouter()); // Bearer 鉴权：邮箱账号运行时导入（个人版）
  app.use('/api', apiAuth, appConfigRouter()); // Bearer 鉴权：本地应用配置（白号：GUI 填凭据/切模式）
  app.use('/api', apiAuth, contactsRouter()); // Bearer 鉴权：发送目标名录（会话名，只读）
  // 微信 RPA 操作的是「本机微信窗口」，和平台凭据一样属于机器级能力：
  // 读状态可以给所有登录用户看，但拉取/启停桥只允许机器主人。
  // 注意：机器主人守卫必须挂在「具体路由」上（见各路由工厂的 guard 参数），
  // 不能放在 app.use('/api') 这一层——那会让任意未匹配的 POST/PUT/DELETE
  // 先撞上守卫、收到一个与实际无关的 403，把「接口不存在」伪装成「你没权限」。
  app.use('/api', apiAuth, wechatPullRouter(ownerOnly(svc)));
  app.use('/api', apiAuth, wechatBridgeRouter(undefined, ownerOnly(svc)));  // 通用接入：任何外部采集器按统一格式推消息进来，与平台 webhook 共用幂等/trace/富化链路
  app.use('/api', apiAuth, ingestRouter(svc));
  // 只读诊断摘要：进程内状态，不发任何出站请求
  app.use('/api', apiAuth, diagnosticsRouter());
  // 一键自检（账号页数据源）：必须挂在下面的 404 兜底之前
  app.use('/api', apiAuth, doctorRouter(options.doctor));
  // 自动回复规则管理：传了存储才挂（单测 / 纯人工模式可不挂）。
  // 规则命中后会用机器主人的真实账号外发——与 compose/forward 同一条边界，
  // 因此写操作挂 ownerOnly（GET 放行、部署令牌放行，成员写 403）。
  if (options.autoRules) {
    app.use('/api', apiAuth, autoRulesRouter(options.autoRules, ownerOnly(svc)));
  }
  // 统计看板：传了数据源才挂。
  // 口径说明：这是**机器全局**聚合（含所有登录用户消息的计数与平均处理时长），
  // 不含任何正文/traceId 内容。与 messages 列表按 viewer 过滤不同，这里刻意全局——
  // 看板回答「这台机器的闭环跑得怎么样」。若未来要多租户隔离，改 statsSource 按 viewer 过滤即可。
  if (options.statsSource) app.use('/api', apiAuth, statsRouter(options.statsSource));

  // 未匹配的 /api 路径统一回 JSON 404（而不是 Express 默认的 HTML 报错页）：
  // 前端能拿到可读原因，也避免把「接口不存在」误判成后端挂了。
  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, error: '这个功能不存在或当前版本还没有：请确认 LinkHub 已更新到最新版本' });
  });

  // 同源部署（Docker 单容器）：server 直接托管前端构建产物 + SPA 回退。
  // 只在 WEB_DIST 指向真实 index.html 时启用，本地 dev 走 Vite 5173 不受影响。
  if (webDist && existsSync(resolve(webDist, 'index.html'))) {
    const dist = resolve(webDist);
    app.use(express.static(dist, { index: false }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(resolve(dist, 'index.html'));
    });
  }

  // 必须挂在最后：才能兜住 app 级 json 与路由级 text 解析器的报错
  app.use(bodyErrorHandler(limitMb));

  return app;
}

/**
 * 把 `server.listen` 的报错翻译成中文可操作提示（index.ts 启动失败时打印）。
 * 纯函数：单测直接传入 ErrnoException 即可，不需要真的占端口。
 */
export function formatListenError(error: NodeJS.ErrnoException, port: number): string {
  const code = error?.code;
  if (code === 'EADDRINUSE') {
    return [
      `[unimsg] 启动失败：端口 ${port} 已被占用。`,
      '  改 .env 里的 SERVER_PORT 换一个端口；或结束占用这个端口的进程：',
      `    Windows: netstat -ano | findstr :${port}   然后  taskkill /PID <pid> /F`,
      `    macOS/Linux: lsof -i :${port}   然后  kill <pid>`,
    ].join('\n');
  }
  if (code === 'EACCES') {
    return [
      `[unimsg] 启动失败：没有权限监听端口 ${port}（EACCES）。`,
      '  1024 以下的端口需要管理员/root 权限；或改 .env 的 SERVER_PORT 用 3001 这类高端口。',
    ].join('\n');
  }
  if (code === 'EADDRNOTAVAIL') {
    return [
      `[unimsg] 启动失败：监听地址不可用（EADDRNOTAVAIL）。`,
      '  检查 .env 的 SERVER_HOST 是否写成了本机不存在的网卡地址；留空 = 监听所有网卡。',
    ].join('\n');
  }
  return `[unimsg] 启动失败（${code ?? 'UNKNOWN'}）：${error?.message ?? String(error)}`;
}
