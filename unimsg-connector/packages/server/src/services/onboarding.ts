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
const CWD_HINT = '在项目目录运行，给管理员 / 开发者用的技术操作';

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
  label: '下载钉钉官方登录工具（管理员操作，在项目目录运行）',
  command: 'cd unimsg-connector && pnpm run fetch:dws',
};
const DWS_RELEASE_ACTION: OnboardingAction = {
  id: 'dws-release',
  kind: 'link',
  label: '手动下载钉钉官方登录工具（官方发布页）',
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
    '【给企业管理员看的开通清单：普通用户不用管这些，直接复制发给管理员即可】',
    '飞书管理员开通清单（LinkHub 个人版需要企业管理员配合）：',
    '1. 打开飞书开放平台 https://open.feishu.cn/app ，创建/选择一个「企业自建应用」；',
    '2. 权限管理：按下面清单开通消息权限（缺权限时授权后仍读不到消息）：',
    '   ' + scopes.join('、') + '',
    '3. 安全设置 → 重定向 URL：添加 ' + redirectUri + '（照抄，含 /api/feishu/oauth/callback）；',
    '4. 事件订阅：默认用长连接（FEISHU_STREAM=true）可免公网回调，此时 Verify Token / Encrypt Key 都可不填；只有改用 HTTP 回调模式才必须填 Verification Token；',
    '5. 发布应用；',
    '6. 运行模式：FEISHU_MODE=auto/real（显式 mock 会一直演示，不会真实收发）。',
    '7. 在 LinkHub 点「填写飞书应用凭据」（按钮上写的就是 App ID / App Secret）填入凭据（也可写 .env 的 FEISHU_APP_ID / FEISHU_APP_SECRET），然后重启后端（保存后界面会提示）；',
    '8. 回到「连接账号」页点「连接飞书本人账号」，用本人账号完成授权。',
  ].join('\n');
}

/** 钉钉管理员可复制清单（纯文本；CLI 访问 + 可移植登录命令） */
export function dingtalkAdminChecklist(loginCommand?: string): string {
  const login = portableDwsLoginCommand(loginCommand);
  return [
    '【给企业管理员看的开通清单：普通用户不用管这些，直接复制发给管理员即可】',
    '钉钉管理员开通清单（LinkHub 个人版需要企业管理员配合）：',
    '1. 打开钉钉开发者后台 https://open-dev.dingtalk.com/ ；',
    '2. 如用「本人账号」收发（推荐，无需机器人应用）：企业管理员在钉钉开放平台开启「CLI 访问管理」（钉钉工作台命令行工具的个人身份依赖它）；',
    '3. 如用机器人：创建「企业内部应用」，记录 Client ID / Client Secret，开通机器人发消息权限并配置事件订阅；',
    '4. 个人登录（本机推荐）：打开 LinkHub「连接账号」→ 钉钉 →「用钉钉本人账号登录（推荐）」；',
    `   或在本机终端执行：${login} --recommend（登录成功后无交互批量授权推荐权限）；`,
    '5. 机器人凭据可写回 LinkHub「填写钉钉应用凭据」或 .env 的 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_ROBOT_CODE，然后重启后端；',
    `6. 钉钉工作台命令行工具官方地址与文档：${DWS_REPO_URL} 。`,
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
    label: '去邮箱网页版开启收信服务（QQ 邮箱示例）',
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
      summary: '还没有邮箱账号。个人版可以直接在本页添加（需要邮箱授权码）。',
      hints: [
        '先到邮箱网页版的「设置 → 账户 / 安全」里开启收信服务（有的邮箱写作 IMAP/SMTP 或 POP3/SMTP），并生成授权码（16 位左右，不是网页登录密码）。',
        // P2-1：白号（auto 因无账号回退 mock）不能说成「显式 MAIL_MODE=mock / 改 .env + 重启」
        policy === 'mock'
          ? '邮箱被设成了演示模式：需要由部署的人把邮箱模式改成真实，重新打开 LinkHub 后才会真实收发。'
          : '添加账号并点「测试连接」，验证通过后会自动开始真实收信（不需要改配置，也不用重新打开 LinkHub）。',
        '第一次只从新邮件开始收，不会导入历史邮件；「测试连接」会真实登录一次邮箱（只登录，不发信）。',
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
        '「测试连接」会真实登录一次邮箱服务器（只登录，不发信）；通过后会自动开始收新邮件。',
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
      summary: `邮箱已就绪：${verified.length} 个已验证账号（其中 ${envCount} 个来自部署配置），每 ${pollSeconds} 秒自动收一次新邮件。`,
      hints: [
        '只收新邮件，不会把历史邮件灌进收件箱，也不会改动邮箱里的已读状态。',
        unverified > 0 ? `另有 ${unverified} 个账号未验证，暂不参与收信。` : '',
        '测试连接会真实登录一次邮箱（只登录，不发信）。',
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
      summary: '邮箱被显式设为演示模式：账号已验证，但要由部署的人改成真实模式并重新打开 LinkHub 后才会真实收发。',
      hints: [
        '请让部署的人把邮箱模式改为真实（或改回自动），然后重新打开 LinkHub。',
        '重新打开后再点「重新检测」，已验证账号会自动开始收信。',
      ],
      actions: [addAction, doctorCommand('mail')],
      detail,
    };
  }
  return {
    id: 'mail',
    label: '邮箱',
    state: 'needs_admin',
    summary: '账号已验证，但真实收信还没生效（设置没被读进来）：请让部署的人检查邮箱模式，然后重新打开 LinkHub。',
    hints: [
      '在「平台应用配置」里把邮箱模式改为真实（保存后需重新打开 LinkHub），或请部署的人改好配置后重启后台服务。',
      '如果是页面添加的账号：验证通过后应该会自动开始收信；仍显示模拟时请点「重新检测」或重新打开 LinkHub。',
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
    label: '填写钉钉应用凭据（可选，用机器人时；需管理员提供）',
    path: '/api/app-config',
    method: 'PUT',
  };
  const adminActions: OnboardingAction[] = [
    { id: 'dingtalk-admin', kind: 'link', label: '打开钉钉开发者后台（管理员操作）', url: 'https://open-dev.dingtalk.com/' },
    {
      id: 'dingtalk-admin-checklist',
      kind: 'copy',
      label: '复制给企业管理员的开通清单（技术细节）',
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
      summary: '已登录钉钉本人账号，但钉钉整体还是演示模式：点「仅用本人身份」后立即生效（无需重启），才能真实收发。',
      hints: [
        '现在收发仍是模拟：外部不会真的收到你的消息。',
        '点下面的按钮切到「仅用本人身份」，然后点「重新检测」。',
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
      summary: '还没找到钉钉官方登录工具：个人版可以一键下载到本机，不用自己配置环境变量。',
      hints: [
        '点下面的按钮下载官方登录工具（约 25MB）；也可以让管理员把它装到这台电脑上。',
        '桌面版 LinkHub 已经内置，不用这一步。',
        ...(dws.pathHint ? [`技术详情（给管理员）：${dws.pathHint}`] : []),
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
      summary: '用钉钉本人账号登录即可，无需机器人应用（需企业已开「命令行访问」）。',
      hints: [
        '点「用浏览器登录（推荐）」：浏览器打开钉钉授权页，扫码/登录并确认；授权成功会自动刷新。',
        '授权页只能在运行 LinkHub 的这台电脑上打开；如果 LinkHub 跑在服务器 / 容器里，请改用设备码登录。',
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
      summary: '钉钉当前是演示模式（部署时特意设置的）：不会连接真实钉钉，也不会真的收发。',
      hints: [
        '想真实收发：点「用钉钉本人账号登录（推荐）」完成授权（登录成功后自动启用本人身份，无需重启）；或让部署的人关掉演示模式后重新打开 LinkHub。',
        '演示模式不会去检测本机是否装了钉钉工具，也不会启动收发；登录本身不受影响。',
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
    summary: '用钉钉本人账号登录即可，无需机器人应用（需企业已开「命令行访问」）。',
    hints: [
      '点「用钉钉本人账号登录（推荐）」：登录成功后会自动启用本人身份（无需重启），接收会自动开始。',
      '未完成授权不会改变任何配置（不会出现「已启用但未登录」的状态）；若企业还没开通，请联系管理员（清单可复制）。',
      '登录用本机的钉钉官方工具完成：浏览器授权或设备码确认一次即可，登录凭据只留在这台电脑。',
    ],
    actions: [
      personalLoginAction,
      configureAction,
      { id: 'dingtalk-admin', kind: 'link', label: '打开钉钉开发者后台（管理员操作）', url: 'https://open-dev.dingtalk.com/' },
      {
        id: 'dingtalk-admin-checklist',
        kind: 'copy',
        label: '复制给企业管理员的开通清单（技术细节）',
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
    label: '填写飞书应用凭据（由企业管理员提供）',
    path: '/api/app-config',
    method: 'PUT',
  };
  const adminActions: OnboardingAction[] = [
    configureAction,
    { id: 'feishu-admin', kind: 'link', label: '打开飞书开放平台（管理员操作）', url: 'https://open.feishu.cn/app' },
    {
      id: 'feishu-admin-checklist',
      kind: 'copy',
      label: '复制给企业管理员的开通清单（权限 / 回调地址 / 部署细节）',
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
        summary: '飞书应用凭据已填好，但当前是演示模式：改成真实模式并重新打开 LinkHub 后才会真实收发。',
        hints: [
          '不是缺凭据：凭据已经填好了（可在「平台应用配置」里看到）。',
          '在「平台应用配置」里把飞书改成真实模式，或让部署的人关掉演示模式，然后重新打开 LinkHub。',
          view.user.hint,
        ].filter(Boolean),
        actions: [
          {
            id: 'feishu-mode-real',
            kind: 'api',
            label: '改为真实模式（保存后需重新打开 LinkHub）',
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
      summary: '已授权飞书本人身份，但缺少飞书应用凭据：请管理员提供 App ID / App Secret 后填入，重新打开 LinkHub 才会真实收发。',
      hints: [
        '现在收发仍是模拟：外部不会真的收到消息。',
        '点「填写飞书应用凭据」填入管理员给的 App ID / App Secret，重新打开 LinkHub 后再点「重新检测」。',
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
      summary: '缺少飞书应用凭据：个人用户需要企业管理员创建一个飞书应用；拿到 App ID / App Secret 后在这里填写，然后重新打开 LinkHub。',
      hints: [
        '应用凭据需要企业管理员提供（App ID / App Secret），普通用户拿不到。',
        '默认用长连接接收消息，校验用的几项都可以不填；只有改成网页回调方式才需要（技术细节问管理员）。',
        `回调地址必须填成：${deps.feishu.redirectUri}（要和飞书后台里填的完全一致）。`,
        '配好后回到本页刷新；管理员可复制上面的「给企业管理员的开通清单」。',
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
        summary: '飞书当前是演示模式（部署时特意设置的）：不会连接真实飞书，也不会真的收发。',
        hints: ['想真实收发：请部署的人关掉演示模式（改回自动或真实），然后重新打开 LinkHub。'],
        actions: adminActions,
        detail,
      };
    }
    return {
      id: 'feishu',
      label: '飞书',
      state: 'needs_admin',
      summary: '飞书凭据已填好，但还没启用真实收发：请管理员检查飞书后台的回调地址与消息订阅设置，然后重新打开 LinkHub。',
      hints: [`技术原因（给管理员）：${runtime.reason}`, ...runtime.warnings.slice(0, 2)],
      actions: adminActions,
      detail,
    };
  }

  if (!view.user.linked) {
    return {
      id: 'feishu',
      label: '飞书',
      state: 'needs_user_auth',
      summary: '飞书应用已就绪，还差你用本人账号授权登录。',
      hints: [
        '点「连接飞书本人账号」，在浏览器里用飞书账号登录并同意授权；完成后回到 LinkHub 会自动刷新。',
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
    '微信个人号没有官方接口，只能在这台电脑上模拟操作：需要装好微信桌面端，并额外运行一个本机辅助程序。',
    '辅助程序需要在本机运行一条命令启动（技术操作，可复制给管理员）：python scripts/wechat-rpa/rpa_bridge.py --mode rpa（需先装好 pyautogui / pyperclip / pywin32 / uiautomation）。',
  ];
  const bridgeModeLabel = bridge?.mode === 'mock' ? '演示' : (bridge?.mode ?? '未知');

  // 1) 配置上就是 mock：如实说不会碰真实微信（这里不是"就绪"）
  if (runtime.mode !== 'real') {
    return {
      id: 'wechat',
      label: '微信',
      state: 'mock',
      summary: '微信当前是模拟模式：可以在收件箱演示，但不会操作真实微信，也不会采集真实消息。',
      hints: [
        ...setupHints,
        '要真实接入：请部署的人把微信切到真实模式，并启动本机辅助程序。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  // 2) 配了 real 但没探测到桥 / 桥连不上：绝不能报 ready（P0：以前只看环境变量）
  if (!bridge) {
    return {
      id: 'wechat',
      label: '微信',
      state: 'needs_install',
      summary: '微信已设为真实模式，但还没检测到本机辅助程序在运行，无法确认真实收发。',
      hints: [...setupHints, '点「重新检测」或刷新本页：LinkHub 会真的去检查辅助程序是否在运行。'],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  if (!bridge.reachable) {
    return {
      id: 'wechat',
      label: '微信',
      state: 'needs_install',
      summary: '微信已设为真实模式，但连不上本机辅助程序。',
      hints: [
        ...setupHints,
        '请确认辅助程序已经启动；如果 LinkHub 跑在另一台机器上，辅助程序要装在那台机器上。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  // 3) 桥活着但跑在 mock：发送会被后端拒绝（我们不再把它的"成功"当真实送达）
  if (bridge.mode !== 'rpa') {
    return {
      id: 'wechat',
      label: '微信',
      state: 'needs_install',
      summary: `本机辅助程序正运行在「${bridgeModeLabel}」模式：不会操作真实微信，发送会被如实拒绝。`,
      hints: [
        '给管理员：用 --mode rpa 重新启动辅助程序（命令见上方说明）。',
        '如果依赖没装齐，辅助程序会直接报错并列出缺什么，不会假装能用。',
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
      label: '微信',
      // 4.x 不是「不可用」：发送真实可用，接收走按需拉取。
      // 标 needs_install 会把人推去装 3.9，而他其实可以立刻用起来。
      state: 'ready',
      summary: '微信 4.x：发送可用；收消息改成「按需拉取」（在收件箱里点从微信拉取当前会话）。',
      hints: [
        '微信 4.x 的界面读不到消息列表，所以做不到自动收信；改成按需拉取：LinkHub 会把微信置前、选中当前会话、复制消息再入库。',
        '局限：只能拉当前打开的那个会话、屏幕上能看到的部分；过程中微信会短暂跳到最前，结束后自动还原。',
        '4.x 发送能提交，但读不到当前会话标题，LinkHub 会标「已提交未核对」；发送前请确认微信里打开的是目标会话。',
        '想让消息自动进来：改用微信 3.9 并登录，辅助程序就能自动收消息。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  // 5) 桥在 rpa 模式：还要确认它真的能收到消息（P0：以前接收钩子为空也报 ready）
  if (!bridge.canReceive) {
    return {
      id: 'wechat',
      label: '微信',
      state: 'needs_install',
      summary: `辅助程序已启动，但真实接收还没就绪：${bridge.receiveReason}`,
      hints: [
        '发送已经可用（真的操作微信桌面端）；收消息需要能读到微信窗口里的消息。',
        '检查：微信桌面端已登录并打开；辅助程序没有被最小化到找不到窗口；运行环境已装齐所需组件。',
        '只看当前会话可用 --no-switch；想自动发现新消息就保持默认（会切换会话）。',
      ],
      actions: [doctorCommand('wechat')],
      detail,
    };
  }

  return {
    id: 'wechat',
    label: '微信',
    state: 'ready',
    summary: '微信已就绪：发送真实操作微信桌面端，收到的消息由本机辅助程序转发进来。',
    hints: [
      bridge.receiveReason,
      '这种方式受窗口布局与分辨率影响，也会切换会话；发送失败会如实报错，不会假装成功。',
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
