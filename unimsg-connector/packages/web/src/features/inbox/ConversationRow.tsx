import { Platform } from '../../types';
import { SendOutlined, UserOutlined } from '@ant-design/icons';
import type { Conversation } from '../../utils/conversations';
import { conversationSnippet, formatConversationTitle, isRawIdTitle } from '../../utils/conversations';
import { PLATFORM_META, formatRelative } from '../../utils/format';
import { PlatformGlyph } from '../../components/PlatformGlyph';
import { initials } from '../../utils/format';

/**
 * 会话列表的一行：一个「人 / 群 / 邮件主题」一行，不是一条消息一行。
 *
 * 信息层级（参考 IM 列表）：谁 → 最后一句 → 时间 + 未读。
 * 平台用头像角标表达，群聊额外标「群」，邮件用邮件图标 —— 一行扫下来不需要读平台名。
 */
export function ConversationRow({
  conversation,
  active,
  onSelect,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: (traceId: string) => void;
}) {
  const meta = PLATFORM_META[conversation.platform];
  const isGroup = conversation.conversationType === 'group';
  const isMail = conversation.platform === Platform.MAIL;
  const unread = conversation.unread > 0;
  /** 平台只给了 open_id 时降级成「未命名会话（…2084）」，不把 ID 直接摆给用户 */
  const title = formatConversationTitle(conversation.title, conversation.platform);
  /** 整段都是自己发的（只有出站）：头像不取名字首字，用自己的发送图标 */
  const outOnly = conversation.messages.every((m) => m.direction === 'out');
  const avatarText = outOnly
    ? <SendOutlined size={14} />
    : isMail
      ? <PlatformGlyph platform={Platform.MAIL} size={16} />
      : isGroup
        ? '群'
        : isRawIdTitle(conversation.title)
          /* 平台没给昵称时，拿首字做头像会得到括号/数字，用人形图标更稳 */
          ? <UserOutlined />
          : initials(title);

  return (
    <article
      className={`conv-row${active ? ' is-active' : ''}${unread ? ' is-unread' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={active}
      aria-label={`${unread ? '未读，' : ''}${title}`}
      data-conv={conversation.key}
      onClick={() => onSelect(conversation.lastMessage.traceId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(conversation.lastMessage.traceId);
        }
      }}
    >
      <span
        className={`conv-row__avatar${isGroup ? ' is-group' : ''}${isMail ? ' is-mail' : ''}`}
        style={{
          background: meta.soft,
          color: meta.color,
        }}
        aria-hidden="true"
      >
        {avatarText}
      </span>

      <div className="conv-row__main">
        <div className="conv-row__top">
          <span className="conv-row__title" title={conversation.title}>
            {title}
          </span>
          {isGroup && <span className="conv-row__tag">群</span>}
          <span className="conv-row__spacer" />
          <span className="conv-row__time">{formatRelative(conversation.lastAt)}</span>
        </div>

        <div className="conv-row__bottom">
          <span className="conv-row__snippet">{conversationSnippet(conversation)}</span>
          {conversation.needsAction > 0 && (
            <span className="conv-row__flag" title="有需要处理的条目（待确认 / 发送失败）">
              待处理
            </span>
          )}
          {unread && (
            <span className="conv-row__badge" aria-label={`${conversation.unread} 条未读`}>
              {conversation.unread > 99 ? '99+' : conversation.unread}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}