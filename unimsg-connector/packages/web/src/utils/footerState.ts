/**
 * 侧边栏页脚状态映射（纯函数，便于单测）。
 *
 * 背景：页脚此前只要 demoMode=false 就永远显示「真实后端 · 已接入 LinkHub Server」，
 * 后端断连 / 请求报错时用户会误判。这里把「模式 + 实时连接 + 加载错误」如实映射为
 * badge / 说明文案 / 语义色调，AppShell 只负责渲染。
 *
 * 措辞面向非技术用户：不出现「后端 / Mock / Server」这类实现词，统一说「LinkHub 服务」。
 */
import type { RealtimeStatus } from '../services/realtime';

export type FooterTone = 'demo' | 'ok' | 'pending' | 'error';

export interface FooterState {
  /** badge 文案 */
  badge: string;
  /** 说明文案 */
  text: string;
  /** 语义色调：demo=演示（橙）/ ok=正常（绿）/ pending=连接中（橙）/ error=异常（红） */
  tone: FooterTone;
}

/**
 * 页脚状态：
 *  - demoMode：纯前端演示数据，说明「未连接真实服务」；
 *  - 有 error：badge=连接异常（红色），提示确认 LinkHub 服务在运行；
 *  - 否则按实时连接：connected / reconnecting / offline 如实展示。
 */
export function footerState(
  demoMode: boolean,
  connection: RealtimeStatus,
  error: string | null,
): FooterState {
  if (demoMode) {
    return { badge: '演示数据', text: '演示模式 · 未连接真实服务', tone: 'demo' };
  }

  if (error) {
    return { badge: '连接异常', text: '数据加载失败 · 请确认 LinkHub 服务还在运行', tone: 'error' };
  }

  switch (connection) {
    case 'connected':
      return { badge: '服务已连接', text: '已连上本机 LinkHub 服务（不代表平台账号已连接）', tone: 'ok' };
    case 'reconnecting':
      return { badge: '服务', text: '正在重新连接 LinkHub 服务…', tone: 'pending' };
    case 'offline':
      return { badge: '服务', text: '未连上 LinkHub 服务（请确认服务还在运行）', tone: 'error' };
  }
}

/**
 * 页脚可见短文案（小白看不到「aria-label」，断线时却能看到「已离线」会不对称）。
 * 侧栏只有 76px，短文案控制在 2–4 个汉字；完整说明仍放在 Tooltip / aria-label。
 */
export function footerShortLabel(footer: FooterState): string {
  if (footer.tone === 'demo') return '演示';
  if (footer.tone === 'ok') return '服务已连接';
  if (footer.tone === 'pending') return '重连中';
  return footer.badge === '连接异常' ? '异常' : '未连接';
}
