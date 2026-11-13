import { useState } from 'react';
import { App as AntApp, Button, Tooltip } from 'antd';
import {
  CopyOutlined,
  DownOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
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
  regenerating = false,
}: {
  message: UnifiedMessage;
  onUseDraft: (draft: string) => void;
  onRegenerate: () => void;
  /** 后端正在重新分析：按钮进入 loading，避免连点重复调用模型 */
  regenerating?: boolean;
}) {
  const { message: toast } = AntApp.useApp();
  const [open, setOpen] = useState(true);
  const pending = !message.intent;
  const fallback = !message.intent || message.intent === '未分类';

  // 来源标签取消息上记录的「当时」厂商，绝不固定写 MiMo；旧数据没有记录就只说「大模型识别」
  const sourceIsLlm = message.intentSource === 'llm';
  // 低精度仍来自真实模型：只提示「信息不足、草稿偏短」，绝不写成规则兜底
  const lowPrecision = sourceIsLlm && message.aiPrecision === 'low';
  const confidenceText = typeof message.aiConfidence === 'number'
    ? `${Math.round(message.aiConfidence * 100)}%`
    : '较低';
  const sourceLabel = sourceIsLlm
    ? (message.aiProvider ? `${message.aiProvider} 识别` : '大模型识别')
    : '规则兜底';
  const sourceTitle = sourceIsLlm
    ? `由真实大模型识别${message.aiModel ? `（模型 ${message.aiModel}）` : ''}${lowPrecision ? '；本次信息量较少，属低精度结果' : ''}`
    : '真实模型不可用，已回退关键词规则';

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
    <section className="ai-panel" aria-label="AI 处理建议">
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
                className={`ai-panel__source${sourceIsLlm ? ' is-llm' : ''}`}
                title={sourceTitle}
              >
                {sourceLabel}
              </span>
            )}
          </span>
        )}
        <span className="ai-panel__spacer" />
        <span className="ai-panel__toggle">{open ? <DownOutlined /> : <RightOutlined />}</span>
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
                      {fallback && (
                        <span className="ai-facts__muted">
                          {sourceIsLlm ? '信息不足，模型暂未归类' : '未识别，已回退未分类'}
                        </span>
                      )}
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
            {lowPrecision && (
              <p className="ai-precision" role="note">
                信息量较少 · 模型把握 {confidenceText}，草稿偏简短、精度较低，建议补充上下文后再发送
              </p>
            )}
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
                  sourceIsLlm
                    ? (lowPrecision
                      ? '用当前 AI 配置重新生成；信息量较少时结果仍来自模型，只是更简短，不会回退规则'
                      : '用当前 AI 配置重新分析并生成草稿（会真实调用一次模型）')
                    : '用当前 AI 配置重新分析；若仍显示「规则兜底」，请到「连接账号 → AI 模型」检查服务商 / 端点 / 模型 ID / Key，保存后重启后端'
                }
              >
                <Button
                  size="small"
                  type="text"
                  icon={<ReloadOutlined />}
                  loading={regenerating}
                  disabled={regenerating}
                  onClick={onRegenerate}
                >
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