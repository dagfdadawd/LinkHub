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
import { basename } from 'node:path';
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

/** 已保存账号 → 测试输入（验证接口用；authCode 只在服务端内流转，绝不下发） */
function accountToInput(account: {
  key: string; address: string; authCode: string; provider: string; label: string;
  imapHost: string; imapPort: number; imapSecure: boolean;
  smtpHost: string; smtpPort: number; smtpSecure: boolean; folders: string[];
}): MailAccountInput {
  return {
    key: account.key,
    address: account.address,
    authCode: account.authCode,
    provider: account.provider,
    label: account.label,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapSecure: account.imapSecure,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    folders: account.folders,
  };
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
          // P3：认证接口只给 basename，不暴露本机绝对路径
          filePath: basename(snapshot.filePath),
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

  r.post('/mail/accounts', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = bodyObject(req);
      const wantVerify = body.verify === true;
      if (wantVerify) {
        // 先做一次真实 IMAP/SMTP 登录自检：通过才保存并直接标记已验证（「测试通过才保存」语义）
        const built = createMailAccountFromInput(body as MailAccountInput);
        if (!built.account) {
          res.status(400).json({ ok: false, error: built.errors.join('；'), errors: built.errors });
          return;
        }
        const tested = await testAccount(body as MailAccountInput);
        if (tested.errors) {
          res.status(400).json({ ok: false, error: tested.errors.join('；'), errors: tested.errors });
          return;
        }
        if (!tested.result?.ok) {
          res.status(200).json({
            ok: false,
            saved: false,
            error: '测试连接未通过，账号未保存。请按提示修正授权码/服务器后重试（也可取消勾选「测试通过再保存」先保存待验证）。',
            test: tested.result,
          });
          return;
        }
        const saved = store().addOrUpdate(body as MailAccountInput);
        const marked = store().markVerified(saved.account.key);
        const source = marked.snapshot.sources[saved.account.key] ?? 'file';
        res.status(201).json({
          ok: true,
          data: {
            account: store().maskedOf(marked.account, source),
            warnings: saved.warnings,
            hotReloaded: true,
            verified: true,
            message: '邮箱连接测试通过，账号已保存并标记为已验证（无需重启，下一轮开始收信）。',
          },
        });
        return;
      }
      const { account, warnings, snapshot } = store().addOrUpdate(body as MailAccountInput);
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

  // 对「已保存的本地账号」跑真实 IMAP+SMTP 登录自检；成功才写 verifiedAt（未验证不算已就绪）
  r.post('/mail/accounts/:key/verify', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const key = String(req.params.key ?? '');
      const storeRef = store();
      const account = storeRef.accountOf(key);
      if (!account) {
        res.status(404).json({ ok: false, error: `本地没有找到邮箱账号「${key}」（可能已删除）` });
        return;
      }
      if (storeRef.sourceOf(key) === 'env') {
        res.status(400).json({
          ok: false,
          error: `邮箱账号「${key}」来自 .env：默认视为已验证，无需在页面验证（要改凭据请修改 .env 并重启）。`,
        });
        return;
      }
      const tested = await testAccount(accountToInput(account));
      if (tested.errors) {
        res.status(400).json({ ok: false, error: tested.errors.join('；'), errors: tested.errors });
        return;
      }
      if (!tested.result?.ok) {
        res.json({
          ok: false,
          verified: false,
          error: '测试连接未通过：账号保持「未验证」，请按提示修正后重试。',
          imap: tested.result?.imap,
          smtp: tested.result?.smtp,
        });
        return;
      }
      const marked = storeRef.markVerified(key);
      res.json({
        ok: true,
        verified: true,
        verifiedAt: marked.account.verifiedAt,
        account: storeRef.maskedOf(marked.account, 'file'),
        message: '验证通过：邮箱账号已标记为已验证，下一轮开始真实收信。',
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