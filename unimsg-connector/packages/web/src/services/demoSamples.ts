/**
 * 空态「一键注入」用的演示数据。
 *
 * 样例定义已下沉到 `@unimsg/shared`（前后端共用一份）：
 *  - 真实后端优先调用带登录态的 `/api/messages/demo`（消息归属当前账号）；
 *  - 这里保留公开 webhook 的拼包能力，只作为旧后端 / 手工验证的兜底。
 *
 * 诚实性：这些消息的发送人是演示身份，回复时平台会走 mock 通道，界面上会如实显示「模拟发送」。
 */
import {
  buildDemoSample,
  DEMO_INJECT_PLATFORMS,
  Platform,
  type DemoInjectPlatform,
} from '@unimsg/shared';

/** 可注入的平台（邮箱是 IMAP 轮询拉取，没有入站推送，不在其中） */
export type InjectPlatform = DemoInjectPlatform;

export const INJECT_PLATFORMS: InjectPlatform[] = DEMO_INJECT_PLATFORMS;

/** 生成一次注入的请求（path + body），`seq` 用于保证 messageId 唯一、避免被幂等去重吃掉 */
export const buildSample = buildDemoSample;

/**
 * 把样例投递到真实后端；`base` 为 `VITE_API_BASE`（空字符串表示同源部署）。
 * 失败时抛出，由调用方决定怎么提示——不静默吞掉。
 */
export async function injectSample(
  platform: InjectPlatform,
  seq: number,
  base: string,
  timeoutMs = 8000,
): Promise<void> {
  const { path, body } = buildSample(platform, seq);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 微信连接器 verify() 只认 dev* 前缀签名（等同本机 RPA 桥）；其它平台用各自报文验签
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (platform === Platform.WECHAT) headers['x-signature'] = 'dev-demo';
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    window.clearTimeout(timer);
  }
}
