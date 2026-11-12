/**
 * 侧边栏页脚状态映射（纯函数，便于单测）。
 *
 * 背景：页脚此前只要 demoMode=false 就永远显示「真实后端 · 已接入 LinkHub Server」，
 * 后端断连 / 请求报错时用户会误判。这里把「模式 + 实时连接 + 加载错误」如实映射为
 * badge / 说明文案 / 语义色调，AppShell 只负责渲染。
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
 *  - demoMode：Mock 演示，保持「前端演示模式 · 未接后端」；
 *  - 有 error：badge=连接异常（红色），提示检查后端；
 *  - 否则按实时连接：connected / reconnecting / offline 如实展示。
 */
export function footerState(
  demoMode: boolean,
  connection: RealtimeStatus,
  error: string | null,
): FooterState {
  if (demoMode) {
    return { badge: 'Mock 数据', text: '前端演示模式 · 未接后端', tone: 'demo' };
  }

  if (error) {
    return { badge: '连接异常', text: '数据加载失败 · 检查后端是否启动', tone: 'error' };
  }

  switch (connection) {
    case 'connected':
      return { badge: '服务已连接', text: '本地后端已连接（不代表平台账号已连接）', tone: 'ok' };
    case 'reconnecting':
      return { badge: '本地后端', text: '正在重连本地后端…', tone: 'pending' };
    case 'offline':
      return { badge: '本地后端', text: '本地后端未连接（检查后端是否启动）', tone: 'error' };
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

