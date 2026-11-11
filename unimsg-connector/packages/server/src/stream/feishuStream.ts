/**
 * 飞书长连接（WebSocket）模式：免公网回调接收机器人消息。
 *
 * 与钉钉 Stream 长连接同理，但使用飞书官方 @larksuiteoapi/node-sdk 的 WSClient。
 *
 * 使用前置条件（飞书开放平台）：
 *   1. 事件与回调 → 事件配置 → 订阅方式选「使用长连接接收事件」并保存
 *      （保存时要求本地长连接已在线，所以先启动本服务再在后台保存）；
 *   2. 权限管理开通 im:message / im:message:send_as_bot，并发布应用版本；
 *   3. 应用需已发布且启用，否则 tenant_access_token 仍报 21001（长连接鉴权同样依赖它）。
 *
 * 长连接下事件由 SDK 明文推送，跳过 Webhook 的 verify/decrypt，
 * 直接复用 MessageService.onPlatformEvent 走与 HTTP 回调相同的入库/幂等链路。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { Platform } from '@unimsg/shared';
import { config } from '../config';
import { MessageService } from '../services/message';

export interface FeishuStreamHandle {
  client: Lark.WSClient;
  close(): void;
}

/**
 * 把飞书长连接推送的事件（im.message.receive_v1）送入与 HTTP 回调相同的入库/幂等链路。
 * 长连接事件为明文，跳过 Webhook 的 verify/decrypt。抽成纯函数便于单测。
 */
export async function dispatchFeishuStreamEvent(svc: MessageService, data: unknown): Promise<void> {
  await svc.onPlatformEvent(Platform.FEISHU, data);
}

/** 由 baseUrl 推导长连接域名：国际版 Lark（含 larksuite）走 Lark，其余默认飞书中国 */
function domainOf(baseUrl: string): Lark.Domain {
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = '';
  }
  return host.includes('larksuite') ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

export async function startFeishuStream(svc: MessageService): Promise<FeishuStreamHandle | null> {
  const { appId, appSecret, baseUrl } = config.platforms.feishu;
  if (!appId || !appSecret) {
    console.warn('[feishu-stream] 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，跳过飞书长连接');
    return null;
  }

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: domainOf(baseUrl),
    loggerLevel: Lark.LoggerLevel.warn,
    autoReconnect: true,
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      const chatId =
        data?.message?.chat_id ?? data?.event?.message?.chat_id ?? 'unknown';
      console.log(`[feishu-stream] 收到消息事件: chat_id=${chatId}`);
      try {
        // 长连接要求 3s 内处理完；失败也要 resolve，避免触发平台重试风暴
        await dispatchFeishuStreamEvent(svc, data);
      } catch (e) {
        console.error('[feishu-stream] 处理消息失败:', e instanceof Error ? e.message : e);
      }
    },
  });

  // start() 在连接存续期间保持 pending（不阻塞主线程）；断线由 SDK 自动重连，故 fire-and-forget
  wsClient
    .start({ eventDispatcher: dispatcher })
    .then(() => console.log('[feishu-stream] 飞书长连接已正常关闭'))
    .catch((e: unknown) => {
      console.error('[feishu-stream] 长连接异常:', e instanceof Error ? e.message : e);
    });

  console.log(
    '[feishu-stream] 飞书长连接已启动：免公网回调，事件明文推送' +
      '（需飞书后台「使用长连接接收事件」且应用已发布启用）',
  );
  return { client: wsClient, close: () => wsClient.close() };
}
