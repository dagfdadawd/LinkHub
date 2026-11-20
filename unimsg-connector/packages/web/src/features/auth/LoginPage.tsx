/**
 * 登录 / 注册页。
 *
 * 这是「用户怎么成为你的用户」的入口：注册即建账号并直接登录；
 * 登录拿到会话令牌后，后续所有请求以该用户身份发出（顶栏会显示当前账号）。
 *
 * 刻意保持极简：不收集邮箱/手机号，不需要验证码——比赛要求的闭环是
 * 「注册 → 配置平台 → 看消息 → 发送 → 状态回流」，账号只承担"我是谁"。
 *
 * 若干容易踩坑的细节在这里兜住：
 *  - 恢复码只显示一次，写进 sessionStorage，刷新页面不会永久丢失；
 *  - 重置密码会作废全部会话，所以"我已保存"之后回登录页，而不是假装已登录进收件箱；
 *  - 后端已要求登录（本机已有账号）时，已登录用户访问 /login 直接回收件箱；
 *  - 注册策略由后端下发：本机已有账号且没配邀请码时，注册入口置灰并说明原因。
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Form, Input } from 'antd';
import {
  ArrowRightOutlined,
  IdcardOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LockOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { services, store } from '../../store';
import { setSession, useSession } from '../../services/session';
import type { AuthStatus } from '../../services/api';

type Mode = 'login' | 'register' | 'reset';

interface PendingRecovery {
  code: string;
  username: string;
  /** register = 注册后仍处于登录态；reset = 密码已重置、必须重新登录 */
  kind: 'register' | 'reset';
}

const RECOVERY_KEY = 'linkhub.pending-recovery';

function readPendingRecovery(): PendingRecovery | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRecovery>;
    if (!parsed?.code || !parsed?.username) return null;
    return { code: parsed.code, username: parsed.username, kind: parsed.kind === 'reset' ? 'reset' : 'register' };
  } catch {
    return null;
  }
}

function writePendingRecovery(next: PendingRecovery | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (next) window.sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(RECOVERY_KEY);
  } catch {
    // 隐私模式 / 存储禁用：仅本次内存状态生效
  }
}

export function LoginPage() {
  const { message: toast } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const [form] = Form.useForm();
  const [mode, setMode] = useState<Mode>('login');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  /**
   * 登录失败时让输入框摇一下（阻尼振荡，像被推了一把后收住）。
   *
   * 用布尔量 + animationend 复位，而不是把动画名写进 className 再靠 key 重挂载：
   * 重挂载会让输入框失焦，用户刚敲的内容虽然还在值里，光标却没了。
   */
  /** 换一张表单：顺手把上一次的错误抹掉（不抹的话切过去还挂着红框） */
  const goMode = (next: Mode) => {
    setError(undefined);
    setMode(next);
  };

  const [shaking, setShaking] = useState(false);
  const shakeFrame = useRef<number>();
  const [status, setStatus] = useState<AuthStatus>();
  /** 注册/重置成功后必须先看到恢复码（只显示这一次），点「已保存」才继续 */
  const [recovery, setRecovery] = useState<PendingRecovery | null>(() => readPendingRecovery());

  /**
   * 「添加账号」模式（/login?add=1）：
   * 已经登录着别的账号时，登录页不能自动把人踢回收件箱——
   * 这里是「再登一个」，成功后并进账号列表，侧栏随时切回来。
   */
  const addMode = new URLSearchParams(location.search).get('add') === '1';
  const from = (location.state as { from?: string } | null)?.from ?? '/inbox';
  const prefillUsername = (location.state as { username?: string } | null)?.username;
  const registration = status?.registration;
  const registrationOpen = registration ? registration.open : true;
  const needsInviteCode = registration?.requireCode === true;

  // 注册策略（是否还开放、要不要邀请码）；拿不到就按"开放"处理，保持零账号演示可用
  useEffect(() => {
    let alive = true;
    const api = services.api as { authStatus?: () => Promise<AuthStatus> };
    if (typeof api.authStatus !== 'function') return undefined;
    api
      .authStatus()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 已经是登录态又访问 /login：直接回收件箱（除非正停在恢复码页）
  // 注意要排除"正在提交"：注册成功会先 setSession，若此时立刻跳走，恢复码页就被跳过了。
  useEffect(() => {
    if (session && !recovery && !submitting && !addMode) navigate('/inbox', { replace: true });
  }, [session, recovery, submitting, addMode, navigate]);

  // 重置密码后回到登录页时带上用户名，少敲一次
  useEffect(() => {
    if (prefillUsername) form.setFieldsValue({ username: prefillUsername });
  }, [prefillUsername, form]);

  /**
   * 触发一次摇动。
   *
   * 先摘掉再加回：同名 animation 直接重设 className 不会重播，
   * 隔一帧再做一次「移除 → 添加」，连续失败才能每次都摇起来。
   */
  function triggerShake(): void {
    setShaking(false);
    if (shakeFrame.current) cancelAnimationFrame(shakeFrame.current);
    shakeFrame.current = requestAnimationFrame(() => setShaking(true));
  }

  useEffect(
    () => () => {
      if (shakeFrame.current) cancelAnimationFrame(shakeFrame.current);
    },
    [],
  );

  async function handleSubmit(values: {
    username: string;
    password: string;
    displayName?: string;
    confirmPassword?: string;
    recoveryCode?: string;
    signupCode?: string;
  }) {
    setError(undefined);
    if (mode !== 'login' && values.password !== values.confirmPassword) {
      setError('两次输入的密码不一致');
      triggerShake();
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'reset') {
        const result = await services.api.resetPassword({
          username: values.username,
          recoveryCode: values.recoveryCode ?? '',
          newPassword: values.password,
        });
        toast.success('密码已重置，请用新密码登录');
        if (result.recoveryCode) {
          const pending: PendingRecovery = {
            code: result.recoveryCode,
            username: values.username,
            kind: 'reset',
          };
          writePendingRecovery(pending);
          setRecovery(pending);
        }
        setMode('login');
        return;
      }

      if (mode === 'register') {
        const result = await services.api.register({
          username: values.username,
          password: values.password,
          displayName: values.displayName,
          ...(values.signupCode ? { signupCode: values.signupCode } : {}),
        });
        setSession({ token: result.token, user: result.user });
        // 实时通道由 AuthGate 在认证放行后统一重连，这里不重复握手
        void store.refresh?.();
        // 不立刻跳转：先让用户把恢复码抄下来
        const pending: PendingRecovery = { code: result.recoveryCode, username: result.user.username, kind: 'register' };
        writePendingRecovery(pending);
        setRecovery(pending);
        return;
      }

      const result = await services.api.login({ username: values.username, password: values.password });
      setSession({ token: result.token, user: result.user });
      // 换令牌后由 AuthGate 统一重连实时通道；这里只重拉一次数据
      void store.refresh?.();
      toast.success(`欢迎回来，${result.user.displayName}`);
      navigate(from, { replace: true });
    } catch (e) {
      const text = e instanceof Error ? e.message : '操作失败，请稍后重试';
      setError(text);
      triggerShake();
    } finally {
      setSubmitting(false);
    }
  }

  // 恢复码展示：注册 / 重置密码后各出现一次
  if (recovery) {
    const isReset = recovery.kind === 'reset';
    return (
      <div className="auth-page">
        <div className="auth-card auth-card--recovery">
          <div className="auth-brand">
            <span className="auth-brand__dot" aria-hidden="true" />
            <span className="auth-brand__name">LinkHub</span>
          </div>
          <header className="auth-head">
            <h1 className="auth-title">请保存恢复码</h1>
            <p className="auth-sub">
              忘记密码时用它可以重置。这串码 <b>只显示这一次</b>，服务端只存哈希，丢了只能改密码。
            </p>
          </header>
          <div className="auth-recovery" data-testid="recovery-code">
            {recovery.code}
          </div>
          <dl className="auth-meta">
            <div>
              <dt>账号</dt>
              <dd>{recovery.username}</dd>
            </div>
            <div>
              <dt>存放</dt>
              <dd>这串码暂存在本浏览器，点下面的按钮后会清除</dd>
            </div>
          </dl>
          <Button
            type="primary"
            size="large"
            block
            className="auth-submit"
            onClick={() => {
              writePendingRecovery(null);
              setRecovery(null);
              if (isReset) {
                toast.success('密码已重置，请用新密码登录');
                navigate('/login', { replace: true, state: { username: recovery.username } });
                return;
              }
              toast.success('账号已就绪');
              navigate('/inbox', { replace: true });
            }}
          >
            <span>{isReset ? '我已保存，返回登录' : '我已保存，进入收件箱'}</span>
            <ArrowRightOutlined />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand__dot" aria-hidden="true" />
          <span className="auth-brand__name">LinkHub</span>
        </div>

        <header className="auth-head">
          <h1 className="auth-title">
            {mode === 'login' ? '登录' : mode === 'register' ? '创建账号' : '重置密码'}
          </h1>
          <p className="auth-sub">
            {mode === 'login'
              ? addMode
                ? '再登一个账号，之后在侧栏账号菜单里一点就切'
                : '用你的账号登录，继续处理多平台消息'
              : mode === 'register'
                ? '注册后即可统一收发飞书、钉钉、邮箱的消息'
                : '用注册时保存的恢复码重置密码，不需要旧密码'}
          </p>
        </header>

        <div
          className="auth-tabs"
          role="tablist"
          aria-label="登录或注册"
          data-active={mode === 'reset' ? 'none' : mode}
        >
          {/* 滑动高光：切换时用带一点回弹的曲线从一侧「果冻」到另一侧 */}
          <span className="auth-tabs__thumb" aria-hidden="true" />
          {(['login', 'register'] as Mode[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              className={`auth-tab${mode === key ? ' is-active' : ''}`}
              onClick={() => goMode(key)}
            >
              {key === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          requiredMark={false}
          className={`auth-form${error ? ' is-invalid' : ''}${shaking ? ' is-shaking' : ''}`}
          /* 一开始改动就撤掉红框与提示：错误已经看过了，再挂着只会让人以为改坏了 */
          onValuesChange={() => setError(undefined)}
          onAnimationEnd={(e) => {
            if (e.animationName === 'auth-shake') setShaking(false);
          }}
        >
          {/* 字段区与按钮分开：字段区吃掉卡片多余高度，登录/注册切换时按钮不会挪位置 */}
          <div className="auth-fields">
            {/* 四个字段各占一行：卡只有 440px 宽，分成两列后标签和输入框都显得挤；
                一行一个之后纵向节奏好控，输入框也能整体矮一档 */}
            <Form.Item
              name="username"
              label={
                <span className="auth-label">
                  <UserOutlined aria-hidden="true" />
                  用户名
                </span>
              }
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input placeholder="2-32 位，支持中英文" autoComplete="username" size="large" />
            </Form.Item>

            {mode === 'register' && (
              <Form.Item
                name="displayName"
                label={
                  /* 这一栏也有图标：四个字段竖排后标签左边对齐成一条线，
                     只有「显示名」没有图标会显得凹进去一格 */
                  <span className="auth-label">
                    <IdcardOutlined aria-hidden="true" />
                    显示名（可选）
                  </span>
                }
              >
                <Input placeholder="展示在顶栏的名字" size="large" maxLength={32} />
              </Form.Item>
            )}

            {mode === 'register' && needsInviteCode && (
              <Form.Item
                name="signupCode"
                label={
                  <span className="auth-label">
                    <KeyOutlined aria-hidden="true" />
                    邀请码
                  </span>
                }
                rules={[{ required: true, message: '本机已开启邀请制，请输入邀请码' }]}
              >
                <Input placeholder="向机器主人索取邀请码" size="large" autoComplete="off" />
              </Form.Item>
            )}

            {mode === 'reset' && (
              <Form.Item
                name="recoveryCode"
                label={
                  <span className="auth-label">
                    <KeyOutlined aria-hidden="true" />
                    恢复码
                  </span>
                }
                rules={[{ required: true, message: '请输入注册时保存的恢复码' }]}
              >
                <Input placeholder="形如 A1B2-C3D4-E5F6" size="large" autoComplete="off" />
              </Form.Item>
            )}

            <Form.Item
              name="password"
              label={
                <span className="auth-label">
                  <LockOutlined aria-hidden="true" />
                  {mode === 'reset' ? '新密码' : '密码'}
                </span>
              }
              rules={[
                { required: true, message: '请输入密码' },
                ...(mode === 'login' ? [] : [{ min: 6, message: '密码至少 6 位' }]),
              ]}
            >
              <Input.Password
                placeholder={mode === 'login' ? '请输入密码' : '至少 6 位'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                size="large"
              />
            </Form.Item>

            {mode !== 'login' && (
              <Form.Item
                name="confirmPassword"
                label={
                  <span className="auth-label">
                    <LockOutlined aria-hidden="true" />
                    {mode === 'reset' ? '确认新密码' : '确认密码'}
                  </span>
                }
                rules={[{ required: true, message: '请再输入一次密码' }]}
              >
                <Input.Password placeholder="再输入一次" autoComplete="new-password" size="large" />
              </Form.Item>
            )}
          </div>

          {/* 提示槽常驻：高度写死，错误与「注册已关闭 / 需要邀请码」共用这一格。
              提示出现只是槽内淡入，不新增高度，所以整页一帧都不会被挤压；
              两种模式的槽高一样，切 Tab 时按钮也不挪位。 */}
          <div className="auth-slot" aria-live="polite">
            {error ? (
              <p className="auth-error" role="alert" title={error}>
                {error}
              </p>
            ) : mode === 'register' && (needsInviteCode || !registrationOpen) ? (
              <p className="auth-hint" title={registration?.reason}>
                <InfoCircleOutlined aria-hidden="true" />
                <span>
                  {needsInviteCode
                    ? '本机已开启邀请制：注册需要机器主人提供的邀请码。'
                    : (registration?.reason ??
                      '请让机器主人在设置里开启自助注册，或配置 AUTH_SIGNUP_CODE 后重启 LinkHub。')}
                </span>
              </p>
            ) : null}
          </div>

          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={submitting}
            disabled={mode === 'register' && !registrationOpen}
            className="auth-submit"
            data-testid="auth-submit"
          >
            <span>{mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '重置密码'}</span>
            <ArrowRightOutlined />
          </Button>
        </Form>

        {/* 底部链接行常驻：注册页没有内容也占位，否则两种模式的表单高度差一行，按钮会上下跳 */}
        <div className="auth-links">
          {addMode && session && (
            <>
              <span className="auth-links__hint">
                当前是 {session.user.displayName}，新账号会加进同一个窗口
              </span>
              <span className="auth-links__sep" aria-hidden="true" />
              <button type="button" className="auth-link" onClick={() => navigate('/inbox')}>
                取消
              </button>
            </>
          )}
          {mode === 'login' && !addMode && (
            <>
              <span className="auth-links__hint">忘记密码？</span>
              <span className="auth-links__sep" aria-hidden="true" />
              <button
                type="button"
                className="auth-link"
                onClick={() => goMode('reset')}
              >
                用恢复码重置
              </button>
            </>
          )}
          {mode === 'reset' && (
            <button
              type="button"
              className="auth-link"
              onClick={() => goMode('login')}
            >
              返回登录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}