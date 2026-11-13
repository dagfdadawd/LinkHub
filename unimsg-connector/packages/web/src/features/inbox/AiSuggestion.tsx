import { useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, Button, Tooltip } from 'antd';
import {
  CheckOutlined,
  CopyOutlined,
  DownOutlined,
  HistoryOutlined,
  LoadingOutlined,
  MailOutlined,
  ReloadOutlined,
  RobotOutlined,
  UpOutlined,
} from '@ant-design/icons';
import type { UnifiedMessage } from '../../types';
import { IntentTag } from '../../components/IntentTag';
import { TYPE_LABEL, clamp, conversationLabel, formatDateTime } from '../../utils/format';

/** AI 面板的三个标签页（与参考图一致） */
type AiTab = 'analyze' | 'reply' | 'tools';

const TABS: Array<{ key: AiTab; label: string }> = [
  { key: 'analyze', label: '消息分析' },
  { key: 'reply', label: '智能回复' },
  { key: 'tools', label: '快捷工具' },
];

/** 超过这个字数才值得摘一遍：短消息在气泡里已经读完了 */
const SUMMARY_MIN_CHARS = 60;

/**
 * AI 智能助手面板：把「理解这条消息」和「准备怎么回」拆成两个标签页，
 * 再加一个「快捷工具」承接原有的消息操作。
 *
 * 所有展示内容都来自消息上已有的 AI 字段（intent / intentSource / replyDraft），
 * 没有后端生成接口的项（例如「对方要解决的问题」）宁可留空，也不在前端编造。
 * 快捷工具里的每个按钮都必须有真实回调（复制 / 已读 / 完成 / 回放），
 * 没有回调就不渲染——不做只有外观的假按钮。
 */
export function AiSuggestion({
  message,
  onUseDraft,
  onRegenerate,
  regenerating = false,
  onCopyBody,
  onMarkRead,
  onMarkDone,
  onTrace,
}: {
  message: UnifiedMessage;
  onUseDraft: (draft: string) => void;
  onRegenerate: () => void;
  /** 后端正在重新分析：按钮进入 loading，避免连点重复调用模型 */
  regenerating?: boolean;
  /** 快捷工具：复制原文 / 切换已读 / 标记完成 / 打开回放（详情页注入真实回调） */
  onCopyBody?: () => void;
  onMarkRead?: () => void;
  onMarkDone?: () => void;
  onTrace?: () => void;
}) {
  const { message: toast } = AntApp.useApp();
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<AiTab>('analyze');
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

  const tools = [
    onCopyBody && { key: 'copy', icon: <CopyOutlined />, label: '复制消息内容', onClick: onCopyBody },
    onMarkRead && {
      key: 'read',
      icon: <MailOutlined />,
      label: message.readAt ? '标为未读' : '标为已读',
      onClick: onMarkRead,
    },
    onMarkDone && { key: 'done', icon: <CheckOutlined />, label: '标记完成', onClick: onMarkDone },
    onTrace && { key: 'trace', icon: <HistoryOutlined />, label: '全链路回放', onClick: onTrace },
  ].filter(Boolean) as Array<{ key: string; icon: ReactNode; label: string; onClick: () => void }>;

  return (
    <aside className="ai-panel" aria-label="AI 智能助手">
      <header className="ai-panel__head">
        <span className="ai-panel__icon" aria-hidden="true">
          <RobotOutlined />
        </span>
        <span className="ai-panel__titles">
          <span className="ai-panel__title">AI 智能助手</span>
          <span className="ai-panel__sub">意图识别 · 回复建议 · 快捷操作</span>
        </span>
        {/* 重新分析作用于整条消息（意图 + 草稿），所以放在面板级，切标签也随时可用 */}
        <Tooltip title="用当前 AI 配置重新分析这条消息">
          <button
            type="button"
            className="ai-panel__action"
            aria-label="重新生成"
            disabled={regenerating}
            onClick={onRegenerate}
          >
            {regenerating ? <LoadingOutlined /> : <ReloadOutlined />}
          </button>
        </Tooltip>
        <button
          type="button"
          className="ai-panel__collapse"
          aria-label={open ? '收起 AI 助手' : '展开 AI 助手'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <UpOutlined /> : <DownOutlined />}
        </button>
      </header>

      {open && (
        <>
          <div className="ai-tabs" role="tablist" aria-label="AI 功能">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                id={`ai-tab-${item.key}`}
                aria-selected={tab === item.key}
                aria-controls={`ai-panel-${item.key}`}
                className={`ai-tab${tab === item.key ? ' is-active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* 低精度是整条消息的属性（信息量不足），与当前停在哪个标签无关，放在面板级 */}
          {lowPrecision && (
            <p className="ai-precision" role="note">
              信息量较少 · 模型把握 {confidenceText}，草稿偏简短、精度较低，建议补充上下文后再发送
            </p>
          )}

          <div
            className="ai-panel__body"
            role="tabpanel"
            id={`ai-panel-${tab}`}
            aria-labelledby={`ai-tab-${tab}`}
          >
            {tab === 'analyze' && (
              <>
                <section className="ai-block" aria-label="消息理解">
                  <h4 className="ai-block__label">意图识别</h4>
                  <div className="ai-intent">
                    {pending ? (
                      <span className="ai-facts__muted">分析中…</span>
                    ) : (
                      <>
                        <IntentTag intent={message.intent} />
                        {message.intentSource && (
                          <span
                            className={`ai-panel__source${sourceIsLlm ? ' is-llm' : ''}`}
                            title={sourceTitle}
                          >
                            {sourceLabel}
                          </span>
                        )}
                        {fallback && (
                          <span className="ai-facts__muted">
                            {sourceIsLlm ? '信息不足，模型暂未归类' : '未识别，已回退未分类'}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </section>

                <section className="ai-block" aria-label="消息摘要">
                  <h4 className="ai-block__label">消息摘要</h4>
                  {message.body.trim().length > SUMMARY_MIN_CHARS ? (
                    <>
                      <p className="ai-summary">{clamp(message.body, 160)}</p>
                      <p className="ai-note">摘自原文，未做模型改写</p>
                    </>
                  ) : (
                    /* 短消息在气泡里已经读完了，再摘一遍只会制造重复噪音 */
                    <p className="ai-facts__muted">消息较短，已在聊天区完整展示。</p>
                  )}
                </section>

                <section className="ai-block" aria-label="关键信息">
                  <h4 className="ai-block__label">关键信息</h4>
                  <dl className="ai-facts">
                    <div>
                      <dt>消息类型</dt>
                      <dd>{TYPE_LABEL[message.type]}</dd>
                    </div>
                    <div>
                      <dt>所属会话</dt>
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
              </>
            )}

            {tab === 'reply' && (
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
                </div>
              </section>
            )}

            {tab === 'tools' && (
              <section className="ai-block" aria-label="快捷工具">
                <h4 className="ai-block__label">快捷工具</h4>
                {tools.length > 0 ? (
                  <div className="ai-tools">
                    {tools.map((tool) => (
                      <button
                        key={tool.key}
                        type="button"
                        className="ai-tool"
                        onClick={tool.onClick}
                      >
                        <span className="ai-tool__icon" aria-hidden="true">
                          {tool.icon}
                        </span>
                        <span className="ai-tool__label">{tool.label}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="ai-facts__muted">当前无可用的消息操作。</p>
                )}
                <p className="ai-note">以上均为现有消息操作，不额外调用模型。</p>
              </section>
            )}
          </div>
        </>
      )}
    </aside>
  );
}