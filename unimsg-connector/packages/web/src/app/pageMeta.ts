/**
 * 顶栏标题：小号 eyebrow + 大标题，Apple 式信息层级（AppShell 用）。
 *
 * 每个一级路由都必须在这里登记：漏映射的页面顶栏会一直显示「收件箱」
 * （评审 D1 的回归点——/stats 与 /auto-reply 就这么漏过）。
 */
export interface PageMeta {
  eyebrow: string;
  title: string;
}

export function pageMeta(pathname: string): PageMeta {
  if (pathname.startsWith('/todos')) return { eyebrow: 'TASKS', title: '待办' };
  if (pathname.startsWith('/trace')) return { eyebrow: 'TRACE', title: '全链路回放' };
  if (pathname.startsWith('/accounts')) return { eyebrow: 'ACCOUNTS', title: '平台账号' };
  if (pathname.startsWith('/connect')) return { eyebrow: 'CONNECT', title: '连接账号' };
  if (pathname.startsWith('/auto-reply')) return { eyebrow: 'AUTOMATION', title: '自动回复' };
  if (pathname.startsWith('/stats')) return { eyebrow: 'STATS', title: '看板' };
  return { eyebrow: 'INBOX', title: '收件箱' };
}
