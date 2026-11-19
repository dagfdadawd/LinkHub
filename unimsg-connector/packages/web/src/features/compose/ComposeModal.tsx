/**
 * 「新建发送」：赛题 A 功能需求 3 的统一入口主动发送界面。
 *
 * 与「回复」的区别：不依赖先收到某条消息，可直接选平台 + 填目标会话 +
 * 输入文本 + 挂附件。后端把这次发送纳入同一条闭环状态机（含 traceId），
 * 因此发送后在收件箱与「全链路回放」里都能逐步看到状态回流。
 *
 * 另外支持勾选「同时加为待办」：手填标题 / 截止时间，待办就是这条发出的
 * 消息本身（不再造一条额外消息），发送完成即出现在「待办」清单里可持续跟进。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dayjs } from 'dayjs';
import { Alert, App as AntApp, Button, Checkbox, DatePicker, Input, Modal, Radio, Select, Space, Tag } from 'antd';
import { CheckSquareOutlined, PaperClipOutlined, SendOutlined, UploadOutlined } from '@ant-design/icons';
import { FILE_LIMITS, Platform, TODO_TITLE_MAX } from '../../types';
import type { ComposeRequest, IdentityRole, SendCapabilities } from '../../types';
import type { AccountInfo, ContactDirectory, MailAccountInfo } from '../../services/api';
import { PLATFORM_META, formatRelative } from '../../utils/format';
import { buildConversations } from '../../utils/conversations';
import { UserOutlined } from '@ant-design/icons';
import { useAppState } from '../../hooks/useAppState';
import { IdentityTag } from '../../components/IdentityTag';
import { filesToAttachments, formatBytes, validateFiles } from '../../utils/attachments';
import { formatSendError } from '../../utils/sendError';
import { services, store } from '../../store';

const { TextArea } = Input;

const PLATFORM_OPTIONS = Object.values(Platform).map((p) => ({
  value: p,
  label: PLATFORM_META[p].name,
}));

/** 统一入口自己发的消息用的假发信人，不能当成联系人名 */
const LINKHUB_SENDER = 'LinkHub 统一入口';

/**
 * 平台原始 ID 长这样：`ou_c8bb…` / `oc_abc…` / `cidvtwl…==` / `cli_…`。
 * 判断依据是「够长 + 纯 ASCII + 没有中文和空格」，人起的名字（Jarvis / 测试群）不会命中。
 */
export function looksLikePlatformId(name: string | undefined): boolean {
  const v = (name ?? '').trim();
  if (v.length < 12) return false;
  if (/[一-龥\s]/.test(v)) return false;
  return /^[A-Za-z0-9_+/=-]+$/.test(v);
}

/**
 * 「发给谁」的展示名：优先人话，实在没有名字就用「单聊 · …尾部6位」，
 * 完整 ID 放到 tooltip 里——列表里铺一长串 ID 用户根本认不出是谁。
 */
export function pickTargetLabel(
  name: string | undefined,
  conversationId: string,
  type?: 'p2p' | 'group',
): string {
  const v = (name ?? '').trim();
  if (v && !looksLikePlatformId(v) && v !== '（未命名会话）') return v;
  const kind = type === 'group' ? '群聊' : '单聊';
  const tail = conversationId ? conversationId.slice(-6) : '';
  return tail ? `${kind} · …${tail}` : `未命名${kind}`;
}

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
  const state = useAppState();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [platform, setPlatform] = useState<Platform>(Platform.FEISHU);
  /** 选中的会话（内部存会话键，对用户只展示名字）；邮箱平台用下面的地址输入框 */
  const [targetKey, setTargetKey] = useState<string>();
  const [conversationId, setConversationId] = useState('');
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [mailAccount, setMailAccount] = useState<string>();
  /** 本次发送身份：仅飞书/钉钉且后端身份视图可用时可指定；默认跟随后端 effectiveSend */
  const [sendIdentity, setSendIdentity] = useState<IdentityRole>();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  /** 同时手动加一条待办：勾选后这条发出的消息本身进入待办清单（同一条记录，不另造消息） */
  const [todoEnabled, setTodoEnabled] = useState(false);
  const [todoTitle, setTodoTitle] = useState('');
  const [todoDue, setTodoDue] = useState<Dayjs>();
  const [caps, setCaps] = useState<SendCapabilities[]>([]);
  const [sending, setSending] = useState(false);
  /** 平台会话名录（飞书可用）：补齐「还没聊过的人 / 群」 */
  const [directory, setDirectory] = useState<ContactDirectory>();

  // 拉一次该平台的会话名录（只读、后端有缓存）；旧后端没有该接口时保持 undefined
  useEffect(() => {
    if (!open || platform === Platform.MAIL) return;
    let alive = true;
    services.api
      .contacts(platform)
      .then((result) => {
        if (alive) setDirectory(result);
      })
      .catch(() => {
        if (alive) setDirectory(undefined);
      });
    return () => {
      alive = false;
    };
  }, [open, platform]);

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

  /**
 * 可选目标 = 「已有会话」 ∪ 「平台会话名录」。
 *
 * 已有会话保证任何平台都能用；名录（飞书）能补上「还没聊过的人/群」，
 * 解决「为什么只能选三个」——只要这个人/群在本人账号的会话列表里就能选到。
 */
  const targetOptions = useMemo(() => {
    // 平台会话名录（飞书）里的名字最可读：同一个会话 id 优先用它
    const dirById = new Map(
      (directory?.platform === platform ? directory.items : []).map((it) => [it.id, it]),
    );

    const fromMessages = buildConversations(state.messages)
      .filter((c) => c.platform === platform)
      .map((c) => {
        const withConv = c.messages.find((m) => m.conversation?.id);
        const conversationId = withConv?.conversation?.id ?? '';
        const conversationType = withConv?.conversation?.type ?? c.conversationType;
        // 名字候选：名录名 → 会话名 → 消息里的真实发信人名（跳过统一入口自己的假名字）
        const readableSender = c.messages
          .map((m) => m.sender?.name)
          .find((n): n is string => Boolean(n && !looksLikePlatformId(n) && n !== LINKHUB_SENDER));
        const name = [dirById.get(conversationId)?.name, c.title, readableSender]
          .find((n): n is string => Boolean(n && !looksLikePlatformId(n)));
        return {
          value: c.key,
          label: pickTargetLabel(name, conversationId, conversationType),
          // 悬停能看到原始值（排查时仍然有用），但列表/输入框只显示人话
          rawTitle: [c.title, conversationId].filter(Boolean).join(' · '),
          conversationId,
          conversationType,
          lastAt: c.lastAt as string | undefined,
          group: conversationType === 'group',
          fromDirectory: false,
        };
      })
      .filter((o) => Boolean(o.conversationId));

    const known = new Set(fromMessages.map((o) => o.conversationId));
    const extra = (directory?.platform === platform ? directory.items : [])
      .filter((it) => it.id && !known.has(it.id))
      .map((it) => ({
        value: `${platform}:${it.id}`,
        label: pickTargetLabel(it.name, it.id, it.type),
        rawTitle: [it.name, it.id].filter(Boolean).join(' · '),
        conversationId: it.id,
        conversationType: it.type,
        lastAt: undefined as string | undefined,
        group: it.type === 'group',
        fromDirectory: true,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));

    return [...fromMessages, ...extra];
  }, [state.messages, platform, directory]);

  const selectedTarget = targetOptions.find((o) => o.value === targetKey);

  // 选目标：默认该平台最近的会话；用户已选的不会被新消息打断
  useEffect(() => {
    if (!open || platform === Platform.MAIL) return;
    setTargetKey((prev) => {
      if (prev && targetOptions.some((o) => o.value === prev)) return prev;
      return targetOptions[0]?.value;
    });
  }, [open, platform, targetOptions]);

  // 邮箱：目标是收件地址，仍用输入框；预填该平台最近一条会话（历史上用过的地址）
  useEffect(() => {
    if (!open || platform !== Platform.MAIL) return;
    const recent = store.getSnapshot().messages.find(
      (m) => m.platform === platform && m.conversation?.id,
    );
    setConversationId(recent?.conversation?.id ?? '');
  }, [platform, open]);

  const cap = caps.find((c) => c.platform === platform);
  const accountMode = accounts.find((a) => a.platform === platform)?.mode;
  /** 演示模式：Mock 通道发送按钮可直接发（后端会用演示会话 mock:demo 生成模拟消息） */
  const mockChannel = cap?.mode === 'mock' || accountMode === 'mock' || effectiveSend === 'mock';
  /** 本次真正的目标：IM 取选中会话的 conversation.id + type，邮箱取输入的地址 */
  const resolvedConversationId =
    platform === Platform.MAIL ? conversationId.trim() : (selectedTarget?.conversationId ?? '');
  const resolvedConversationType =
    platform === Platform.MAIL ? ('p2p' as const) : selectedTarget?.conversationType;
  const hasTarget = mockChannel || Boolean(resolvedConversationId);
  const canSend = !sending
    && hasTarget
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
        ...(resolvedConversationId ? { conversationId: resolvedConversationId } : {}),
        // 会话类型从选中的会话带过来：以前不传，群会被后端当成单聊
        ...(resolvedConversationType ? { conversationType: resolvedConversationType } : {}),
        // 会话名一起带上：不带的话这条发送会在收件箱里形成一个没有名字的会话
        ...(selectedTarget?.label ? { conversationTitle: selectedTarget.label } : {}),
        ...(platform === Platform.MAIL && mailAccount ? { mailAccount } : {}),
        // 身份显式下发：两种身份都可用时尊重用户选择；只有一种时等同 effectiveSend。
        // Mock 通道不传（服务端整体模拟，不接受身份覆盖）。
        ...(sendIdentity ? { identity: sendIdentity } : {}),
        text: text.trim(),
        ...(attachments.length > 0 ? { attachments } : {}),
        // 勾选「同时加为待办」才带 todo：传 {} 也代表建待办（标题回退消息内容）
        ...(todoEnabled
          ? {
              todo: {
                ...(todoTitle.trim() ? { title: todoTitle.trim() } : {}),
                ...(todoDue ? { dueAt: todoDue.toISOString() } : {}),
              },
            }
          : {}),
      };
      const taskId = await store.compose(req);
      // 成功不再弹 toast：弹窗关闭 + 新消息出现在会话里，本身就是反馈；
      // 失败才提示，避免每次发送都被一层浮层挡一下。
      setText('');
      setFiles([]);
      setTodoEnabled(false);
      setTodoTitle('');
      setTodoDue(undefined);
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
      width={560}
      /* 整体上移：默认 top=100 在小屏上会把「发送给 / 发送」挤到折叠线以下 */
      style={{ top: 24 }}
      /* 内容区自己滚，footer 的「发送」永远可见，不用一路翻到底 */
      styles={{ body: { maxHeight: 'min(62vh, 640px)', overflowY: 'auto', paddingRight: 6 } }}
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
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
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
          {platform === Platform.MAIL ? (
            <>
              <div className="compose-field__label">收件邮箱地址</div>
              <Input
                value={conversationId}
                onChange={(e) => setConversationId(e.target.value)}
                placeholder={CONVERSATION_HINT[platform]}
                aria-label="目标会话"
              />
              <div className="compose-field__hint">
                留空会复用该平台最近一封邮件往来的地址；首次给新地址发信时直接填写即可。
              </div>
            </>
          ) : (
            <>
              <div className="compose-field__label">发送给</div>
              <Select
                className="compose-target"
                showSearch
                value={targetKey}
                options={targetOptions}
                onChange={setTargetKey}
                optionFilterProp="label"
                placeholder={
                  targetOptions.length === 0 ? '该平台还没有会话' : '选择联系人或群'
                }
                disabled={targetOptions.length === 0}
                style={{ width: '100%' }}
                aria-label="发送给"
                data-testid="compose-target"
                optionRender={(option) => {
                  const item = option.data as (typeof targetOptions)[number];
                  return (
                    <div className="compose-target__option" title={item.rawTitle}>
                      <span className={`compose-target__avatar${item.group ? ' is-group' : ''}`}>
                        {item.group ? '群' : <UserOutlined />}
                      </span>
                      <span className="compose-target__name">{item.label}</span>
                      <span className="compose-target__meta">
                        {item.group ? '群聊' : '单聊'}
                        {item.lastAt ? ` · ${formatRelative(item.lastAt)}` : ''}
                        {item.fromDirectory ? ' · 通讯录' : ''}
                      </span>
                    </div>
                  );
                }}
              />
              <div className="compose-field__hint">
                {targetOptions.length === 0
                  ? directory?.reason
                    || '该平台还没有可发送的会话：先在收件箱收到一条消息，再回到这里发送。'
                  : directory && !directory.available
                    ? `可发送给已有会话；${directory.reason ?? '当前平台不提供通讯录。'}`
                    : directory?.available
                      ? `已包含飞书本人账号可见的全部会话（${directory.items.length} 个），可直接搜索人名或群名。`
                      : '列表来自真实的收件箱会话；选中后按该会话的类型（单聊 / 群聊）发送。'}
              </div>
            </>
          )}
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

        {/* 手动加待办：待办就是这条发出的消息本身（同一条记录），发送完成即进入待办清单 */}
        <div className="compose-todo">
          <Checkbox
            checked={todoEnabled}
            onChange={(e) => setTodoEnabled(e.target.checked)}
            data-testid="compose-todo-toggle"
          >
            <CheckSquareOutlined aria-hidden="true" /> 同时加为待办
          </Checkbox>
          <div className="compose-field__hint">
            勾选后这条发出的消息会同时出现在「待办」清单里，可随时勾选完成；标题与截止时间都可以不填。
          </div>
          {todoEnabled && (
            <div className="compose-todo__fields">
              <div>
                <div className="compose-field__label">待办标题（选填）</div>
                <Input
                  value={todoTitle}
                  onChange={(e) => setTodoTitle(e.target.value)}
                  placeholder="默认用消息内容作为标题"
                  maxLength={TODO_TITLE_MAX}
                  showCount
                  aria-label="待办标题"
                  data-testid="compose-todo-title"
                />
              </div>
              <div>
                <div className="compose-field__label">截止时间（选填）</div>
                <DatePicker
                  value={todoDue ?? null}
                  onChange={(value) => setTodoDue(value ?? undefined)}
                  showTime={{ format: 'HH:mm' }}
                  format="YYYY-MM-DD HH:mm"
                  placeholder="不设置则不显示截止提醒"
                  style={{ width: '100%' }}
                  aria-label="待办截止时间"
                />
              </div>
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
