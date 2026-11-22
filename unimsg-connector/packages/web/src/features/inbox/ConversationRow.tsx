import { useNavigate } from 'react-router-dom';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { CheckOutlined, CheckSquareOutlined, HistoryOutlined, SendOutlined } from '@ant-design/icons';
import { Platform } from '../../types';
import type { Conversation } from '../../utils/conversations';
import { conversationSnippet } from '../../utils/conversations';
import { formatRelative, platformMeta } from '../../utils/format';
import { PlatformGlyph } from '../../components/PlatformGlyph';
import { initials } from '../../utils/format';
import { store } from '../../store';

/**
 * 会话列表的一行：一个「人 / 群 / 邮件主题」一行，不是一条消息一行。
 *
 * 信息层级（参考 IM 列表）：谁 → 最后一句 → 时间 + 未读。
 * 平台用头像角标表达，群聊额外标「群」，邮件用邮件图标 —— 一行扫下来不需要读平台名。
 *
 * 右键菜单（评审 D4）：标已读 / 完成全部待办 / 打开回放——不用进详情页或记键盘快捷键，
 * 列表上右键就能把会话收拾干净。
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
  const navigate = useNavigate();
  const meta = platformMeta(conversation.platform);
  const isGroup = conversation.conversationType === 'group';
  const isMail = conversation.platform === Platform.MAIL;
  const unread = conversation.unread > 0;
  /** 会话标题：平台给了什么就显示什么（缺昵称是平台侧问题，不在前端编造） */
  const title = conversation.title;
  /** 整段都是自己发的（只有出站）：头像不取名字首字，用自己的发送图标 */
  const outOnly = conversation.messages.every((m) => m.direction === 'out');
  const avatarText = outOnly
    ? <SendOutlined size={14} />
    : isMail
      ? <PlatformGlyph platform={Platform.MAIL} size={16} />
      : isGroup
        ? '群'
        : initials(title);

  /** 未完成的待办：右键「完成全部待办」的目標集合 */
  const pendingTodos = conversation.messages.filter((m) => m.type === 'todo' && !m.done);

  /** 整个会话标已读：只动入站且未读的，自己发出的没有已读概念 */
  async function markConvRead(): Promise<void> {
    for (const m of conversation.messages) {
      if (m.direction === 'out' || m.readAt) continue;
      await store.markRead(m.traceId, true);
    }
  }

  async function markConvDone(): Promise<void> {
    for (const t of pendingTodos) {
      await store.markDone(t.traceId);
    }
  }

  const menuItems: MenuProps['items'] = [
    {
      key: 'read',
      icon: <CheckOutlined />,
      label: conversation.unread > 0 ? `标为已读（${conversation.unread} 条未读）` : '标为已读',
      disabled: !unread,
      onClick: () => void markConvRead(),
    },
    {
      key: 'done',
      icon: <CheckSquareOutlined />,
      label: pendingTodos.length > 0 ? `完成全部待办（${pendingTodos.length}）` : '标记完成',
      disabled: pendingTodos.length === 0,
      onClick: () => void markConvDone(),
    },
    { type: 'divider' },
    {
      key: 'trace',
      icon: <HistoryOutlined />,
      label: '打开全链路回放',
      onClick: () => navigate(`/trace/${conversation.lastMessage.traceId}`),
    },
  ];

  return (
    <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']} placement="bottomRight">
      <article
        className={`conv-row${active ? ' is-active' : ''}${unread ? ' is-unread' : ''}${
          conversation.priority === 'urgent' ? ' is-pinned' : ''
        }`}
        role="button"
        tabIndex={0}
        aria-current={active}
        aria-label={`${unread ? '未读，' : ''}${conversation.priority === 'urgent' ? '紧急置顶，' : ''}${title}`}
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
            {/* 优先级是「先处理哪条」的判断：紧急给红色徽标，不急给灰色徽标；
                没有判定就不显示，绝不用「普通」占位假装有结论。 */}
            {conversation.priority === 'urgent' && (
              <span
                className="conv-row__priority conv-row__priority--urgent"
                title="有未完成的消息被标记为「紧急」：会话置顶显示"
              >
                紧急
              </span>
            )}
            {conversation.priority === 'low' && (
              <span className="conv-row__priority" title="这条会话待处理的消息被标记为「不急」">
                不急
              </span>
            )}
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
    </Dropdown>
  );
}
