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
    // 连接生命周期回调：SDK 的 start() 立即返回（后台异步建连），
    // 连接状态只能通过这些回调感知，不能靠 start() 的 promise。
    onReady: () => console.log('[feishu-stream] 飞书长连接已就绪（ws client ready）'),
    onReconnected: () => console.log('[feishu-stream] 飞书长连接断线重连成功'),
    onError: (e: Error) => console.error('[feishu-stream] 长连接错误:', e?.message ?? e),
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
    'card.action.trigger': async (data: any) => {
      // 卡片按钮交互：用户在"机器人单聊被 UI 禁发"场景下的可用交互通道
      const action =
        data?.action?.value ?? data?.event?.action?.value ?? data?.context?.open_message_id ?? 'unknown';
      const operator =
        data?.operator?.open_id ?? data?.event?.operator?.open_id ?? 'unknown';
      console.log(`[feishu-stream] 收到卡片交互: operator=${operator} action=${JSON.stringify(action)}`);
    },
  });

  // start() 立即 resolve（SDK 在后台异步建连，详见 WSClient 源码），
  // 因此它的 promise 不代表连接关闭；真正的连接状态走 onReady/onError 回调。
  wsClient
    .start({ eventDispatcher: dispatcher })
    .catch((e: unknown) => {
      console.error('[feishu-stream] 长连接启动失败:', e instanceof Error ? e.message : e);
    });

  console.log(
    '[feishu-stream] 飞书长连接启动指令已下发（SDK 异步建连，就绪时会打「已就绪」日志）',
  );
  return { client: wsClient, close: () => wsClient.close() };
}
