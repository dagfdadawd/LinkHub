/**
 * 快捷回复模板（评审 P1-5）：重复性回复（「收到，稍后处理」）的确定性手段——
 * AI 草稿不可控时的保底，客服 / 助理型用户每天都要重复输入的话术不用再手敲。
 *
 * 与个人资料 / 偏好同一套约定：只存本机 localStorage（换浏览器不同步，见评审 P1-14）。
 * 模板正文支持 `{对方称呼}` 变量，插入回复框时按当前会话的发送人替换；
 * 称呼未知时替换为空串——绝不能把字面 `{对方称呼}` 发给对方。
 */
import { useSyncExternalStore } from 'react';

export interface ReplyTemplate {
  id: string;
  name: string;
  content: string;
}

/** 内置四条最常用的话术，开箱即用；可删可改（重置恢复默认） */
export const DEFAULT_TEMPLATES: ReplyTemplate[] = [
  { id: 'tpl-ack', name: '收到', content: '收到，我看一下，稍后回复你。' },
  { id: 'tpl-todo', name: '稍后处理', content: '收到，这条我先记为待办，今天下班前给你答复。' },
  { id: 'tpl-ok', name: '应承', content: '好的，没问题，{对方称呼}。我会按你说的办，有进展同步你。' },
  { id: 'tpl-sorry', name: '致歉跟进', content: '抱歉让你久等了，{对方称呼}。现在跟进这件事，马上给你结果。' },
];

const STORAGE_KEY = 'linkhub-reply-templates';
const MAX_TEMPLATES = 50;
const MAX_NAME = 30;
const MAX_CONTENT = 500;

let cache: ReplyTemplate[] | null = null;
const listeners = new Set<() => void>();

function sanitize(input: unknown): ReplyTemplate[] {
  if (!Array.isArray(input)) return DEFAULT_TEMPLATES;
  const seen = new Set<string>();
  const items: ReplyTemplate[] = [];
  for (const raw of input.slice(0, MAX_TEMPLATES)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<ReplyTemplate>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, MAX_NAME) : '';
    const content = typeof r.content === 'string' ? r.content.replace(/\r\n/g, '\n').slice(0, MAX_CONTENT) : '';
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 40) : '';
    if (!name || !content || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, name, content });
  }
  return items.length > 0 ? items : DEFAULT_TEMPLATES;
}

function read(): ReplyTemplate[] {
  if (typeof window === 'undefined') return DEFAULT_TEMPLATES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TEMPLATES;
    return sanitize(JSON.parse(raw));
  } catch {
    return DEFAULT_TEMPLATES;
  }
}

function persist(next: ReplyTemplate[]): void {
  cache = sanitize(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // 隐私模式下写入失败：本次会话仍然生效
  }
  listeners.forEach((listener) => listener());
}

export function getTemplates(): ReplyTemplate[] {
  if (!cache) cache = read();
  return cache;
}

export function addTemplate(name: string, content: string): void {
  const items = getTemplates();
  const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  persist([...items, { id, name, content }]);
}

export function removeTemplate(id: string): void {
  persist(getTemplates().filter((t) => t.id !== id));
}

export function resetTemplates(): void {
  persist(DEFAULT_TEMPLATES);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTemplates(): ReplyTemplate[] {
  return useSyncExternalStore(subscribe, getTemplates, () => DEFAULT_TEMPLATES);
}

/**
 * 模板变量替换：`{对方称呼}` → 联系人名（未知 → 空串，绝不把占位符发出去）。
 * 未知变量原样保留——用户可能真的想发花括号内容，不猜。
 */
export function applyTemplateVariables(content: string, vars: { contactName?: string }): string {
  return content.replace(/\{对方称呼\}/g, vars.contactName?.trim() ?? '');
}
