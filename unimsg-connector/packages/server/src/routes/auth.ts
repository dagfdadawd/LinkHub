/**
 * `POST /api/auth/*`：注册 / 登录 / 当前用户 / 登出。
 *
 * 这四个接口**不挂 apiAuth**（否则"要先有令牌才能登录"成死循环），
 * 但做了朴素防爆破：连续失败达到阈值后按窗口拒绝再试，并回 `Retry-After`。
 * 限流按「动作 + 来源 IP + 用户名」分桶：
 *  - 登录失败只影响该用户名，不会把同一出口 IP 下所有人一起锁死；
 *  - 注册只统计失败次数，成功会清零（旧实现成功也计数，10 次后正常用户也注册不了）；
 *  - 重置口令使用独立桶，登录被限不会连带找回口令。
 * 响应里绝不返回口令哈希或盐。
 */
import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { userStore, UserStoreError } from '../services/users';
import { loginRequired } from '../middlewares/auth';
import { config } from '../config';
import type { MessageService } from '../services/message';

// 账号库单例已经下沉到 services/users（避免 routes/auth ⇄ middlewares/auth 循环依赖）。
// 这里保留同名导出，历史上从本模块 import 的调用方与单测无需改动。
export { userStore, setUserStore } from '../services/users';

const FAIL_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAIL_LIMIT = 10;
const REGISTER_FAIL_LIMIT = 10;
/** 失败计数表的上限：超过后先清过期项，避免被大量不同 IP/用户名撑爆内存 */
const MAX_BUCKETS = 5000;

interface Bucket {
  count: number;
  firstAt: number;
}

const failures = new Map<string, Bucket>();

function clientKey(req: Request): string {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return String(ip);
}

function sweepExpired(now: number): void {
  if (failures.size < MAX_BUCKETS) return;
  for (const [key, hit] of failures) {
    if (now - hit.firstAt > FAIL_WINDOW_MS) failures.delete(key);
  }
}

/** 命中限流时返回建议等待秒数（用于 Retry-After），未命中返回 null */
function blockedSeconds(key: string, limit: number, windowMs = FAIL_WINDOW_MS): number | null {
  const hit = failures.get(key);
  if (!hit) return null;
  const now = Date.now();
  if (now - hit.firstAt > windowMs) {
    failures.delete(key);
    return null;
  }
  if (hit.count < limit) return null;
  return Math.max(1, Math.ceil((hit.firstAt + windowMs - now) / 1000));
}

function noteFailure(key: string): void {
  const now = Date.now();
  const hit = failures.get(key);
  if (!hit || now - hit.firstAt > FAIL_WINDOW_MS) {
    sweepExpired(now);
    failures.set(key, { count: 1, firstAt: now });
    return;
  }
  hit.count += 1;
}

function clearFailures(key: string): void {
  failures.delete(key);
}

function sendRateLimited(res: Response, retryAfterSeconds: number): void {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json({ ok: false, error: `尝试过于频繁，请 ${minutes} 分钟后再试` });
}

/** 单测用 */
export function resetAuthRateLimit(): void {
  failures.clear();
}

export interface RegistrationPolicy {
  open: boolean;
  requireCode: boolean;
  reason?: string;
}

/**
 * 注册准入（安全默认）：
 *  - 纯内存账号库（单测 / 未落盘）不限制；
 *  - `AUTH_REGISTRATION=open` 始终允许；`closed` 始终拒绝；
 *  - `auto`（默认）：本机还没有账号时允许创建第一个账号；
 *    已有账号后默认关闭，只有配置了 `AUTH_SIGNUP_CODE` 时才凭邀请码注册。
 */
export function registrationPolicy(): RegistrationPolicy {
  if (!config.usersFile) return { open: true, requireCode: false };
  if (config.authRegistrationMode === 'open') return { open: true, requireCode: false };
  if (config.authRegistrationMode === 'closed') {
    return { open: false, requireCode: false, reason: '本机已关闭自助注册（AUTH_REGISTRATION=closed）' };
  }
  try {
    if (userStore().count() === 0) return { open: true, requireCode: false };
  } catch {
    return { open: false, requireCode: false, reason: '账号库读取失败，暂时禁止注册（请检查 users.json）' };
  }
  if (config.authSignupCode) return { open: true, requireCode: true };
  return {
    open: false,
    requireCode: false,
    reason: '本机已有账号，自助注册已关闭；如需添加成员，请设置 AUTH_SIGNUP_CODE 后重启 LinkHub',
  };
}

/** 邀请码按哈希常数时间比较，避免逐字符比较泄露前缀 */
function signupCodeOk(provided: string): boolean {
  const expected = config.authSignupCode;
  if (!expected) return false;
  const a = createHash('sha256').update((provided ?? '').trim()).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function authRouter(svc?: MessageService): Router {
  const r = Router();

  /**
   * 公开的登录态/策略查询：前端据此决定「要不要先登录」「注册入口怎么展示」。
   *  - requireLogin：本机是否强制登录（登录守卫的唯一依据）；
   *  - hasUsers：是否已经建过账号；
   *  - registration：自助注册是否开放、是否需要邀请码；
   *  - machineOwner：只有主人本人（或还没产生主人时）才返回，避免匿名泄露账号信息。
   */
  r.get('/auth/status', (req: Request, res: Response) => {
    const token = bearer(req);
    const user = token ? userStore().resolveSession(token) : undefined;
    const ownerId = svc?.getDefaultOwner();
    const owner = ownerId ? userStore().list().find((u) => u.id === ownerId) : undefined;
    const policy = registrationPolicy();
    res.json({
      ok: true,
      data: {
        requireLogin: loginRequired(),
        hasUsers: userStore().count() > 0,
        registration: {
          open: policy.open,
          requireCode: policy.requireCode,
          ...(policy.reason ? { reason: policy.reason } : {}),
        },
        machineOwner: owner && user && user.id === owner.id
          ? { id: owner.id, displayName: owner.displayName }
          : null,
        user: user ?? null,
      },
    });
  });

  r.post('/auth/register', (req: Request, res: Response) => {
    const key = `register|${clientKey(req)}`;
    const retry = blockedSeconds(key, REGISTER_FAIL_LIMIT);
    if (retry !== null) {
      sendRateLimited(res, retry);
      return;
    }
    const policy = registrationPolicy();
    if (!policy.open) {
      res.status(403).json({ ok: false, error: policy.reason ?? '自助注册已关闭' });
      return;
    }
    if (policy.requireCode && !signupCodeOk(String(req.body?.signupCode ?? ''))) {
      // 邀请码错误按失败计数：避免无限猜码
      noteFailure(key);
      res.status(403).json({ ok: false, error: '邀请码不正确' });
      return;
    }
    try {
      const registered = userStore().register({
        username: String(req.body?.username ?? ''),
        password: String(req.body?.password ?? ''),
        displayName: req.body?.displayName ? String(req.body.displayName) : undefined,
      });
      // 注册成功直接发会话，省掉"注册完还要再登录一次"
      const { token } = userStore().login({
        username: registered.user.username,
        password: String(req.body?.password ?? ''),
        ip: clientKey(req),
      });
      // 成功不占用失败额度：否则 10 个正常用户就把整台机器的注册口锁 5 分钟
      clearFailures(key);
      // 第一个注册的账号接管「机器主人」：平台连接收到的消息默认归属它
      if (svc && !svc.getDefaultOwner()) {
        svc.setDefaultOwner(registered.user.id);
        // 顺手接管注册前就已入库的无主消息：否则新用户一登录看到空收件箱，会以为服务坏了
        // （启动路径 index.ts 做的是同一件事，这里补上"运行期才注册"的情况）
        const claimed = svc.claimUnowned(registered.user.id);
        if (claimed > 0) {
          console.log(`[auth] 首个账号接管了 ${claimed} 条历史消息`);
        }
      }
      // recoveryCode 只在这里返回一次（库里只存哈希）
      res.status(201).json({
        ok: true,
        data: { user: registered.user, token, recoveryCode: registered.recoveryCode },
      });
    } catch (e) {
      noteFailure(key);
      if (e instanceof UserStoreError) {
        res.status(e.status).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : '注册失败' });
    }
  });

  r.post('/auth/login', (req: Request, res: Response) => {
    const username = String(req.body?.username ?? '').trim();
    // 按「IP + 用户名」分桶：同办公室/同 NAT 的其他人不会被一个人的连续失败连坐
    const key = `login|${clientKey(req)}|${username.toLowerCase()}`;
    const retry = blockedSeconds(key, LOGIN_FAIL_LIMIT);
    if (retry !== null) {
      sendRateLimited(res, retry);
      return;
    }
    try {
      const result = userStore().login({
        username,
        password: String(req.body?.password ?? ''),
        ip: clientKey(req),
      });
      clearFailures(key);
      res.json({ ok: true, data: result });
    } catch (e) {
      noteFailure(key);
      if (e instanceof UserStoreError) {
        res.status(e.status).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : '登录失败' });
    }
  });

  /** 忘记口令：用注册时发的恢复码重置（不需要旧口令），成功后返回**新的**恢复码 */
  r.post('/auth/reset-password', (req: Request, res: Response) => {
    const username = String(req.body?.username ?? '').trim();
    // 独立桶：登录被限流不应连带把「找回口令」也锁死
    const key = `reset|${clientKey(req)}|${username.toLowerCase()}`;
    const retry = blockedSeconds(key, LOGIN_FAIL_LIMIT);
    if (retry !== null) {
      sendRateLimited(res, retry);
      return;
    }
    try {
      const { revoked, recoveryCode } = userStore().resetPassword({
        username,
        recoveryCode: String(req.body?.recoveryCode ?? ''),
        newPassword: String(req.body?.newPassword ?? ''),
      });
      clearFailures(key);
      // 旧恢复码已作废：不把新码带回去，用户就再也找不回账号了
      res.json({ ok: true, data: { revoked, recoveryCode } });
    } catch (e) {
      noteFailure(key);
      if (e instanceof UserStoreError) {
        res.status(e.status).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : '重置口令失败' });
    }
  });

  r.get('/auth/me', (req: Request, res: Response) => {
    const token = bearer(req);
    const user = token ? userStore().resolveSession(token) : undefined;
    if (!user) {
      res.status(401).json({ ok: false, error: '未登录或会话已过期' });
      return;
    }
    res.json({ ok: true, data: { user, sessionCount: userStore().countSessions(user.id) } });
  });

  /** 改口令：需要当前会话；成功后该账号所有会话（含本机）全部作废，必须重新登录 */
  r.post('/auth/password', (req: Request, res: Response) => {
    const token = bearer(req);
    const user = token ? userStore().resolveSession(token) : undefined;
    if (!user) {
      res.status(401).json({ ok: false, error: '未登录或会话已过期' });
      return;
    }
    try {
      const { revoked } = userStore().changePassword({
        userId: user.id,
        oldPassword: String(req.body?.oldPassword ?? ''),
        newPassword: String(req.body?.newPassword ?? ''),
      });
      res.json({ ok: true, data: { revoked } });
    } catch (e) {
      if (e instanceof UserStoreError) {
        res.status(e.status).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : '修改口令失败' });
    }
  });

  /** 退出所有设备：作废该账号全部会话（当前这条也失效） */
  r.post('/auth/logout-all', (req: Request, res: Response) => {
    const token = bearer(req);
    const user = token ? userStore().resolveSession(token) : undefined;
    if (!user) {
      res.status(401).json({ ok: false, error: '未登录或会话已过期' });
      return;
    }
    const revoked = userStore().revokeAllSessions(user.id);
    res.json({ ok: true, data: { revoked } });
  });

  r.post('/auth/logout', (req: Request, res: Response) => {
    const token = bearer(req);
    if (token) userStore().logout(token);
    res.json({ ok: true });
  });

  return r;
}

function bearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}