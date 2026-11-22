/**
 * 「一键注入示例消息」用的演示数据（前后端共用一份，避免两边样例漂移）。
 *
 * 为什么注入仍走真实入站链路：
 *  - 样例会被包成各平台**真实的入站报文**，经连接器解析、幂等去重、写 trace、富化，
 *    和平台推来的消息走同一条流水线，演示时经得起追问；
 *  - 前端不再直接打公共 webhook（那样消息会归到「机器主人」名下，普通账号点了
 *    只会看到「已注入」却收不到任何消息）；改为调用带登录态的 `/api/messages/demo`，
 *    后端用同一份样例入库并**把消息归属到发起请求的账号**。
 *
 * 诚实性：发送人是演示身份，回复时按平台当前通道发送，界面会照实标注「模拟发送」。
 */
import { Platform } from './message';

/** 可注入的平台（邮箱是 IMAP 轮询拉取，没有入站推送，不能假装能推） */
export type DemoInjectPlatform = Platform.FEISHU | Platform.DINGTALK | Platform.WECHAT;

export const DEMO_INJECT_PLATFORMS: DemoInjectPlatform[] = [
  Platform.FEISHU,
  Platform.DINGTALK,
  Platform.WECHAT,
];

/** 每个平台的样例消息（轮转使用，多点几次不会重复同一条） */
export const DEMO_SAMPLES: Record<DemoInjectPlatform, Array<{ from: string; name: string; text: string }>> = {
  [Platform.FEISHU]: [
    { from: 'zhangsan', name: '张三', text: '明天 10:00 前把周报发我，重点写本周联调进展和下周计划。' },
    { from: 'lisi', name: '李四', text: '新版接口文档什么时候能更新？前端联调卡在鉴权字段上了，麻烦今天确认一下。' },
  ],
  [Platform.DINGTALK]: [
    { from: 'zhaoliu', name: '赵六', text: '明天上午 10:00 评审会，会议室 A301，请提前准备演示材料。' },
    { from: 'sunqi', name: '孙七', text: '本周五 18:00 前把预算确认单发我，财务要归档。' },
  ],
  [Platform.WECHAT]: [
    { from: 'wangwu', name: '王五', text: '客户反馈登录偶发失败，方便拉个群一起看下日志吗？' },
    { from: 'chenba', name: '陈八', text: '下周一 9点 灰度上线，今晚需要把回滚方案发出来确认。' },
  ],
};

/** 平台入站地址（相对 /api/webhook/*），旧后端/手工 curl 仍可用这条公开链路 */
const WEBHOOK_PATH: Record<DemoInjectPlatform, string> = {
  [Platform.FEISHU]: '/api/webhook/feishu',
  [Platform.DINGTALK]: '/api/webhook/dingtalk',
  [Platform.WECHAT]: '/api/webhook/wechat',
};

/** 按平台拼一条最小可用的入站事件；`seq` 保证 messageId 唯一、不会被幂等去重吃掉 */
export function buildDemoSample(
  platform: DemoInjectPlatform,
  seq: number,
): { path: string; body: Record<string, unknown> } {
  const pool = DEMO_SAMPLES[platform];
  const sample = pool[Math.abs(seq) % pool.length];
  // 前缀保留 readability；时间戳 + seq 保证唯一
  const messageId = `demo_${platform}_${Date.now()}_${seq}`;
  const text = sample.text;

  if (platform === Platform.FEISHU) {
    return {
      path: WEBHOOK_PATH[platform],
      body: {
        schema: '2.0',
        event: {
          message: {
            message_id: messageId,
            message_type: 'text',
            content: JSON.stringify({ text }),
            sender: { sender_id: { user_id: sample.from } },
          },
        },
      },
    };
  }

  if (platform === Platform.DINGTALK) {
    return {
      path: WEBHOOK_PATH[platform],
      body: {
        msgtype: 'text',
        text: { content: text },
        msgId: messageId,
        senderId: sample.from,
        senderNick: sample.name,
      },
    };
  }

  // 微信（RPA 桥）上报格式：见 packages/server/src/connectors/wechat.ts 的 WechatRawEvent
  return {
    path: WEBHOOK_PATH[platform],
    body: {
      externalId: messageId,
      from: sample.name,
      senderId: sample.from,
      conversation: sample.name,
      conversationType: 'p2p',
      text,
      type: 'text',
    },
  };
}
