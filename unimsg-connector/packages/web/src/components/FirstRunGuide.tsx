/**
 * 首启引导：真实后端已连上、但还没有收到任何消息时，给出「3 步上手」。
 *
 * 客户化（白号 P1-5/P2-9）：
 *  - 不再把 DINGTALK_AES_TOKEN 这类环境变量名堆给客户；管理员项折叠为「需要管理员配置（N 项）」；
 *  - 主 CTA：「去连接账号」；次 CTA：「先体验演示（注入示例消息）」；
 *  - 去掉指向不存在按钮的文案（不再写「到平台账号页点连接本人账号」）；
 *  - 开发者命令收进折叠区，普通客户默认看不到。
 *
 * 设计约束（为了零学习成本 + 可独立单测）：
 *  - 纯 props 驱动：不直接读 store，页面负责把 AppState 的关键字段传进来；
 *  - localStorage 可注入：key = linkhub.firstRunDismissed，读写失败一律降级为「未关闭」；
 *  - 显示条件严格：非 Mock 演示 + 0 条消息 + 后端从未收到消息 + 未点过「知道了」。
 */
import { useState } from 'react';
import { Button, Card, Tag, Typography } from 'antd';
import { ArrowRightOutlined, PlayCircleOutlined, RocketOutlined } from '@ant-design/icons';
import type { AccountInfo } from '../services/api';
import type { RealtimeStatus } from '../services/realtime';
import { Platform } from '../types';
import { PLATFORM_META } from '../utils/format';
import { humanizeMissingKeys } from '../features/connect/appConfigFields';
import { FIRST_RUN_DISMISS_KEY } from '../utils/onboarding';

/** 「知道了」标记沿用统一 key（与 onboarding 横幅分开；设置里可一起重置） */
export { FIRST_RUN_DISMISS_KEY };

/** 冒烟脚本默认后端地址：VITE_API_BASE 未配置成绝对地址时的回退值 */
export const DEFAULT_SMOKE_BASE = 'http://127.0.0.1:3001';

/** 可注入的最小存储接口：测试传内存实现即可，不依赖 jsdom 的 localStorage */
export type FirstRunStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 四类数据源的展示顺序（与侧边栏 / 账号页一致） */
const PLATFORM_ORDER: Platform[] = [Platform.FEISHU, Platform.DINGTALK, Platform.WECHAT, Platform.MAIL];

/** 本次实际通道：real=真实接口，mock=本地模拟（Mock 绝不伪装成真实成功） */
const MODE_META: Record<string, { label: string; color: string }> = {
  real: { label: '真实接口', color: 'success' },
  mock: { label: '演示模式', color: 'warning' },
};

/** 实时连接状态：说「后端已连上」的同时如实展示连接质量 */
const CONNECTION_META: Record<RealtimeStatus, { label: string; color: string }> = {
  connected: { label: '实时连接正常', color: 'success' },
  reconnecting: { label: '实时连接重连中', color: 'warning' },
  offline: { label: '实时连接已断开', color: 'error' },
};

const COPY_TOOLTIPS: [string, string] = ['复制命令', '已复制'];

/** 默认存储：localStorage 在隐私模式 / SSR 下可能抛错，读取失败按「未关闭」处理 */
function defaultStorage(): FirstRunStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** 读取「知道了」标记；存储不可用或抛错时按未关闭处理（引导优先展示） */
export function readFirstRunDismissed(storage?: FirstRunStorage): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(FIRST_RUN_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** 空首启判定（与「知道了」无关）：真实后端 + 收件箱为空 + 后端从未收到消息 */
export function isEmptyFirstRun(input: {
  demoMode: boolean;
  messageCount: number;
  received: number;
}): boolean {
  return !input.demoMode && input.messageCount === 0 && input.received === 0;
}

/** 显示条件（严格）：空首启 && 用户没点过「知道了」 */
export function shouldShowFirstRun(input: {
  demoMode: boolean;
  messageCount: number;
  received: number;
  dismissed: boolean;
}): boolean {
  return isEmptyFirstRun(input) && !input.dismissed;
}

/** 冒烟命令里的后端地址：优先用实际 VITE_API_BASE；相对路径（同源部署）回退默认端口 */
export function smokeBaseUrl(apiBase?: string): string {
  const base = (apiBase ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? base : DEFAULT_SMOKE_BASE;
}

/** 可一键复制的命令行（Typography.Text copyable，命令本身也可见可选中） */
function Command({ text }: { text: string }) {
  return (
    <Typography.Text className="first-run-guide__cmd" code copyable={{ text, tooltips: COPY_TOOLTIPS }}>
      {text}
    </Typography.Text>
  );
}

export interface FirstRunGuideProps {
  /** 前端 Mock 演示模式（true 时永不显示） */
  demoMode: boolean;
  /** 当前收件箱消息数（>0 时说明已有数据，不显示） */
  messageCount: number;
  /** 后端健康指标 health.received（>0 时说明后端已收到过消息，不显示） */
  received: number;
  /** /api/accounts 的四平台通道状态（mode / missing 用于展示） */
  accounts: AccountInfo[];
  /** 实时连接状态（如实展示，不参与显示条件） */
  connection: RealtimeStatus;
  /** 可注入的本地存储（测试 / SSR 用）；默认 window.localStorage */
  storage?: FirstRunStorage;
  /** 实际后端地址（来自 VITE_API_BASE），用于生成可复制的冒烟命令 */
  apiBase?: string;
  /** 是否仍在加载：加载中不显示，避免数据未就绪时误报「空收件箱」 */
  loading?: boolean;
  /** 加载错误：请求失败时绝不显示（不能在后端不可用时谎称「后端已连上」） */
  error?: string | null;
  /** 来自 onboarding steps：needs_admin/needs_install 数量（与横幅统一口径） */
  needsAdminCount?: number;
  /** 来自 onboarding steps：needs_user_auth 数量（可自己登录/添加） */
  needsAuthCount?: number;
  /** 去「连接账号」授权中心（主 CTA） */
  onOpenConnect?: () => void;
  /** 先体验演示：注入一条示例消息（次 CTA） */
  onDemo?: () => void;
  /** 点「知道了」后通知页面（页面据此把注入入口放回空态） */
  onDismiss?: () => void;
}

export function FirstRunGuide({
  demoMode,
  messageCount,
  received,
  accounts,
  connection,
  storage,
  apiBase,
  loading = false,
  error = null,
  needsAdminCount,
  needsAuthCount,
  onOpenConnect,
  onDemo,
  onDismiss,
}: FirstRunGuideProps) {
  const resolvedStorage = storage ?? defaultStorage();
  const [dismissed, setDismissed] = useState(() => readFirstRunDismissed(resolvedStorage));

  // 诚实性优先：加载中/加载失败时不显示引导（失败时页面上方已有错误 Alert）
  if (loading || error) return null;
  if (!shouldShowFirstRun({ demoMode, messageCount, received, dismissed })) return null;

  const connectionMeta = CONNECTION_META[connection];
  const smokeCommand = `python scripts/smoke.py ${smokeBaseUrl(apiBase)}`;

  /** 缺配置的平台（折叠展示数量，不暴露 env 键名） */
  const platformsMissingConfig = PLATFORM_ORDER.map((platform) => {
    const account = accounts.find((item) => item.platform === platform);
    const missing = account?.missing ?? [];
    return { platform, count: missing.length, names: humanizeMissingKeys(missing) };
  }).filter((item) => item.count > 0);
  // 只有飞书需要企业管理员开通；邮箱/钉钉/微信可自助（添加账号 / 本人扫码 / 本地 RPA 桥）。
  // 与首启横幅统一口径：管理员数量优先用 onboarding steps 的 needs_admin 计数。
  const adminPlatforms = platformsMissingConfig.filter((item) => item.platform === 'feishu');
  const selfServicePlatforms = platformsMissingConfig.filter((item) => item.platform === 'mail' || item.platform === 'dingtalk');
  const adminPlatformCount = needsAdminCount ?? adminPlatforms.length;

  const handleDismiss = () => {
    try {
      resolvedStorage?.setItem(FIRST_RUN_DISMISS_KEY, '1');
    } catch {
      // 隐私模式 / 存储不可写时也不阻塞关闭：本次会话内隐藏即可
    }
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <section className="first-run-guide" data-testid="first-run-guide" aria-label="首次上手引导">
      <Card
        className="first-run-guide__card"
        title={
          <span className="first-run-guide__card-title">
            <RocketOutlined /> 3 步上手
          </span>
        }
      >
        <div className="first-run-guide__lead">
          <span className="first-run-guide__lead-strong">后端已连上，但还没有消息</span>
          <span className="first-run-guide__lead-desc">
            先连接你自己的账号，或注入一条示例消息看完整闭环。
          </span>
          <Tag color={connectionMeta.color} className="first-run-guide__connection">
            {connectionMeta.label}
          </Tag>
        </div>

        <div className="first-run-guide__modes" data-testid="first-run-modes">
          <span className="first-run-guide__modes-label">当前通道</span>
          {PLATFORM_ORDER.map((platform) => {
            const account = accounts.find((item) => item.platform === platform);
            const meta = PLATFORM_META[platform];
            const modeMeta = account?.mode ? MODE_META[account.mode] : undefined;
            return (
              <span
                className="first-run-guide__mode-item"
                key={platform}
                data-testid={`first-run-mode-${platform}`}
              >
                <Tag color={modeMeta?.color ?? 'default'}>
                  {meta.name} · {modeMeta?.label ?? '通道未知'}
                </Tag>
              </span>
            );
          })}
          {adminPlatformCount > 0 || adminPlatforms.length > 0 || selfServicePlatforms.length > 0 ? (
            <details className="first-run-guide__admin" data-testid="first-run-admin-config">
              <summary>
                {adminPlatformCount > 0 ? `需要管理员配置（${adminPlatformCount} 个平台）` : '还缺账号配置'}
                {(needsAuthCount ?? 0) > 0
                  ? ` · 另有 ${needsAuthCount} 项可自己登录/添加`
                  : ''}
              </summary>
              <ul>
                {adminPlatforms.map((item) => (
                  <li key={item.platform}>
                    {PLATFORM_META[item.platform].name}：{item.count} 项待配置（{item.names.join('、')}）
                    ——需要企业管理员在平台后台开通；也可以把「连接账号」里的清单发给管理员。
                  </li>
                ))}
                {selfServicePlatforms.length > 0 ? (
                  <li>
                    {selfServicePlatforms.map((item) => PLATFORM_META[item.platform].name).join('、')}
                    ：可以自己添加/登录（打开「连接账号」按卡片操作即可；邮箱只需授权码，钉钉需企业已开启 CLI 访问）。
                  </li>
                ) : null}
              </ul>
            </details>
          ) : null}
        </div>

        <ol className="first-run-guide__steps">
          <li className="first-run-guide__step">
            <span className="first-run-guide__num">1</span>
            <div className="first-run-guide__step-body">
              <div className="first-run-guide__step-head">
                <span className="first-run-guide__step-title">想先看看效果</span>
                {onDemo ? (
                  <Button
                    type="primary"
                    size="small"
                    icon={<PlayCircleOutlined />}
                    onClick={onDemo}
                  >
                    先体验演示（注入示例消息）
                  </Button>
                ) : (
                  <span className="first-run-guide__step-desc">点收件箱空态里的「注入示例」。</span>
                )}
              </div>
              <div className="first-run-guide__step-desc">
                注入一条示例消息，走通「接收 → 回复 → 回写 → 回流」的完整闭环。
              </div>
            </div>
          </li>

          <li className="first-run-guide__step">
            <span className="first-run-guide__num">2</span>
            <div className="first-run-guide__step-body">
              <div className="first-run-guide__step-head">
                <span className="first-run-guide__step-title">想接真实平台</span>
                {onOpenConnect ? (
                  <Button
                    type="primary"
                    size="small"
                    onClick={onOpenConnect}
                  >
                    去连接账号 <ArrowRightOutlined />
                  </Button>
                ) : (
                  <span className="first-run-guide__step-desc">打开左侧「连接账号」页。</span>
                )}
              </div>
              <div className="first-run-guide__step-desc">
                在「连接账号」页按 邮箱 → 钉钉 → 飞书 → 微信 逐项连接。
                钉钉可以只用本人账号（无需机器人应用）；管理员项可复制清单给管理员。
              </div>
            </div>
          </li>

          <li className="first-run-guide__step">
            <span className="first-run-guide__num">3</span>
            <div className="first-run-guide__step-body">
              <div className="first-run-guide__step-head">
                <span className="first-run-guide__step-title">想核对每个平台走了哪条通道</span>
                {onOpenConnect ? (
                  <Button
                    type="link"
                    size="small"
                    className="first-run-guide__link"
                    onClick={onOpenConnect}
                  >
                    去「连接账号」查看状态 <ArrowRightOutlined />
                  </Button>
                ) : (
                  <span className="first-run-guide__step-desc">打开左侧「连接账号」页查看。</span>
                )}
              </div>
              <div className="first-run-guide__step-desc">
                每张卡会如实标注「已就绪 / 需本人授权 / 需安装 / 需管理员 / 演示模式」，
                并给出下一步按钮；不会把 Mock 说成已连接。
              </div>
            </div>
          </li>
        </ol>

        <details className="first-run-guide__dev">
          <summary>开发者：命令行方式（可选）</summary>
          <div className="first-run-guide__dev-body">
            <div className="first-run-guide__dev-row">
              <span>冒烟脚本（在 unimsg-connector/ 下）：</span>
              <Command text={smokeCommand} />
            </div>
            <div className="first-run-guide__dev-row">
              <span>平台自检：</span>
              <Command text="pnpm run doctor" />
            </div>
            <div className="first-run-guide__dev-row">
              <span>启动后端：</span>
              <Command text="pnpm --filter @unimsg/server start" />
            </div>
            <div className="first-run-guide__dev-row">
              <span>启动前端：</span>
              <Command text="pnpm --filter @unimsg/web dev" />
            </div>
          </div>
        </details>

        <div className="first-run-guide__footer">
          <span className="first-run-guide__foot-hint">收到第一条消息后，这条引导会自动隐藏。</span>
          <Button size="small" onClick={handleDismiss}>
            知道了
          </Button>
        </div>
      </Card>
    </section>
  );
}


