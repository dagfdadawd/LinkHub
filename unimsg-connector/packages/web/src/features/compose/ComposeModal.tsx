/**
 * 「新建发送」：赛题 A 功能需求 3 的统一入口主动发送界面。
 *
 * 与「回复」的区别：不依赖先收到某条消息，可直接选平台 + 填目标会话 +
 * 输入文本 + 挂附件。后端把这次发送纳入同一条闭环状态机（含 traceId），
 * 因此发送后在收件箱与「全链路回放」里都能逐步看到状态回流。
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Input, Modal, Radio, Select, Space, Tag } from 'antd';
import { PaperClipOutlined, SendOutlined, UploadOutlined } from '@ant-design/icons';
import { FILE_LIMITS, Platform } from '../../types';
import type { ComposeRequest, IdentityRole, SendCapabilities } from '../../types';
import type { AccountInfo, MailAccountInfo } from '../../services/api';
import { PLATFORM_META } from '../../utils/format';
import { IdentityTag } from '../../components/IdentityTag';
import { filesToAttachments, formatBytes, validateFiles } from '../../utils/attachments';
import { formatSendError } from '../../utils/sendError';
import { services, store } from '../../store';

const { TextArea } = Input;

const PLATFORM_OPTIONS = Object.values(Platform).map((p) => ({
  value: p,
  label: PLATFORM_META[p].name,
}));

/** 目标会话输入框的提示：不同平台的目标 ID 语义不同，直接告诉用户填什么 */
const CONVERSATION_HINT: Record<Platform, string> = {
  [Platform.FEISHU]: '飞书 chat_id（oc_…）或单聊 open_id',
  [Platform.DINGTALK]: '钉钉 openConversationId（cid…）或单聊 userId',
  [Platform.WECOM]: '企业微信成员 userid',
  [Platform.MAIL]: '收件邮箱地址',
};

export function ComposeModal({
  open,
  onClose,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  onSent?: (taskId: string) => void;
}) {
  const { message: toast } = AntApp.useApp();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [platform, setPlatform] = useState<Platform>(Platform.FEISHU);
  const [conversationId, setConversationId] = useState('');
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [mailAccount, setMailAccount] = useState<string>();
  /** 本次发送身份：仅飞书/钉钉且后端身份视图可用时可指定；默认跟随后端 effectiveSend */
  const [sendIdentity, setSendIdentity] = useState<IdentityRole>();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [caps, setCaps] = useState<SendCapabilities[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    services.api.capabilities()
      .then((list) => { if (alive) setCaps(list); })
      .catch(() => { /* 能力接口不可用时按全平台可发文本处理，不阻断演示 */ });
    services.api.accounts()
      .then((list) => {
        if (!alive) return;
        setAccounts(list);
      })
      .catch(() => { /* 账号接口不可用时退回服务端默认身份/账号，不阻断发送 */ });
    return () => { alive = false; };
  }, [open]);

  const mailAccounts: MailAccountInfo[] =
    accounts.find((a) => a.platform === Platform.MAIL)?.accounts ?? [];
  const identity = accounts.find((a) => a.platform === platform)?.identity;
  const userAvailable = Boolean(identity?.user.linked);
  const botAvailable = Boolean(identity?.botAvailable);
  const bothIdentitiesAvailable = Boolean(identity && userAvailable && botAvailable);
  const effectiveSend = identity?.effectiveSend;

  // 打开 / 切平台时默认跟随后端 effectiveSend（本人或机器人）；Mock 不给可选身份
  useEffect(() => {
    if (!open) return;
    setSendIdentity(
      effectiveSend === 'user' || effectiveSend === 'bot' ? effectiveSend : undefined,
    );
  }, [open, platform, effectiveSend, userAvailable, botAvailable]);

  // 选邮箱平台时默认第一个已配置账号；已选项被移除时同步纠正
  useEffect(() => {
    if (!open || platform !== Platform.MAIL || mailAccounts.length === 0) return;
    setMailAccount((prev) =>
      prev && mailAccounts.some((a) => a.key === prev) ? prev : mailAccounts[0].key,
    );
  }, [open, platform, mailAccounts]);

  // 切换平台时自动预填该平台最近一条已知会话，减少演示现场手填
  useEffect(() => {
    if (!open) return;
    const recent = store.getSnapshot().messages.find(
      (m) => m.platform === platform && m.conversation?.id,
    );
    setConversationId(recent?.conversation?.id ?? '');
  }, [platform, open]);

  const cap = caps.find((c) => c.platform === platform);
  const accountMode = accounts.find((a) => a.platform === platform)?.mode;
  /** 演示模式：Mock 通道发送按钮可直接发（后端会用演示会话 mock:demo 生成模拟消息） */
  const mockChannel = cap?.mode === 'mock' || accountMode === 'mock' || effectiveSend === 'mock';
  const canSend = !sending
    && (text.trim().length > 0 || files.length > 0)
    && (files.length === 0 || cap?.file !== false);

  function pickFiles(picked: File[]): void {
    const next = [...files, ...picked].slice(0, FILE_LIMITS.maxFiles);
    const problem = validateFiles(next);
    if (problem) {
      toast.error(problem);
      return;
    }
    setFiles(next);
  }

  async function handleSend(): Promise<void> {
    if (!canSend) return;
    setSending(true);
    try {
      const attachments = await filesToAttachments(files);
      const req: ComposeRequest = {
        platform,
        ...(conversationId.trim() ? { conversationId: conversationId.trim() } : {}),
        ...(platform === Platform.MAIL
          ? { conversationType: 'p2p' as const, ...(mailAccount ? { mailAccount } : {}) }
          : {}),
        // 身份显式下发：两种身份都可用时尊重用户选择；只有一种时等同 effectiveSend。
        // Mock 通道不传（服务端整体模拟，不接受身份覆盖）。
        ...(sendIdentity ? { identity: sendIdentity } : {}),
        text: text.trim(),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      const taskId = await store.compose(req);
      // 「已提交」不是「已发出」：异步发送结果会经 WS 回流；演示模式必须显式写「模拟」
      toast.success(
        mockChannel
          ? '已模拟发送（不会真的发到平台）…可在「全链路回放」查看状态回流'
          : '已提交，正在发送…（可在「全链路回放」查看状态回流）',
      );
      setText('');
      setFiles([]);
      onSent?.(taskId);
      onClose();
    } catch (e) {
      const rawMessage = e instanceof Error ? e.message : '发送失败';
      // 真实模式缺目标会话：给可执行的下一步，而不是只报 conversationId
      if (!mockChannel && /conversationId|目标会话|缺少会话/.test(rawMessage)) {
        toast.error('真实发送需要目标会话：请从收件箱打开一条该平台消息点「回复」，或填写会话 ID 后重试。');
      } else {
        // 后端建议「改用 identity=user」在本人身份未连接时做不到：按能力替换成去连接的指引（NEW-P2-3）
        toast.error(formatSendError(rawMessage, identity));
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="新建发送 · 向指定平台发送消息或文件"
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={!canSend}
            loading={sending}
            onClick={() => void handleSend()}
            data-testid="compose-send"
          >
            发送
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <div className="compose-field__label">目标平台</div>
          <Select
            value={platform}
            options={PLATFORM_OPTIONS}
            onChange={(v) => setPlatform(v as Platform)}
            style={{ width: '100%' }}
            aria-label="目标平台"
          />
        </div>

        {/* 发送身份：只在后端下发了身份视图（飞书 / 钉钉）时出现；两种身份都可用才可切换 */}
        {identity && (
          <div className="compose-identity" data-testid="compose-identity">
            <div className="compose-field__label">发送身份</div>
            {bothIdentitiesAvailable ? (
              <>
                <Radio.Group
                  value={sendIdentity}
                  onChange={(e) => setSendIdentity(e.target.value as IdentityRole)}
                  aria-label="发送身份"
                >
                  <Radio value="user">
                    本人
                    {identity.user.displayName ? `（${identity.user.displayName}）` : ''}
                  </Radio>
                  <Radio value="bot">机器人</Radio>
                </Radio.Group>
                <div className="compose-field__hint">
                  默认跟随后端策略（当前是{effectiveSend === 'user' ? '本人' : '机器人'}）。
                  以本人发送时，收件人看到的是你；以机器人发送时，收件人看到的是机器人。
                </div>
              </>
            ) : effectiveSend === 'mock' ? (
              <>
                <IdentityTag role="mock" action="send" />
                <div className="compose-field__hint">
                  当前平台是演示模式：只会生成本地模拟发送记录，不会真的发到平台，因此不能选择本人 / 机器人身份。
                </div>
              </>
            ) : (
              <>
                <IdentityTag role={effectiveSend === 'user' ? 'user' : 'bot'} action="send" />
                <div className="compose-field__hint">
                  {effectiveSend === 'user'
                    ? `当前只能以本人身份发送${identity.user.displayName ? `（${identity.user.displayName}）` : ''}：机器人通道不可用。${identity.botHint}`
                    : `当前只能以机器人身份发送：本人账号未连接。${identity.user.hint}`}
                </div>
              </>
            )}
          </div>
        )}

        {platform === Platform.MAIL && (
          <div>
            <div className="compose-field__label">发件邮箱</div>
            <Select
              value={mailAccount}
              options={mailAccounts.map((a) => ({
                value: a.key,
                label: `${a.label}（${a.address}）`,
              }))}
              onChange={setMailAccount}
              disabled={mailAccounts.length === 0}
              placeholder={mailAccounts.length === 0 ? '未配置邮箱账号' : undefined}
              style={{ width: '100%' }}
              aria-label="发件邮箱"
              data-testid="compose-mail-account"
            />
            {mailAccounts.length === 0 && (
              <div className="compose-field__hint">
                暂无可用邮箱账号：请先到「连接账号」页添加邮箱账号（需要邮箱授权码）。
              </div>
            )}
          </div>
        )}

        <div>
          <div className="compose-field__label">目标会话 ID（留空则复用该平台最近会话）</div>
          <Input
            value={conversationId}
            onChange={(e) => setConversationId(e.target.value)}
            placeholder={CONVERSATION_HINT[platform]}
            aria-label="目标会话"
          />
          <div className="compose-field__hint">
            {mockChannel
              ? '演示模式：留空即可，会生成一条本地模拟发送记录（不会真的发到平台）。'
              : '真实发送需要目标会话：留空会复用该平台最近一条消息的会话；没有最近会话时，请从收件箱对应消息点「回复」。'}
          </div>
        </div>

        <div>
          <div className="compose-field__label">文本内容（也可只发文件）</div>
          <TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="输入要发送的文本…"
            autoSize={{ minRows: 3, maxRows: 6 }}
            maxLength={4000}
            showCount
            aria-label="发送文本"
          />
        </div>

        <div>
          <div className="compose-field__label">
            附件（最多 {FILE_LIMITS.maxFiles} 个 · 单文件 ≤ {formatBytes(FILE_LIMITS.maxFileBytes)}）
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              pickFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
            data-testid="compose-file-input"
          />
          <Button icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>
            添加文件
          </Button>
          {files.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {files.map((f, i) => (
                <Tag
                  key={`${f.name}-${i}`}
                  icon={<PaperClipOutlined />}
                  closable
                  onClose={() => setFiles(files.filter((_, idx) => idx !== i))}
                  style={{ marginBottom: 4 }}
                >
                  {f.name} · {formatBytes(f.size)}
                </Tag>
              ))}
            </div>
          )}
        </div>

        {cap && (
          <Alert
            type={cap.mode === 'mock' ? 'info' : 'success'}
            showIcon
            message={`当前 ${PLATFORM_META[platform].name} 通道：${cap.mode === 'mock' ? '演示模式（模拟发送，不会真的调用平台）' : '真实平台接口'}`}
            description={cap.note ?? '文本与文件都按统一消息格式转换后发送，状态会回流到全链路回放'}
          />
        )}
      </Space>
    </Modal>
  );
}
