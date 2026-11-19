/**
 * 「连接账号 / 授权中心」聚合视图（个人版首次使用向导的后端数据源）。
 *
 * 白号审计（docs/qa/white-account/white-auditor-report.md）修正后的状态机：
 *  - 缺平台应用凭据 → `needs_admin`（给「填写凭据」入口 + 管理员后台深链 + 可复制清单），**不再落进 mock 死胡同**；
 *  - 平台整体显式 Mock（用户自己选的演示模式）→ `mock`，如实写「不会真实收发」；
 *  - 钉钉支持「仅本人身份」（personal-only，无需机器人应用）：dws 可用但未登录 → `needs_user_auth`
 *    + `dingtalk-login`（只发起 dws 登录；登录成功后后端自动热应用 identity.dingtalk=user，未授权不改配置）；
 *  - **已登录（linked）但通道仍 mock → 不得 ready**（P0-2 假成功红线），给「仅用本人身份」热应用动作；
 *  - 飞书已授权但通道 mock 同样不得 ready；
 *  - 邮箱：本地账号未验证不算 ready（需要真实 IMAP+SMTP 登录自检通过）；
 *  - `overall.needsAction = 非 ready 的数量`（ready<total 时不得为 0）。
 *
 * 本模块只做只读聚合，**绝不包含任何 token / 授权码 / 密钥**。
 */
import { Platform, type PlatformIdentityView } from '@unimsg/shared';
import type { PlatformRuntime } from '../config/runtime';
import type { DwsBinSource } from '../connectors/dwsBin';
import type { MaskedMailAccount } from './mailAccounts';
import type { WechatBridgeStatus } from './wechatBridge';

export type OnboardingStepId = 'mail' | 'dingtalk' | 'feishu' | 'wechat';
export type OnboardingState = 'ready' | 'needs_user_auth' | 'needs_install' | 'needs_admin' | 'mock' | 'error';
export type OnboardingActionKind = 'api' | 'form' | 'link' | 'copy' | 'command';

/** 前端按顺序调用的后续接口（例如：先热应用身份，再发起登录） */
export interface OnboardingActionStep {
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  payload?: Record<string, unknown>;
}

export interface OnboardingAction {
  id: string;
  kind: OnboardingActionKind;
  label: string;
  /** kind=api：接口路径（前端用现有 api client 调用） */
  path?: string;
  method?: 'GET' | 'POST' | 'PUT';
  /** kind=api：请求体（如 {identity:{dingtalk:'user'}} 热应用「仅本人身份」） */
  payload?: Record<string, unknown>;
  /** kind=api：主调用完成后需继续执行的步骤（如热应用后再 POST 登录） */
  then?: OnboardingActionStep[];
  /** kind=link：官方后台/文档深链 */
  url?: string;
  /** kind=copy：可复制清单原文（管理员按此开通） */
  text?: string;
  /** kind=command：可复制的终端命令（已带 cd unimsg-connector） */
  command?: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  state: OnboardingState;
  summary: string;
  hints: string[];
  actions: OnboardingAction[];
  detail: Record<string, unknown>;
}

export interface OnboardingView {
  ok: true;
  data: {
    generatedAt: string;
    /** 首次使用（全部平台都非 ready；前端另有 localStorage 标记） */
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
    /** 运行模式策略 auto/real/mock（用于区分「显式 mock」与「auto 无账号回退」） */
    policy?: 'auto' | 'real' | 'mock';
    /** 邮箱轮询秒数（展示用） */
    pollSeconds?: number;
  };
  dingtalk: {
    view: PlatformIdentityView;
    runtime: PlatformRuntime;
    dws: { available: boolean; version?: string; source: DwsBinSource; pathHint?: string };
    /** identityChannelsReal：服务端「本人身份通道是否真实工作」（personal-only 时为 true） */
    identityChannelsReal: boolean;
  };
  feishu: {
    view: PlatformIdentityView;
    runtime: PlatformRuntime;
    scopes: string[];
    redirectUri: string;
    identityChannelsReal: boolean;
  };
  wechat: {
    runtime: PlatformRuntime;
    /**
     * RPA 桥实测状态（只读探测，来自 services/wechatBridge）。
     * 缺省 = 没探测（mock 模式不探测）：此时绝不能报 ready，因为"桥有没有起来"根本没验证。
     */
    bridge?: WechatBridgeStatus | null;
  };
  port?: number;
}

const DWS_RELEASES_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases';
const DWS_REPO_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli';

type StepPlatform = 'mail' | 'dingtalk' | 'feishu' | 'wechat';

/** 命令统一带工作目录提示（P2-7：pnpm 不在 PATH 时用 corepack pnpm） */
const CWD_HINT = '在 unimsg-connector/ 目录运行；pnpm 不在 PATH 时用 corepack pnpm run …';

function doctorCommand(platform: StepPlatform): OnboardingAction {
  return {
    id: `${platform}-doctor`,
    kind: 'command',
    label: `自检 ${platform} 配置（${CWD_HINT}）`,
    command: `cd unimsg-connector && pnpm run doctor --platform=${platform}`,
  };
}

const FETCH_DWS_ACTION: OnboardingAction = {
  id: 'dws-install',
  kind: 'command',
  label: '一键下载 dws 到 tools/（在 unimsg-connector/ 目录运行）',
  command: 'cd unimsg-connector && pnpm run fetch:dws',
};
const DWS_RELEASE_ACTION: OnboardingAction = {
  id: 'dws-release',
  kind: 'link',
  label: '手动下载 dws（GitHub release）',
  url: DWS_RELEASES_URL,
};

/** 管理员清单里的登录命令不要暴露本机绝对路径（P3）：尽量转成可移植写法 */
export function portableDwsLoginCommand(command?: string): string {
  const raw = (command ?? 'dws auth login').trim();
  const toolMatch = /(?:^|[\\/])tools[\\/](dws(?:\.exe)?)\s+auth\s+login/i.exec(raw);
  if (toolMatch) return `tools\\${toolMatch[1]} auth login`;
  const absMatch = /^[A-Za-z]:[\\/].*?([^\\/]+(?:\.exe)?)\s+auth\s+login/i.exec(raw);
  if (absMatch) return `${absMatch[1]} auth login`;
  return raw;
}

/** 飞书管理员可复制清单（纯文本、无 Markdown 星号；按钮名与前端一致） */
export function feishuAdminChecklist(redirectUri: string, scopes: string[]): string {
  return [
    '飞书管理员开通清单（LinkHub 个人版需要企业管理员配合）：',
    '1. 打开飞书开放平台 https://open.feishu.cn/app ，创建/选择一个「企业自建应用」；',
    '2. 权限管理：按下面清单开通消息权限（缺权限时 OAuth 后仍读不到消息）：',
    '   ' + scopes.join('、') + '',
    '3. 安全设置 → 重定向 URL：添加 ' + redirectUri + '（照抄，含 /api/feishu/oauth/callback）；',
    '4. 事件订阅：默认用长连接（FEISHU_STREAM=true）可免公网回调，此时 Verify Token / Encrypt Key 都可不填；只有改用 HTTP 回调模式才必须填 Verification Token；',
    '5. 发布应用；',
    '6. 运行模式：FEISHU_MODE=auto/real（显式 mock 会一直演示，不会真实收发）。',
    '7. 在 LinkHub 点「填写飞书应用凭据（App ID / App Secret）」填入凭据（也可写 .env 的 FEISHU_APP_ID / FEISHU_APP_SECRET），然后重启后端（保存后界面会提示）；',
    '8. 回到「连接账号」页点「连接飞书本人账号」，用本人账号完成 OAuth 授权。',
  ].join('\n');
}

/** 钉钉管理员可复制清单（纯文本；CLI 访问 + 可移植登录命令） */
export function dingtalkAdminChecklist(loginCommand?: string): string {
  const login = portableDwsLoginCommand(loginCommand);
  return [
    '钉钉管理员开通清单（LinkHub 个人版需要企业管理员配合）：',
    '1. 打开钉钉开发者后台 https://open-dev.dingtalk.com/ ；',
    '2. 如用「本人账号」收发（推荐，无需机器人应用）：企业管理员在钉钉开放平台开启「CLI 访问管理」（dws 个人身份依赖）；',
    '3. 如用机器人：创建「企业内部应用」，记录 Client ID / Client Secret，开通机器人发消息权限并配置事件订阅；',
    '4. 个人登录（本机推荐）：打开 LinkHub「连接账号」→ 钉钉 →「用钉钉本人账号登录（推荐）」；',
    `   或在本机终端执行：${login} --recommend（登录成功后无交互批量授权推荐权限）；`,
    '5. 机器人凭据可写回 LinkHub「填写钉钉应用凭据」或 .env 的 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_ROBOT_CODE，然后重启后端；',
    `6. dws 官方 CLI 与文档：${DWS_REPO_URL} 。`,
  ].join('\n');
}

function mailStep(deps: OnboardingDeps): OnboardingStep {
  const { accounts, mode } = deps.mail;
  const envCount = accounts.filter((a) => a.source === 'env').length;
  const verified = accounts.filter((a) => a.verified);
  const unverified = accounts.length - verified.length;
  const pollSeconds = deps.mail.pollSeconds ?? 45;
  const policy = deps.mail.policy ?? 'auto';
  const addAction: OnboardingAction = { id: 'mail-add-account', kind: 'form', label: '添加邮箱账号' };
  const providerHelp: OnboardingAction = {
    id: 'mail-provider-help',
    kind: 'link',
    label: '去邮箱网页版开启 IMAP/SMTP（QQ 邮箱示例）',
    url: 'https://mail.qq.com',
  };
  const detail = {
    accounts,
    filePath: deps.mail.filePath,
    issues: deps.mail.issues,
    mode,
    verifiedCount: verified.length,
    unverifiedCount: unverified,
  };

  if (accounts.length === 0) {
    return {
      id: 'mail',
      label: '邮箱',
      state: 'needs_user_auth',
      summary: '还没有邮箱账号。个人版可直接在页面添加（需要邮箱授权码）。',
      hints: [
        '先到邮箱网页版「设置 → POP3/SMTP/IMAP」开启服务并生成授权码（16 位左右，不是网页登录密码）。',
        // P2-1：白号（auto 因无账号回退 mock）不能说成「显式 MAIL_MODE=mock / 改 .env + 重启」
        policy === 'mock'
          ? '邮箱通道被显式设为演示模式（MAIL_MODE=mock）：改 .env 或 LinkHub 配置里的邮箱模式并重启后才会真实收发。'
          : '添加账号并点「测试连接」验证通过后会自动启用真实收信（无需改 .env、无需重启）。',
        '首轮只建立 UID 基线、不导入历史邮件；测试连接会真实连接一次邮箱服务器（只做 IMAP/SMTP 登录，不发信）。',
      ],
      actions: [addAction, providerHelp, doctorCommand('mail')],
      detail,
    };
  }

  if (verified.length === 0) {
    return {
      id: 'mail',
      label: '邮箱',
      state: 'needs_user_auth',
      summary: `已保存 ${accounts.length} 个邮箱账号，但还没有验证通过：请点「测试连接」验证。`,
      hints: [
        '未验证的账号不会真实收信，也不算「已就绪」。',
        '「测试连接」会真实连接一次 IMAP/SMTP 服务器并做登录（不发信）；验证通过后自动启用轮询。',
        unverified > 0 ? `还有 ${unverified} 个账号未验证。` : '',
      ].filter(Boolean),
      actions: [addAction, doctorCommand('mail')],
      detail,
    };
  }

  if (mode === 'real') {
    return {
      id: 'mail',
      label: '邮箱',
      state: 'ready',
      summary: `邮箱已就绪：${verified.length} 个已验证账号（.env ${envCount} 个），每 ${pollSeconds}s 自动收信。`,
      hints: [
        'IMAP 只拉新邮件（UID 增量），不会把历史邮件灌进收件箱，也不会改动邮箱已读状态。',
        unverified > 0 ? `另有 ${unverified} 个账号未验证，暂不参与收信。` : '',
        '测试连接会真实连接一次服务器（只登录，不发信）。',
      ].filter(Boolean),
      actions: [addAction, doctorCommand('mail')],
      detail,
    };
  }

  // 有已验证账号但邮箱通道仍为 mock：
  // P2-2：`modes.mail=real` 是静态键（保存后需重启），且显式 .env 优先；白号场景已验证账号会自动重算为 real，
  // 走到这里通常说明是「显式 MAIL_MODE=mock」或其它配置把通道锁成了演示，因此不下发误导性的「一键无需重启」动作。
  if (policy === 'mock') {
    return {
      id: 'mail',
      label: '邮箱',
      state: 'needs_admin',
      summary: '邮箱通道被显式设为演示模式（MAIL_MODE=mock）：账号已验证，但需要改为 auto/real 并重启后才会真实收发。',
      hints: [
        '显式 .env 优先：请修改 .env 的 MAIL_MODE，或在 LinkHub 配置页把邮箱模式改为 real（保存后需重启 LinkHub）。',
        '改完重启后再点「重新检测」，已验证账号会自动开始收信。',
      ],
      actions: [addAction, doctorCommand('mail')],
      detail,
    };
  }
  return {
    id: 'mail',
    label: '邮箱',
    state: 'needs_admin',
    summary: '账号已验证，但邮箱通道尚未启用真实收信（配置未生效）：请检查 MAIL_MODE / MAIL_ENABLED 后重启。',
    hints: [
      '在 LinkHub 配置页把邮箱模式改为 auto/real（保存后需重启 LinkHub），或直接修改 .env 的 MAIL_MODE。',
      '若是界面添加的账号：验证通过后应自动启用真实收信；仍显示模拟时请点「重新检测」或重启后端。',
    ],
    actions: [addAction, doctorCommand('mail')],
    detail,
  };
}

function dingtalkStep(deps: OnboardingDeps): OnboardingStep {
  const { view, runtime, dws } = deps.dingtalk;
  const real = deps.dingtalk.identityChannelsReal;
  const dwsMissing = !dws.available;
  const detail = {
    identity: {
      state: view.user.state,
      linked: view.user.linked,
      displayName: view.user.displayName,
      hint: view.user.hint,
    },
    dws,
    identityChannelsReal: real,
    botAvailable: view.botAvailable,
    runtimeMode: runtime.mode,
    runtimePolicy: runtime.policy,
    effectiveSend: view.effectiveSend,
    effectiveReceive: view.effectiveReceive,
    missing: runtime.missing,
  };

  // 「一登即用」时序：点击时**不预先改配置**，只发起 dws 登录；
  // 登录成功后后端（personalIdentity）才自动热应用 identity.dingtalk=user 并持久化；
  // 未完成授权 → 配置完全不改变（避免「已启用本人身份但未登录」导致发送失败/进 DLQ）。
  const personalLoginLabel = '用钉钉本人账号登录（推荐，无需机器人应用）';
  const personalLoginAction: OnboardingAction = {
    id: 'dingtalk-login',
    kind: 'api',
    label: personalLoginLabel,
    path: '/api/dingtalk/personal/login',
    method: 'POST',
    payload: { mode: 'browser' },
  };
  const enablePersonalOnlyAction: OnboardingAction = {
    id: 'dingtalk-enable-personal-only',
    kind: 'api',
    label: '仅用本人身份（立即生效，无需重启）',
    path: '/api/app-config',
    method: 'PUT',
    payload: { identity: { dingtalk: 'user' } },
  };
  const loginAction: OnboardingAction = {
    id: 'dingtalk-login',
    kind: 'api',
    label: '用浏览器登录（推荐）',
    path: '/api/dingtalk/personal/login',
    method: 'POST',
    payload: { mode: 'browser' },
  };
  const configureAction: OnboardingAction = {
    id: 'dingtalk-configure',
    kind: 'form',
    label: '填写钉钉应用凭据（可选，用机器人时）',
    path: '/api/app-config',
    method: 'PUT',
  };
  const adminActions: OnboardingAction[] = [
    { id: 'dingtalk-admin', kind: 'link', label: '打开钉钉开发者后台', url: 'https://open-dev.dingtalk.com/' },
    {
      id: 'dingtalk-admin-checklist',
      kind: 'copy',
      label: '复制管理员开通清单（CLI 访问 + 登录命令 + .env 键名）',
      text: dingtalkAdminChecklist(view.user.loginCommand),
    },
    doctorCommand('dingtalk'),
  ];
  const installActions: OnboardingAction[] = [FETCH_DWS_ACTION, DWS_RELEASE_ACTION, ...adminActions];

  // 已登录但通道仍 mock：P0-2 假成功红线 —— 绝不 ready
  if (view.user.linked && !real) {
    return {
      id: 'dingtalk',
      label: '钉钉',
      state: 'needs_admin',
      summary: '已登录 dws，但钉钉整体仍是模拟模式：点「仅用本人身份」后立即生效（无需重启），就能真实收发。',
      hints: [
        '当前 effectiveSend/Receive 仍是 mock：外部不会真的收到消息。',
        '点下面的按钮把钉钉切到「仅本人身份」（热应用 identity.dingtalk=user），然后重新检测。',
        view.user.hint,
      ].filter(Boolean),
      actions: [enablePersonalOnlyAction, ...adminActions],
      detail,
    };
  }

  if (dwsMissing) {
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

  // personal-only 已生效（或机器人真实通道）：只差本人登录
  if (real && !view.user.linked) {
    return {
      id: 'dingtalk',
      label: '钉钉',
      state: 'needs_user_auth',
      summary: '用钉钉本人账号登录即可，无需机器人应用（需企业已开 CLI 访问）。',
      hints: [
        '点「用浏览器登录（推荐）」：浏览器打开钉钉授权页，扫码/登录并确认；授权成功会自动刷新。',
        '浏览器授权地址是 127.0.0.1 本机回调，必须在运行 LinkHub 的机器上打开；服务器/容器请用设备码登录。',
        view.user.hint,
      ].filter(Boolean),
      // 只要 dws 可用就给登录入口（探测尚未完成时 canLink 可能为 false；白号审计 P1-1：入口必须可达）
      actions: [loginAction, ...adminActions],
      detail,
    };
  }

  if (real && view.user.linked && view.effectiveSend !== 'mock') {
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
        doctorCommand('dingtalk'),
      ],
      detail,
    };
  }

  // 显式演示模式（用户自己设了 DINGTALK_MODE=mock）：如实标注，给恢复真实的方式
  if (runtime.policy === 'mock') {
    return {
      id: 'dingtalk',
      label: '钉钉',
      state: 'mock',
      summary: '钉钉当前为演示模式（你显式设置了 DINGTALK_MODE=mock）：不会连真实钉钉。',
      hints: [
        '想真实收发：点「用钉钉本人账号登录（推荐）」完成授权（登录成功后自动启用本人身份，无需重启），或去掉 .env 的 DINGTALK_MODE=mock 后重启。',
        '显式 mock 时不会探测 dws、也不会启动本人身份收发；登录本身不受影响。',
      ],
      actions: [personalLoginAction, ...adminActions],
      detail,
    };
  }

  // 白号：没有机器人凭据、dws 可用、未登录 —— 最顺路径是「仅本人身份」
  return {
    id: 'dingtalk',
    label: '钉钉',
    state: 'needs_user_auth',
    summary: '用钉钉本人账号登录即可，无需机器人应用（需企业已开 CLI 访问）。',
    hints: [
      '点「用钉钉本人账号登录（推荐）」：登录成功后会自动启用本人身份（无需重启），个人事件接收自动启动。',
      '未完成授权不会改变任何配置（不会出现「已启用但未登录」的状态）；若企业未开 CLI 访问，请联系管理员（清单可复制）。',
      '登录用的是本机 dws CLI：浏览器授权/设备码确认一次即可，凭据只留在本机。',
    ],
    actions: [
      personalLoginAction,
      configureAction,
      { id: 'dingtalk-admin', kind: 'link', label: '打开钉钉开发者后台', url: 'https://open-dev.dingtalk.com/' },
      {
        id: 'dingtalk-admin-checklist',
        kind: 'copy',
        label: '复制管理员开通清单（CLI 访问 + 登录命令）',
        text: dingtalkAdminChecklist(view.user.loginCommand),
      },
      doctorCommand('dingtalk'),
    ],
    detail,
  };
}

function feishuStep(deps: OnboardingDeps): OnboardingStep {
  const { view, runtime } = deps.feishu;
  const real = deps.feishu.identityChannelsReal;
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
    identityChannelsReal: real,
    effectiveSend: view.effectiveSend,
    effectiveReceive: view.effectiveReceive,
  };
  const configureAction: OnboardingAction = {
    id: 'feishu-configure',
    kind: 'form',
    label: '填写飞书应用凭据（App ID / App Secret）',
    path: '/api/app-config',
    method: 'PUT',
  };
  const adminActions: OnboardingAction[] = [
    configureAction,
    { id: 'feishu-admin', kind: 'link', label: '打开飞书开放平台（应用后台）', url: 'https://open.feishu.cn/app' },
    {
      id: 'feishu-admin-checklist',
      kind: 'copy',
      label: '复制管理员开通清单（权限 + 回调 URL + .env 键名 + 重启）',
      text: feishuAdminChecklist(deps.feishu.redirectUri, deps.feishu.scopes),
    },
    doctorCommand('feishu'),
  ];

  // 已授权但通道仍 mock：不得 ready；且按 configured 区分「缺凭据」vs「演示模式」（P2-3）
  if (view.user.linked && !real) {
    if (runtime.configured) {
      return {
        id: 'feishu',
        label: '飞书',
        state: 'needs_admin',
        summary: '飞书应用凭据已配置，但当前是演示模式：改为 auto/real 并重启后才会真实收发。',
        hints: [
          '不是缺凭据：凭据已配置（见「设置 → 应用配置」或 /api/app-config）。',
          '在 LinkHub 配置页把飞书模式改为 auto/real，或去掉 .env 的 FEISHU_MODE=mock 后重启。',
          view.user.hint,
        ].filter(Boolean),
        actions: [
          {
            id: 'feishu-mode-real',
            kind: 'api',
            label: '改为真实模式（保存后需重启 LinkHub）',
            path: '/api/app-config',
            method: 'PUT',
            payload: { modes: { feishu: 'real' } },
          },
          ...adminActions,
        ],
        detail,
      };
    }
    return {
      id: 'feishu',
      label: '飞书',
      state: 'needs_admin',
      summary: '已授权飞书本人身份，但缺少飞书应用凭据：填入 App ID / App Secret 并重启后才会真实收发。',
      hints: [
        '当前 effectiveSend/Receive 仍是 mock：外部不会真的收到消息。',
        '点「填写飞书应用凭据」填入 App ID / App Secret，重启后重新检测。',
        view.user.hint,
      ].filter(Boolean),
      actions: adminActions,
      detail,
    };
  }

  if (!runtime.configured) {
    return {
      id: 'feishu',
      label: '飞书',
      state: 'needs_admin',
      summary: '缺少飞书应用凭据：个人用户需企业管理员创建自建应用；拿到 App ID / Secret 后在 LinkHub 填写（或写 .env）并重启。',
      hints: [
        runtime.missing.length > 0 ? `还缺：${runtime.missing.join(' / ')}（填到 LinkHub 配置或 .env 后重启）` : '应用凭据未就绪。',
        '用长连接时 Verify Token 可不填（默认 FEISHU_STREAM=true，免公网回调）；只有改用 HTTP 回调模式才需要 Verification Token。',
        `重定向 URL 必须是：${deps.feishu.redirectUri}（与飞书后台逐字一致）。`,
        '个人版通常需要企业管理员操作；配好后回到本页刷新。',
      ],
      actions: adminActions,
      detail,
    };
  }

  if (!real) {
    if (runtime.policy === 'mock') {
      return {
        id: 'feishu',
        label: '飞书',
        state: 'mock',
        summary: '飞书当前为演示模式（你显式设置了 FEISHU_MODE=mock）：不会连真实飞书。',
        hints: ['想真实收发：去掉 .env 的 FEISHU_MODE=mock 并重启（或改为 auto）。'],
        actions: adminActions,
        detail,
      };
    }
    return {
      id: 'feishu',
      label: '飞书',
      state: 'needs_admin',
      summary: '飞书凭据已配置，但通道未启用真实收发：检查安全配置（重定向 URL / 事件订阅）后重启。',
      hints: [runtime.reason, ...runtime.warnings.slice(0, 2)],
      actions: adminActions,
      detail,
    };
  }

  if (!view.user.linked) {
    return {
      id: 'feishu',
      label: '飞书',
      state: 'needs_user_auth',
      summary: '飞书应用已就绪，还差你用本人账号授权（OAuth）。',
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
        doctorCommand('feishu'),
      ],
      detail,
    };
  }

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
        // 原 /api/feishu/oauth/status 不存在（P1-6 404）；统一用 /api/accounts 读身份视图
        path: '/api/accounts',
        method: 'GET',
      },
      doctorCommand('feishu'),
    ],
    detail,
  };
}

function wechatStep(deps: OnboardingDeps): OnboardingStep {
  const { runtime, bridge } = deps.wechat;
  const detail = {
    missing: runtime.missing,
    warnings: runtime.warnings,
    configured: runtime.configured,
    mode: runtime.mode,
    policy: runtime.policy,
    bridge: bridge ?? null,
  };
  const setupHints = [
    '微信个人版无官方收发 API，走 RPA 通道：需本机微信桌面端 + 本地 RPA 桥（scripts/wechat-rpa）。',
    '启动桥：python scripts/wechat-rpa/rpa_bridge.py --mode rpa（需 pip install pyautogui pyperclip pywin32 uiautomation）。',
  ];

  // 1) 配置上就是 mock：如实说不会碰真实微信（这里不是"就绪"）
  if (runtime.mode !== 'real') {
    return {
      id: 'wechat',
      label: '微信（RPA）',
      state: 'mock',
      summary: '微信当前为模拟模式：可在收件箱演示，但不会操作真实微信，也不会采集真实消息。',
      hints: [
        ...setupHints,
        '要真实接入：设 .env 的 WECHAT_MODE=real，装齐依赖后以 --mode rpa 启动 RPA 桥。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  // 2) 配了 real 但没探测到桥 / 桥连不上：绝不能报 ready（P0：以前只看环境变量）
  if (!bridge) {
    return {
      id: 'wechat',
      label: '微信（RPA）',
      state: 'needs_install',
      summary: 'WECHAT_MODE=real，但还没有探测到本机 RPA 桥的运行态，无法确认能否真实收发。',
      hints: [...setupHints, '点「重新检测」或刷新本页：后端会实际请求桥的 /health 再给结论。'],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  if (!bridge.reachable) {
    return {
      id: 'wechat',
      label: '微信（RPA）',
      state: 'needs_install',
      summary: `WECHAT_MODE=real，但连不上本机 RPA 桥（${bridge.url}）。`,
      hints: [
        ...setupHints,
        '确认桥已启动并监听该地址；如果是 Docker/远程后端，桥必须在后端能访问到的机器上。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  // 3) 桥活着但跑在 mock：发送会被后端拒绝（我们不再把它的"成功"当真实送达）
  if (bridge.mode !== 'rpa') {
    return {
      id: 'wechat',
      label: '微信（RPA）',
      state: 'needs_install',
      summary: `RPA 桥正在以 ${bridge.mode ?? '未知'} 模式运行：不会操作真实微信，发送会被如实拒绝。`,
      hints: [
        '用 --mode rpa 重启桥：python scripts/wechat-rpa/rpa_bridge.py --mode rpa',
        '若依赖没装齐，桥会直接以退出码 2 报错并列出缺失项（不会静默降级）。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  // 4) 微信 4.x：不是配置问题，是版本根本不暴露控件树 —— 必须单独讲，
  //    否则用户会去反复查依赖/重登微信，怎么弄都不会好。
  if (bridge.client?.kind === 'weixin4') {
    return {
      id: 'wechat',
      label: '微信（RPA）',
      // 4.x 不是「不可用」：发送真实可用，接收走按需拉取。
      // 标 needs_install 会把人推去装 3.9，而他其实可以立刻用起来。
      state: 'ready',
      summary: '微信 4.x：发送真实可用；接收为「按需拉取」（收件箱 → 微信 → 从微信拉取当前会话）。',
      hints: [
        '4.x 界面是 Qt 自绘，不暴露可访问性控件树（实测根节点仅 2 个空 Pane），所以做不到「自动轮询」；改为按需拉取：桥把微信置前 → 消息区拖选 → 复制 → 解析原文入库，零 OCR 误差。',
        '按需拉取的边界：只覆盖当前在微信里打开的那个会话与可视区，执行时会短暂抢前台（结束自动还原剪贴板与焦点）。',
        '4.x 发送能提交，但读不到当前会话标题，LinkHub 会标「已提交未核对」；发送前请确认微信里打开的是目标会话。',
        '想要「消息自己进来」：换装微信 3.9.x 并登录，桥会自动轮询接收（3.x 的会话/消息列表是标准 ListControl）。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  // 5) 桥在 rpa 模式：还要确认它真的能收到消息（P0：以前接收钩子为空也报 ready）
  if (!bridge.canReceive) {
    return {
      id: 'wechat',
      label: '微信（RPA）',
      state: 'needs_install',
      summary: `RPA 桥在 rpa 模式，但真实接收还没就绪：${bridge.receiveReason}`,
      hints: [
        '发送已经可用（真实操作微信桌面端）；接收需要桥能读到微信窗口消息。',
        '检查：微信桌面端已登录并打开、桥进程未被最小化到无法找到窗口、依赖 uiautomation 已安装。',
        '只看当前会话可用 --no-switch；需要自动发现新消息则保持默认（会切换会话）。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  return {
    id: 'wechat',
    label: '微信（RPA）',
    state: 'ready',
    summary: '微信 RPA 通道已就绪：发送真实操作微信桌面端，入站由桥轮询窗口消息转发。',
    hints: [
      bridge.receiveReason,
      'RPA 受窗口布局/分辨率影响，也会切换会话；发送失败会如实报错，不会假装成功。',
    ],
    actions: [doctorCommand('wechat')],
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
    wechatStep(deps),
  ];
  const ready = steps.filter((s) => s.state === 'ready').length;
  // 白号审计 P1-2：非 ready 就是待处理（ready<total 时不得为 0）；mock 也是「未真实可用」，同样计入
  const needsAction = steps.filter((s) => s.state !== 'ready').length;
  const startedAt = deps.startedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
  return {
    ok: true,
    data: {
      generatedAt,
      // 白号：全部平台都非 ready 才算首次使用
      firstRun: steps.every((s) => s.state !== 'ready'),
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

/** 供路由推导 Platform 常量（避免路由到处 import Platform） */
export const ONBOARDING_PLATFORMS = {
  mail: Platform.MAIL,
  dingtalk: Platform.DINGTALK,
  feishu: Platform.FEISHU,
  wechat: Platform.WECHAT,
} as const;
