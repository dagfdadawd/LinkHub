/**
 * 邮箱账号运行时导入（个人版「连接账号」页）单测：
 *  - 输入校验/预设推导/脱敏；
 *  - 本地文件加载/合并（file 覆盖 env + warn）/增删/热加载回调；
 *  - 授权码永不出现在脱敏视图；env 来源不可删（400 语义）。
 * 全部使用临时文件，不连网络、不碰真实账号。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config';
import { createMailAccountFromInput, type MailAccount } from '../config/runtime';
import {
  LOCAL_MAIL_ACCOUNTS_FILE,
  MailAccountsError,
  MailAccountsStore,
  loadMailAccountsFile,
  mailAccountsFilePath,
  maskMailAddress,
  saveMailAccountsFile,
} from './mailAccounts';

const dirs: string[] = [];
const original = {
  accounts: [...config.mail.accounts],
  enabled: config.mail.enabled,
  issues: [...config.mail.issues],
};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkhub-mail-accounts-'));
  dirs.push(dir);
  return dir;
}

function envAccount(): MailAccount {
  return {
    key: 'envmail',
    label: '.env 邮箱',
    address: 'env@qq.com',
    authCode: 'env-secret-code',
    provider: 'qq',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    folders: ['INBOX'],
  };
}

function resetConfig(accounts: MailAccount[] = []): void {
  config.mail.accounts.splice(0, config.mail.accounts.length, ...accounts);
  config.mail.issues.splice(0, config.mail.issues.length);
}

beforeEach(() => {
  resetConfig();
});

after(() => {
  config.mail.accounts.splice(0, config.mail.accounts.length, ...original.accounts);
  config.mail.issues.splice(0, config.mail.issues.length, ...original.issues);
  config.mail.enabled = original.enabled;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('createMailAccountFromInput：预设推导 / 自定义 hosts / 中文校验错误', () => {
  const qq = createMailAccountFromInput({ address: 'zhang.san@qq.com', authCode: 'abcd1234abcd1234' });
  assert.ok(qq.account);
  assert.equal(qq.account!.key, 'zhangsan', 'key 由邮箱地址推导');
  assert.equal(qq.account!.provider, 'qq');
  assert.equal(qq.account!.label, 'QQ邮箱');
  assert.equal(qq.account!.imapHost, 'imap.qq.com');
  assert.equal(qq.account!.imapPort, 993);
  assert.equal(qq.account!.imapSecure, true);
  assert.equal(qq.account!.smtpHost, 'smtp.qq.com');
  assert.equal(qq.account!.smtpPort, 465);
  assert.deepEqual(qq.account!.folders, ['INBOX']);

  const custom = createMailAccountFromInput({
    key: 'work',
    address: 'me@company.com',
    authCode: 'code',
    imapHost: 'imap.company.com',
    smtpHost: 'smtp.company.com',
    imapPort: '143',
    smtpPort: '587',
    folders: 'INBOX,Junk',
  });
  assert.ok(custom.account);
  assert.equal(custom.account!.provider, 'custom');
  assert.equal(custom.account!.imapPort, 143);
  assert.equal(custom.account!.imapSecure, false, '143 默认 STARTTLS');
  assert.equal(custom.account!.smtpSecure, false);
  assert.deepEqual(custom.account!.folders, ['INBOX', 'Junk']);

  const bad = createMailAccountFromInput({ address: 'not-an-email', authCode: '' });
  assert.equal(bad.account, undefined);
  const text = bad.errors.join('；');
  assert.match(text, /邮箱地址格式不对/);
  assert.match(text, /授权码/);

  const noHosts = createMailAccountFromInput({ address: 'a@unknown-domain.test', authCode: 'x' });
  assert.equal(noHosts.account, undefined);
  assert.match(noHosts.errors.join('；'), /IMAP 服务器|SMTP 服务器/);

  const badKey = createMailAccountFromInput({ key: '中文 key', address: 'a@qq.com', authCode: 'x' });
  assert.equal(badKey.account, undefined);
  assert.match(badKey.errors.join('；'), /账号 key/);
});

test('掩码/文件路径：保留首字母+域名；DATA_DIR 优先，否则仓库根 .linkhub-mail-accounts.json', () => {
  assert.equal(maskMailAddress('zhangsan@qq.com'), 'z******@qq.com'); // 首字母 + 最多 6 个星号
  assert.equal(maskMailAddress('a@163.com'), 'a**@163.com');
  assert.equal(mailAccountsFilePath({ DATA_DIR: 'C:\\data' }).replace(/\\/g, '/').endsWith('/data/mail-accounts.json'), true);
  assert.equal(mailAccountsFilePath({}).endsWith(LOCAL_MAIL_ACCOUNTS_FILE), true);
});

test('本地文件：加载容错 + 原子保存后往返一致（文件包含授权码，绝不打印）', () => {
  const dir = tempDir();
  const file = join(dir, 'mail-accounts.json');

  // 文件损坏 → 带回 issue，不抛错
  writeFileSync(file, '{bad json', 'utf8');
  const broken = loadMailAccountsFile(file);
  assert.equal(broken.entries.length, 0);
  assert.ok(broken.issues[0]!.includes('解析失败'));

  // 保存 → 读回（含 authCode，仅供服务端使用）
  const account = createMailAccountFromInput({ address: 'a@qq.com', authCode: 'secret-1' }).account!;
  saveMailAccountsFile(file, [account]);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.accounts[0].authCode, 'secret-1');
  const loaded = loadMailAccountsFile(file);
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0]!.address, 'a@qq.com');
  assert.deepEqual(loaded.issues, []);
});

test('Store：启动合并 env+file（file 覆盖同 key + warn）、热加载回调、脱敏视图不含授权码', () => {
  const dir = tempDir();
  const file = join(dir, 'mail-accounts.json');
  const env = envAccount();
  resetConfig([env]);
  // 文件里：一个全新账号 + 一个与 env 同 key 的覆盖账号
  saveMailAccountsFile(file, [
    createMailAccountFromInput({ key: 'newmail', address: 'new@163.com', authCode: 'new-code' }).account!,
    createMailAccountFromInput({ key: 'envmail', address: 'override@qq.com', authCode: 'file-code' }).account!,
  ]);

  const changes: string[] = [];
  const warns: string[] = [];
  const store = new MailAccountsStore({ file, onChange: (r) => changes.push(r), log: () => {}, warn: (l) => warns.push(l) });
  const snapshot = store.init();

  assert.equal(config.mail.accounts.length, 2, '同 key 不应重复');
  const override = config.mail.accounts.find((a) => a.key === 'envmail')!;
  assert.equal(override.address, 'override@qq.com', 'file 覆盖 env');
  assert.ok(warns.some((w) => /覆盖 .env 中同名账号/.test(w)), warns.join('\n'));
  assert.equal(store.sourceOf('envmail'), 'file');
  assert.equal(store.sourceOf('newmail'), 'file');

  const maskedText = JSON.stringify(snapshot.masked);
  assert.ok(!maskedText.includes('file-code'), '脱敏视图绝不能包含授权码');
  assert.ok(!maskedText.includes('new-code'));
  const maskedNew = snapshot.masked.find((m) => m.key === 'newmail')!;
  assert.equal(maskedNew.address, 'n**@163.com');
  assert.equal(maskedNew.source, 'file');
  assert.equal(maskedNew.removable, true);

  // 运行时新增（写盘 + 生效 + 回调）
  const added = store.addOrUpdate({ key: 'runtime', address: 'runtime@gmail.com', authCode: 'runtime-code' });
  assert.equal(added.account.key, 'runtime');
  assert.ok(config.mail.accounts.some((a) => a.key === 'runtime'), '新账号立刻进入 config.mail.accounts');
  assert.equal(changes.at(-1), '新增/更新邮箱账号');
  const persisted = loadMailAccountsFile(file).entries.map((a) => a.key);
  assert.ok(persisted.includes('runtime'), '已落盘');

  // 运行时删除本地账号
  const removed = store.remove('runtime');
  assert.equal(removed.removed.key, 'runtime');
  assert.ok(!config.mail.accounts.some((a) => a.key === 'runtime'));
  assert.equal(changes.at(-1), '删除邮箱账号');
  assert.ok(!loadMailAccountsFile(file).entries.some((a) => a.key === 'runtime'));
});

test('Store：env 来源账号不可删（中文错误）、不存在的 key 404、无显式 MAIL_ENABLED 时自动启用轮询', () => {
  const dir = tempDir();
  const file = join(dir, 'mail-accounts.json');
  resetConfig([envAccount()]);
  config.mail.enabled = false;
  config.mail.enabledExplicit = false;

  const store = new MailAccountsStore({ file, log: () => {}, warn: () => {} });
  store.init();
  assert.equal(config.mail.enabled, true, '有账号且未显式关闭 → 自动启用轮询');

  assert.throws(
    () => store.remove('envmail'),
    (e: unknown) => e instanceof MailAccountsError && e.code === 'env-source' && /来自 \.env/.test(e.message),
  );
  assert.throws(
    () => store.remove('nope'),
    (e: unknown) => e instanceof MailAccountsError && e.code === 'not-found',
  );
  // 校验失败 → validation
  assert.throws(
    () => store.addOrUpdate({ address: 'bad', authCode: '' }),
    (e: unknown) => e instanceof MailAccountsError && e.code === 'validation',
  );
  assert.equal(existsSync(file), false, '校验失败不应写文件');
});