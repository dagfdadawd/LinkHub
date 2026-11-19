/**
 * 各平台样例事件（单测 & 演示用）。
 *
 * 真实评审时，这些会被平台推过来的 Webhook 回调取代；
 * 现在用它们驱动 receive 解析与 convert 映射的单元测试。
 */
export const feishuSample = {
  schema: '2.0',
  header: { event_type: 'im.message.receive_v1' },
  event: {
    message: {
      message_id: 'om_demo_001',
      message_type: 'text',
      content: JSON.stringify({ text: '周五前交周报' }),
      sender: { sender_id: { user_id: 'u_feishu_demo' } },
    },
  },
};

export const dingtalkSample = {
  msgtype: 'text',
  text: { content: '周五前交周报' },
  msgId: 'msg_demo_001',
  senderId: 'user_dingtalk_demo',
  senderNick: '钉钉小王',
  conversationType: '1',
};

export const wechatSample = {
  externalId: 'wx_demo_001',
  from: '微信好友',
  senderId: 'wx_demo_user',
  conversation: '项目群',
  conversationType: 'group',
  text: '周五前交周报',
  type: 'text',
  at: 1732000000000,
};
