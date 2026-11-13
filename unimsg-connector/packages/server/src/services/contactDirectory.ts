/**
 * 通讯录 / 会话名录：给「发送给」选择器和会话标题提供**可读名字**。
 *
 * 现状（已实测）：
 *  - 飞书：本人 user_access_token 的 `im/v1/chats` 能拿到会话名，**单聊也有名字**
 *    （例如「郑友佳（测试用」），不需要额外权限；联系人搜索接口则需要
 *    contact:user.base:readonly，当前应用没开。
 *  - 钉钉：dws `contact user search` 可搜人（走本人登录态，不需要应用凭据）；
 *    会话名在个人事件里自带。
 *  - 企微：当前是 mock，不提供名录。
 *
 * 所以这里只做「会话名录」：飞书真实可用；其它平台返回 available=false + 原因，
 * 前端据此说明「为什么只能选已有会话」，而不是假装有通讯录。
 */
import { Platform } from '@unimsg/shared';
import { feishuUserAuth } from '../connectors/feishuUserAuth';
import { fetchUserChats } from '../connectors/feishuUserReceive';

export interface DirectoryEntry {
  /** 会话 ID（发送目标） */
  id: string;
  name: string;
  type: 'p2p' | 'group';
}

export interface DirectoryResult {
  platform: Platform;
  /** 本平台能不能提供名录 */
  available: boolean;
  /** 不可用时的中文原因（给用户看） */
  reason?: string;
  items: DirectoryEntry[];
  /** 名单来源：本人会话列表 / 平台通讯录 */
  source?: string;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; result: DirectoryResult }>();

function unavailable(platform: Platform, reason: string): DirectoryResult {
  return { platform, available: false, reason, items: [] };
}

async function listFeishu(): Promise<DirectoryResult> {
  try {
    const token = await feishuUserAuth().accessToken();
    const res = await fetchUserChats(token, { pageSize: 100, maxChats: 200 });
    const items: DirectoryEntry[] = res.chats
      .filter((c) => Boolean(c.chatId))
      .map((c) => ({
        id: c.chatId,
        name: (c.name ?? '').trim() || c.chatId,
        type: c.chatMode === 'p2p' ? 'p2p' : 'group',
      }));
    return {
      platform: Platform.FEISHU,
      available: true,
      items,
      source: '飞书本人账号可见的会话（含单聊与群聊）',
    };
  } catch (e) {
    return unavailable(
      Platform.FEISHU,
      `飞书会话名录不可用：${e instanceof Error ? e.message : String(e)}。`
        + '需要先在「平台账号」页完成飞书本人账号授权。',
    );
  }
}

/** 列出某平台可用于「发送给」的目标（带缓存，避免每次开弹窗都打平台接口） */
export async function listDirectory(platform: Platform): Promise<DirectoryResult> {
  const hit = cache.get(platform);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  let result: DirectoryResult;
  if (platform === Platform.FEISHU) {
    result = await listFeishu();
  } else if (platform === Platform.DINGTALK) {
    // 钉钉个人事件自带会话名，会话目标仍以「已有会话」为准；不臆造通讯录
    result = unavailable(
      Platform.DINGTALK,
      '钉钉目前只能发给「已有会话」：会话名来自收到的消息。按钉钉号给人发新会话需要额外授权。',
    );
  } else if (platform === Platform.WECOM) {
    result = unavailable(Platform.WECOM, '企业微信当前是演示模式，没有可用名录。');
  } else {
    result = unavailable(Platform.MAIL, '邮箱按地址发送，不使用会话名录。');
  }

  cache.set(platform, { at: Date.now(), result });
  return result;
}

/** 单测用 */
export function resetDirectoryCache(): void {
  cache.clear();
}