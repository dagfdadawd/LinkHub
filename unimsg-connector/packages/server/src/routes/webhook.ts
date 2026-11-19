/**
 * 平台 Webhook 入口：公共接口（用平台签名验签，不用用户 token）。
 * 同一入口既收“新消息”，也收“状态回流事件”（由 service 分流）。
 */
import express, { Request, Router } from 'express';
import { Platform } from '@unimsg/shared';
import { config } from '../config';
import { connectors } from '../connectors/registry';
import { InvalidPlatformEvent, isEmptyPlatformEvent, MessageService } from '../services/message';

/**
 * 钉钉（HTTP 回调模式）用 XML 推消息，app 级的 express.json 不认这个 content-type，
 * 这里再挂一层 express.text 把原始报文收进 req.body（JSON 请求会被原样跳过）。
 */
const xmlAsText = express.text({
  type: ['text/xml', 'application/xml', 'text/plain'],
  defaultCharset: 'utf-8',
  limit: '2mb',
});

/**
 * 部分平台把签名参数挂在 query 上（如钉钉的 msg_signature/timestamp/nonce），
 * 而 PlatformConnector.verify 只收 headers，所以把 query 并入 headers 传给连接器。
 */
function signHeaders(req: Request): Record<string, string | string[] | undefined> {
  const merged: Record<string, string | string[] | undefined> = { ...req.headers };
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string' && merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

function querySignature(req: Request): string {
  return (req.headers['x-signature'] as string)
    ?? (typeof req.query.msg_signature === 'string' ? req.query.msg_signature : undefined)
    ?? (typeof req.query.sig === 'string' ? req.query.sig : 'mock');
}

/** 微信 RPA 桥只监听 127.0.0.1；real 模式下 webhook 也只收本机回环。 */
export function isLoopbackAddress(addr?: string): boolean {
  const value = (addr ?? '').trim().toLowerCase();
  return value === '127.0.0.1'
    || value === '::1'
    || value === '::ffff:127.0.0.1'
    || value === '::ffff:7f00:1';
}

export function webhookRouter(svc: MessageService) {
  const r = Router();

  // GET 握手：配置回调 URL 时会带签名参数与 echostr 来，
  // 需要原样返回 challenge/明文，否则平台判定 URL 验证失败。
  r.get('/webhook/:platform', (req, res) => {
    const platform = req.params.platform as Platform;
    const connector = connectors[platform];
    if (!connector) {
      res.status(404).json({ ok: false, error: 'unknown platform' });
      return;
    }
    const handshake = connector.challenge?.(req.query);
    if (typeof handshake !== 'string' || !handshake) {
      res.status(400).json({ ok: false, error: 'handshake failed' });
      return;
    }
    res.type('text/plain').send(handshake);
  });

  r.post('/webhook/:platform', xmlAsText, async (req, res) => {
    const platform = req.params.platform as Platform;
    const connector = connectors[platform];
    if (!connector) {
      res.status(404).json({ ok: false, error: 'unknown platform' });
      return;
    }

    // 微信 RPA 桥只监听本机；real 模式下不让 LAN/公网请求伪造微信消息。
    // 固定 dev-rpa 签名写在源码里，不是秘密，必须再加来源限制。
    if (platform === Platform.WECHAT
      && config.runtime[Platform.WECHAT].mode === 'real'
      && !isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(401).json({ ok: false, error: 'wechat webhook only accepts loopback in real mode' });
      return;
    }

    let body: unknown = req.body;
    try {
      if (connector.decrypt) body = connector.decrypt(body);
    } catch (e) {
      res.status(400).json({ ok: false, error: e instanceof Error ? e.message : 'decrypt failed' });
      return;
    }

    // 飞书配置回调地址时会发 url_verification，需要原样返回 challenge
    const handshake = connector.challenge?.(body);
    if (handshake !== undefined) {
      res.json(handshake);
      return;
    }

    if (!connector.verify(body, querySignature(req), signHeaders(req))) {
      res.status(401).json({ ok: false, error: 'verify failed' });
      return;
    }

    // 验签通过后、入库之前再校验「事件体确实承载了内容」：
    // mock 验签较宽松，空 body / 空 XML 壳 / 空对象都可能走到这里，
    // 必须在写 trace 与幂等表之前拒绝，否则会占住 externalId='unknown' 的去重键。
    if (isEmptyPlatformEvent(body)) {
      res.status(400).json({
        ok: false,
        error: '空事件体：已拒绝入库（未写 trace、未写幂等表）',
      });
      return;
    }

    try {
      const result = await svc.onPlatformEvent(platform, body);
      res.status(200).json({ ok: true, duplicate: result.duplicate ?? false });
    } catch (e) {
      // 畸形事件（缺 externalId 等）是「调用方的问题」→ 400；其余异常仍 500
      if (e instanceof InvalidPlatformEvent) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'error' });
    }
  });
  return r;
}
