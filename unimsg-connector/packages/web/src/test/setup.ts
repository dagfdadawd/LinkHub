import '@testing-library/jest-dom/vitest';

// AntD 组件在 jsdom 下需要 matchMedia
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// rc-textarea 的 autoSize 依赖 getComputedStyle 读取 padding/border/line-height，
// jsdom 对未显式声明的属性返回空串 → parseFloat('') = NaN → React 报 height: NaN。
// 仅给 textarea 补齐计算样式默认值，保持测试输出干净（仅测试环境生效）。
const nativeGetComputedStyle = window.getComputedStyle.bind(window);
const TEXTAREA_STYLE_DEFAULTS: Record<string, string> = {
  'box-sizing': 'border-box',
  'padding-top': '4px',
  'padding-bottom': '4px',
  'padding-left': '11px',
  'padding-right': '11px',
  'border-top-width': '1px',
  'border-bottom-width': '1px',
  'line-height': '22px',
};
window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
  // jsdom 对伪元素 getComputedStyle 直接抛 not-implemented（rc-util 的滚动条测量会传
  // 伪元素参数）——测试环境忽略伪元素参数即可，不影响任何断言。
  const style = pseudo ? nativeGetComputedStyle(el) : nativeGetComputedStyle(el, pseudo);
  if (!(el instanceof HTMLTextAreaElement)) return style;
  const original = style.getPropertyValue.bind(style);
  Object.defineProperty(style, 'getPropertyValue', {
    configurable: true,
    value: (name: string) => original(name) || TEXTAREA_STYLE_DEFAULTS[name] || '',
  });
  return style;
}) as typeof window.getComputedStyle;