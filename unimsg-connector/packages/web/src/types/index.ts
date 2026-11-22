/**
 * 统一消息契约的再导出：前端只从这里取类型，
 * 真正定义在 monorepo 的 packages/shared，避免契约漂移。
 */
export { Platform, MsgStatus, FILE_LIMITS, TODO_TITLE_MAX, PRIORITY_LABELS, PRIORITY_RANK } from '@unimsg/shared';
export type {
  UnifiedMessage, TraceEntry, MsgType, Sender,
  OutboundAttachment, AttachmentInfo, ComposeRequest, ComposeAck, SendCapabilities,
  TodoDraft,
  DeliveryInfo, DeliveryMode,
  // 本人身份能力（本人账号接收 / 本人账号发送）
  IdentityRole, IdentityPolicy, UserIdentityStatus, PlatformIdentityView,
  // 人工处理动作 / 自动回复 / 看板
  Priority, StatusChangeRequest, StatusChangeResult, ForwardRequest,
  PriorityChangeResult, AutoRule, AutoRuleInput, StatsOverview,
} from '@unimsg/shared';