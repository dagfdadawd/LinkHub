/**
 * 极简 MIME 解析（RFC 822 / 2045）。
 *
 * 邮箱没有 Webhook，只能自己把原始报文取回来解析，所以这里不引第三方库：
 * 头部折叠、encoded-word 中文主题、multipart 分段、base64/quoted-printable
 * 与 GBK 字符集都在这一层收敛成 { from, subject, text }。
 */

import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

/** 出站附件：内容已是 base64（由统一入口的 OutboundAttachment 直接透传，不落盘） */
export interface MailAttachment {
  name: string;
  mimeType: string;
  contentBase64: string;
}

/** 解码 =?UTF-8?B?...?= / =?GBK?Q?...?= 形式的头部字段 */
export function decodeWords(input: string): string {
  return input.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=([ \t]*\r?\n?[ \t]*)?/g,
    (_m, charset: string, enc: string, data: string, gap: string) => {
      const text = decodeOne(charset, enc.toUpperCase(), data);
      // encoded-word 之间的空白是分隔符，不该丢
      return text + (gap && gap.trim() === '' ? ' ' : '');
    },
  );
}

function decodeOne(charset: string, enc: string, data: string): string {
  let bytes: Buffer;
  if (enc === 'B') {
    bytes = Buffer.from(data.replace(/[\r\n\s]/g, ''), 'base64');
  } else {
    bytes = Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'binary');
  }
  return decodeBytes(bytes, charset);
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const cs = (charset || 'utf-8').toLowerCase().replace(/_/g, '-');
  if (cs === 'utf-8' || cs === 'us-ascii' || cs === 'ascii') return bytes.toString('utf8');
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    try {
      return new TextDecoder(cs === 'gb2312' ? 'gbk' : 'utf-8').decode(bytes);
    } catch {
      return bytes.toString('utf8');
    }
  }
}

export interface MailHeaders {
  [name: string]: string; // 同名多行以 ", " 连接
}

export interface RawMail {
  headers: MailHeaders;
  body: Buffer;
}

/** 原始报文 → 头部 + 体（头部按 latin1 读，避免中文 encoded-word 被破坏） */
export function parseMail(raw: Buffer | string): RawMail {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'binary');
  const nl = buf.indexOf('\r\n\r\n');
  const lfOnly = buf.indexOf('\n\n');
  let split = nl;
  if (nl === -1) split = lfOnly;
  else if (lfOnly !== -1 && lfOnly < nl) split = lfOnly;
  if (split === -1) return { headers: {}, body: buf };

  const head = buf.subarray(0, split).toString('latin1');
  const body = buf.subarray(split + (nl !== -1 && split === nl ? 4 : 2));

  const headers: MailHeaders = {};
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { headers, body };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseParam(header: string | undefined, key: string): string {
  if (!header) return '';
  const m = header.match(new RegExp(`${escapeRegExp(key)}=("[^"]*"|[^;\\s]*)`, 'i'));
  if (!m) return '';
  return m[1].replace(/^"|"$/g, '');
}

/** Content-Disposition 的类型（attachment / inline）：只看首个分号前的 token，避免 filename 里带 attachment 被误判 */
function dispositionType(header: string | undefined): string {
  return (header ?? '').split(';')[0].trim().toLowerCase();
}

/** base64 / quoted-printable / 7bit-8bit → 文本 */
function transferDecode(body: Buffer, encoding: string, charset: string): string {
  const enc = (encoding || '7bit').toLowerCase().replace(/[\s_-]/g, '');
  if (enc === 'base64') {
    // 先按 ASCII 取出报文里的 base64 文本，去掉换行空白，再解一次
    const cleaned = body.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
    return decodeBytes(Buffer.from(cleaned, 'base64'), charset);
  }
  if (enc === 'quotedprintable') {
    const soft = body.toString('binary').replace(/=\r?\n/g, '');
    return decodeBytes(Buffer.from(soft.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'binary'), charset);
  }
  return decodeBytes(body, charset);
}

/** 递归深度上限：防御恶意构造的超深嵌套 multipart */
const MAX_MIME_DEPTH = 20;

interface BodySearch {
  plain: string;
  html: string;
  attachments: string[];
  /** 附件元数据（与 attachments 同序）：入库时挂到消息上的真实体积与类型（评审 P0-4） */
  meta: Array<{ name: string; size: number; mimeType: string }>;
}

/** 附件字节解码：base64 / quoted-printable → Buffer（附件是二进制，不做字符集转换） */
function attachmentBytes(part: RawMail): Buffer {
  const enc = (part.headers['content-transfer-encoding'] ?? '7bit').toLowerCase().replace(/[\s_-]/g, '');
  if (enc === 'base64') {
    const cleaned = part.body.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(cleaned, 'base64');
  }
  if (enc === 'quotedprintable') {
    const soft = part.body.toString('binary').replace(/=\r?\n/g, '');
    return Buffer.from(soft.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'binary');
  }
  return part.body;
}

/** 附件名：优先 Content-Disposition 的 filename，退化到 Content-Type 的 name */
function attachmentName(part: RawMail): string {
  const cd = part.headers['content-disposition'] ?? '';
  const ct = part.headers['content-type'] ?? '';
  const raw = parseParam(cd, 'filename*')
    || parseParam(cd, 'filename')
    || parseParam(ct, 'name*')
    || parseParam(ct, 'name');
  return raw ? decodeParamValue(raw) : '';
}

/** 还原 RFC 2231 的 filename*=charset'lang'%XX 与 encoded-word 文件名 */
function decodeParamValue(raw: string): string {
  const rfc2231 = raw.match(/^([^']*)'[^']*'(.*)$/);
  if (rfc2231) {
    const bytes = Buffer.from(
      rfc2231[2].replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
      'binary',
    );
    return decodeBytes(bytes, rfc2231[1] || 'utf-8').trim();
  }
  return decodeWords(raw).trim();
}

/**
 * 按 MIME boundary 切分 multipart 体：
 *  - 只认「行首的 --boundary（可跟 -- 结束标记）+ 行尾」，天然跳过 preamble/epilogue；
 *  - 用「行尾匹配」而不是裸字符串 split，避免外层 boundary 前缀撞上内层 boundary
 *    （如 outer=abc、inner=abcd 时 `--abcd` 不能被外层切断）。
 */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('binary');
  const delimiter = new RegExp(`--${escapeRegExp(boundary)}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');
  const parts: Buffer[] = [];
  let start = -1;
  for (let m = delimiter.exec(text); m !== null; m = delimiter.exec(text)) {
    if (start >= 0) {
      // 上一个 boundary 行之后、本 boundary 行之前即 part 原文；去掉紧贴 boundary 的那个换行
      const chunk = text.slice(start, m.index).replace(/\r?\n$/, '');
      if (chunk.length > 0) parts.push(Buffer.from(chunk, 'binary'));
    }
    if (m[1]) break; // 结束 boundary，后面是 epilogue，直接丢弃
    start = m.index + m[0].length;
  }
  return parts;
}

/**
 * 深度优先遍历 MIME 树，把正文/附件名收集到 found：
 *  - `Content-Disposition: attachment` 的 part 整段跳过（附件里也可能嵌 multipart，绝不能当正文）；
 *  - 正文全局优先级 text/plain > text/html（html 去标签兜底），任一层找到非空正文即采用；
 *  - 只有确认完全没有正文时，附件名才用于 `[附件] a, b` 摘要。
 */
function walkPart(part: RawMail, found: BodySearch, depth: number): void {
  if (depth > MAX_MIME_DEPTH) return;
  const ct = part.headers['content-type'] ?? '';
  const encoding = part.headers['content-transfer-encoding'] ?? '';

  if (dispositionType(part.headers['content-disposition']) === 'attachment') {
    const name = attachmentName(part) || '未命名';
    found.attachments.push(name);
    found.meta.push({
      name,
      size: attachmentBytes(part).length,
      mimeType: ct.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream',
    });
    return;
  }

  if (/multipart\//i.test(ct)) {
    const boundary = parseParam(ct, 'boundary');
    if (!boundary) {
      // 畸形 multipart（缺 boundary）：沿用旧行为把整段当文本兜底，总比正文静默丢失好
      if (!found.plain) {
        const fallback = transferDecode(part.body, encoding, parseParam(ct, 'charset') || 'utf-8');
        if (fallback.trim()) found.plain = fallback;
      }
      return;
    }
    for (const child of splitMultipart(part.body, boundary)) walkPart(parseMail(child), found, depth + 1);
    return;
  }

  const charset = parseParam(ct, 'charset') || 'utf-8';
  // 无 Content-Type 的 part 按 RFC 2045 默认 text/plain
  if (!ct || /text\/plain/i.test(ct)) {
    if (!found.plain) {
      const text = transferDecode(part.body, encoding, charset);
      if (text.trim()) found.plain = text;
    }
    return;
  }
  if (/text\/html/i.test(ct)) {
    if (!found.html) {
      const html = transferDecode(part.body, encoding, charset);
      if (html.trim()) found.html = htmlToText(html);
    }
    return;
  }
  // 非文本 part：有文件名（name=）视为附件；无名字的多是内联图片等资源，忽略
  const name = attachmentName(part);
  if (name) {
    found.attachments.push(name);
    found.meta.push({
      name,
      size: attachmentBytes(part).length,
      mimeType: ct.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream',
    });
    return;
  }
  // 顶层非文本（历史上直接按文本兜底）：保持兼容，别让老报文突然变空
  if (depth === 0 && !found.plain) {
    const fallback = transferDecode(part.body, encoding, charset);
    if (fallback.trim()) found.plain = fallback;
  }
}

/** 附件元数据：入库时挂在消息附件上的真实体积与类型（下载按钮与体积展示用） */
export interface MailAttachmentMeta {
  name: string;
  size: number;
  mimeType: string;
}

/** 邮件正文 + 附件名：递归解析整棵 MIME 树（multipart/mixed 里嵌 multipart/alternative 也能出正文） */
export function extractMail(mail: RawMail): {
  text: string;
  attachments: string[];
  /** 有附件时才带：附件的真实字节体积与 MIME（评审 P0-4，旧调用方零感知） */
  attachmentMeta?: MailAttachmentMeta[];
} {
  const found: BodySearch = { plain: '', html: '', attachments: [], meta: [] };
  walkPart(mail, found, 0);
  const text = found.plain.trim() ? found.plain : found.html;
  const meta = found.meta.length > 0 ? found.meta : undefined;
  if (text.trim()) return { text, attachments: found.attachments, attachmentMeta: meta };
  // 确认没有任何正文，才退化成附件名摘要
  return {
    text: found.attachments.length > 0 ? `[附件] ${found.attachments.join(', ')}` : '',
    attachments: found.attachments,
    attachmentMeta: meta,
  };
}

/** 按文件名从原始报文里解出附件字节（大小写不敏感；邮件附件下载的唯一入口） */
export function extractAttachment(raw: Buffer | string, name: string): MailAttachmentMeta & { buffer: Buffer } | undefined {
  const target = name.trim().toLowerCase();
  if (!target) return undefined;
  let hit: (MailAttachmentMeta & { buffer: Buffer }) | undefined;
  const visit = (part: RawMail, depth: number): void => {
    if (hit || depth > MAX_MIME_DEPTH) return;
    const ct = part.headers['content-type'] ?? '';
    if (/multipart\//i.test(ct)) {
      const boundary = parseParam(ct, 'boundary');
      if (boundary) for (const child of splitMultipart(part.body, boundary)) visit(parseMail(child), depth + 1);
      return;
    }
    const partName = attachmentName(part);
    if (!partName || partName.toLowerCase() !== target) return;
    const mimeType = ct.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
    const buffer = attachmentBytes(part);
    hit = { name: partName, mimeType: mimeType || 'application/octet-stream', size: buffer.length, buffer };
  };
  visit(parseMail(raw), 0);
  return hit;
}

/** 邮件正文：优先 text/plain，退化到 text/html 去标签 */
export function extractText(mail: RawMail): string {
  return extractMail(mail).text;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, CRLF + CRLF)
    .trim();
}

/** 解析 "名字 <a@b.com>"，并解码 encoded-word */
export function parseAddress(header: string | undefined): { name: string; address: string } {
  const raw = decodeWords(header ?? '').trim();
  const m = raw.match(/^(.*?)<([^>]+)>/);
  if (m) {
    return { name: m[1].trim().replace(/^"|"$/g, '').trim(), address: m[2].trim().toLowerCase() };
  }
  return { name: '', address: raw.replace(/^"|"$/g, '').trim().toLowerCase() };
}

export interface ParsedMessage {
  messageId: string;
  inReplyTo: string;
  subject: string;
  date: string;
  from: { name: string; address: string };
  to: string;
  text: string;
  /** 附件文件名（只在确实解析到附件时出现；正文摘要仍走 text，不破坏原有字段语义） */
  attachments?: string[];
  /** 附件元数据（真实体积 / MIME / 与 attachments 同序）；入库时映射为消息附件（评审 P0-4） */
  attachmentMeta?: MailAttachmentMeta[];
}

/** 原始报文 → 结构化邮件（连接器 receive 的输入） */
export function readMessage(raw: Buffer | string): ParsedMessage {
  const mail = parseMail(raw);
  const extracted = extractMail(mail);
  const parsed: ParsedMessage = {
    messageId: (mail.headers['message-id'] ?? '').replace(/^<|>$/g, ''),
    inReplyTo: (mail.headers['in-reply-to'] ?? '').replace(/^<|>$/g, ''),
    subject: decodeWords(mail.headers['subject'] ?? '').trim(),
    date: mail.headers['date'] ?? '',
    from: parseAddress(mail.headers['from']),
    to: mail.headers['to'] ?? '',
    text: extracted.text.replace(/\r\n/g, '\n').trim(),
  };
  if (extracted.attachments.length > 0) parsed.attachments = extracted.attachments;
  return parsed;
}

/** base64 按 RFC 2045 折行（每行 76 字符），末尾不留多余 CRLF */
function foldBase64(text: string): string {
  return text.replace(/(.{76})/g, `$1${CRLF}`).replace(/\r\n$/, '');
}

/**
 * 回写报文：主题自动加 Re:，头部带 In-Reply-To 以便原会话串联。
 *
 * 无附件时保持原来的 text/plain 单 part 结构（字节级兼容既有单测与 SMTP 服务器）；
 * 有附件时升级为 multipart/mixed：第一个 part 是正文，其后每个附件一个 part，
 * 文件名走 RFC 2047 encoded-word，中文名在邮件客户端里也能正常显示。
 */
export function buildMail(
  from: string,
  to: string,
  subject: string,
  text: string,
  opts: { inReplyTo?: string; messageId: string; attachments?: MailAttachment[] },
): string {
  const subj = subject.startsWith('Re:') ? subject : `Re: ${subject || '(无主题)'}`;
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subj)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${opts.messageId}>`,
  ];
  if (opts.inReplyTo) head.push(`In-Reply-To: <${opts.inReplyTo}>`);

  const encoded = foldBase64(Buffer.from(text.replace(/\r?\n/g, CRLF), 'utf8').toString('base64'));

  if (!opts.attachments || opts.attachments.length === 0) {
    head.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    // 头部与正文之间必须留一个空行，结尾单独一行的 . 表示 DATA 结束
    return `${head.join(CRLF)}${CRLF}${CRLF}${encoded}${CRLF}.${CRLF}`;
  }

  const boundary = `----=_LinkHub_${randomUUID().replace(/-/g, '')}`;
  head.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [];
  parts.push([
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encoded,
  ].join(CRLF));

  for (const a of opts.attachments) {
    const safeName = a.name.replace(/["\r\n]/g, '_');
    parts.push([
      `--${boundary}`,
      `Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${encodeHeader(safeName)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeader(safeName)}"`,
      '',
      foldBase64(a.contentBase64),
    ].join(CRLF));
  }
  parts.push(`--${boundary}--`);

  return `${head.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}${CRLF}.${CRLF}`;
}

/** 主题里的中文用 encoded-word，纯 ASCII 原样 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
