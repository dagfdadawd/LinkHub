"""RPA 桥的离线单测：不碰真实微信、不发网络请求。

覆盖容易回归的边界：
  - 附件落盘必须保留原文件名（不能给用户看到 <时间戳>-原名）；
  - 拉取不到任何消息时不能返回 200 假成功；
  - 发送前聚焦失败必须中止（不能把按键打到别的窗口）；
  - 纯附件发送也必须先聚焦微信。
"""

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("rpa_bridge", HERE / "rpa_bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
sys.modules["rpa_bridge"] = bridge
assert SPEC.loader is not None
SPEC.loader.exec_module(bridge)


class FakeHandler:
    def __init__(self):
        self.status = None
        self.body = None

    def _json(self, status, obj):
        self.status = status
        self.body = obj


class FocusFailingDesktop:
    def focus_wechat(self):
        return False


class FakeReader:
    def __init__(self, raw):
        self.raw = raw
        self.last_meta = {"focusForced": True, "focusRestored": True}

    def pull_text(self, start_offset=0):
        return self.raw, None


class TestAttachments(unittest.TestCase):
    def test_save_attachments_preserves_original_filename(self):
        old = bridge.OUTBOX_DIR
        tmp = tempfile.mkdtemp(prefix="linkhub-rpa-test-")
        bridge.OUTBOX_DIR = tmp
        try:
            paths = bridge.save_attachments([
                {"name": "方案 终版.pdf", "contentBase64": "YWJj"},
            ])
            self.assertEqual(len(paths), 1)
            self.assertEqual(os.path.basename(paths[0]), "方案 终版.pdf")
            self.assertTrue(os.path.isfile(paths[0]))
            self.assertEqual(Path(paths[0]).read_bytes(), b"abc")
        finally:
            bridge.OUTBOX_DIR = old
            shutil.rmtree(tmp, ignore_errors=True)


class TestStableId(unittest.TestCase):
    def test_same_text_at_different_message_indexes_gets_distinct_ids(self):
        a = bridge.make_stable_id("项目群", "张三", "好的", 3)
        b = bridge.make_stable_id("项目群", "张三", "好的", 4)
        self.assertNotEqual(a, b, "同一会话里两条『好的』不能共用幂等键")
        self.assertEqual(a, bridge.make_stable_id("项目群", "张三", "好的", 3))


class TestFileToken(unittest.TestCase):
    def test_build_pulled_inbound_uses_opaque_token_not_absolute_path(self):
        tmp = tempfile.mkdtemp(prefix="linkhub-token-test-")
        path = os.path.join(tmp, "方案.pdf")
        with open(path, "wb") as f:
            f.write(b"pdf")
        old_locate = bridge.locate_wechat_file
        bridge.locate_wechat_file = lambda name: path
        try:
            msg = bridge.build_pulled_inbound(
                {
                    "sender": "李四",
                    "text": "[文件] 方案.pdf",
                    "type": "file",
                    "fileName": "方案.pdf",
                    "at": bridge.datetime.now(),
                },
                "项目群",
            )
            att = msg["attachments"][0]
            self.assertTrue(att["token"].startswith("wxfile_"))
            self.assertNotIn(path, str(att), "消息里不能出现本机绝对路径")
            self.assertNotIn("path", att)
            self.assertEqual(bridge.resolve_file_token(att["token"]), path)
        finally:
            bridge.locate_wechat_file = old_locate
            shutil.rmtree(tmp, ignore_errors=True)

    def test_expired_token_is_none(self):
        self.assertIsNone(bridge.resolve_file_token("wxfile_expired"))


class TestPull(unittest.TestCase):
    def test_pull_with_zero_messages_is_an_error_not_success(self):
        old_mode, old_reader = bridge.MODE, bridge.WechatVisualReader
        bridge.MODE = "rpa"
        bridge.WechatVisualReader = lambda: FakeReader("")
        h = FakeHandler()
        try:
            bridge.Handler._handle_pull_unlocked(h, {"conversation": "项目群"})
        finally:
            bridge.MODE, bridge.WechatVisualReader = old_mode, old_reader
        self.assertEqual(h.status, 422, h.body)
        self.assertFalse(h.body["ok"])
        self.assertIn("没有", h.body["error"])

    def test_pull_passes_group_conversation_type(self):
        old_mode, old_reader = bridge.MODE, bridge.WechatVisualReader
        old_forward = bridge.forward_to_linkhub
        bridge.MODE = "rpa"
        bridge.WechatVisualReader = lambda: FakeReader(
            "张三\n2026年11月19日 12:03\n明天交周报\n"
        )
        seen = []

        def fake_forward(payload):
            seen.append(payload)
            return True, "", False

        bridge.forward_to_linkhub = fake_forward
        h = FakeHandler()
        try:
            bridge.Handler._handle_pull_unlocked(
                h, {"conversation": "项目群", "conversationType": "group"}
            )
        finally:
            bridge.MODE, bridge.WechatVisualReader = old_mode, old_reader
            bridge.forward_to_linkhub = old_forward
        self.assertEqual(h.status, 200, h.body)
        self.assertEqual(seen[0]["conversationType"], "group")


class TestClipboard(unittest.TestCase):
    def test_send_text_restores_user_clipboard(self):
        class Clip:
            def __init__(self):
                self.value = "原来的剪贴板"
                self.copies = []

            def paste(self):
                return self.value

            def copy(self, value):
                self.value = value
                self.copies.append(value)

        class Gui:
            def hotkey(self, *args):
                pass

            def press(self, *args):
                pass

        desktop = bridge.WechatDesktop.__new__(bridge.WechatDesktop)
        desktop.focus_wechat = lambda: True
        desktop.pyautogui = Gui()
        desktop.pyperclip = Clip()
        desktop.send_text("", "要发出去的消息")
        self.assertEqual(desktop.pyperclip.value, "原来的剪贴板")
        self.assertEqual(desktop.pyperclip.copies[-1], "原来的剪贴板")


class TestSendFocus(unittest.TestCase):
    def test_send_text_aborts_when_focus_fails(self):
        desktop = bridge.WechatDesktop.__new__(bridge.WechatDesktop)
        desktop.focus_wechat = lambda: False
        desktop.pyautogui = None
        desktop.pyperclip = None
        with self.assertRaises(RuntimeError) as ctx:
            desktop.send_text("张三", "hello")
        self.assertIn("聚焦", str(ctx.exception))

    def test_send_files_aborts_when_focus_fails(self):
        desktop = bridge.WechatDesktop.__new__(bridge.WechatDesktop)
        desktop.focus_wechat = lambda: False
        desktop.pyautogui = None
        with self.assertRaises(RuntimeError) as ctx:
            desktop.send_files([__file__])
        self.assertIn("聚焦", str(ctx.exception))

    def test_handle_send_file_only_focuses_before_paste(self):
        old_mode, old_desktop, old_save = bridge.MODE, bridge._get_desktop, bridge.save_attachments
        calls = []

        class Desktop:
            def focus_wechat(self):
                calls.append("focus")
                return True

            def send_files(self, paths):
                calls.append("files")

            def send_text(self, contact, text):
                calls.append("text")

        bridge.MODE = "rpa"
        bridge._get_desktop = lambda: Desktop()
        bridge.save_attachments = lambda atts: ["C:\\tmp\\a.pdf"]
        h = FakeHandler()
        try:
            bridge.Handler._handle_send(
                h, {"text": "", "conversation": "", "attachments": [{"name": "a.pdf", "contentBase64": "YQ=="}]}
            )
        finally:
            bridge.MODE, bridge._get_desktop, bridge.save_attachments = old_mode, old_desktop, old_save
        self.assertEqual(calls[:1], ["focus"], calls)
        self.assertEqual(h.status, 200, h.body)
        self.assertTrue(h.body["verified"])

    def test_handle_send_marks_4x_contact_as_unverified(self):
        old_mode, old_desktop = bridge.MODE, bridge._get_desktop

        class Desktop:
            def focus_wechat(self):
                return True

            def open_chat(self, contact):
                return False  # 4.x 无控件树，只能确认聚焦

            def send_text(self, contact, text):
                pass

            def send_files(self, paths):
                pass

        bridge.MODE = "rpa"
        bridge._get_desktop = lambda: Desktop()
        h = FakeHandler()
        try:
            bridge.Handler._handle_send(h, {"text": "hi", "conversation": "张三"})
        finally:
            bridge.MODE, bridge._get_desktop = old_mode, old_desktop
        self.assertEqual(h.status, 200, h.body)
        self.assertFalse(h.body["verified"])


if __name__ == "__main__":
    unittest.main()
