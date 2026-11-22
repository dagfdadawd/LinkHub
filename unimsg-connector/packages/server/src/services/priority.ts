/**
 * 优先级推断（规则版）。
 *
 * 为什么先做规则而不是让大模型直接给：
 *  - 优先级是**可解释**的判断，规则命中哪个词能在界面上说清楚；
 *  - 大模型只输出 intent / 草稿，优先级另走一条便宜的规则链，失败不影响主链路；
 *  - 用户随时能人工改，改动会记进闭环日志（Feedback 样本），后续可用来调规则。
 *
 * 与 intent 的分工：intent 说明「这是一条什么消息」，priority 说明「先处理哪条」。
 */
import type { Priority } from '@unimsg/shared';

/** 紧急信号：明确要求尽快 / 今天 / 有截止时间 */
const URGENT_PATTERN = /加急|紧急|马上|立刻|尽快|十万火急|今天|今晚|截止|到期|deadline|asap|urgent|eod|immediately/i;

/** 低优先级信号：明确说了不急 / 只是参考 */
const LOW_PATTERN = /不急|不着急|有空|方便时|闲了|下周|之后再|仅供参考|看看就行|fyi|when you have time/i;

/** 待办类意图默认普通；这里只做兜底，不覆盖更明确的信号 */
const TODO_INTENTS = new Set(['待办', 'todo', '任务']);

export interface PriorityInference {
  priority: Priority;
  /** 命中的规则说明（写进闭环日志，答辩时能解释「为什么判紧急」） */
  reason: string;
}

/**
 * 推断一条消息的默认优先级。
 *
 * 返回 undefined = 没有足够信号，保持「未判定」（前端按普通展示，不写死到消息里）。
 * 这样界面不会假装 AI 对每条消息都有判断。
 */
export function inferPriority(
  body: string,
  opts: { dueAt?: string; intent?: string; now?: Date } = {},
): PriorityInference | undefined {
  const text = (body ?? '').trim();
  if (!text) return undefined;

  // 1) 截止时间在 24 小时内：比任何关键词都硬
  if (opts.dueAt) {
    const due = new Date(opts.dueAt).getTime();
    if (Number.isFinite(due)) {
      const now = (opts.now ?? new Date()).getTime();
      const hours = (due - now) / 3_600_000;
      if (hours <= 24) return { priority: 'urgent', reason: `截止时间在 ${Math.max(0, Math.round(hours))} 小时内` };
    }
  }

  // 2) 紧急词优先于低优先级词：「不急，但今天要」按紧急算
  const urgent = text.match(URGENT_PATTERN);
  if (urgent) return { priority: 'urgent', reason: `命中紧急词「${urgent[0]}」` };

  const low = text.match(LOW_PATTERN);
  if (low) return { priority: 'low', reason: `命中低优先级词「${low[0]}」` };

  // 3) 待办类给普通，让用户知道它进了待办队列
  if (opts.intent && TODO_INTENTS.has(opts.intent)) {
    return { priority: 'normal', reason: `意图为「${opts.intent}」` };
  }

  return undefined;
}
