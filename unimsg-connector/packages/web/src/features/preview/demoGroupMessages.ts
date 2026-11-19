/**
 * 「群消息视图」预览用的假数据（仅在 /inbox?preview=groups 时启用）。
 *
 * 目的：让决策者在**真实布局**里看「顶部频道切换 + @我 置顶」是否协调，
 * 不写库、不影响正常数据；确认方案后可整体删除本文件。
 */
import { Platform, MsgStatus } from '../../types';
import type { UnifiedMessage } from '../../types';

let seq = 0;
const nextId = () => `demo-${++seq}`;

function msg(input: {
  platform: Platform;
  conversationId: string;
  conversationType: 'p2p' | 'group';
  title?: string;
  sender: string;
  senderId?: string;
  body: string;
  at: string;
  out?: boolean;
}): UnifiedMessage {
  const id = nextId();
  return {
    traceId: id,
    platform: input.platform,
    externalId: `demo:${id}`,
    sender: { id: input.senderId ?? `u-${input.sender}`, name: input.sender },
    conversation: {
      id: input.conversationId,
      type: input.conversationType,
      ...(input.title ? { title: input.title } : {}),
    },
    type: 'text',
    body: input.body,
    status: input.out ? MsgStatus.SYNCED : MsgStatus.RECEIVED,
    ...(input.out ? { direction: 'out' as const } : {}),
    createdAt: input.at,
    updatedAt: input.at,
  } as UnifiedMessage;
}

/** 与真实会话 ID 对齐，切到预览时左栏就是你自己的会话 */
export const DEMO_GROUP_MESSAGES: UnifiedMessage[] = [
  // ---- 单聊：郑友佳 ----
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidawPDdxpnUttEivql3hu3sfHlc2RNJIHJPqbVwknMVS8=',
    conversationType: 'p2p',
    sender: '郑友佳',
    body: '明天上午的评审会你参加吗？',
    at: '2026-11-19T09:12:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidawPDdxpnUttEivql3hu3sfHlc2RNJIHJPqbVwknMVS8=',
    conversationType: 'p2p',
    sender: 'LinkHub 统一入口',
    body: '参加，我提前十分钟到。',
    at: '2026-11-19T09:15:00+08:00',
    out: true,
  }),

  // ---- 单聊：郑乐斌 ----
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cids1oy/hE8wrkIwXRx0e6EJPHlc2RNJIHJPqbVwknMVS8=',
    conversationType: 'p2p',
    sender: '郑乐斌',
    body: '接口文档更新了，记得看 v2。',
    at: '2026-11-18T18:20:00+08:00',
  }),

  // ---- 群：消息管理（含 @我） ----
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '陈(陈)',
    body: '今天的发布窗口推迟到 20:00。',
    at: '2026-11-19T10:02:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '郑乐斌',
    body: '@郑友佳 请问你想约什么时间、什么地点呢？',
    at: '2026-11-19T10:05:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '林工',
    body: '我这边测试环境已经好了。',
    at: '2026-11-19T10:08:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '陈(陈)',
    body: '收到。',
    at: '2026-11-19T10:09:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '郑乐斌',
    body: '@郑友佳 记得把回归结果贴上来',
    at: '2026-11-19T10:31:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '林工',
    body: '这个报错有人遇到过吗？',
    at: '2026-11-19T10:44:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '陈(陈)',
    body: '@郑友佳 帮忙看下这个报错',
    at: '2026-11-19T10:45:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '林工',
    body: '已解决，是缓存没清。',
    at: '2026-11-19T10:52:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidtnU87VwpUmOPEKhMrr2Iyw==',
    conversationType: 'group',
    title: '消息管理',
    sender: '陈(陈)',
    body: '下午三点对齐一下进度。',
    at: '2026-11-19T11:40:00+08:00',
  }),

  // ---- 群：工作通知（系统消息，无 @） ----
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidPekYat+DwMXquizt6ZcUJQ==',
    conversationType: 'group',
    title: '工作通知:消息管理',
    sender: '系统通知',
    body: '你有一条新的审批待处理。',
    at: '2026-11-19T08:00:00+08:00',
  }),
  msg({
    platform: Platform.DINGTALK,
    conversationId: 'cidPekYat+DwMXquizt6ZcUJQ==',
    conversationType: 'group',
    title: '工作通知:消息管理',
    sender: '系统通知',
    body: '考勤异常提醒：昨日未打卡。',
    at: '2026-11-19T08:05:00+08:00',
  }),

  // ---- 飞书群 ----
  msg({
    platform: Platform.FEISHU,
    conversationId: 'oc_abc587d27c36d4d0b457c7d375852722',
    conversationType: 'group',
    title: 'LinkHub 测试群',
    sender: '郑乐斌',
    body: '收到，已确认这条是来自 LinkHub 的通知消息。',
    at: '2026-11-19T09:30:00+08:00',
  }),
];

/** 预览模式用的「@我」判定：正文里出现自己的名字 */
export function mentionsMe(body: string, selfName = '郑友佳'): boolean {
  return body.includes(`@${selfName}`);
}