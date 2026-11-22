/**
 * 入口鉴权：保护 /api/*（除 health、webhook、auth 之外的业务接口）。
 *
 * 两种凭证都接受：
 *  1. 账号会话令牌（登录后颁发，带「我是谁」——注册/登录闭环的主角）；
 *  2. 部署级 API_TOKEN（单机演示 / 旧客户端兼容，不带用户身份）。
 */
import type { Request, RequestHandler } from 'express';
import { config } from '../config';
import { userStore } from '../services/users';
import type { PublicUser } from '../services/users';
import type { MessageService } from '../services/message';

/** 通过会话令牌登录后的身份；用 API_TOKEN 直连时为 undefined */
export interface AuthedRequest extends Request {
  user?: PublicUser;
}

/** 默认演示令牌：零配置能跑通本地演示，但对外暴露前必须替换 */
export const DEFAULT_DEV_TOKEN = 'dev-token';

/**
 * 有效入密码牌：空 API_TOKEN（漏填/写成空串）视同「未配置」→ 回退 dev-token，
 * 绝不因为空串而关闭鉴权（旧实现 `if (!token) next()` 会让空 token 变成人人可访问）。
 */
export function resolveApiToken(raw: string | undefined): string {
  const token = (raw ?? '').trim();
  return token || DEFAULT_DEV_TOKEN;
}

/**
 * 默认令牌告警文案。返回 null 表示令牌已自定义，无需提示。
 * 启动日志会把它打成醒目中文警告（演示可以、对外暴露前必须改）。
 */
export function devTokenWarning(token: string): string | null {
  if (token !== DEFAULT_DEV_TOKEN) return null;
  return '正在使用默认 dev-token，演示可以、对外暴露前必须改：'
    + '请在 .env 中设置 API_TOKEN=<足够随机的字符串> 并重启服务。';
}

/** 启动时令牌告警：空串与默认令牌都要醒目提示（自定义令牌返回 null） */
export function apiTokenWarning(raw: string | undefined): string | null {
  if (!(raw ?? '').trim()) {
    return 'API_TOKEN 为空（等于未配置），已回退默认 dev-token 并继续要求 Bearer 鉴权；'
      + '演示可以、对外暴露前必须改：请在 .env 设置强随机 API_TOKEN 后重启。';
  }
  return devTokenWarning(resolveApiToken(raw));
}

/**
 * 生产环境安全闸门：NODE_ENV=production 且令牌为空/仍是默认 dev-token 时拒绝启动。
 * 返回 null 表示可以启动；返回字符串 = 拒绝启动的原因。
 */
export function productionTokenBlocker(raw: string | undefined, nodeEnv: string | undefined): string | null {
  if (nodeEnv !== 'production') return null;
  if (resolveApiToken(raw) !== DEFAULT_DEV_TOKEN) return null;
  const why = (raw ?? '').trim() ? '，仍在使用默认 dev-token' : '，API_TOKEN 为空（等于未配置）';
  return `拒绝启动：NODE_ENV=production 时${why}。`
    + '请先在 .env 设置强随机 API_TOKEN，再重新启动，避免接口被任意人调用。';
}

/**
 * 当前部署是否「必须登录」——决定部署令牌通道（API_TOKEN 直连）是否关闭。
 *
 * `auto`（默认）：本机已建账号就必须登录，否则 dev-token 可以绕过数据隔离；
 * 没账号时仍然零配置可演示。单测的纯内存账号库（usersFile 为空）不参与判定。
 */
export function loginRequired(): boolean {
  if (config.authRequireLoginMode === 'on') return true;
  if (config.authRequireLoginMode === 'off') return false;
  if (!config.usersFile) return false;
  try {
    const store = userStore();
    // 账号库损坏时 fail-closed：否则「读不出来 = 0 个账号」会让部署令牌重新可用，
    // 悄悄绕过登录与数据隔离。修复办法见 doctor / users.json.bak。
    if (store.loadFailure) return true;
    return store.count() > 0;
  } catch {
    // 连账号库都构造不出来时同样按「要求登录」处理，不再 fail-open
    return true;
  }
}

/** 机器主人：优先取显式登记的 owner，否则取最早注册的账号（与「首个账号接管」一致） */
export function machineOwnerId(svc: MessageService): string | undefined {
  const explicit = svc.getDefaultOwner();
  if (explicit) return explicit;
  const users = userStore().list();
  if (users.length === 0) return undefined;
  return users.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id;
}

/**
 * 机器级操作（改平台凭据 / 加邮箱账号 / 拉起本人授权）只允许机器主人执行。
 *
 * 读接口（GET/HEAD）放行：普通成员仍能看账号状态，只是不能改；
 * 部署令牌（req.user 为空）放行——它在有账号时已被 apiAuth 关闭，能走到这里说明还没建账号。
 */
export function ownerOnly(svc: MessageService): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      next();
      return;
    }
    const user = (req as AuthedRequest).user;
    if (!user) {
      next();
      return;
    }
    const ownerId = machineOwnerId(svc);
    if (!ownerId || ownerId === user.id) {
      next();
      return;
    }
    res.status(403).json({
      ok: false,
      error: '这项设置管的是整台电脑上的平台连接，只有「主人账号」能改。请让主人账号操作，或换成主人账号再试。',
    });
  };
}

export const apiAuth: RequestHandler = (req, res, next) => {
  // 永远鉴权：空串已在上方回退为 dev-token，不存在「未配置就放行」的分支
  const token = resolveApiToken(config.apiToken);

  const header = req.headers.authorization ?? '';
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : '';
  const fromQuery = typeof req.query.token === 'string' ? req.query.token : '';
  const provided = fromHeader || fromQuery;

  // 1) 部署令牌（单机演示 / 兼容旧客户端）：可用，但没有用户身份。
  //    一旦本机有账号（或显式要求登录）这条通道关闭，否则隔离可被 dev-token 绕过。
  if (provided && provided === token && !loginRequired()) {
    next();
    return;
  }

  // 2) 账号会话令牌：把「我是谁」挂到请求上，业务层可以据此归属数据
  if (provided) {
    const user = userStore().resolveSession(provided);
    if (user) {
      (req as AuthedRequest).user = user;
      next();
      return;
    }
  }

  res.status(401).json({ ok: false, error: 'unauthorized' });
};
