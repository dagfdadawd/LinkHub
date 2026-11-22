import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Input, Modal, Popconfirm, Segmented, Switch, Tabs } from 'antd';
import {
  BgColorsOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
  LockOutlined,
  LogoutOutlined,
  MessageOutlined,
  PictureOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import { useAppState } from '../../hooks/useAppState';
import { services, store } from '../../store';
import { clearSession, listSessions, useSession } from '../../services/session';
import { resetOnboardingTips } from '../../utils/onboarding';
import { useTheme, type ThemePreference } from '../../app/ThemeProvider';
import {
  AVATAR_TONES,
  DEFAULT_PROFILE,
  initialOf,
  resetProfile,
  saveProfile,
  useProfile,
} from './profile';
import {
  patchPreferences,
  resetPreferences,
  usePreferences,
  type Density,
  type MotionLevel,
  type SendKey,
} from './preferences';
import {
  playUrgentChime,
  requestNotificationPermission,
  showUrgentTestNotification,
} from '../../utils/urgentAlert';

const MAX_AVATAR_BYTES = 300 * 1024;
const APP_VERSION = '1.1.0';

/**
 * 构建时间（vite define 注入）。看「设置 → 关于」这里就能判断浏览器里跑的是不是最新代码：
 * 之前因为浏览器一直用 7 天前的旧产物，排查了大量"改了没生效"的假问题。
 */
const BUILD_TIME = (() => {
  try {
    const raw = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '';
    return raw ? new Date(raw).toLocaleString('zh-CN') : '开发模式（未构建）';
  } catch {
    return '开发模式（未构建）';
  }
})();
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/** 一行设置：左侧标题 + 说明，右侧控件 */
function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row__text">
        <div className="set-row__title">{title}</div>
        {description && <div className="set-row__desc">{description}</div>}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const profile = useProfile();
  const prefs = usePreferences();
  const state = useAppState();
  const { mode, preference, setPreference } = useTheme();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();

  const [name, setName] = useState(profile.name);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile.avatarUrl);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 账号分区：当前登录用户 + 改密码 / 退出所有设备 */
  const session = useSession();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  async function handleChangePassword(): Promise<void> {
    if (newPassword !== confirmPassword) {
      message.error('两次输入的新密码不一致');
      return;
    }
    setChangingPassword(true);
    try {
      const { revoked } = await services.api.changePassword({ oldPassword, newPassword });
      // 后端作废了这个账号的会话：本地必须同步清掉，否则会拿着废令牌继续请求。
      // 多开场景下别的账号还留着，这时不该把人赶回登录页。
      clearSession();
      services.realtime.reconnectNow?.();
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onClose();
      if (listSessions().length > 0) {
        void store.refresh?.();
        message.success(`密码已修改，${revoked} 个登录已失效；已切到本机其他账号`);
        navigate('/inbox', { replace: true });
        return;
      }
      message.success(`密码已修改，${revoked} 个登录已失效，请用新密码重新登录`);
      navigate('/login', { replace: true });
    } catch (e) {
      message.error(e instanceof Error ? e.message : '修改密码失败');
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleLogoutAll(): Promise<void> {
    try {
      const { revoked } = await services.api.logoutAll();
      clearSession();
      services.realtime.reconnectNow?.();
      onClose();
      if (listSessions().length > 0) {
        void store.refresh?.();
        message.success(`已退出这个账号的所有设备（${revoked} 个登录失效），已切到本机其他账号`);
        navigate('/inbox', { replace: true });
        return;
      }
      message.success(`已退出所有设备（${revoked} 个登录失效）`);
      navigate('/login', { replace: true });
    } catch (e) {
      message.error(e instanceof Error ? e.message : '退出失败');
    }
  }

  const [claiming, setClaiming] = useState(false);

  /** 把「无主」的历史消息认领到当前账号（数据隔离的入口） */
  async function handleClaim(): Promise<void> {
    setClaiming(true);
    try {
      const { claimed } = await services.api.claimMessages();
      await store.refresh();
      message.success(claimed > 0 ? `已认领 ${claimed} 条历史消息` : '没有可认领的历史消息');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '认领失败');
    } finally {
      setClaiming(false);
    }
  }

  /**
   * 开启 / 关闭紧急桌面通知。
   *
   * 权限只能在用户手势里申请 —— 设置页这个开关就是手势，所以放在这里申请；
   * 用户拒绝后如实告诉去哪里改，不假装已开启。
   */
  async function toggleDesktopAlert(checked: boolean): Promise<void> {
    if (!checked) {
      patchPreferences({ urgentDesktop: false });
      return;
    }
    const permission = await requestNotificationPermission();
    if (permission === 'granted') {
      patchPreferences({ urgentDesktop: true });
      showUrgentTestNotification();
      message.success('已开启紧急桌面通知（页面不在前台时提醒）');
      return;
    }
    patchPreferences({ urgentDesktop: false });
    if (permission === 'unsupported') {
      message.warning('当前环境不支持桌面通知，已保持关闭');
    } else if (permission === 'denied') {
      message.warning('浏览器已拒绝通知权限：请在地址栏左侧的站点权限里允许通知后重试');
    } else {
      message.warning('未获得通知权限，桌面通知保持关闭');
    }
  }

  /** 试听提示音：用户手势里调用，确保浏览器允许发声 */
  function previewChime(): void {
    if (playUrgentChime()) message.success('这就是收到紧急消息时的提示音');
    else message.warning('当前浏览器不支持 / 暂时无法播放提示音');
  }

  // 每次打开都同步为已保存的值，避免上次未提交的编辑残留
  useEffect(() => {
    if (!open) return;
    setName(profile.name);
    setAvatarUrl(profile.avatarUrl);
  }, [open, profile]);

  function commitName() {
    const trimmed = name.trim();
    if (!trimmed) {
      message.warning('名称不能为空');
      setName(profile.name);
      return;
    }
    if (trimmed !== profile.name) {
      saveProfile({ ...profile, name: trimmed.slice(0, 24) });
    }
  }

  function handleFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      message.error('图片请小于 300KB（会存在浏览器本地）');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setAvatarUrl(url);
      saveProfile({ ...profile, name: name.trim() || profile.name, avatarUrl: url });
    };
    reader.onerror = () => message.error('读取图片失败，请重试');
    reader.readAsDataURL(file);
  }

  function handleResetAll() {
    resetProfile();
    resetPreferences();
    setName(DEFAULT_PROFILE.name);
    setAvatarUrl(null);
    message.success('已恢复默认设置');
  }

  const localBackendText = state.demoMode
    ? '演示模式（未接后端）'
    : state.error
      ? '连接异常'
      : state.connection === 'connected'
        ? '服务已连接'
        : state.connection === 'reconnecting'
          ? '重连中'
          : '未连接';
  const progress = state.onboarding?.overall;
  // 措辞用「平台」而不是「账号」：这里数的是平台连接的就绪数，与登录账号无关（评审 D3）
  const accountsReadyText = `平台 ${progress?.ready ?? 0}/${progress?.total ?? 4} 已就绪（不代表已连真实平台）`;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="设置"
      width={700}
      centered
      footer={null}
      className="settings-modal"
    >
      <Tabs
        className="settings-tabs"
        tabPosition="left"
        items={[
          {
            key: 'profile',
            label: (
              <span>
                <UserOutlined /> 个人资料
              </span>
            ),
            children: (
              <div className="set-pane">
                <div className="settings__avatar-row">
                  <div className="settings__avatar" style={{ background: profile.tone }}>
                    {avatarUrl ? <img src={avatarUrl} alt="头像预览" /> : <span>{initialOf(name)}</span>}
                  </div>
                  <div className="settings__avatar-actions">
                    <div className="settings__hint">JPG / PNG，小于 300KB；不传图片就用名字首字。</div>
                    <div className="settings__avatar-btns">
                      <Button icon={<PictureOutlined />} onClick={() => fileRef.current?.click()}>
                        上传
                      </Button>
                      {avatarUrl && (
                        <Button
                          icon={<DeleteOutlined />}
                          onClick={() => {
                            setAvatarUrl(null);
                            saveProfile({ ...profile, name: name.trim() || profile.name, avatarUrl: null });
                          }}
                        >
                          移除
                        </Button>
                      )}
                    </div>
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      handleFile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </div>

                <Row title="显示名称">
                  <Input
                    value={name}
                    maxLength={24}
                    style={{ width: 220 }}
                    placeholder="例如：张三"
                    onChange={(e) => setName(e.target.value)}
                    onBlur={commitName}
                    onPressEnter={commitName}
                  />
                </Row>

                <Row title="头像底色" description="不传图片时，头像用名字首字 + 这个底色。">
                  <div className="settings__tones">
                    {AVATAR_TONES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={`settings__tone${profile.tone === color ? ' is-active' : ''}`}
                        style={{ background: color }}
                        aria-label={`选择底色 ${color}`}
                        aria-pressed={profile.tone === color}
                        onClick={() => saveProfile({ ...profile, name: name.trim() || profile.name, tone: color })}
                      />
                    ))}
                  </div>
                </Row>
              </div>
            ),
          },
          {
            key: 'appearance',
            label: (
              <span>
                <BgColorsOutlined /> 外观
              </span>
            ),
            children: (
              <div className="set-pane">
                <Row title="主题" description="跟随系统时，系统切深浅色会同步变化。">
                  <Segmented
                    value={preference}
                    onChange={(value) => setPreference(value as ThemePreference)}
                    options={[
                      { label: '明色', value: 'light' },
                      { label: '暗色', value: 'dark' },
                      { label: '跟随系统', value: 'system' },
                    ]}
                  />
                </Row>
                <Row title="界面密度" description="紧凑会压缩列表与详情的留白，一屏看更多。">
                  <Segmented
                    value={prefs.density}
                    onChange={(value) => patchPreferences({ density: value as Density })}
                    options={[
                      { label: '舒适', value: 'comfortable' },
                      { label: '紧凑', value: 'compact' },
                    ]}
                  />
                </Row>
                <Row title="动效" description="减弱会关闭过渡与弹性动画。">
                  <Segmented
                    value={prefs.motion}
                    onChange={(value) => patchPreferences({ motion: value as MotionLevel })}
                    options={[
                      { label: '完整', value: 'full' },
                      { label: '减弱', value: 'reduced' },
                    ]}
                  />
                </Row>
                <div className="set-note">当前生效：{mode === 'dark' ? '暗色' : '明色'}</div>
              </div>
            ),
          },
          {
            key: 'message',
            label: (
              <span>
                <MessageOutlined /> 消息
              </span>
            ),
            children: (
              <div className="set-pane">
                <Row title="发送快捷键" description="在回复框里按什么键直接发送。">
                  <Segmented
                    value={prefs.sendKey}
                    onChange={(value) => patchPreferences({ sendKey: value as SendKey })}
                    options={[
                      { label: '⌘/Ctrl + Enter', value: 'mod-enter' },
                      { label: '仅 Enter', value: 'enter' },
                    ]}
                  />
                </Row>
                <Row title="显示 AI 建议" description="关闭后详情页不再出现建议卡片。">
                  <Switch
                    checked={prefs.showAiDraft}
                    onChange={(checked) => patchPreferences({ showAiDraft: checked })}
                  />
                </Row>

                <div className="set-section__title">紧急提醒</div>
                <Row
                  title="紧急提示音"
                  description="收到判定为「紧急」的入站消息时播放两声提示音；自己手动标的紧急不会再响。"
                >
                  <div className="settings__inline-actions">
                    <Button size="small" onClick={previewChime}>
                      试听
                    </Button>
                    <Switch
                      checked={prefs.urgentSound}
                      onChange={(checked) => patchPreferences({ urgentSound: checked })}
                      aria-label="紧急提示音"
                    />
                  </div>
                </Row>
                <Row
                  title="紧急桌面通知"
                  description="页面不在前台时弹系统通知，点击直达该会话；开启时浏览器会请求通知权限。"
                >
                  <Switch
                    checked={prefs.urgentDesktop}
                    onChange={(checked) => void toggleDesktopAlert(checked)}
                    aria-label="紧急桌面通知"
                  />
                </Row>
              </div>
            ),
          },
          {
            key: 'account',
            label: (
              <span>
                <LockOutlined /> 账号
              </span>
            ),
            children: (
              <div className="set-pane">
                {session ? (
                  <>
                    <div className="set-kv">
                      <div>
                        <span>当前账号</span>
                        <b>{session.user.displayName}</b>
                      </div>
                      <div>
                        <span>用户名</span>
                        <b className="mono">{session.user.username}</b>
                      </div>
                      <div>
                        <span>注册时间</span>
                        <b>{new Date(session.user.createdAt).toLocaleString('zh-CN')}</b>
                      </div>
                      <div>
                        <span>最近登录</span>
                        <b>
                          {session.user.lastLoginAt
                            ? new Date(session.user.lastLoginAt).toLocaleString('zh-CN')
                            : '本次为首次登录'}
                        </b>
                      </div>
                    </div>

                    <div className="set-section__title">数据归属</div>
                    <p className="set-hint">
                      登录后只看到归属你账号的消息。接入平台后新收的消息默认无主，
                      点下方按钮可把历史/无主消息收进你的收件箱（别人的不会被抢走）。
                    </p>
                    <Button loading={claiming} onClick={() => void handleClaim()} data-testid="account-claim">
                      认领无主的历史消息
                    </Button>

                    <div className="set-section__title">修改密码</div>
                    <p className="set-hint">
                      修改成功后，该账号的所有登录（含本机）都会失效，需要用新密码重新登录。
                    </p>
                    <div className="account-pwd">
                      <Input.Password
                        placeholder="原密码"
                        aria-label="原密码"
                        value={oldPassword}
                        onChange={(e) => setOldPassword(e.target.value)}
                        size="large"
                      />
                      <Input.Password
                        placeholder="新密码（至少 6 位）"
                        aria-label="新密码"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        size="large"
                      />
                      <Input.Password
                        placeholder="确认新密码"
                        aria-label="确认新密码"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        size="large"
                      />
                      <Button
                        type="primary"
                        loading={changingPassword}
                        disabled={!oldPassword || !newPassword || !confirmPassword}
                        onClick={() => void handleChangePassword()}
                        data-testid="account-change-password"
                      >
                        修改密码
                      </Button>
                    </div>

                    <div className="set-section__title">登录设备</div>
                    <Popconfirm
                      title="退出所有设备？"
                      description="该账号的全部登录都会失效，需要重新登录。"
                      okText="退出全部"
                      cancelText="取消"
                      onConfirm={() => void handleLogoutAll()}
                    >
                      <Button danger icon={<LogoutOutlined />} data-testid="account-logout-all">
                        退出所有设备
                      </Button>
                    </Popconfirm>
                  </>
                ) : (
                  <>
                    <p className="set-hint">
                      当前未登录（正在使用部署令牌，适合本机演示）。
                      登录后所有消息与发送记录都会归属到你的账号。
                    </p>
                    <Button type="primary" onClick={() => navigate('/login')}>
                      去登录 / 注册
                    </Button>
                  </>
                )}
              </div>
            ),
          },
          {
            key: 'about',
            label: (
              <span>
                <InfoCircleOutlined /> 关于
              </span>
            ),
            children: (
              <div className="set-pane">
                <div className="set-kv">
                  <div>
                    <span>版本</span>
                    <b>v{APP_VERSION}</b>
                  </div>
                  <div>
                    <span>前端构建</span>
                    <b className="mono">{BUILD_TIME}</b>
                  </div>
                  <div>
                    <span>接口地址</span>
                    <b className="mono">{API_BASE || '未配置（前端演示模式）'}</b>
                  </div>
                  <div>
                    <span>本地后端</span>
                    <b>{localBackendText}</b>
                  </div>
                  <div>
                    <span>账号</span>
                    <b>{accountsReadyText}</b>
                  </div>
                </div>

                <div className="set-actions">
                  <Popconfirm
                    title="清除本地数据"
                    description="会删除本机保存的个人资料与偏好，并重新加载页面。"
                    okText="清除"
                    cancelText="取消"
                    onConfirm={() => {
                      try {
                        ['linkhub-profile', 'linkhub-prefs'].forEach((k) =>
                          window.localStorage.removeItem(k),
                        );
                      } catch {
                        // 忽略
                      }
                      window.location.reload();
                    }}
                  >
                    <Button danger>清除本地数据</Button>
                  </Popconfirm>
                  <Button onClick={handleResetAll}>恢复默认设置</Button>
                  <Button
                    onClick={() => {
                      resetOnboardingTips();
                      onClose();
                      navigate('/inbox');
                      message.success('已重新打开首次使用引导');
                    }}
                  >
                    重新显示首次使用引导
                  </Button>
                </div>
              </div>
            ),
          },
        ]}
      />

      <div className="settings__footer">
        <span className="settings__hint">设置会立即生效，并保存在本机浏览器。</span>
        <Button className="settings__save" onClick={onClose}>
          完成
        </Button>
      </div>
    </Modal>
  );
}

