import { describe, expect, it } from 'vitest';
import { pageMeta } from './pageMeta';

describe('pageMeta 顶栏标题映射', () => {
  it('每个一级路由都有专属标题，不得漏映射落回「收件箱」（评审 D1）', () => {
    const routes = [
      '/todos',
      '/trace',
      '/trace/t-1',
      '/accounts',
      '/connect',
      '/auto-reply',
      '/stats',
    ];
    for (const r of routes) expect(pageMeta(r).title, r).not.toBe('收件箱');
  });

  it('/stats 与 /auto-reply 分别显示看板 / 自动回复', () => {
    expect(pageMeta('/stats')).toEqual({ eyebrow: 'STATS', title: '看板' });
    expect(pageMeta('/auto-reply')).toEqual({ eyebrow: 'AUTOMATION', title: '自动回复' });
  });

  it('收件箱、收件箱详情与未知路径都落回默认', () => {
    expect(pageMeta('/inbox')).toEqual({ eyebrow: 'INBOX', title: '收件箱' });
    expect(pageMeta('/inbox/t-1')).toEqual({ eyebrow: 'INBOX', title: '收件箱' });
    expect(pageMeta('/nope')).toEqual({ eyebrow: 'INBOX', title: '收件箱' });
  });
});
