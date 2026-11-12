/**
 * 邮箱账号「运行时导入」HTTP 接口（个人版「连接账号」页使用；Bearer 鉴权，中文错误）：
 *
 *  - GET    /api/mail/accounts        本地 + .env 账号脱敏列表（授权码永不下发）
 *  - POST   /api/mail/accounts/test   只做 IMAP/SMTP 登录自检（不落盘、不发信、不打印授权码）
 *  - POST   /api/mail/accounts        校验 + 保存到本地文件 + 热加载轮询（无需重启）
 *  - DELETE /api/mail/accounts/:key   只允许删本地导入账号；.env 来源 → 400 中文提示
 *
 * 安全：authCode 只在服务端内存/本地文件中；响应、日志、错误信息都不含授权码。
 */
import { Router, type Request, type Response } from 'express';
import { currentMailAccounts, MailAccountsError, maskMailAddress, type MailAccountsStore } from '../services/mailAccounts';
import { testMailAccountInput } from '../services/mailAccountTest';
import { createMailAccountFromInput, type MailAccountInput } from '../config/runtime';

export interface MailAccountsRouterDeps {
  /** 单测注入：内存 store（避免写真实文件） */
  store?: MailAccountsStore;
  /** 单测注入：测试连接实现（避免真实 IMAP/SMTP 网络） */
  testAccount?: typeof testMailAccountInput;
}

function sendError(res: Response, e: unknown): void {
  if (e instanceof MailAccountsError) {
    const status = e.code === 'not-found' ? 404 : 400;
    res.status(status).json({ ok: false, error: e.message });
    return;
  }
  const message = e instanceof Error ? e.message : String(e);
  res.status(500).json({ ok: false, error: `邮箱账号操作失败：${message}` });
}

/** 请求体必须是对象（避免数组/字符串导致字段访问异常） */
function bodyObject(req: Request): Record<string, unknown> {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

export function mailAccountsRouter(deps: MailAccountsRouterDeps = {}): Router {
  const r = Router();
  const store = (): MailAccountsStore => deps.store ?? currentMailAccounts();
  const testAccount = deps.testAccount ?? testMailAccountInput;

  r.get('/mail/accounts', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const snapshot = store().snapshot();
      res.json({
        ok: true,
        data: {
          accounts: snapshot.masked,
          filePath: snapshot.filePath,
          issues: snapshot.issues,
          providers: ['qq', '163', '126', 'yeah', 'gmail', 'outlook', 'icloud', 'custom'],
        },
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.post('/mail/accounts/test', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const input = bodyObject(req) as MailAccountInput;
      // 先做纯本地校验：字段不全直接 400，绝不为了"测试连接"去连网络/碰真实邮箱
      const built = createMailAccountFromInput(input);
      if (!built.account) {
        res.status(400).json({ ok: false, error: built.errors.join('；'), errors: built.errors });
        return;
      }
      const { errors, result } = await testAccount(input);
      if (errors) {
        res.status(400).json({ ok: false, error: errors.join('；'), errors });
        return;
      }
      res.json({ ok: true, data: result });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.post('/mail/accounts', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { account, warnings, snapshot } = store().addOrUpdate(bodyObject(req) as MailAccountInput);
      const source = snapshot.sources[account.key] ?? 'file';
      res.status(201).json({
        ok: true,
        data: {
          account: store().maskedOf(account, source),
          warnings,
          hotReloaded: true,
          message: '邮箱账号已保存到本地并热加载（无需重启后端）。重启后会从本地文件自动恢复。',
        },
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.delete('/mail/accounts/:key', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { removed, snapshot } = store().remove(String(req.params.key ?? ''));
      res.json({
        ok: true,
        data: {
          removed: {
            key: removed.key,
            label: removed.label,
            address: maskMailAddress(removed.address),
          },
          hotReloaded: true,
        },
      });
      void snapshot;
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}