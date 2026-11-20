/**
 * IMAP / SMTP 共用的 STARTTLS 升级实现（零依赖，只用 node:tls / node:net）。
 *
 * 两个客户端各自的 upgradeStartTls 除 ALPN 协议名与超时错误文案外逐行相同，
 * 收敛到这里参数化注入；错误消息由调用方传入原文，保证文案逐字节不变。
 */
import net from 'node:net';
import tls from 'node:tls';

/** 与 imapClient / smtpClient 内部各自定义的 TIMEOUT_MS 一致：20s */
const TIMEOUT_MS = 20_000;

export interface UpgradeStartTlsOptions {
  /** ALPN 协议名（'imap' / 'smtp'） */
  alpn: string;
  /** 握手超时时抛出的完整错误消息（逐字节进入 Error.message，如 'IMAP STARTTLS 升级超时'） */
  timeoutLabel: string;
}

/** 在已连接的明文 socket 上升级 TLS（tls.connect({ socket })），握手成功才返回 */
export function upgradeStartTls(plain: net.Socket, servername: string, opts: UpgradeStartTlsOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: plain, servername, ALPNProtocols: [opts.alpn] });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error(opts.timeoutLabel));
    }, TIMEOUT_MS);
    const onError = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    secure.once('error', onError);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      secure.removeListener('error', onError);
      resolve(secure);
    });
  });
}
