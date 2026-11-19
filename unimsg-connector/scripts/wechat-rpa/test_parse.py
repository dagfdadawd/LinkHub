"""
微信「拖选复制」文本解析器的测试。

为什么值得单独测：解析错了不会报错，只会把消息挂到错的人/错的时间上，
在界面上看起来「一切正常」—— 这正是最该防的一类问题。

跑：``python -m unittest test_parse -v``（在 scripts/wechat-rpa 目录下）
"""
import importlib.util
import os
import unittest
from datetime import datetime

_SPEC = importlib.util.spec_from_file_location(
    "rpa_bridge", os.path.join(os.path.dirname(os.path.abspath(__file__)), "rpa_bridge.py")
)
bridge = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(bridge)


class ParseMsgTimeTest(unittest.TestCase):
    NOW = datetime(2026, 11, 19, 16, 30)

    def test_full_date(self):
        self.assertEqual(
            bridge.parse_msg_time("2026年11月19日 12:03", self.NOW),
            datetime(2026, 11, 19, 12, 3),
        )

    def test_full_date_extra_spaces(self):
        # 微信在个位数小时前会多一个空格：「2026年11月19日  9:25」
        self.assertEqual(
            bridge.parse_msg_time("2026年11月19日  9:25", self.NOW),
            datetime(2026, 11, 19, 9, 25),
        )

    def test_today_only(self):
        self.assertEqual(bridge.parse_msg_time("15:58", self.NOW), datetime(2026, 11, 19, 15, 58))

    def test_yesterday(self):
        self.assertEqual(bridge.parse_msg_time("昨天 09:10", self.NOW), datetime(2026, 11, 18, 9, 10))

    def test_weekday(self):
        # 2026-11-19 是周四；「星期三」应落到 11-18？不，周三比周四早一天 → 11-18 是周三
        self.assertEqual(bridge.parse_msg_time("星期三 08:00", self.NOW), datetime(2026, 11, 18, 8, 0))

    def test_afternoon_meridiem(self):
        self.assertEqual(bridge.parse_msg_time("下午 3:05", self.NOW), datetime(2026, 11, 19, 15, 5))

    def test_not_a_time(self):
        for s in ("我要", "[文件] a.pdf", "2026年11月19日", "", "   "):
            self.assertIsNone(bridge.parse_msg_time(s, self.NOW), s)


class ParseClipboardTest(unittest.TestCase):
    NOW = datetime(2026, 11, 19, 16, 30)

    def parse(self, raw, **kw):
        return bridge.parse_clipboard(raw, "测试会话", now=self.NOW, **kw)

    def test_loose_format(self):
        """宽松格式：昵称与时间之间有空行（真实复制样本）"""
        raw = (
            "Yue.\n\n2026年11月19日 15:58\n\n我要\n\n\n\n"
            "de.\n\n2026年11月19日 15:58\n\n好"
        )
        msgs, stats = self.parse(raw)
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[0]["sender"], "Yue.")
        self.assertEqual(msgs[0]["text"], "我要")
        self.assertEqual(msgs[1]["text"], "好")
        self.assertEqual(stats["anchors"], 2)

    def test_compact_format(self):
        """紧凑格式：昵称下一行就是时间（同版本微信，另一种选择范围）"""
        raw = "张三\n2026年11月19日 15:20\n收到\n\n李四\n2026年11月19日 15:22\n好的"
        msgs, _ = self.parse(raw)
        self.assertEqual([m["sender"] for m in msgs], ["张三", "李四"])
        self.assertEqual([m["text"] for m in msgs], ["收到", "好的"])

    def test_multiline_body_kept(self):
        raw = "张三\n\n15:20\n\n第一行\n第二行还在同一条"
        msgs, _ = self.parse(raw)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["text"], "第一行\n第二行还在同一条")

    def test_file_and_image_metadata(self):
        raw = (
            "张三\n\n15:20\n\n[文件] 方案 终版.pptx\n\n"
            "张三\n\n15:21\n\n[图片] 微信图片_1.dat"
        )
        msgs, _ = self.parse(raw)
        self.assertEqual(msgs[0]["type"], "file")
        self.assertEqual(msgs[0]["fileName"], "方案 终版.pptx")
        self.assertEqual(msgs[1]["type"], "file")
        self.assertEqual(msgs[1]["fileName"], "微信图片_1.dat")

    def test_plain_text_is_text(self):
        msgs, _ = self.parse("张三\n\n15:20\n\n明天交周报")
        self.assertEqual(msgs[0]["type"], "text")
        self.assertIsNone(msgs[0]["fileName"])

    def test_skip_self(self):
        """自己发的消息按昵称过滤掉，并计数（不静默丢弃）"""
        raw = "张三\n\n15:20\n\n你好\n\n我自己\n\n15:21\n\n收到"
        msgs, stats = self.parse(raw, self_name="我自己")
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["sender"], "张三")
        self.assertEqual(stats["skippedSelf"], 1)

    def test_lone_time_in_body_not_anchor(self):
        """正文里孤立的时间不会被当成消息锚点（否则会把一条消息拆成两条）"""
        raw = "张三\n\n15:20\n\n会议改到\n15:30 开始"
        msgs, _ = self.parse(raw)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["text"], "会议改到\n15:30 开始")

    def test_empty_body_skipped(self):
        raw = "张三\n\n15:20\n\n\n\n李四\n\n15:22\n\n有内容"
        msgs, stats = self.parse(raw)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["text"], "有内容")
        self.assertEqual(stats["skippedEmpty"], 1)

    def test_garbage_returns_nothing(self):
        msgs, stats = self.parse("随便一段没有结构的文字\n第二行")
        self.assertEqual(msgs, [])
        self.assertEqual(stats["anchors"], 0)

    def test_crlf_normalized(self):
        raw = "张三\r\n\r\n15:20\r\n\r\n收到"
        msgs, _ = self.parse(raw)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["text"], "收到")


class BuildInboundTest(unittest.TestCase):
    def test_stable_external_id(self):
        """同一屏重复拉取必须产生同一个 externalId，否则后端去重形同虚设"""
        item = {"sender": "张三", "at": datetime(2026, 11, 19, 15, 20), "text": "收到", "type": "text"}
        a = bridge.build_pulled_inbound(item, "项目群")
        b = bridge.build_pulled_inbound(item, "项目群")
        self.assertEqual(a["externalId"], b["externalId"])
        c = bridge.build_pulled_inbound(item, "别的群")
        self.assertNotEqual(a["externalId"], c["externalId"])

    def test_iso_time_passed_through(self):
        item = {"sender": "张三", "at": datetime(2026, 11, 19, 15, 20), "text": "x", "type": "text"}
        payload = bridge.build_pulled_inbound(item, "项目群")
        self.assertEqual(payload["at"], "2026-11-19T15:20:00")

    def test_missing_file_has_no_path(self):
        """定位不到本机文件时不给 path：前端据此不显示下载按钮，不假装能下"""
        item = {
            "sender": "张三",
            "at": datetime(2026, 11, 19, 15, 20),
            "text": "[文件] 不存在的文件_zzz.pdf",
            "type": "file",
            "fileName": "不存在的文件_zzz.pdf",
        }
        payload = bridge.build_pulled_inbound(item, "项目群")
        self.assertEqual(payload["attachments"][0]["path"], "")
        self.assertEqual(payload["attachments"][0]["name"], "不存在的文件_zzz.pdf")


if __name__ == "__main__":
    unittest.main()
