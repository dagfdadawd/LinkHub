/**
 * 「连接账号 / 授权中心」聚合视图（个人版首次使用向导的后端数据源）。
 *
 * 只做只读聚合：平台身份视图 + 运行时画像 + 邮箱账号脱敏列表 + dws 来源，
 * 组装成前端可以直接渲染的 steps/actions/hints。**绝不包含任何 token / 授权码 / 密钥**。
 *
 * 判定原则（诚实标注，不假装可用）：
 *  - 真实可用 → ready；
 *  - 需要用户本人授权（飞书 OAuth / 钉钉 dws 登录）→ needs_user_auth；
 *  - 缺 dws → needs_install（给 `pnpm run fetch:dws` 命令）；
 *  - 缺企业管理员配置（App 凭据 / CLI 访问 / 企微可信 IP 等）→ needs_admin（给官方后台深链 + 可复制清单）；
 *  - 平台整体 Mock（演示模式）→ mock（明确写「不会真实收发」）。
 */
import { Platform, type PlatformIdentityView } from '@unimsg/shared';
import type { PlatformRuntime } from '../config/runtime';
import type { DwsBinSource } from '../connectors/dwsBin';
import type { MaskedMailAccount } from './mailAccounts';

export type OnboardingStepId = 'mail' | 'dingtalk' | 'feishu' | 'wecom';
export type OnboardingState = 'ready' | 'needs_user_auth' | 'needs_install' | 'needs_admin' | 'mock' | 'error';
export type OnboardingActionKind = 'api' | 'form' | 'link' | 'copy' | 'command';

export interface OnboardingAction {
  id: string;
  kind: OnboardingActionKind;
  label: string;
  /** kind=api：接口路径（前端用现有 api client 调用） */
  path?: string;
  method?: 'GET' | 'POST';
  /** kind=link：官方后台/文档深链 */
  url?: string;
  /** kind=copy：可复制清单原文（管理员按此开通） */
  text?: string;
  /** kind=command：可复制的终端命令 */
  command?: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  state: OnboardingState;
  /** 一句话现状（前端卡片正文） */
  summary: string;
  /** 可操作提示（中文） */
  hints: string[];
  actions: OnboardingAction[];
  /** 明细（邮箱脱敏列表 / identity 摘要 / 运行时缺失项 / dws 来源），不含任何密钥 */
  detail: Record<string, unknown>;
}

export interface OnboardingView {
  ok: true;
  data: {
    generatedAt: string;
    /** 首次使用（没有任何平台已就绪；前端用 localStorage 标记是否已展示过向导） */
    firstRun: boolean;
    startedAt: string;
    envFile: { path: string; mtime: string } | null;
    dws: {
      available: boolean;
      version?: string;
      source: DwsBinSource;
      pathHint?: string;
    };
    overall: { ready: number; total: number; needsAction: number };
    steps: OnboardingStep[];
  };
}

export interface OnboardingDeps {
  now?: () => number;
  startedAt?: string;
  envFile?: { path: string; mtime: string } | null;
  mail: {
    accounts: MaskedMailAccount[];
    filePath: string;
    issues: string[];
    mode: 'real' | 'mock';
  };
  dingtalk: {
    view: PlatformIdentityView;
    runtime: PlatformRuntime;
    dws: { available: boolean; version?: string; source: DwsBinSource; pathHint?: string };
  };
  feishu: {
    view: PlatformIdentityView;
    runtime: PlatformRuntime;
    /** 授权 scope（展示给管理员核对权限用；不含 token） */
    scopes: string[];
    redirectUri: string;
  };
  wecom: { runtime: PlatformRuntime };
  /** 服务端口（生成回调地址提示用） */
  port?: number;
}

const DWS_RELEASE_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases';
const DWS_REPO_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli';

/** 飞书管理员可复制清单（开通后用户才能 OAuth；文字会随 docs/personal-identity.md 对齐） */
export function feishuAdminChecklist(redirectUri: string, scopes: string[]): string {
  return [
    '飞书管理员开通清单（LinkHub 个人版需要企业管理员配合）：',
    '1. 打开飞书开放平台 https://open.feishu.cn/app ，创建/选择一个「企业自建应用」；',
    '2. 权限管理：按下面清单开通消息权限（缺权限时 OAuth 后仍读不到消息）：',
    `   ${scopes.join('、')}`,
    `3. 安全设置 → 重定向 URL：添加 ${redirectUri}（照抄，含 /api/feishu/oauth/callback）；`,
    '4. 事件订阅：配置 Encrypt Key / Verification Token（或使用长连接），否则机器人收不到消息；',
    '5. 发布应用后，回到 LinkHub「连接账号」页点「连接飞书本人账号」，用本人账号完成授权。',
  ].join('\n');
}

/** 钉钉管理员可复制清单（dws 个人身份依赖企业开启 CLI 访问） */
export function dingtalkAdminChecklist(port?: number): string {
  return [
    '钉钉管理员开通清单（LinkHub 个人版需要企业管理员配合）：',
    '1. 打开钉钉开发者后台 https://open-dev.dingtalk.com/ ，创建「企业内部应用」，记录 Client ID / Client Secret；',
    '2. 为应用开通机器人发送消息等权限；机器人接收需配置「事件订阅」的 AES Token / AES Key；',
    '3. 如用「本人账号」收发，需企业管理员在钉钉开放平台开启「CLI 访问管理」（dws 个人身份依赖）；',
    `4. dws 官方 CLI 与文档：${DWS_REPO_URL} ；`,
    `5. 个人登录：回到 LinkHub「连接账号」页点「用浏览器登录（推荐）」，本机浏览器扫码/登录即可${port ? `（回调地址在本机 127.0.0.1，需在运行 LinkHub 的机器上打开）` : ''}。`,
  ].join('\n');
}

/** 企业微信管理员可复制清单（自建应用 + 可信 IP） */
export function wecomAdminChecklist(port?: number): string {
  return [
    '企业微信管理员开通清单（LinkHub 个人版需要企业管理员配合）：',
    '1. 打开企业微信管理后台 https://work.weixin.qq.com/ → 应用管理 → 自建，创建应用并记录 AgentId / Secret / 企业 CorpID；',
    '2. 应用「接收消息」：设置 Token 与 EncodingAESKey，回调 URL 指向 LinkHub 的 /api/wecom/callback（需公网可达）',
    `   ${port ? `本机演示端口：http://127.0.0.1:${port}/api/wecom/callback（公网需用域名/内网穿透）` : ''}`,
    '3. 应用「企业可信 IP」：添加运行 LinkHub 的机器的公网出口 IP（否则发送会报 60020）；',
    '4. 把 WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET / WECOM_TOKEN / WECOM_AES_KEY 填到 .env 后重启 LinkHub。',
  ].join('\n');
}

function mailStep(deps: OnboardingDeps): OnboardingStep {
  const { accounts, mode } = deps.mail;
  const fileCount = accounts.filter((a) => a.source === 'file').length;
  const envCount = accounts.length - fileCount;
  const actions: OnboardingAction[] = [
    { id: 'mail-add-account', kind: 'form', label: '添加邮箱账号' },
    {
      id: 'mail-provider-help',
      kind: 'link',
      label: '去邮箱网页版开启 IMAP/SMTP（QQ 邮箱示例）',
      url: 'https://mail.qq.com',
    },
  ];
  const detail = {
    accounts,
    filePath: deps.mail.filePath,
    issues: deps.mail.issues,
    mode,
  };

  if (accounts.length === 0) {
    return {
      id: 'mail',
      label: '邮箱',
      state: 'needs_user_auth',
      summary: '还没有邮箱账号。个人版可直接在页面添加（需要邮箱授权码）。',
      hints: [
        '先到邮箱网页版「设置 → POP3/SMTP/IMAP」开启服务并生成授权码（16 位左右，不是网页登录密码）。',
        mode === 'mock' ? '当前邮箱通道为模拟模式（MAIL_MODE=mock）：添加账号后改 MAIL_MODE=auto/real 才会真实收信。' : '',
        '保存后会热加载（无需重启），首轮只建立 UID 基线、不导入历史邮件。',
      ].filter(Boolean),
      actions,
      detail,
    };
  }
  const summaryBase = `已配置 ${accounts.length} 个邮箱账号（.env ${envCount} / 本地导入 ${fileCount}）`;
  if (mode === 'mock') {
    return {
      id: 'mail',
      label: '邮箱',
      state: 'mock',
      summary: `${summaryBase}，但当前为演示模式：不会真实连 IMAP 收信。`,
      hints: ['邮箱通道当前为 Mock（MAIL_MODE=mock）：去掉 MAIL_MODE 或设为 auto/real 后重启即可真实收发。'],
      actions: [
        { id: 'mail-doctor', kind: 'command', label: '自检邮箱配置', command: 'pnpm run doctor --platform=mail' },
        ...actions,
      ],
      detail,
    };
  }
  return {
    id: 'mail',
    label: '邮箱',
    state: 'ready',
    summary: `${summaryBase}，轮询每 ${Math.max(5, Number(process.env.MAIL_POLL_SECONDS ?? 45))}s 自动收信。`,
    hints: ['IMAP 只拉新邮件（UID 增量），不会把历史邮件灌进收件箱，也不会改动邮箱已读状态。'],
    actions: [
      { id: 'mail-doctor', kind: 'command', label: '自检邮箱配置', command: 'pnpm run doctor --platform=mail' },
      ...actions,
    ],
    detail,
  };
}

function dingtalkStep(deps: OnboardingDeps): OnboardingStep {
  const { view, runtime, dws } = deps.dingtalk;
  const detail = {
    identity: {
      state: view.user.state,
      linked: view.user.linked,
      displayName: view.user.displayName,
      hint: view.user.hint,
    },
    dws,
    botAvailable: view.botAvailable,
    effectiveSend: view.effectiveSend,
    effectiveReceive: view.effectiveReceive,
    missing: runtime.missing,
  };
  const installActions: OnboardingAction[] = [
    {
      id: 'dws-install',
      kind: 'command',
      label: '一键下载 dws 到 tools/',
      command: 'pnpm run fetch:dws',
    },
    {
      id: 'dws-release',
      kind: 'link',
      label: '手动下载 dws（GitHub release）',
      url: DWS_RELEASE_URL,
    },
  ];

  if (runtime.mode === 'mock' && !view.user.linked) {
    return {
      id: 'dingtalk',
      label: '钉钉',
      state: 'mock',
      summary: '钉钉当前为演示模式（Mock）：不会连真实钉钉；连接本人账号后可真实收发。',
      hints: [view.receiveHint, view.sendHint],
      actions: [
        ...(dws.available ? [] : installActions),
        { id: 'dingtalk-doctor', kind: 'command', label: '自检钉钉配置', command: 'pnpm run doctor --platform=dingtalk' },
      ],
      detail,
    };
  }
  if (view.user.linked) {
    return {
      id: 'dingtalk',
      label: '钉钉',
      state: 'ready',
      summary: `已连接钉钉本人账号${view.user.displayName ? `：${view.user.displayName}` : ''}，消息以本人身份收发。`,
      hints: [view.receiveHint, view.sendHint],
      actions: [
        {
          id: 'dingtalk-status',
          kind: 'api',
          label: '刷新连接状态',
          path: '/api/dingtalk/personal/status',
          method: 'GET',
        },
      ],
      detail,
    };
  }
  if (!dws.available) {
    return {
      id: 'dingtalk',
      label: '钉钉',
      state: 'needs_install',
      summary: '未找到钉钉官方 CLI（dws）：个人版可一键下载到 tools/，无需自己配 PATH。',
      hints: [
        dws.pathHint ?? '运行 `pnpm run fetch:dws` 下载 dws（约 25MB），或把 dws 放到 PATH。',
        '桌面版会内置 dws，无需此步骤。',
      ],
      actions: installActions,
      detail,
    };
  }
  if (view.user.canLink) {
    return {
      id: 'dingtalk',
      label: '钉钉',
      state: 'needs_user_auth',
      summary: 'dws 已就绪，还差你本人用钉钉授权（浏览器登录，推荐）。',
      hints: [
        '点「用浏览器登录（推荐）」后在弹出的钉钉页面扫码/登录并确认；授权成功会自动刷新。',
        '浏览器授权地址是 127.0.0.1 本机回调，必须在运行 LinkHub 的机器上打开；服务器/容器请用设备码登录。',
        view.user.hint,
      ].filter(Boolean),
      actions: [
        {
          id: 'dingtalk-login',
          kind: 'api',
          label: '用浏览器登录（推荐）',
          path: '/api/dingtalk/personal/login',
          method: 'POST',
        },
        {
          id: 'dingtalk-device-login',
          kind: 'copy',
          label: '复制终端登录命令（备用）',
          text: view.user.loginCommand ?? 'dws auth login',
        },
      ],
      detail,
    };
  }
  return {
    id: 'dingtalk',
    label: '钉钉',
    state: 'needs_admin',
    summary: 'dws 已安装但还不能连接：需要企业管理员开通 CLI 访问/应用权限。',
    hints: [view.user.hint, '管理员开通后，回到本页刷新，再点「用浏览器登录」。'],
    actions: [
      {
        id: 'dingtalk-admin',
        kind: 'link',
        label: '打开钉钉开发者后台',
        url: 'https://open-dev.dingtalk.com/',
      },
      {
        id: 'dingtalk-admin-checklist',
        kind: 'copy',
        label: '复制管理员开通清单',
        text: dingtalkAdminChecklist(deps.port),
      },
    ],
    detail,
  };
}

function feishuStep(deps: OnboardingDeps): OnboardingStep {
  const { view, runtime } = deps.feishu;
  const detail = {
    identity: {
      state: view.user.state,
      linked: view.user.linked,
      displayName: view.user.displayName,
      hint: view.user.hint,
      expiresAt: view.user.expiresAt,
    },
    redirectUri: deps.feishu.redirectUri,
    scopes: deps.feishu.scopes,
    missing: runtime.missing,
    warnings: runtime.warnings,
    effectiveSend: view.effectiveSend,
    effectiveReceive: view.effectiveReceive,
  };
  const adminActions: OnboardingAction[] = [
    {
      id: 'feishu-admin',
      kind: 'link',
      label: '打开飞书开放平台（应用后台）',
      url: 'https://open.feishu.cn/app',
    },
    {
      id: 'feishu-admin-checklist',
      kind: 'copy',
      label: '复制管理员开通清单（含回调 URL / 权限）',
      text: feishuAdminChecklist(deps.feishu.redirectUri, deps.feishu.scopes),
    },
  ];

  if (runtime.mode === 'mock' && !view.user.linked) {
    return {
      id: 'feishu',
      label: '飞书',
      state: 'mock',
      summary: '飞书当前为演示模式（Mock）：不会连真实飞书；企业管理员配好应用后可连接本人账号。',
      hints: [view.receiveHint, view.sendHint],
      actions: adminActions,
      detail,
    };
  }
  if (view.user.linked) {
    return {
      id: 'feishu',
      label: '飞书',
      state: 'ready',
      summary: `已连接飞书本人账号${view.user.displayName ? `：${view.user.displayName}` : ''}，消息以本人身份收发。`,
      hints: [view.receiveHint, view.sendHint],
      actions: [
        {
          id: 'feishu-status',
          kind: 'api',
          label: '刷新连接状态',
          path: '/api/feishu/oauth/status',
          method: 'GET',
        },
      ],
      detail,
    };
  }
  if (view.user.canLink) {
    return {
      id: 'feishu',
      label: '飞书',
      state: 'needs_user_auth',
      summary: '飞书应用凭据已配置，还差你用本人账号授权。',
      hints: [
        '点「连接飞书本人账号」，在浏览器里用飞书账号登录并同意授权；完成后回到 LinkHub 自动刷新。',
        view.user.hint,
      ].filter(Boolean),
      actions: [
        {
          id: 'feishu-oauth',
          kind: 'api',
          label: '连接飞书本人账号',
          path: '/api/feishu/oauth/start',
          method: 'POST',
        },
        {
          id: 'feishu-doctor',
          kind: 'command',
          label: '自检飞书配置',
          command: 'pnpm run doctor --platform=feishu',
        },
      ],
      detail,
    };
  }
  return {
    id: 'feishu',
    label: '飞书',
    state: 'needs_admin',
    summary: '需要企业管理员先创建飞书自建应用、开通消息权限并配置重定向 URL，之后才能连接本人账号。',
    hints: [
      runtime.missing.length > 0 ? `还缺应用凭据：${runtime.missing.join(' / ')}（填到 .env 后重启）` : '应用凭据未就绪。',
      `重定向 URL 必须是：${deps.feishu.redirectUri}（与飞书后台逐字一致）。`,
      '个人版通常需要企业管理员操作；配好后回到本页刷新。',
    ],
    actions: adminActions,
    detail,
  };
}

function wecomStep(deps: OnboardingDeps): OnboardingStep {
  const { runtime } = deps.wecom;
  const detail = { missing: runtime.missing, warnings: runtime.warnings, configured: runtime.configured };
  if (runtime.mode === 'real' && runtime.configured) {
    return {
      id: 'wecom',
      label: '企业微信',
      state: 'ready',
      summary: '企业微信自建应用已配置，机器人通道可用。',
      hints: ['如发送报 60020（IP 不在白名单），请管理员把本机公网 IP 加入「企业可信 IP」。'],
      actions: [
        { id: 'wecom-doctor', kind: 'command', label: '自检企业微信配置', command: 'pnpm run doctor --platform=wecom' },
      ],
      detail,
    };
  }
  const actions: OnboardingAction[] = [
    { id: 'wecom-admin', kind: 'link', label: '打开企业微信管理后台', url: 'https://work.weixin.qq.com/' },
    { id: 'wecom-admin-checklist', kind: 'copy', label: '复制管理员开通清单（含可信 IP）', text: wecomAdminChecklist(deps.port) },
  ];
  return {
    id: 'wecom',
    label: '企业微信',
    state: 'mock',
    summary: '企业微信当前为演示模式（Mock）：需要企业管理员配好自建应用与可信 IP 才能真实收发。',
    hints: [
      runtime.missing.length > 0 ? `缺少变量：${runtime.missing.join(' / ')}` : '未配置企业微信自建应用。',
      '个人版无法自行开通企业微信，需要企业管理员配合。',
    ],
    actions,
    detail,
  };
}

/**
 * 组装 onboarding 聚合视图（纯函数；所有数据由 deps 注入，便于单测与「不碰真实平台」）。
 */
export function buildOnboarding(deps: OnboardingDeps): OnboardingView {
  const generatedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
  const steps: OnboardingStep[] = [
    mailStep(deps),
    dingtalkStep(deps),
    feishuStep(deps),
    wecomStep(deps),
  ];
  const ready = steps.filter((s) => s.state === 'ready').length;
  const needsAction = steps.filter((s) => s.state === 'needs_user_auth' || s.state === 'needs_install' || s.state === 'needs_admin').length;
  const startedAt = deps.startedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
  return {
    ok: true,
    data: {
      generatedAt,
      firstRun: ready === 0,
      startedAt,
      envFile: deps.envFile ?? null,
      dws: {
        available: deps.dingtalk.dws.available,
        ...(deps.dingtalk.dws.version ? { version: deps.dingtalk.dws.version } : {}),
        source: deps.dingtalk.dws.source,
        ...(deps.dingtalk.dws.pathHint ? { pathHint: deps.dingtalk.dws.pathHint } : {}),
      },
      overall: { ready, total: steps.length, needsAction },
      steps,
    },
  };
}