/**
 * 飞书本人身份 OAuth 的共享流程（账号页 / 授权中心共用）。
 *
 * 为什么抽出来：OAuth 回跳反馈（P1-6）不是一句 toast，而是一整套状态：
 *  - 授权前落 pending 标记，并记住本次真实回调地址（桌面版端口随机，20029 高发）；
 *  - 同步开空白页，避免 await 后被浏览器当作弹窗拦截；
 *  - 被拦截时给可点击链接，而不是整页跳走；
 *  - 回到页面 / 重新载入时判定是否真的连上，未连上给中文原因与清单。
 * 两个页面复制这套逻辑必然走样，所以只留一份。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import { Platform } from '../../types';
import { store } from '../../store';
import {
  clearFeishuOAuthPending,
  defaultOAuthStorage,
  markFeishuOAuthPending,
  readFeishuOAuthPending,
  saveFeishuOAuthRedirectUri,
} from './feishuOAuthFeedback';

export interface FeishuOAuthController {
  connecting: boolean;
  /** 弹窗被拦截时的可点击授权 URL */
  fallbackUrl?: string;
  /** 本次授权实际使用的回调地址（后端下发；刷新丢失后为空，面板会展示兜底文案） */
  redirectUri?: string;
  /** 授权回跳后仍未连接（用于展示原因 + 配置清单） */
  unfinished: boolean;
  connect: () => Promise<void>;
  dismiss: () => void;
}

export function useFeishuOAuth(options: { onLinked?: () => void } = {}): FeishuOAuthController {
  const { message } = AntApp.useApp();
  const storage = useMemo(() => defaultOAuthStorage(), []);
  const [connecting, setConnecting] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string>();
  const [redirectUri, setRedirectUri] = useState<string>();
  const [unfinished, setUnfinished] = useState(false);
  const connectingRef = useRef(false);
  const onLinkedRef = useRef(options.onLinked);
  onLinkedRef.current = options.onLinked;

  /**
   * 授权回跳反馈：授权页在另一个标签，回到本页/页面重载时刷新账号；
   * 若仍是未连接，展示中文原因 + 配置清单（含本次真实回调地址）。
   */
  useEffect(() => {
    let timer: number | undefined;
    let alive = true;
    const pending = readFeishuOAuthPending(storage);
    if (pending) {
      setUnfinished(true);
      // 刷新 / 从授权中心切到账号页后仍能显示「该填哪个地址」，不退回兜底文案
      if (pending.redirectUri) setRedirectUri(pending.redirectUri);
    }

    const evaluateReturn = async (): Promise<void> => {
      if (!readFeishuOAuthPending(storage)) return;
      await store.refreshAccounts();
      if (!alive) return;
      const feishu = store.getSnapshot().accounts.find((a) => a.platform === Platform.FEISHU);
      if (feishu?.identity?.user.linked) {
        clearFeishuOAuthPending(storage);
        setUnfinished(false);
        setRedirectUri(undefined);
        message.success('飞书本人身份已连接');
        onLinkedRef.current?.();
      } else {
        setUnfinished(true);
      }
    };

    const onFocus = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void store.refreshAccounts();
        // 授权回调可能还在服务端落 token：稍等再判断一次，避免「刚成功却提示失败」
        void evaluateReturn();
      }, 250);
    };
    window.addEventListener('focus', onFocus);
    // 页面重载进入时也判断一次（同页跳转/刚拿到回调的情况）
    if (pending) timer = window.setTimeout(() => { void evaluateReturn(); }, 800);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [message, storage]);

  const connect = async (): Promise<void> => {
    // state 更新是异步的，同 tick 连点会绕过 connecting；用 ref 同步拦截
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setFallbackUrl(undefined);
    // 在授权前落 pending 标记：回来若仍未连接，就能给出失败反馈
    markFeishuOAuthPending(storage);
    // 必须在 await 之前同步开空白页，否则会被浏览器当作弹窗拦截
    const tab = window.open('about:blank', '_blank');
    if (tab) {
      try { tab.opener = null; } catch { /* 跨域前设置失败不影响授权 */ }
    }
    try {
      const { url, redirectUri: startedRedirectUri } = await store.feishuOAuthStart();
      // 20029 自解释的关键：记住本次真实回调地址（桌面版端口 3901–3930 与飞书后台登记的不一致）
      if (startedRedirectUri) {
        setRedirectUri(startedRedirectUri);
        saveFeishuOAuthRedirectUri(storage, startedRedirectUri);
      }
      if (tab) {
        tab.location.href = url;
      } else {
        // 弹窗被拦截：绝不整页跳走（会丢失上下文，失败回来也没有提示）；
        // 改为展示可点击链接 + 可复制 URL，用户点一下仍在浏览器手势内，能正常打开。
        setFallbackUrl(url);
        message.warning('浏览器拦截了飞书授权窗口，请点页面上的「打开飞书授权页」继续');
      }
    } catch (e) {
      tab?.close();
      clearFeishuOAuthPending(storage);
      message.error(e instanceof Error ? e.message : '获取飞书授权地址失败');
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  };

  const dismiss = (): void => {
    clearFeishuOAuthPending(storage);
    setUnfinished(false);
    setFallbackUrl(undefined);
    setRedirectUri(undefined);
  };

  return { connecting, fallbackUrl, redirectUri, unfinished, connect, dismiss };
}
