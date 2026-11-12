import { useState } from 'react';
import { App as AntApp, Button, Tooltip } from 'antd';
import {
  CopyOutlined,
  DownOutlined,
  ReloadOutlined,
  RobotOutlined,
  RightOutlined,
} from '@ant-design/icons';
import type { UnifiedMessage } from '../../types';
import { IntentTag } from '../../components/IntentTag';
import { TYPE_LABEL, conversationLabel, formatDateTime } from '../../utils/format';

/**
 * AI 辅助区：把「理解这条消息」和「准备怎么回」拆成两块。
 *
 * 所有展示内容都来自消息上已有的 AI 字段（intent / intentSource / replyDraft），
 * 没有后端生成接口的项（例如「对方要解决的问题」）宁可留空，也不在前端编造。
 */
export function AiSuggestion({
  message,
  onUseDraft,
  onRegenerate,
}: {
  message: UnifiedMessage;
  onUseDraft: (draft: string) => void;
  onRegenerate: () => void;
}) {
  const { message: toast } = AntApp.useApp();
  const [open, setOpen] = useState(true);
  const pending = !message.intent;
  const fallback = !message.intent || message.intent === '未分类';

  /** 建议动作：按现有状态做确定性推断，不是模型输出，所以单独标注 */
  const nextAction = message.needsReview
    ? '先核对图片 / 文件内容，再回复'
    : message.done
      ? '已处理完成，无需再跟进'
      : message.reply
        ? '已回写，如需补充可继续发送'
        : '待回复';

  async function copyDraft() {
    if (!message.replyDraft) return;
    try {
      await navigator.clipboard.writeText(message.replyDraft);
      toast.success('草稿已复制');
    } catch {
      toast.info(message.replyDraft);
    }
  }

  return (
    <section className="ai-panel" aria-label="AI 辅助">
      <header
        className="ai-panel__head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="ai-panel__icon" aria-hidden="true">
          <RobotOutlined />
        </span>
        <span className="ai-panel__title">AI 辅助</span>
        {!pending && (
          <span className="ai-panel__intent">
            意图 <IntentTag intent={message.intent} />
            {message.intentSource && (
              <span
                className={`ai-panel__source${message.intentSource === 'llm' ? ' is-llm' : ''}`}
                title={message.intentSource === 'llm' ? '由真实大模型识别' : '真实模型不可用，已回退关键词规则'}
              >
                {message.intentSource === 'llm' ? 'MiMo 识别' : '规则兜底'}
              </span>
            )}
          </span>
        )}
        <span className="ai-panel__spacer" />
        <span className="ai-panel__toggle">
          {open ? <DownOutlined /> : <RightOutlined />}
        </span>
      </header>

      {open && (
        <div className="ai-panel__body">
          <section className="ai-block" aria-label="消息理解">
            <h4 className="ai-block__label">消息理解</h4>
            <dl className="ai-facts">
              <div>
                <dt>意图</dt>
                <dd>
                  {pending ? (
                    <span className="ai-facts__muted">分析中…</span>
                  ) : (
                    <>
                      <IntentTag intent={message.intent} />
                      {fallback && <span className="ai-facts__muted">未识别，已回退未分类</span>}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>消息类型</dt>
                <dd>{TYPE_LABEL[message.type]}</dd>
              </div>
              <div>
                <dt>会话</dt>
                <dd>{conversationLabel(message)}</dd>
              </div>
              {message.dueAt && (
                <div>
                  <dt>待办截止</dt>
                  <dd>{formatDateTime(message.dueAt)}</dd>
                </div>
              )}
              <div>
                <dt>建议动作</dt>
                <dd>{nextAction}</dd>
              </div>
            </dl>
          </section>

          <section className="ai-block" aria-label="回复建议">
            <h4 className="ai-block__label">回复建议</h4>
            <div className={`ai-draft${pending ? ' is-pending' : ''}`}>
              {pending
                ? '正在根据消息内容生成回复草稿…'
                : message.replyDraft || '暂无草稿，可直接在下方输入回复。'}
            </div>
            <div className="ai-panel__actions">
              <Button
                size="small"
                type="primary"
                ghost
                disabled={!message.replyDraft}
                onClick={() => message.replyDraft && onUseDraft(message.replyDraft)}
              >
                采用草稿
              </Button>
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                disabled={!message.replyDraft}
                onClick={() => void copyDraft()}
              >
                复制
              </Button>
              <Tooltip
                title={
                  message.intentSource === 'llm'
                    ? '重新分析并生成草稿'
                    : '当前使用关键词规则，未调用大模型；重新生成前请先在 .env 配置 LLM'
                }
              >
                <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRegenerate}>
                  重新生成
                </Button>
              </Tooltip>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}