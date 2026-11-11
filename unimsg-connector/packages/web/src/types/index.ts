/**
 * 统一消息契约的再导出：前端只从这里取类型，
 * 真正定义在 monorepo 的 packages/shared，避免契约漂移。
 */
export { Platform, MsgStatus, FILE_LIMITS } from '@unimsg/shared';
export type {
  UnifiedMessage, TraceEntry, MsgType, Sender,
  OutboundAttachment, AttachmentInfo, ComposeRequest, ComposeAck, SendCapabilities,
} from '@unimsg/shared';