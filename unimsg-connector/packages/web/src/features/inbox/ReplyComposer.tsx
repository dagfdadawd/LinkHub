import { useRef, useState } from 'react';
import { Input, Tag } from 'antd';
import { PaperClipOutlined, SendOutlined, UploadOutlined } from '@ant-design/icons';
import { MsgStatus } from '../../types';
import type { UnifiedMessage, OutboundAttachment } from '../../types';
import { FILE_LIMITS } from '../../types';
import { RippleButton } from '../../components/RippleButton';
import { usePreferences } from '../settings/preferences';
import { filesToAttachments, formatBytes, validateFiles } from '../../utils/attachments';

const { TextArea } = Input;

export function ReplyComposer({
  message,
  value,
  sending,
  onChange,
  onSend,
}: {
  message: UnifiedMessage;
  value: string;
  sending: boolean;
  onChange: (text: string) => void;
  /** 带上本次选中的附件一起回写；没有附件时传空数组 */
  onSend: (attachments: OutboundAttachment[]) => void;
}) {
  const prefs = usePreferences();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<OutboundAttachment[]>([]);
  const [fileError, setFileError] = useState('');
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !sending;
  const enterToSend = prefs.sendKey === 'enter';

  // 发送按钮状态色：以「是否已有回写内容」为准，而不是追 WebSocket 推来的状态——
  // reply 是落库事实，WS 可能丢包导致状态滞后；进死信队列时保留明亮态，
  // 让用户一眼看出还能修改后重试。
  const delivered = Boolean(message.reply) && message.status !== MsgStatus.FAILED;
  const sendState = delivered ? 'sent' : 'ready';

  async function pickFiles(picked: File[]): Promise<void> {
    setFileError('');
    const problem = validateFiles(picked);
    if (problem) {
      setFileError(problem);
      return;
    }
    if (attachments.length + picked.length > FILE_LIMITS.maxFiles) {
      setFileError(`最多只能带 ${FILE_LIMITS.maxFiles} 个附件`);
      return;
    }
    const total = attachments.reduce((s, a) => s + a.size, 0) + picked.reduce((s, f) => s + f.size, 0);
    if (total > FILE_LIMITS.maxTotalBytes) {
      setFileError(`附件总大小超过 ${formatBytes(FILE_LIMITS.maxTotalBytes)} 上限`);
      return;
    }
    try {
      // 选文件时就完成 base64 转换，发送动作保持同步（键盘流与单测不受异步影响）
      const converted = await filesToAttachments(picked);
      setAttachments([...attachments, ...converted]);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : '读取附件失败');
    }
  }

  function send(): void {
    if (!canSend) return;
    onSend(attachments);
    setAttachments([]);
    setFileError('');
  }

  return (
    <section className="composer" aria-label="回复编辑器">
      <TextArea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          enterToSend ? '输入回复内容…（Enter 发送 · Shift + Enter 换行）' : '输入回复内容…'
        }
        autoSize={{ minRows: 3, maxRows: 6 }}
        maxLength={2000}
        showCount
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !canSend) return;
          // 中文输入法确认候选词时也会触发 Enter，必须排除
          if (e.nativeEvent.isComposing) return;
          const shouldSend = enterToSend
            ? !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
            : e.ctrlKey || e.metaKey;
          if (shouldSend) {
            e.preventDefault();
            send();
          }
        }}
      />

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        data-testid="reply-file-input"
        onChange={(e) => {
          void pickFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {attachments.length > 0 && (
        <div className="composer__attachments" aria-label="待发送附件">
          {attachments.map((a, i) => (
            <Tag
              key={`${a.name}-${i}`}
              icon={<PaperClipOutlined />}
              closable
              onClose={() => setAttachments(attachments.filter((_, idx) => idx !== i))}
            >
              {a.name} · {formatBytes(a.size)}
            </Tag>
          ))}
        </div>
      )}
      {fileError && <div className="composer__file-error" role="alert">{fileError}</div>}

      <div className="composer__bar">
        <button
          type="button"
          className="composer__attach"
          onClick={() => fileRef.current?.click()}
          aria-label="添加附件"
          title={`添加文件（最多 ${FILE_LIMITS.maxFiles} 个，单个 ≤ ${formatBytes(FILE_LIMITS.maxFileBytes)}）`}
        >
          <UploadOutlined /> 添加文件
        </button>
        <RippleButton
          loading={sending}
          disabled={!canSend}
          onClick={send}
          className={`ripple-btn--${sendState}`}
          data-testid="send-reply"
          data-send-state={sendState}
          title={delivered ? '该消息已有回写内容，可继续编辑后再次发送' : '发送回复'}
        >
          <SendOutlined />
          发送回复
        </RippleButton>
      </div>
    </section>
  );
}
