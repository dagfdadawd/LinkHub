/**
 * 快捷回复模板单测：sanitize 兜底（坏数据回落默认）、增删、变量替换的
 * 「占位符绝不外发」原则——{对方称呼} 未知时替换为空串，未知变量原样保留。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  addTemplate,
  applyTemplateVariables,
  getTemplates,
  removeTemplate,
  resetTemplates,
} from './templates';

afterEach(() => {
  resetTemplates();
  window.localStorage.clear();
});

describe('reply templates', () => {
  it('默认四条开箱即用，含 {对方称呼} 变量示例', () => {
    expect(getTemplates()).toHaveLength(4);
    expect(DEFAULT_TEMPLATES.some((t) => t.content.includes('{对方称呼}'))).toBe(true);
  });

  it('坏数据（非数组 / 全非法项）回落默认，不白屏不丢默认话术', () => {
    window.localStorage.setItem('linkhub-reply-templates', JSON.stringify({ nope: 1 }));
    expect(getTemplates()).toEqual(DEFAULT_TEMPLATES);
    window.localStorage.setItem('linkhub-reply-templates', JSON.stringify([null, 42, { name: '', content: 'x' }]));
    expect(getTemplates()).toEqual(DEFAULT_TEMPLATES);
  });

  it('新增 / 删除走 localStorage 持久化', () => {
    addTemplate('打款确认', '已打款，{对方称呼}请查收。');
    const withNew = getTemplates();
    expect(withNew).toHaveLength(5);
    const added = withNew.find((t) => t.name === '打款确认');
    expect(added?.content).toContain('{对方称呼}');

    removeTemplate(added!.id);
    expect(getTemplates()).toHaveLength(4);
  });

  it('变量替换：{对方称呼} → 联系人名；未知 → 空串，绝不外发占位符', () => {
    expect(applyTemplateVariables('好的，没问题，{对方称呼}。', { contactName: '郑友佳' })).toBe('好的，没问题，郑友佳。');
    expect(applyTemplateVariables('好的，没问题，{对方称呼}。', {})).toBe('好的，没问题，。');
    expect(applyTemplateVariables('好的，没问题，{对方称呼}。', { contactName: '  ' })).toBe('好的，没问题，。');
  });

  it('未知变量原样保留（用户可能真想发花括号内容，不猜）', () => {
    expect(applyTemplateVariables('报价 {价格} 元', { contactName: '李四' })).toBe('报价 {价格} 元');
  });
});
