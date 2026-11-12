import { Button, Tooltip } from 'antd';
import { RobotOutlined, ReloadOutlined } from '@ant-design/icons';
import type { UnifiedMessage } from '../../types';
import { IntentTag } from '../../components/IntentTag';

export function AiSuggestion({
  message,
  onUseDraft,
  onRegenerate,
}: {
  message: UnifiedMessage;
  onUseDraft: (draft: string) => void;
  onRegenerate: () => void;
}) {
  const fallback = !message.intent || message.intent === '未分类';
  const pending = !message.intent;

  return (
    <section className="ai-card" aria-label="AI 处理建议">
      <header className="ai-card__head">
        <span className="ai-card__icon">
          <RobotOutlined />
        </span>
        <span className="ai-card__title">AI 建议</span>
        {pending ? (
          <span className="ai-card__status">分析中…</span>
        ) : (
          <span className="ai-card__intent">
            意图 <IntentTag intent={message.intent} />
            {message.intentSource && (
              <span
                className={`ai-card__source${message.intentSource === 'llm' ? ' is-llm' : ''}`}
                title={message.intentSource === 'llm' ? '由真实大模型识别' : '真实模型不可用，已回退关键词规则'}
              >
                {message.intentSource === 'llm' ? 'MiMo 识别' : '规则兜底'}
              </span>
            )}
          </span>
        )}
        {!pending && <span className="ai-card__hint">{fallback ? '未识别，已回退未分类' : '可编辑后发送'}</span>}
      </header>

      <div className={`ai-card__draft${pending ? ' is-pending' : ''}`}>
        {pending ? '正在根据消息内容生成回复草稿…' : message.replyDraft || '暂无草稿，可直接输入回复。'}
      </div>

      <footer className="ai-card__actions">
        <Button
          size="small"
          type="default"
          className="ai-card__use"
          disabled={!message.replyDraft}
          onClick={() => message.replyDraft && onUseDraft(message.replyDraft)}
        >
          采用草稿
        </Button>
        <Tooltip title={message.intentSource === 'llm' ? '由真实大模型重新分析' : '当前使用关键词规则，未调用大模型'}>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRegenerate}>
            重新生成
          </Button>
        </Tooltip>
      </footer>
    </section>
  );
}