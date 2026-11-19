/**
 * 「新建发送」目标名的回归：列表里不能出现平台原始 ID。
 *
 * 线上真实反馈：发送给列表里显示的是 `ou_c8bb2c7ac5dac96250fef8e3dde34d38` 这种串，
 * 客户根本看不出这是发给谁——收件箱里明明有人名。
 */
import { describe, expect, it } from 'vitest';
import { looksLikePlatformId, pickTargetLabel } from './ComposeModal';

describe('发送目标的展示名', () => {
  it('平台原始 ID 会被识别出来（不能直接当名字展示）', () => {
    expect(looksLikePlatformId('ou_c8bb2c7ac5dac96250fef8e3dde34d38')).toBe(true);
    expect(looksLikePlatformId('oc_abc587d27c36d4d0b457c7d375852722')).toBe(true);
    expect(looksLikePlatformId('cidvtwlUu0ZWAYibiQCSj7PO7pH/c+2FUV1lSq6x')).toBe(true);
    expect(looksLikePlatformId('cli_aa7ece820af89ce0')).toBe(true);
  });

  it('人起的名字不会被误判成 ID', () => {
    expect(looksLikePlatformId('Jarvis')).toBe(false);
    expect(looksLikePlatformId('LinkHub 测试群')).toBe(false);
    expect(looksLikePlatformId('郑友佳（测试用')).toBe(false);
    expect(looksLikePlatformId('')).toBe(false);
    expect(looksLikePlatformId(undefined)).toBe(false);
  });

  it('有可读名就用可读名', () => {
    expect(pickTargetLabel('Jarvis', 'oc_a8e370f29b91cb5098245056e41525e2', 'p2p')).toBe('Jarvis');
    expect(pickTargetLabel('LinkHub 测试群', 'oc_abc', 'group')).toBe('LinkHub 测试群');
  });

  it('只有 ID 时退成「单聊/群聊 · …尾部」，不再铺一长串', () => {
    const label = pickTargetLabel('ou_c8bb2c7ac5dac96250fef8e3dde34d38', 'ou_c8bb2c7ac5dac96250fef8e3dde34d38', 'p2p');
    expect(label).toBe('单聊 · …e34d38');
    expect(label).not.toContain('ou_c8bb2c7ac5');
    expect(pickTargetLabel(undefined, 'oc_abc587d27c36d4d0b457c7d375852722', 'group')).toBe('群聊 · …852722');
  });

  it('既没有名字也没有 ID 时给中性兜底，不崩', () => {
    expect(pickTargetLabel(undefined, '', undefined)).toBe('未命名单聊');
    expect(pickTargetLabel('（未命名会话）', '', 'group')).toBe('未命名群聊');
  });
});