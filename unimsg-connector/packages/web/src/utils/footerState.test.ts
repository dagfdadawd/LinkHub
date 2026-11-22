import { describe, expect, it } from 'vitest';
import { footerShortLabel, footerState } from './footerState';

describe('footerState 页脚状态映射', () => {
  it('演示模式：说「演示数据 · 未连接真实服务」，不出现 Mock 字样', () => {
    const footer = footerState(true, 'offline', null);
    expect(footer).toEqual({
      badge: '演示数据',
      text: '演示模式 · 未连接真实服务',
      tone: 'demo',
    });
  });

  it('真实服务已连接：显示「服务已连接」，不误称账号已连接', () => {
    expect(footerState(false, 'connected', null)).toEqual({
      badge: '服务已连接',
      text: '已连上本机 LinkHub 服务（不代表平台账号已连接）',
      tone: 'ok',
    });
  });

  it('重连中：如实显示正在重新连接', () => {
    expect(footerState(false, 'reconnecting', null)).toEqual({
      badge: '服务',
      text: '正在重新连接 LinkHub 服务…',
      tone: 'pending',
    });
  });

  it('已离线：提示确认 LinkHub 服务还在运行', () => {
    expect(footerState(false, 'offline', null)).toEqual({
      badge: '服务',
      text: '未连上 LinkHub 服务（请确认服务还在运行）',
      tone: 'error',
    });
  });

  it('存在加载错误时 badge 显示「连接异常」，优先于连接状态', () => {
    const footer = footerState(false, 'connected', '无法连接 LinkHub 服务，请确认它还在运行');
    expect(footer.badge).toBe('连接异常');
    expect(footer.tone).toBe('error');
    expect(footer.text).toContain('LinkHub 服务还在运行');
    // 错误态对任何连接状态都显示为异常（含重连中/离线）
    expect(footerState(false, 'offline', '请求超时').badge).toBe('连接异常');
  });

  it('演示模式不会被服务错误污染（演示模式不发请求）', () => {
    expect(footerState(true, 'connected', 'should-not-happen').tone).toBe('demo');
  });

  it('可见短文案与断线状态对称（不再只有一颗绿点）', () => {
    expect(footerShortLabel(footerState(true, 'offline', null))).toBe('演示');
    expect(footerShortLabel(footerState(false, 'connected', null))).toBe('服务已连接');
    expect(footerShortLabel(footerState(false, 'reconnecting', null))).toBe('重连中');
    expect(footerShortLabel(footerState(false, 'offline', null))).toBe('未连接');
    expect(footerShortLabel(footerState(false, 'connected', '请求超时'))).toBe('异常');
  });
});
