import { AppstoreOutlined } from '@ant-design/icons';
import { Platform } from '../../types';
import { PLATFORM_META } from '../../utils/format';
import { PlatformGlyph } from '../../components/PlatformGlyph';

export interface ChannelOption {
  value?: Platform;
  label: string;
  count: number;
}

/**
 * 渠道筛选条：图标 + 名称 + 动态数量。
 *
 * 数量由调用方按「除平台外的其他筛选」算好传进来——这样切换渠道时
 * 数字不会因为自身筛选而坍缩，搜索时又能跟着结果变化。
 */
export function ChannelTabs({
  options,
  value,
  onChange,
}: {
  options: ChannelOption[];
  value?: Platform;
  onChange: (platform?: Platform) => void;
}) {
  return (
    <div className="channel-tabs" role="tablist" aria-label="渠道筛选">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.label}
            type="button"
            role="tab"
            aria-selected={active}
            className={`channel-tab${active ? ' is-active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.value ? (
              <PlatformGlyph platform={opt.value} size={15} />
            ) : (
              <AppstoreOutlined style={{ fontSize: 15 }} aria-hidden="true" />
            )}
            <span className="channel-tab__label">{opt.label}</span>
            <span className="channel-tab__count">{opt.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 默认渠道项：全部 + 四个平台（数量由调用方填入） */
export const CHANNEL_DEFS: Array<{ value?: Platform; label: string }> = [
  { value: undefined, label: '全部' },
  { value: Platform.FEISHU, label: PLATFORM_META[Platform.FEISHU].name },
  { value: Platform.DINGTALK, label: PLATFORM_META[Platform.DINGTALK].name },
  { value: Platform.WECOM, label: '企微' },
  { value: Platform.MAIL, label: PLATFORM_META[Platform.MAIL].name },
];