#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信 RPA 桥 —— LinkHub 的"微信个人版"通道（本地独立进程）。

微信个人版没有官方收发 API，本桥用 RPA（模拟键鼠 + UI Automation）实现消息采集与发送，
并通过 HTTP 与 LinkHub 后端对接。设计上分两态，绝不把模拟冒充真实：

  - MOCK 态（默认，零依赖）：不发真实消息、不碰微信窗口，仅供链路自测与演示。
      POST /send 只回一个 rpa-mock 凭证（后端会核对 mode，不会当成真实送达）；
      收消息用 POST /mock/inject 手动注入。
  - RPA  态（需 pyautogui / pyperclip / pywin32 / uiautomation）：真实操作本机微信桌面端。
      发：定位好友 → 粘贴文本/文件 → 回车；
      收：UI Automation 轮询窗口消息 → 转发 LinkHub webhook（会切换会话，见下）。

HTTP 接口（端口默认 8787，只监听 127.0.0.1）：
  GET  /health        运行状态、当前模式、依赖可用性、**接收能力（receive）**
  GET  /file?path=…   回吐微信已落盘的入站文件（白名单目录 + 50MB 上限）
  POST /send          后端 connector.send() 调用：{text, conversation, senderId, attachments, traceId}
  POST /ingest        微信侧消息入库（RPA 轮询器内部调用 / 手工补录）
  POST /mock/inject   MOCK 态手动注入一条入站消息（自测用）
  GET  /queue         MOCK 态查看已注入待处理队列

关键约定：
  - 入站转发到 LinkHub 的 /api/webhook/wechat，带 x-signature: dev-rpa
    （后端 wechat.verify() 接受 dev* 前缀，等同"本机可信来源"）。
  - externalId 由"时间戳+发送方+正文"哈希生成，作为幂等键，避免重复入库。
  - 每条消息随机延迟（300–900ms）模拟真人节奏；严禁高频群发。
  - **绝不虚报能力**：/health 里 receive.supported 只有在 UI Automation 真正可用、
    且能找到微信主窗口时才为 true；后端据此决定能否说"接收已就绪"。

用法：
  python rpa_bridge.py                       # MOCK 态，零依赖，立即能跑
  python rpa_bridge.py --mode rpa            # RPA 态，需装依赖且微信已登录
  python rpa_bridge.py --mode rpa --no-switch  # 只读当前打开的会话（不抢焦点）
  python rpa_bridge.py --mode mock --port 8787 --linkhub http://127.0.0.1:3001

Windows 控制台中文乱码：本脚本启动时已把 stdout/stderr 切到 UTF-8；
如果仍乱码，先执行 `set PYTHONIOENCODING=utf-8`（PowerShell：$env:PYTHONIOENCODING="utf-8"）。
"""

import argparse
import hashlib
import json
import mimetypes
import os
import random
import re
import shutil
import sys
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError, HTTPError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
LINKHUB_BASE = os.environ.get("LINKHUB_BASE", "http://127.0.0.1:3001").rstrip("/")
LINKHUB_WEBHOOK = LINKHUB_BASE + "/api/webhook/wechat"
SIGNATURE = "dev-rpa"          # 后端 verifyMock 接受 dev* 前缀
OUTBOX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outbox")

MODE = "mock"                  # 由命令行覆盖
POLL_INTERVAL = 2.0            # RPA 态收消息轮询间隔（秒）
SCAN_ALL = False               # True=不只扫未读会话（会频繁切换会话，默认关闭）
NO_SWITCH = False              # True=只读当前打开的会话，不点击会话列表
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_SESSIONS_PER_POLL = 5      # 每轮最多切几个会话（避免抢焦点太久）
MAX_MESSAGES_PER_CONV = 20

_watch_thread = None
_stop = threading.Event()
_lock = threading.Lock()
_queue = deque()               # MOCK 态：注入待转发的消息
_sent_log = deque(maxlen=50)   # 最近发送记录（/health 可见条数）
_pulled_seen = set()           # 按需拉取已转发的 externalId（桥侧重去重；后端幂等键兜底）
_pulled_log = deque(maxlen=50) # 最近拉取记录
_reader = None
_file_tokens = {}              # token -> 本机绝对路径；只存在于桥进程内，绝不写进消息
_file_tokens_lock = threading.Lock()

# 接收能力的真实状态：由轮询线程写、/health 读。绝不预设为"可用"。
RECEIVE = {
    "implemented": True,       # read_new_messages 已实现（不再是空钩子）
    "supported": False,        # 当前环境是否真的能读（UIA 可用 + 找到窗口）
    "reason": "尚未启动（mock 模式不读取微信窗口）",
    "forwarded": 0,
    "lastPollAt": None,
    "lastError": None,
}

# 本机微信客户端形态。3.x 是原生控件（UIA 可读）；4.x（Weixin）是 Qt 5 自绘，
# UIA 与 MSAA 都只有空壳，任何基于控件树的读取都会拿到 0 条消息。
# 与其笼统报「找不到窗口」让用户以为是没登录，不如把版本不兼容这一点讲明白。
CLIENT = {
    "kind": "unknown",       # wechat3 | weixin4 | none | unknown
    "class": None,           # 窗口类名（WeChatMainWndForPC / Qt51514QWindowIcon）
    "title": None,
    "hwnd": None,
    "uiaUsable": False,      # 是否暴露可访问性控件树
    "visible": None,         # 窗口当前是否可见（最小化到托盘时为 False）
    "reason": "尚未探测微信客户端",
    "checkedAt": None,
}
_client_checked_at = 0.0
CLIENT_CACHE_SEC = 3.0


def detect_client(force=False):
    """
    识别当前微信是 3.x 还是 4.x，并给出「能不能读」的结论。

    判定依据（都是实测出来的，不是猜的）：
      - 微信 3.x：主窗口 ClassName = WeChatMainWndForPC，UIA 树完整（会话列表/消息列表都是 ListControl）
      - 微信 4.x：主窗口 ClassName = Qt51514QWindowIcon、Name = 微信/Weixin，
                  根节点只有 2 个空 Pane，渲染子窗口 childCount=0（MSAA 也只到窗口层）
    """
    global _client_checked_at
    now = time.time()
    if not force and CLIENT["kind"] != "unknown" and now - _client_checked_at < CLIENT_CACHE_SEC:
        return CLIENT

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    hits = []

    def _area(hwnd):
        rect = wintypes.RECT()
        try:
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            return max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top)
        except Exception:
            return 0

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):
        try:
            cbuf = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cbuf, 256)
            cls = cbuf.value
            is3 = cls == "WeChatMainWndForPC"
            is4 = cls.startswith("Qt5") and cls.endswith("QWindowIcon")
            if not (is3 or is4):
                return True
            tbuf = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, tbuf, 512)
            title = tbuf.value
            if is4 and not ("微信" in title or "Weixin" in title):
                return True
            # 不按可见性过滤：4.x 最小化到托盘时主窗口只是被隐藏（IsWindowVisible=0），
            # 但它仍然存在，拉取前可以用 ShowWindow 拉回来。过滤掉会造成
            # "明明登录着却说没找到微信"的假结论。
            visible = bool(user32.IsWindowVisible(hwnd))
            hits.append(("wechat3" if is3 else "weixin4", cls, title, hwnd, visible, _area(hwnd)))
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(_cb, 0)
    except Exception as e:
        CLIENT.update({"kind": "unknown", "reason": f"枚举窗口失败：{e}", "checkedAt": now_iso()})
        return CLIENT

    # 3.x 优先（同时开着两个客户端时，能读的那个才是我们要的）；
    # 4.x 可能有主窗口和若干小窗，取面积最大的那个当主窗口
    pick = next((h for h in hits if h[0] == "wechat3"), None)
    if pick is None and hits:
        pick = max(hits, key=lambda h: h[5])
    visible = bool(pick[4]) if pick else False

    if pick is None:
        CLIENT.update({
            "kind": "none", "class": None, "title": None, "hwnd": None, "uiaUsable": False,
            "visible": False,
            "reason": "未找到微信主窗口：请先登录并打开微信桌面端（进程在运行但还没有主窗口）",
            "checkedAt": now_iso(),
        })
    elif pick[0] == "wechat3":
        CLIENT.update({
            "kind": "wechat3", "class": pick[1], "title": pick[2], "hwnd": pick[3],
            "uiaUsable": True, "visible": visible,
            "reason": "微信 3.x：暴露可访问性控件树，可读取会话与消息",
            "checkedAt": now_iso(),
        })
    else:
        CLIENT.update({
            "kind": "weixin4", "class": pick[1], "title": pick[2], "hwnd": pick[3],
            "uiaUsable": False, "visible": visible,
            "reason": (
                "检测到微信 4.x（Weixin，Qt 自绘）：不暴露可访问性控件树"
                f"（窗口类 {pick[1]}，UIA/MSAA 均为空），无法自动轮询读消息；"
                "接收走「按需拉取」（拖选复制），或在 3.9.x 上自动接收。发送不受影响"
                + ("" if visible else "；当前窗口已最小化到托盘，拉取时会临时拉回可见")
            ),
            "checkedAt": now_iso(),
        })
    _client_checked_at = now
    return CLIENT


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def log(msg):
    print("[rpa-bridge] " + str(msg), flush=True)


def init_console_encoding():
    """Windows 控制台默认 GBK：中文日志/异常会乱码。统一切 UTF-8，失败也不影响功能。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def init_dpi_awareness():
    """
    声明 per-monitor DPI 感知。

    不声明的话 Windows 会把坐标按缩放虚拟化（本机 150%：同一个微信窗口
    win32 报 1011x729、UIA 报 1516x1093），而 pyautogui 点击/截图走物理像素，
    两套坐标混用必然点错位置 —— 这是 RPA 最容易踩、又最难查的坑。
    """
    try:
        import ctypes
        try:
            # PROCESS_PER_MONITOR_DPI_AWARE
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception as e:
        log(f"DPI 感知设置失败（坐标可能偏移）：{e}")


# ---------------------------------------------------------------------------
# 微信文件目录（入站文件白名单：/file 只允许读这些目录下的文件）
# ---------------------------------------------------------------------------
def wechat_file_roots():
    roots = []
    explicit = os.environ.get("WECHAT_FILE_ROOT", "").strip()
    if explicit:
        roots.append(explicit)
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "Documents", "WeChat Files"),
        os.path.join(home, "Documents", "xwechat_files"),   # 微信 4.x
        os.path.join(home, "Documents", "WeChat Files", "All Users"),
    ]
    for p in candidates:
        if os.path.isdir(p):
            roots.append(p)
    if os.path.isdir(OUTBOX_DIR):
        roots.append(OUTBOX_DIR)
    return [os.path.realpath(p) for p in roots]


def issue_file_token(path):
    """给本机文件签发不透明 token；真实路径只留在桥进程内。"""
    token = "wxfile_" + uuid.uuid4().hex
    real = os.path.abspath(path)
    with _file_tokens_lock:
        if len(_file_tokens) >= 2000:
            _file_tokens.pop(next(iter(_file_tokens)), None)
        _file_tokens[token] = real
    return token


def resolve_file_token(token):
    if not token:
        return None
    with _file_tokens_lock:
        return _file_tokens.get(token)


def resolve_servable_path(raw):
    """把请求里的路径落到白名单目录内才允许读。返回 (realpath, error)。"""
    if not raw or not isinstance(raw, str):
        return None, "缺少 path 参数"
    try:
        path = os.path.realpath(os.path.abspath(raw))
    except Exception as e:
        return None, f"非法路径：{e}"
    if not os.path.isfile(path):
        return None, "文件不存在或已被移动/删除"
    roots = wechat_file_roots()
    if not any(path == r or path.startswith(r + os.sep) for r in roots):
        return None, "路径不在微信文件目录/桥的 outbox 白名单内，拒绝读取"
    try:
        size = os.path.getsize(path)
    except OSError as e:
        return None, f"读取文件信息失败：{e}"
    if size > MAX_FILE_BYTES:
        return None, f"文件过大（{size} 字节），超过 50MB 上限"
    return path, None


# ---------------------------------------------------------------------------
# RPA 适配器：真实操作微信桌面端（可选依赖，缺失时明确报错，不静默降级）
# ---------------------------------------------------------------------------
class WechatDesktop:
    """封装对微信 Windows 桌面端的模拟操作。只在 --mode rpa 时使用。"""

    def __init__(self):
        self.pyautogui = None
        self.pyperclip = None
        errs = []
        try:
            import pyautogui
            self.pyautogui = pyautogui
            self.pyautogui.FAILSAFE = True   # 鼠标移到左上角可紧急停止
            self.pyautogui.PAUSE = 0.15
        except Exception:
            errs.append("pyautogui")
        try:
            import pyperclip
            self.pyperclip = pyperclip
        except Exception:
            errs.append("pyperclip")
        if errs:
            raise RuntimeError(
                "RPA 态缺少依赖: " + ", ".join(errs)
                + "。请 pip install pyautogui pyperclip uiautomation（Windows 还需 pywin32）。"
            )

    def _human_pause(self):
        time.sleep(random.uniform(0.3, 0.9))

    def _backup_clipboard(self):
        try:
            return self.pyperclip.paste()
        except Exception:
            return None

    def _restore_clipboard(self, value):
        if value is None:
            return
        try:
            self.pyperclip.copy(value)
        except Exception:
            pass

    def focus_wechat(self):
        """把微信窗口切到前台，并**校验真的到了前台**。

        以前只调 SetForegroundWindow 就返回 True；Windows 前台锁会让它静默失败，
        后续 Ctrl+F/粘贴/回车就打到别的窗口上。这里复用拉取用的 _force_foreground，
        它带 AttachThreadInput 和 GetForegroundWindow 轮询。
        """
        try:
            import win32gui
            hwnd = win32gui.FindWindow("WeChatMainWndForPC", None)
            if not hwnd:
                hwnd = win32gui.FindWindow(None, "微信")
            if hwnd:
                return bool(_force_foreground(hwnd))
        except Exception as e:
            log(f"聚焦微信失败：{e}")
        log("提示：未能自动聚焦微信窗口，请确保微信桌面端已打开并置于前台。")
        return False

    def current_chat_name(self):
        """3.x 用 UIA 读当前选中会话；4.x 没有控件树，返回 None（不猜）。"""
        try:
            if detect_client().get("kind") != "wechat3":
                return None
            reader = WechatUiaReader()
            window = reader._main_window()
            if window is None:
                return None
            sessions, _ = reader._lists(window)
            if not sessions:
                return None
            current = reader._current_conversation(sessions)
            return (current.Name or "").strip() if current is not None else None
        except Exception:
            return None

    def open_chat(self, contact):
        """聚焦并按会话名打开聊天；返回是否**确认**打开了目标会话。

        3.x 能读当前选中会话：搜完名字对不上就直接报错，绝不把消息发到当前聊天；
        4.x 没有控件树，只能确认「聚焦成功」，返回 False 表示未核对（不是成功）。
        """
        contact = (contact or "").strip()
        if not contact:
            return self.focus_wechat()
        if not self.focus_wechat():
            raise RuntimeError("无法聚焦微信窗口，已中止发送（没有把按键打到别的窗口）")
        g = self.pyautogui
        backup = self._backup_clipboard()
        try:
            g.hotkey("ctrl", "f")
            self._human_pause()
            self.pyperclip.copy(contact)
            g.hotkey("ctrl", "v")
            self._human_pause()
            g.press("enter")
            self._human_pause()
            current = self.current_chat_name()
        finally:
            self._restore_clipboard(backup)
        if current:
            # UIA 的 ListItem Name 可能带预览/未读数；只认第一行，避免
            # 「张三丰」因为包含「张三」被误判成目标会话。
            current_name = current.splitlines()[0].strip()
            if current_name != contact and not current_name.startswith(contact + " "):
                raise RuntimeError(
                    f"目标会话校验失败：搜索后当前会话是「{current_name}」，不是「{contact}」；"
                    "已中止发送，避免发错人/错群"
                )
            return True
        if detect_client().get("kind") == "wechat3":
            # 3.x 本来能读控件树；读不到说明 UIA 不可用/窗口结构变了。
            # 这时无法核对会话，宁可中止，也不把消息发给当前聊天。
            raise RuntimeError("3.x 无法读取当前会话（UI Automation 不可用），已中止发送")
        # 4.x：界面不暴露当前会话标题，只能确认聚焦成功；标记为未核对
        return False

    def send_text(self, contact, text):
        """定位联系人并发送文本。contact 为空时假定当前聊天窗口就是要发的对象。"""
        backup = self._backup_clipboard()
        try:
            if not self.focus_wechat():
                raise RuntimeError("无法聚焦微信窗口，已中止发送（没有把按键打到别的窗口）")
            verified = True
            if contact:
                verified = self.open_chat(contact)
            g = self.pyautogui
            # 文本走剪贴板粘贴，避免中文/emoji 逐字输入失真
            self.pyperclip.copy(text)
            g.hotkey("ctrl", "v")
            self._human_pause()
            g.press("enter")
            self._human_pause()
            return verified
        finally:
            self._restore_clipboard(backup)

    def send_files(self, paths):
        """
        一次粘贴多个文件（微信支持 Ctrl+V 一次发多个）。

        以前只取 paths[0]，多附件会静默丢文件——这里构造多文件 CF_HDROP：
        DROPFILES 头（20 字节）+ UTF-16LE 的双 \0 结尾文件列表。
        纯附件发送也必须先聚焦微信，否则 Ctrl+V 会落到别的窗口。
        """
        if not paths:
            return True
        if not self.focus_wechat():
            raise RuntimeError("无法聚焦微信窗口，已中止发送（没有把文件粘贴到别的窗口）")
        backup = self._backup_clipboard()
        try:
            import struct
            import win32clipboard
            import win32con

            files = []
            for p in paths:
                ap = os.path.abspath(p)
                with open(ap, "rb"):
                    pass
                files.append(ap)
            if not files:
                return True
            # DROPFILES: pFiles(DWORD)=20, pt(POINT, 8B), fNC(BOOL), fWide(BOOL)=1
            header = struct.pack("<Iiiii", 20, 0, 0, 0, 1)
            listing = "\0".join(files) + "\0\0"
            payload = header + listing.encode("utf-16-le")

            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32con.CF_HDROP, payload)
            finally:
                win32clipboard.CloseClipboard()

            self.pyautogui.hotkey("ctrl", "v")
            self._human_pause()
            self.pyautogui.press("enter")
            self._human_pause()
        except Exception as e:
            raise RuntimeError("文件粘贴失败（需 pywin32）：" + str(e))
        finally:
            self._restore_clipboard(backup)
        return True


# ---------------------------------------------------------------------------
# 入站消息：生成统一 externalId，转发 LinkHub webhook
# ---------------------------------------------------------------------------
def make_external_id(sender, text, ts_ms):
    seed = f"{ts_ms}|{sender}|{text}".encode("utf-8", "replace")
    return "wx-" + hashlib.sha1(seed).hexdigest()[:20]


def make_stable_id(conversation, sender, text, index=None):
    """
    轮询读到的消息用「会话 + 发送方 + 正文 + 列表位置」作稳定指纹。

    为什么不用时间戳：桥重启后会重新看到同一批消息，时间戳一变就成了新消息，
    后端幂等键形同虚设，会重复入库。加消息列表位置后：
      - 同一会话里两条「好的」在不同位置 → 不同 ID，不会再被永久去重；
      - 同一位置重启重读 → 同一 ID，后端仍会幂等丢弃。
    位置依赖微信消息列表的稳定顺序；列表被裁剪/滚动导致位置变化时，
    极端情况下可能重复入库，但比“所有相同短回复都丢”更可接受。
    """
    seed = f"{conversation}|{sender}|{text}"
    if index is not None:
        seed += f"|#{index}"
    return "wx-" + hashlib.sha1(seed.encode("utf-8", "replace")).hexdigest()[:20]


# ---------------------------------------------------------------------------
# 按需拉取（微信 4.x）：拖选 → 复制 → 解析
#
# 4.x 是 Qt 5 自绘，Weixin.dll 里连 QWindowsAccessib / QT_ACCESSIBILITY 都没有
# （编译期裁掉），UIA 与 MSAA 都是空树，控件树方案在 4.x 上拿不到任何消息。
# 但"选中复制"走的是系统剪贴板这条正规路径，拿到的是精确原文（零 OCR 误差；
# 实测 Windows OCR 在深色主题小字上会整句丢字，不可用）。
# ---------------------------------------------------------------------------
_SELF_NAME = os.environ.get("WECHAT_SELF_NAME", "").strip()

_TIME_FULL = re.compile(r"^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(上午|下午|中午|晚上|凌晨)?\s*(\d{1,2}):(\d{2})$")
_TIME_REL = re.compile(r"^(昨天|前天|星期[一二三四五六日天])\s*(上午|下午|中午|晚上|凌晨)?\s*(\d{1,2}):(\d{2})$")
_TIME_TODAY = re.compile(r"^(上午|下午|中午|晚上|凌晨)?\s*(\d{1,2}):(\d{2})$")
_WEEKDAY_INDEX = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


def _apply_meridiem(hour, pad):
    if pad in ("下午", "晚上") and hour < 12:
        return hour + 12
    if pad == "凌晨" and hour == 12:
        return 0
    return hour


def parse_msg_time(text, now=None):
    """把微信复制文本里的时间行解析成本地 datetime；认不出返回 None。"""
    now = now or datetime.now()
    s = (text or "").strip()
    if not s:
        return None

    m = _TIME_FULL.match(s)
    if m:
        y, mo, d, pad, hh, mm = m.groups()
        try:
            return datetime(int(y), int(mo), int(d), _apply_meridiem(int(hh), pad), int(mm))
        except ValueError:
            return None

    m = _TIME_REL.match(s)
    if m:
        rel, pad, hh, mm = m.groups()
        hour, minute = _apply_meridiem(int(hh), pad), int(mm)
        if rel == "昨天":
            day = now - timedelta(days=1)
        elif rel == "前天":
            day = now - timedelta(days=2)
        else:
            target = _WEEKDAY_INDEX.get(rel[-1])
            if target is None:
                return None
            # 微信只在非今天显示"星期X"；这里取最近的那个过去日期
            delta = (now.weekday() - target) % 7 or 7
            day = now - timedelta(days=delta)
        try:
            return day.replace(hour=hour, minute=minute, second=0, microsecond=0)
        except ValueError:
            return None

    m = _TIME_TODAY.match(s)
    if m:
        pad, hh, mm = m.groups()
        try:
            return now.replace(hour=_apply_meridiem(int(hh), pad), minute=int(mm), second=0, microsecond=0)
        except ValueError:
            return None
    return None


_MEDIA_PREFIXES = ("[图片]", "[视频]", "[语音]", "[动画表情]", "[表情]")


def _classify_body(body):
    """消息正文 → (统一类型, 文件名)。微信复制的媒体消息只有方括号标记，拿不到内容。"""
    t = (body or "").strip()
    if t.startswith("[文件]"):
        name = t[len("[文件]"):].strip()
        return "file", (name or None)
    for tag in _MEDIA_PREFIXES:
        if t.startswith(tag):
            rest = t[len(tag):].strip()
            return "file", (rest or None)
    return "text", None


def parse_clipboard(raw, conversation="微信当前会话", self_name=None, now=None):
    """
    解析微信「拖选 → Ctrl+C」得到的纯文本。

    实测两种格式（同一版本微信，取决于选择范围/滚动位置）：

        紧凑：  发送者\n2026年11月19日 12:03\n正文
        宽松：  发送者\n\n2026年11月19日 12:03\n\n正文

    所以统一以「时间行」为锚点，允许时间行前面是 0 或 1 个空行；
    这样正文里孤立出现的时间（有人发了"15:30"）不会被误当锚点
    （它前面通常是正文行而不是昵称行，且紧邻关系不成立）。
    返回 (messages, stats)：stats 记录跳过了多少条（自己发的 / 空正文），不静默丢弃。
    """
    raw = (raw or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = raw.split("\n")
    time_rows = [i for i, l in enumerate(lines) if parse_msg_time(l, now) is not None]

    anchors = []
    for i in time_rows:
        j = i - 1
        blanks = 0
        while j >= 0 and not lines[j].strip():
            blanks += 1
            j -= 1
        if j < 0 or blanks > 1:
            continue
        if parse_msg_time(lines[j], now) is not None:
            continue
        anchors.append((j, i))

    out, skipped_self, skipped_empty = [], 0, 0
    me = (self_name or "").strip()
    for k, (si, ti) in enumerate(anchors):
        end = anchors[k + 1][0] if k + 1 < len(anchors) else len(lines)
        sender = lines[si].strip()
        body = "\n".join(lines[ti + 1:end]).strip()
        if not body:
            skipped_empty += 1
            continue
        if me and sender == me:
            skipped_self += 1
            continue
        mtype, fname = _classify_body(body)
        out.append({
            "sender": sender,
            "at": parse_msg_time(lines[ti], now),
            "text": body,
            "type": mtype,
            "fileName": fname,
        })
    return out, {
        "anchors": len(anchors),
        "skippedSelf": skipped_self,
        "skippedEmpty": skipped_empty,
    }


def locate_wechat_file(name, months=6):
    """
    按文件名在微信落盘目录里找工作副本（只扫最近几个月，不做全盘 walk）。

    微信收到的文件会落到 `msg/file/<YYYY-MM>/<原文件名>`（4.x）
    或 `FileStorage/File/<YYYY-MM>/<原文件名>`（3.x）。
    找到就带上绝对路径，LinkHub 可通过桥的 /file 下载；找不到就不给路径，
    前端不会显示下载按钮（不假装能下）。
    """
    safe = os.path.basename((name or "").strip())
    if not safe:
        return None
    now = datetime.now()
    stems = []
    for i in range(max(1, months)):
        y = now.year - (now.month - 1 - i) // 12
        mo = (now.month - 1 - i) % 12 + 1
        stems.append(f"{y:04d}-{mo:02d}")

    for root in wechat_file_roots():
        # 真实结构是「根目录 / 账号目录 / ...」：
        #   4.x: <root>/<wxid_xxx>/msg/file/<YYYY-MM>/<name>
        #   3.x: <root>/<wxid_xxx>/FileStorage/File/<YYYY-MM>/<name>
        # outbox 直接就是平铺的，所以根目录本身也试一次。
        bases = [root]
        try:
            bases += [
                os.path.join(root, d)
                for d in sorted(os.listdir(root))[:40]
                if os.path.isdir(os.path.join(root, d))
            ]
        except OSError:
            pass
        for base_root in bases:
            for sub in (("msg", "file"), ("FileStorage", "File")):
                d = os.path.join(base_root, *sub)
                if not os.path.isdir(d):
                    continue
                for stem in stems:
                    p = os.path.join(d, stem, safe)
                    if os.path.isfile(p):
                        return os.path.abspath(p)
    return None


def build_pulled_inbound(item, conversation, conv_type="p2p"):
    """
    解析出的一条 → 后端约定的事件体。

    externalId 用「会话+发送者+时间+正文」的稳定指纹：同一屏重复拉取、桥重启后再拉，
    后端都按幂等键去重，不会重复入库。
    """
    at = item.get("at")
    iso = at.isoformat() if isinstance(at, datetime) else now_iso()
    msg = {
        "externalId": make_stable_id(conversation, item["sender"], f"{iso}|{item['text']}"),
        "from": item["sender"],
        "senderId": item["sender"],
        "conversation": conversation,
        "conversationType": conv_type,
        "text": item["text"],
        "type": item["type"],
        "at": iso,
    }
    # 文件/图片能定位到本机落盘副本就给绝对路径：LinkHub 通过桥 /file 下载
    fname = item.get("fileName")
    if fname:
        local = locate_wechat_file(fname)
        size = 0
        if local:
            try:
                size = os.path.getsize(local)
            except OSError:
                size = 0
        msg["attachments"] = [{
            "name": os.path.basename(fname),
            # 不把绝对路径写进消息：后端只拿到不透明 token，桥按 token 回吐字节。
            "token": issue_file_token(local) if local else "",
            "mimeType": mimetypes.guess_type(fname)[0] or "application/octet-stream",
            "size": size,
        }]
    return msg


def _force_foreground(hwnd, timeout=2.0):
    """
    把窗口可靠地置前。

    Windows 有前台锁定：后台进程直接 SetForegroundWindow 常常静默失败。
    失败却不校验，后续拖选就作用在**别的窗口**上，会复制到无关文字——
    那正是"假装成功"的典型形态。所以这里用 AttachThreadInput 绕开前台锁，
    并且**逐次校验** GetForegroundWindow 是否真的变成了目标窗口。
    """
    import win32api
    import win32con
    import win32gui
    import win32process

    if win32gui.GetForegroundWindow() == hwnd:
        return True

    cur_tid = win32api.GetCurrentThreadId()
    fg = win32gui.GetForegroundWindow()
    fg_tid = 0
    if fg:
        try:
            fg_tid, _ = win32process.GetWindowThreadProcessId(fg)
        except Exception:
            fg_tid = 0

    attached = False
    try:
        if fg_tid and fg_tid != cur_tid:
            try:
                win32process.AttachThreadInput(cur_tid, fg_tid, True)
                attached = True
            except Exception:
                attached = False
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.BringWindowToTop(hwnd)
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
    finally:
        if attached:
            try:
                win32process.AttachThreadInput(cur_tid, fg_tid, False)
            except Exception:
                pass

    deadline = time.time() + timeout
    while time.time() < deadline:
        if win32gui.GetForegroundWindow() == hwnd:
            return True
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        time.sleep(0.12)
    return win32gui.GetForegroundWindow() == hwnd


class WechatVisualReader:
    """
    置前微信 → 消息区从右下往左上拖选 → Ctrl+C → 读剪贴板 → 还原剪贴板与前台窗口。

    能力边界（如实告知，不夸大）：
      - 只覆盖**当前打开的那一个会话**：4.x 没有可访问性树，外部无法定位并点击会话列表；
      - 只覆盖**可视区**：滚出屏幕的历史拉不到；
      - 执行期间会抢前台，并短暂选中文本（结束按 Esc 取消选中）。
    """

    # 消息区相对窗口的位置（按 4.2 默认布局实测）。
    # 右侧必须留足余量：贴着右边缘会按在消息区的滚动条上，拖动变成滚屏、
    # 剪贴板一个字节都不会变（这正是"复制成功但解析出 0 条"的元凶）。
    LEFT_RATIO = 0.33
    RIGHT_RATIO = 0.935
    TOP_RATIO = 0.125
    BOTTOM_RATIO = 0.815

    def __init__(self):
        self.last_meta = {}

    def _start_points(self, left, right, top, bottom):
        """
        拖选起点候选。

        4.x 的规矩：**只有按在消息气泡上**才进入"选择消息"模式，
        按在空白处拖动什么都不会选中（剪贴板一个字节都不变）。
        所以不能只试一个固定点，而按"最可能有气泡"的顺序试几组，命中即停。
        """
        mx, my = (left + right) // 2, (top + bottom) // 2
        yield (right - 70, bottom - 70)   # 右下：最新一条（自己发的在右侧）
        yield (left + 140, bottom - 70)   # 左下：对方最新一条
        yield (right - 70, my)            # 右中
        yield (left + 140, my)            # 左中
        yield (mx, my)                    # 正中
        yield (right - 70, top + 80)      # 右上
        yield (left + 140, top + 80)      # 左上

    def pull_text(self, start_offset=0):
        """
        返回 (clipboard_text, error)。

        start_offset 用来在第一次选中但解析 0 条时换一个起点重试；
        失败时 error 说清原因，绝不返回半截内容或别的窗口的文字。
        last_meta 记录本次实际动作（是否置前成功、试了几个起点、焦点是否还原），
        供调用方如实上报。
        """
        self.last_meta = {
            "focusForced": False,
            "focusRestored": False,
            "windowRestored": False,
            "region": None,
            "attempts": 0,
        }
        try:
            import pyautogui
            import pyperclip
            import win32con
            import win32gui
        except Exception as e:
            return None, f"缺少依赖（pyautogui / pyperclip / pywin32）：{e}"

        client = detect_client(force=True)
        hwnd = client.get("hwnd")
        if not hwnd:
            return None, client.get("reason") or "没找到微信主窗口"

        # 最小化到托盘时窗口只是被隐藏：临时拉出来，拉取结束后再收回去，
        # 保持用户原来的状态（不擅自把微信留在屏幕上）。
        was_hidden = not win32gui.IsWindowVisible(hwnd)
        if was_hidden:
            try:
                win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
                time.sleep(0.5)
            except Exception as e:
                return None, f"微信窗口已最小化到托盘，且无法自动恢复：{e}"
            if not win32gui.IsWindowVisible(hwnd):
                return None, "微信窗口已最小化到托盘，请先手动打开微信窗口再拉取"
            self.last_meta["windowRestored"] = True

        L, T, R, B = win32gui.GetWindowRect(hwnd)
        w, h = R - L, B - T
        if w < 500 or h < 360:
            return None, f"微信窗口太小（{w}x{h}），请先放大到正常尺寸再拉取"

        left = L + int(w * self.LEFT_RATIO)
        right = L + int(w * self.RIGHT_RATIO)
        top = T + int(h * self.TOP_RATIO)
        bottom = T + int(h * self.BOTTOM_RATIO)
        self.last_meta["region"] = [left, top, right, bottom]
        mx = (left + right) // 2

        prev_fg = win32gui.GetForegroundWindow()
        try:
            backup = pyperclip.paste()
        except Exception:
            backup = None

        probe = "__linkhub_pull_probe__"
        try:
            # 1) 置前，并且必须校验真的成功了（否则会去别的窗口上拖选）
            if not _force_foreground(hwnd):
                return None, (
                    "无法把微信窗口切到前台（系统前台锁定）。"
                    "请先手动点一下微信窗口，再重试拉取。"
                )
            self.last_meta["focusForced"] = True
            time.sleep(0.45)

            # 2) 逐点尝试拖选 + 复制，命中即停
            last_hint = "当前会话可能没有消息"
            points = list(self._start_points(left, right, top, bottom))
            if start_offset:
                points = points[start_offset % len(points):] + points[:start_offset % len(points)]
            for sx, sy in points:
                self.last_meta["attempts"] += 1
                # 拖到对角：微信按"鼠标扫过的范围"来决定选中哪几条，
                # 只拖到同侧底部会漏掉半边消息（实测起点在右下时只选了最后一条）。
                ex, ey = (left, top) if sx > mx else (right, top)
                try:
                    pyperclip.copy(probe)
                    pyautogui.moveTo(sx, sy)
                    time.sleep(0.1)
                    pyautogui.mouseDown()
                    time.sleep(0.18)
                    pyautogui.moveTo((sx + ex) // 2, (sy + ey) // 2, duration=0.3)
                    pyautogui.moveTo(ex, ey, duration=0.3)
                    time.sleep(0.2)
                    pyautogui.mouseUp()
                    time.sleep(0.25)
                    pyautogui.hotkey("ctrl", "c")
                    time.sleep(0.5)
                    got = pyperclip.paste()
                except Exception as e:
                    last_hint = f"拖选出错：{e}"
                    got = probe
                if got and got != probe and got.strip():
                    return got, None
                try:
                    pyautogui.press("esc")
                except Exception:
                    pass
                time.sleep(0.1)

            return None, (
                "没能在当前会话里选中任何消息（已换 "
                f"{self.last_meta['attempts']} 个起点都未命中气泡）。"
                f"请确认微信窗口里这个会话确实有消息、且窗口没有被其它窗口遮挡。"
            )
        except Exception as e:
            return None, f"拖选复制失败：{e}"
        finally:
            try:
                pyautogui.press("esc")        # 取消选中，不留下高亮
            except Exception:
                pass
            if backup is not None:
                try:
                    pyperclip.copy(backup)    # 还原用户原来的剪贴板
                except Exception:
                    pass
            if prev_fg and prev_fg != hwnd:
                self.last_meta["focusRestored"] = _force_foreground(prev_fg, timeout=1.0)
            else:
                self.last_meta["focusRestored"] = True
            # 原本最小化到托盘：把窗口收回去，别把微信留在屏幕上
            if was_hidden:
                try:
                    win32gui.ShowWindow(hwnd, win32con.SW_HIDE)
                    self.last_meta["windowRestored"] = False
                except Exception:
                    pass


def forward_to_linkhub(message):
    """
    POST 到 LinkHub webhook；返回 (ok, detail, duplicate)。

    后端的幂等键命中时会回 `{"ok":true,"duplicate":true}`。把这一点区分出来，
    调用方才不会把"后端已去重"报成"又转发了 N 条"。
    失败如实返回，不吞异常。
    """
    body = json.dumps(message, ensure_ascii=False).encode("utf-8")
    req = Request(
        LINKHUB_WEBHOOK,
        data=body,
        headers={"Content-Type": "application/json", "x-signature": SIGNATURE},
        method="POST",
    )
    try:
        with urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8", "replace")
            dup = False
            try:
                dup = bool(json.loads(raw).get("duplicate"))
            except Exception:
                dup = False
            return True, raw[:200], dup
    except HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}", False
    except URLError as e:
        return False, f"后端不可达: {e.reason}", False


def build_inbound(sender, text, conversation=None, conv_type="p2p", msg_type="text", attachments=None):
    ts = int(time.time() * 1000)
    msg = {
        "externalId": make_external_id(sender, text, ts),
        "from": sender,
        "senderId": sender,
        "conversation": conversation or sender,
        "conversationType": conv_type,
        "text": text,
        "type": msg_type,
        "at": ts,
    }
    if attachments:
        msg["attachments"] = attachments
    return msg


def save_attachments(items):
    """
    后端发来的附件 base64 落盘，返回本地路径列表。内容不写日志。

    任何一个附件解不出来都**直接抛错**（调用方在发文本之前就调用本函数）：
    宁可整条发送失败，也不静默少发一个文件——"多附件只发第一个/丢一个"是明确要修的问题。
    """
    import base64
    if not items:
        return []
    os.makedirs(OUTBOX_DIR, exist_ok=True)
    # 每次发送独立目录：文件名必须保持原样（不能给接收方看到 <时间戳>-原名），
    # 同时避免同名文件互相覆盖；发送结束由 _handle_send 清理。
    send_dir = os.path.join(OUTBOX_DIR, "send-" + uuid.uuid4().hex)
    os.makedirs(send_dir, exist_ok=True)
    paths = []
    failures = []
    for a in items or []:
        name = os.path.basename(str(a.get("name", "file"))) or "file"
        data = a.get("contentBase64") or ""
        try:
            raw = base64.b64decode(data, validate=True)
        except Exception:
            failures.append(f"{name}（base64 解码失败）")
            continue
        if not raw:
            failures.append(f"{name}（内容为空）")
            continue
        path = os.path.join(send_dir, name)
        try:
            with open(path, "wb") as f:
                f.write(raw)
        except OSError as e:
            failures.append(f"{name}（写入失败：{e}）")
            continue
        paths.append(path)
    if failures:
        shutil.rmtree(send_dir, ignore_errors=True)
        raise RuntimeError("附件落盘失败：" + "；".join(failures))
    return paths


# ---------------------------------------------------------------------------
# 收消息：UI Automation 读取微信窗口
# ---------------------------------------------------------------------------
class WechatUiaReader:
    """
    用 Windows UI Automation 读微信桌面端的消息。

    说清楚能力边界（不夸大）：
      - 微信只把「当前打开的会话」的消息暴露在可访问性树里，所以要收多个会话必须点击切换；
      - 不同微信版本的控件树不一样，这里用「控件类型 + 位置」做启发式定位，
        找不到就返回错误，由 /health 的 receive.supported=false 如实体现；
      - 图片/文件消息只能拿到占位文案（如 `[图片]`、`[文件] 方案.pptx`）；
        文件会去微信文件目录里按文件名 + 修改时间找本机落盘路径，供后端下载；
      - 自己发出的消息按气泡水平位置（靠右）排除，避免回声。
    """

    def __init__(self):
        import uiautomation as auto   # 延迟导入：mock 态不需要这个依赖
        self.auto = auto
        self.seen = {}                # conversation -> set(消息指纹)
        self.max_mtime = 2 * 3600     # 只认 2 小时内落盘的文件，避免抓到同名旧文件

    # --- 控件定位 ---
    def _main_window(self):
        """
        只认 3.x 的原生主窗口。

        4.x 那个 Qt 窗口即使拿得到句柄，GetChildren() 也是空的（实测 childCount=0），
        拿它去遍历只会白跑一趟，还会把「版本不兼容」误报成「没登录」。
        """
        st = detect_client()
        if st.get("kind") != "wechat3":
            return None
        for kwargs in (
            {"ClassName": "WeChatMainWndForPC"},
            {"ClassName": "WeChatMainWndForPC", "searchDepth": 1},
        ):
            try:
                w = self.auto.WindowControl(**kwargs)
                if w.Exists(0.3):
                    return w
            except Exception:
                continue
        return None

    @staticmethod
    def _walk(ctrl, depth=0, max_depth=6):
        if depth > max_depth:
            return
        try:
            children = ctrl.GetChildren()
        except Exception:
            return
        for child in children:
            yield child
            yield from WechatUiaReader._walk(child, depth + 1, max_depth)

    @staticmethod
    def _rect(ctrl):
        try:
            return ctrl.BoundingRectangle
        except Exception:
            return None

    def _lists(self, window):
        """按位置区分「左侧会话列表」与「右侧消息列表」。"""
        sessions, messages = [], []
        wrect = self._rect(window)
        if wrect is None:
            return sessions, messages
        for c in self._walk(window):
            if c.ControlTypeName != "ListControl":
                continue
            r = self._rect(c)
            if r is None:
                continue
            width = r.right - r.left
            height = r.bottom - r.top
            if width < 80 or height < 80:
                continue
            if width <= 420 and r.left <= wrect.left + 420:
                sessions.append(c)
            else:
                messages.append(c)
        return sessions, messages

    @staticmethod
    def _items(ctrl):
        try:
            return [c for c in ctrl.GetChildren() if c.ControlTypeName == "ListItemControl"]
        except Exception:
            return []

    def _text_of(self, item):
        name = (item.Name or "").strip()
        if name:
            return name
        parts = []
        for c in self._walk(item, 0, 3):
            if c.ControlTypeName == "TextControl":
                t = (c.Name or "").strip()
                if t:
                    parts.append(t)
        return " ".join(parts).strip()

    def _unread_count(self, item):
        """会话项里的纯数字徽标就是未读数；识别不到就返回 0（不猜）。"""
        for c in self._walk(item, 0, 3):
            if c.ControlTypeName != "TextControl":
                continue
            t = (c.Name or "").strip()
            if t.isdigit() and 0 < int(t) <= 99:
                return int(t)
        return 0

    def _is_self(self, item, list_rect):
        """自己发的消息气泡靠右：用气泡中心相对列表中心判断。"""
        r = self._rect(item)
        if r is None or list_rect is None:
            return False
        center = (r.left + r.right) / 2
        mid = (list_rect.left + list_rect.right) / 2
        return center > mid + 20

    # --- 文件定位（入站附件） ---
    def _resolve_inbound_file(self, name):
        if not name:
            return None
        name = name.strip()
        if not name or "/" in name or "\\" in name:
            return None
        deadline = time.time() - self.max_mtime
        for root in wechat_file_roots():
            for dirpath, dirnames, filenames in os.walk(root):
                # 只往最近改过的目录里钻，避免全盘扫描拖慢轮询
                dirnames[:] = [
                    d for d in dirnames
                    if not d.startswith(".")
                    and self._dir_recent(os.path.join(dirpath, d), deadline)
                ]
                for fn in filenames:
                    if fn != name and not fn.endswith(name):
                        continue
                    p = os.path.join(dirpath, fn)
                    try:
                        if os.path.getmtime(p) >= deadline:
                            return p
                    except OSError:
                        continue
        return None

    @staticmethod
    def _dir_recent(path, deadline):
        try:
            return os.path.getmtime(path) >= deadline
        except OSError:
            return False

    # --- 主流程 ---
    def poll(self):
        """返回 (messages, error_reason)。error_reason 为 None 表示这轮正常。"""
        window = self._main_window()
        if window is None:
            # 直接用版本探测的结论：4.x 说"版本不兼容"，没开说"没找到窗口"
            return [], detect_client()["reason"]
        sessions, messages = self._lists(window)
        if not sessions or not messages:
            return [], (
                "找到了微信窗口但读不到会话列表/消息列表控件："
                f"窗口类 {CLIENT.get('class')}，可能该版本控件树结构有变，需适配 _lists()"
            )

        out = []
        candidates = self._items(sessions)
        if NO_SWITCH:
            # 只读当前会话：不点列表，取"当前打开的那个"由用户决定
            candidates = []
            current = self._current_conversation(sessions)
            if current is not None:
                candidates = [current]

        for item in candidates[:MAX_SESSIONS_PER_POLL]:
            conv = (item.Name or "").strip()
            if not conv:
                continue
            unread = self._unread_count(item)
            if not NO_SWITCH and unread == 0 and not SCAN_ALL:
                continue
            if not NO_SWITCH:
                try:
                    item.Click(simulateMove=False)
                except Exception as e:
                    RECEIVE["lastError"] = f"切换会话失败（{conv}）：{e}"
                    continue
                time.sleep(0.35)
                _, messages = self._lists(window)
                if not messages:
                    continue

            mlist = messages[0]
            list_rect = self._rect(mlist)
            all_items = self._items(mlist)
            start_index = max(0, len(all_items) - MAX_MESSAGES_PER_CONV)
            items = all_items[-MAX_MESSAGES_PER_CONV:]
            seen = self.seen.setdefault(conv, set())
            fresh = []
            for idx, mi in enumerate(items, start=start_index):
                text = self._text_of(mi)
                if not text:
                    continue
                # 位置参与指纹：同一会话两条「好的」不再共用幂等键。
                key = hashlib.sha1(f"{conv}|{idx}|{text}".encode("utf-8", "replace")).hexdigest()[:16]
                if key in seen:
                    continue
                fresh.append((key, idx, mi, text))

            # 首次打开某会话：按未读数取尾部，避免把整段历史灌进系统
            if not seen and unread > 0:
                fresh = fresh[-unread:]

            for key, idx, mi, text in fresh:
                seen.add(key)
                if self._is_self(mi, list_rect):
                    continue
                msg = self._build_message(conv, text, idx)
                if msg:
                    out.append(msg)
        return out, None

    def _current_conversation(self, sessions):
        """--no-switch：取会话列表里"已选中"或在最顶上的那一个（顶部通常是当前会话）。"""
        items = self._items(sessions)
        for item in items:
            try:
                if item.GetSelectionItemPattern().IsSelected:
                    return item
            except Exception:
                continue
        return items[0] if items else None

    def _build_message(self, conversation, text, index=None):
        """把一条气泡文案翻译成统一入站事件（含类型/发送方/附件 token）。"""
        body = text.strip()
        if not body:
            return None

        # 群聊里常见 "张三: 你好"；只在冒号前是短昵称时按发送方解析
        sender, sender_name = conversation, body
        conv_type = "p2p"
        m = re.match(r"^([^:：\n]{1,12})[:：]\s+(.+)$", body, re.S)
        if m and " " not in m.group(1):
            sender_name, body = m.group(1), m.group(2).strip()
            conv_type = "group"

        msg_type = "text"
        attachments = []
        fm = re.match(r"^\[(图片|视频|语音|动画表情|文件|链接|位置|名片|小程序|转账|红包)\]\s*(.*)$", body)
        if fm:
            kind, rest = fm.group(1), (fm.group(2) or "").strip()
            msg_type = "image" if kind in ("图片", "动画表情", "视频") else "file"
            if kind == "文件" and rest:
                path = self._resolve_inbound_file(rest)
                item = {"name": rest}
                if path:
                    try:
                        item["token"] = issue_file_token(path)
                        item["size"] = os.path.getsize(path)
                    except OSError:
                        pass
                attachments.append(item)

        msg = build_inbound(
            sender if conv_type == "p2p" else sender_name,
            body,
            conversation,
            conv_type,
            msg_type,
            attachments,
        )
        # 稳定幂等键：位置区分同文消息；重启重读同一位置仍去重（见 make_stable_id）。
        msg["externalId"] = make_stable_id(
            conversation,
            sender if conv_type == "p2p" else sender_name,
            body,
            index,
        )
        return msg


def read_new_messages(desktop):
    """
    收消息钩子：返回 (messages, error_reason)。

    默认实现走 WechatUiaReader（UI Automation）。如果你的微信版本控件树特殊，
    可以替换这个函数（返回同样的结构）而不必改其它链路。
    """
    if _reader is None:
        return [], "读取器未初始化"
    return _reader.poll()


def watch_loop(desktop):
    """RPA 态收消息轮询：每轮读窗口 → 去重 → 转发 webhook。"""
    global _reader
    try:
        _reader = WechatUiaReader()
        st = detect_client(force=True)
        RECEIVE["supported"] = False
        RECEIVE["reason"] = (
            "UI Automation 已加载，等待第一轮读取"
            if st.get("kind") == "wechat3"
            else st["reason"]
        )
        log("收消息轮询已启动：UI Automation 读取微信窗口（会切换会话；加 --no-switch 只读当前会话）")
        if st.get("kind") != "wechat3":
            log("⚠ 真实接收不可用：" + st["reason"])
            log("  → 发送不受影响；/health 的 receive.supported 会保持 false，后端不会报「已就绪」。")
    except Exception as e:
        RECEIVE["supported"] = False
        RECEIVE["reason"] = f"UI Automation 不可用：{e}"
        log("收消息未启动：" + str(RECEIVE["reason"]))
        log("  → 发送功能不受影响；需要接收请 pip install uiautomation 后以 --mode rpa 重启。")
        return

    while not _stop.is_set():
        RECEIVE["lastPollAt"] = now_iso()
        try:
            msgs, err = read_new_messages(desktop)
            if err:
                # 读不到窗口/控件就如实降级：后端会把"接收"标成未就绪，而不是继续报 ready
                RECEIVE["supported"] = False
                RECEIVE["reason"] = err
                RECEIVE["lastError"] = err
            else:
                RECEIVE["supported"] = True
                RECEIVE["reason"] = "轮询正常：可读取微信窗口消息"
                RECEIVE["lastError"] = None
            for m in msgs:
                key = m.get("externalId") or make_external_id(
                    m.get("from", ""), m.get("text", ""), m.get("at", 0)
                )
                ok, detail, _dup = forward_to_linkhub(m)
                if ok:
                    RECEIVE["forwarded"] += 1
                log(f"入站转发 {key}: {'OK' if ok else 'FAIL'} {detail[:80]}")
        except Exception as e:
            RECEIVE["lastError"] = str(e)
            log(f"轮询异常（已忽略，下一轮重试）: {e}")
        _stop.wait(POLL_INTERVAL)


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 静默 access log，避免把消息内容打到控制台（安全约定）
        pass

    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8", "replace"))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(200, {
                "ok": True,
                "mode": MODE,
                "linkhub": LINKHUB_BASE,
                "signature": SIGNATURE,
                "queued": len(_queue),
                "sent": len(_sent_log),
                "sendReal": MODE == "rpa",
                # 后端凭这一段判断"能不能真收"，不再靠猜
                "receive": dict(RECEIVE),
                # 本机微信是什么版本、为什么能/不能读，一眼可见
                "client": dict(CLIENT),
                # 按需拉取（4.x 的可用接收方式）：拖选复制，拿原文零误差
                "pull": {
                    "implemented": True,
                    "available": MODE == "rpa" and bool(CLIENT.get("hwnd")),
                    "mode": "clipboard-drag",
                    "selfName": _SELF_NAME or None,
                    "pulled": len(_pulled_seen),
                    "scope": "只覆盖当前打开的会话与可视区；会抢前台并短暂选中文本",
                    **({} if _SELF_NAME else {
                        "warning": "未配置 --self-name：自己发的消息可能被当成入站",
                    }),
                },
                "note": "MOCK 态不会操作真实微信；RPA 态需 --mode rpa 且已登录微信桌面端。",
            })
        elif path == "/file":
            self._handle_file(parse_qs(urlparse(self.path).query))
        elif path == "/queue":
            with _lock:
                items = list(_queue)
            self._json(200, {"ok": True, "items": items})
        elif path == "/":
            self._json(200, {"ok": True, "service": "wechat-rpa-bridge", "mode": MODE})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def _handle_file(self, query):
        token = (query.get("token") or [""])[0]
        if token:
            raw = resolve_file_token(token)
            if not raw:
                self._json(404, {"ok": False, "error": "文件 token 无效或已过期（桥重启后需重新拉取该会话）"})
                return
        else:
            # 旧版后端兼容：仍允许 path，但新版消息只发 token。
            raw = (query.get("path") or [""])[0]
        real, err = resolve_servable_path(raw)
        if err:
            status = 413 if "过大" in err else 409
            self._json(status, {"ok": False, "error": err})
            return
        try:
            with open(real, "rb") as f:
                data = f.read()
        except OSError as e:
            self._json(500, {"ok": False, "error": f"读取失败：{e}"})
            return
        ctype = mimetypes.guess_type(real)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header(
            "Content-Disposition",
            "attachment; filename*=UTF-8''" + quote(os.path.basename(real)),
        )
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            data = self._read()
        except Exception as e:
            self._json(400, {"ok": False, "error": f"bad json: {e}"})
            return

        if path == "/send":
            self._handle_send(data)
        elif path == "/pull":
            self._handle_pull(data)
        elif path == "/ingest":
            self._handle_ingest(data)
        elif path == "/mock/inject":
            self._handle_mock_inject(data)
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def _handle_pull(self, data):
        """
        按需拉取当前会话的可视消息。

        这是 4.x 上唯一"不读内存、不装旧版"的接收方式：走剪贴板复制拿原文。
        返回里如实带上能力边界，界面可以直接照抄给用户看。
        """
        if MODE != "rpa":
            self._json(409, {
                "ok": False,
                "error": "桥在 mock 模式，不会操作真实微信。请用 --mode rpa 重启桥。",
                "mode": MODE,
            })
            return

        conversation = str(data.get("conversation", "") or "").strip() or "微信当前会话"
        conv_type = "group" if str(data.get("conversationType", "") or "").strip() == "group" else "p2p"
        self_name = str(data.get("selfName", "") or "").strip() or _SELF_NAME

        reader = WechatVisualReader()
        raw, err = reader.pull_text()
        meta = dict(reader.last_meta or {})
        if err:
            with _lock:
                RECEIVE["lastError"] = err
            self._json(502, {"ok": False, "error": err, "conversation": conversation, "meta": meta})
            return

        items, stats = parse_clipboard(raw, conversation, self_name or None)
        if not items:
            # 第一次可能选中了系统提示/空白/非消息文本；换一个拖选起点再试一次。
            # 4.x 的布局不能靠控件树校验，只能靠“解析结果”判断，重试比直接失败更稳。
            retry = WechatVisualReader()
            raw2, err2 = retry.pull_text(start_offset=1)
            if not err2:
                items2, stats2 = parse_clipboard(raw2, conversation, self_name or None)
                if items2:
                    raw, items, stats = raw2, items2, stats2
                    meta = dict(retry.last_meta or {})
                    meta["retried"] = True

        if not items:
            # 「拖选成功但一条也没解析出来」不是成功：可能是拖选区不对、
            # 当前会话为空，或 4.x 布局变了。返回 422 让界面明确失败，不能 toast 成功。
            with _lock:
                RECEIVE["lastError"] = "没有从当前选中内容解析出任何消息"
            self._json(422, {
                "ok": False,
                "error": "没有从当前选中内容解析出任何消息：请确认微信里打开的是目标会话、窗口已放大，且选区覆盖到消息气泡",
                "conversation": conversation,
                "conversationVerified": False,
                "parsed": 0,
                "forwarded": 0,
                "duplicates": 0,
                "failed": [],
                "stats": stats,
                "meta": meta,
            })
            return

        forwarded, duplicates, failed = 0, 0, []
        for item in items:
            payload = build_pulled_inbound(item, conversation, conv_type)
            key = payload["externalId"]
            with _lock:
                if key in _pulled_seen:
                    duplicates += 1
                    continue
            ok, detail, dup = forward_to_linkhub(payload)
            if ok:
                with _lock:
                    _pulled_seen.add(key)
                if dup:
                    # 后端幂等键命中：这条本来就在库里，别报成"又转发了"
                    duplicates += 1
                    continue
                forwarded += 1
                with _lock:
                    _pulled_log.append({
                        "at": now_iso(),
                        "conversation": conversation,
                        "sender": item["sender"],
                        "chars": len(item["text"]),
                    })
            else:
                failed.append({"sender": item["sender"], "error": detail})

        with _lock:
            RECEIVE["lastPollAt"] = now_iso()
            RECEIVE["forwarded"] += forwarded
            if not failed:
                RECEIVE["lastError"] = None
        log(
            f"[PULL] 会话「{conversation}」：解析 {len(items)} 条，转发 {forwarded}，"
            f"去重 {duplicates}，失败 {len(failed)}"
        )
        self._json(200 if not failed else 207, {
            "ok": not failed,
            "conversation": conversation,
            # 4.x 从外部读不到当前会话标题，conversation 是用户手填的，无法自动核对。
            "conversationVerified": False,
            "parsed": len(items),
            "forwarded": forwarded,
            "duplicates": duplicates,
            "failed": failed,
            "stats": stats,
            "selfName": self_name or None,
            # 能力边界：不夸大，界面照抄即可
            "scope": [
                "只覆盖当前打开的这个会话（4.x 无控件树，无法从外部切换会话）",
                "只覆盖可视区（滚出屏幕的历史拉不到）",
                "执行期间会抢前台并短暂选中文本，结束后已还原剪贴板与前台窗口",
            ],
            "meta": meta,
            **({"focusWarning": "未能把焦点切回原来的窗口，请手动点一下你正在用的窗口"} if not meta.get("focusRestored", True) else {}),
            **({"warning": "未配置本人昵称（--self-name / WECHAT_SELF_NAME），自己发的消息可能被当成入站"} if not self_name else {}),
        })

    def _handle_send(self, data):
        text = str(data.get("text", "") or "")
        contact = str(data.get("conversation", "") or "")
        trace = str(data.get("traceId", "") or "")
        atts = data.get("attachments") or []
        message_id = "rpa-" + uuid.uuid4().hex[:16]

        if MODE == "mock":
            # 零依赖：只记一条，不碰微信、不发网络请求。
            # mode 必须回 "mock"：后端会核对，绝不会把它写成真实送达。
            with _lock:
                _sent_log.append({"at": now_iso(), "to": contact, "chars": len(text), "files": len(atts), "traceId": trace})
            log(f"[MOCK] 模拟发送 -> {contact or '(当前会话)'}：{len(text)} 字，{len(atts)} 文件（未真实发送）")
            self._json(200, {"ok": True, "messageId": message_id, "mode": "mock"})
            return

        # RPA 态：真实操作微信桌面端；失败抛错由后端写入 failed，绝不假装成功
        paths = []
        try:
            desktop = _get_desktop()
            # 先聚焦，再落盘/按键；聚焦失败必须中止，不能把 Ctrl+F/粘贴打到别的窗口。
            if not desktop.focus_wechat():
                raise RuntimeError("无法聚焦微信窗口，已中止发送（没有把按键打到别的窗口）")

            verified = True
            if contact:
                # 3.x 能校验当前会话；4.x 返回 False 表示只能提交、无法核对。
                verified = desktop.open_chat(contact)

            paths = save_attachments(atts)
            if text:
                desktop.send_text("", text)
            if paths:
                desktop.send_files(paths)
            with _lock:
                _sent_log.append({"at": now_iso(), "to": contact, "chars": len(text), "files": len(paths), "traceId": trace})
            self._json(200, {
                "ok": True,
                "messageId": message_id,
                "mode": "rpa",
                "files": len(paths),
                "verified": bool(verified),
            })
        except Exception as e:
            log(f"[RPA] 发送失败: {e}")
            self._json(500, {"ok": False, "error": str(e)})
        finally:
            # 附件只是发送中转，不留在 outbox 里堆积（也不泄露用户文件）。
            # 延迟清理：微信粘贴文件后可能异步读取，立刻删会偶发「文件不存在」。
            for p in paths:
                parent = os.path.dirname(p)
                if os.path.dirname(parent) == os.path.realpath(OUTBOX_DIR) and os.path.basename(parent).startswith("send-"):
                    timer = threading.Timer(30.0, shutil.rmtree, args=(parent,), kwargs={"ignore_errors": True})
                    timer.daemon = True
                    timer.start()

    def _handle_ingest(self, data):
        m = dict(data or {})
        if not m.get("externalId"):
            m = build_inbound(
                str(m.get("from", "微信好友")),
                str(m.get("text", "")),
                m.get("conversation"),
                m.get("conversationType", "p2p"),
                m.get("type", "text"),
                m.get("attachments"),
            )
        ok, detail, _dup = forward_to_linkhub(m)
        if ok:
            with _lock:
                _queue.append({"at": now_iso(), "externalId": m.get("externalId")})
        self._json(200 if ok else 502, {"ok": ok, "externalId": m.get("externalId"), "detail": detail})

    def _handle_mock_inject(self, data):
        if MODE != "mock":
            self._json(400, {"ok": False, "error": "仅在 --mode mock 下可用"})
            return
        m = build_inbound(
            str(data.get("from", "微信好友（模拟）")),
            str(data.get("text", "这是一条模拟入站消息")),
            data.get("conversation"),
            data.get("conversationType", "p2p"),
            data.get("type", "text"),
            data.get("attachments"),
        )
        ok, detail, _dup = forward_to_linkhub(m)
        if ok:
            with _lock:
                _queue.append({"at": now_iso(), "externalId": m["externalId"], "preview": m["text"][:40]})
        self._json(200 if ok else 502, {"ok": ok, "externalId": m["externalId"], "detail": detail})


_desktop = None


def _get_desktop():
    global _desktop
    if _desktop is None:
        _desktop = WechatDesktop()
    return _desktop


def main():
    global MODE, POLL_INTERVAL, SCAN_ALL, NO_SWITCH
    init_console_encoding()
    init_dpi_awareness()
    ap = argparse.ArgumentParser(description="微信 RPA 桥（LinkHub 的微信个人版通道）")
    ap.add_argument("--mode", choices=["mock", "rpa"], default=os.environ.get("WECHAT_BRIDGE_MODE", "mock"),
                    help="mock=零依赖自测（默认）；rpa=真实操作微信桌面端")
    ap.add_argument("--port", type=int, default=int(os.environ.get("WECHAT_BRIDGE_PORT", "8787")))
    ap.add_argument("--linkhub", default=LINKHUB_BASE, help="LinkHub 后端地址")
    ap.add_argument("--poll-interval", type=float, default=2.0, help="RPA 态收消息轮询间隔（秒）")
    ap.add_argument("--scan-all", action="store_true",
                    help="不只看有未读的会话（会频繁切换会话，默认关闭）")
    ap.add_argument("--no-switch", action="store_true",
                    help="只读当前打开的会话，不点击会话列表（不抢焦点，但只能收当前会话）")
    ap.add_argument("--self-name", default=_SELF_NAME,
                    help="你自己的微信昵称：过滤掉「自己发的消息」，避免被当成入站（也可用 WECHAT_SELF_NAME）")
    args = ap.parse_args()

    MODE = args.mode
    POLL_INTERVAL = args.poll_interval
    SCAN_ALL = args.scan_all
    NO_SWITCH = args.no_switch
    globals()["_SELF_NAME"] = (args.self_name or "").strip()
    globals()["LINKHUB_BASE"] = args.linkhub.rstrip("/")
    globals()["LINKHUB_WEBHOOK"] = args.linkhub.rstrip("/") + "/api/webhook/wechat"
    if MODE == "mock":
        RECEIVE["supported"] = False
        RECEIVE["reason"] = "桥运行在 mock 模式：不读取微信窗口，入站只能 /mock/inject"

    log(f"启动：mode={MODE} port={args.port} linkhub={LINKHUB_BASE}")
    global _watch_thread
    if MODE == "rpa":
        try:
            _get_desktop()
            st = detect_client(force=True)
            log("RPA 依赖就绪。微信客户端：" + st["reason"])
            if st.get("kind") == "weixin4":
                # 4.x 没有控件树：自动轮询注定读到 0 条，与其空转并反复报错，
                # 不如关掉轮询，明确告诉用户"接收请用按需拉取"。
                RECEIVE["supported"] = False
                RECEIVE["reason"] = "微信 4.x 不暴露控件树，自动轮询不可用；接收请用 POST /pull 按需拉取当前会话"
                log("该版本不暴露控件树：已关闭自动轮询，发送可用；接收请用「按需拉取」（POST /pull）")
                if not _SELF_NAME:
                    log("提示：加 --self-name 你的微信昵称，可过滤掉自己发的消息。")
            else:
                _watch_thread = threading.Thread(target=watch_loop, args=(_get_desktop(),), daemon=True)
                _watch_thread.start()
        except Exception as e:
            log("致命：" + str(e))
            sys.exit(2)

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"监听 http://127.0.0.1:{args.port}  （Ctrl+C 停止）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("停止中…")
        _stop.set()
        srv.shutdown()


if __name__ == "__main__":
    main()
