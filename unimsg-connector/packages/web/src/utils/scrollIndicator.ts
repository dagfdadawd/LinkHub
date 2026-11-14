/**
 * 滚动条「滚动时才出现」。
 *
 * CSS 无法感知「正在滚动」，所以用一个全局捕获监听，给正在滚动的容器临时加
 * `.is-scrolling`，停止 900ms 后移除；样式表据此显示/隐藏滚动条滑块。
 *
 * 只做 classList 切换（不读布局、不写内联样式），不会引起重排；
 * 悬停时依然显示（`:hover` 分支），鼠标在列表上时能看出可滚动。
 */
const IDLE_MS = 900;

export function installScrollIndicator(): () => void {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

  const markScrolling = (el: Element) => {
    el.classList.add('is-scrolling');
    const prev = timers.get(el);
    if (prev !== undefined) clearTimeout(prev);
    timers.set(
      el,
      setTimeout(() => {
        el.classList.remove('is-scrolling');
        timers.delete(el);
      }, IDLE_MS),
    );
  };

  const onScroll = (e: Event) => {
    // 元素级滚动直接标在元素上；页面级滚动标在 html 上
    markScrolling(e.target instanceof Element ? e.target : document.documentElement);
  };

  // 捕获阶段监听：滚动不冒泡，但会在捕获阶段经过各级祖先
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
}
