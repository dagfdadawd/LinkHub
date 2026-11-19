import { Router } from 'express';
import { bridgeUrl } from '../connectors/wechat';

/**
 * `POST /api/wechat/pull`：从本机 RPA 桥「按需拉取」当前微信会话的消息。
 *
 * 为什么由后端代理而不是前端直连桥：
 *  - 桥只监听 127.0.0.1，前端（可能跑在别的端口/浏览器）直连会遇到 CORS；
 *  - 桥地址是后端配置（WECHAT_BRIDGE_URL），前端不该重复维护一份；
 *  - 拉取结果要如实透出（含能力边界），由后端统一转发更容易保持一致。
 *
 * 语义：**不做任何假装**。桥说拉不到，就把桥的原因原样给前端。
 */
export function wechatPullRouter(): Router {
  const r = Router();

  r.post('/wechat/pull', async (req, res) => {
    const body = (req.body ?? {}) as {
      conversation?: unknown;
      conversationType?: unknown;
      selfName?: unknown;
    };
    const conversation = String(body.conversation ?? '').trim();
    if (!conversation) {
      res.status(400).json({
        ok: false,
        error: '请填写要拉取的会话名（要和微信里显示的完全一致，RPA 按名字标注会话）',
      });
      return;
    }

    const url = `${bridgeUrl()}/pull`;
    const payload = {
      conversation,
      conversationType: body.conversationType === 'group' ? 'group' : 'p2p',
      ...(body.selfName ? { selfName: String(body.selfName) } : {}),
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await resp.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = { ok: false, error: text.slice(0, 300) };
      }
      // 桥的 502/409 是「真实的失败原因」，原样带回给界面，不要包装成 500
      const status = resp.status === 200 || resp.status === 207 ? resp.status : 502;
      res.status(status).json(json);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      res.status(502).json({
        ok: false,
        error: `连不上本机 RPA 桥（${url}）：${detail}。请确认桥已用 --mode rpa 启动。`,
      });
    }
  });

  return r;
}
