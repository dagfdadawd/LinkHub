# -*- coding: utf-8 -*-
"""端到端冒烟：三平台接入 → 幂等 → 鉴权 → 回复回写（Mock 标注）→ 状态 synced → trace 回放。

刻意在 mock 模式下跑：不依赖任何真实账号、不触网，验证"零账号也能把闭环走通"，
并断言 Mock 回写必须被如实标注（delivery.mode=mock + sentMock 计数），绝不假成功。

用法：先启动服务（e2e.ps1 / e2e.sh 会自动以 mock 模式启动），再 python scripts/smoke.py [baseUrl]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

# Windows 控制台默认 GBK：显式用 UTF-8 输出，避免中文断言名变成乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001"
# 令牌优先级：显式参数 > 环境变量 > 演示默认值（便于用户改过 API_TOKEN 后手动跑冒烟）
TOKEN = (
    sys.argv[2]
    if len(sys.argv) > 2
    else os.environ.get("LINKHUB_API_TOKEN", "dev-token")
)
PLATFORMS = ["feishu", "dingtalk", "wechat", "mail"]


def req(method, path, body=None, token=None, sig=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    if sig:
        # 微信 RPA 桥的固定 webhook 签名；mock 模式也走同一验签入口
        r.add_header("x-signature", sig)
    try:
        with urllib.request.urlopen(r) as resp:
            ct = resp.headers.get("content-type", "")
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if "json" in ct else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f" | {extra}" if extra else ""))
    if not cond:
        sys.exit(1)


s, h = req("GET", "/api/health")
check("health ok", s == 200 and h.get("ok"), h)
check(
    "health 每个平台都标注了实际通道(mock)",
    all(h.get("modes", {}).get(p) == "mock" for p in PLATFORMS),
    h.get("modes"),
)

feishu = {"schema": "2.0", "event": {"message": {
    "message_id": "om_smoke_1", "message_type": "text",
    "content": json.dumps({"text": "周五前交周报"}),
    "sender": {"sender_id": {"user_id": "u_smoke"}}}}}
s, h = req("POST", "/api/webhook/feishu", feishu)
check("webhook feishu 200", s == 200 and h.get("ok"), h)

s, h = req("POST", "/api/webhook/feishu", feishu)
check("webhook duplicate -> 幂等", h.get("duplicate") is True, h)

dingtalk = {"msgtype": "text", "text": {"content": "周五前交周报"},
            "msgId": "msg_smoke_1", "senderId": "u_dt", "senderNick": "钉钉小王"}
s, h = req("POST", "/api/webhook/dingtalk", dingtalk)
check("webhook dingtalk 200", s == 200, h)

wechat = {"externalId": "wx_smoke_1", "from": "微信好友", "senderId": "u_wx",
          "conversation": "微信好友", "conversationType": "p2p", "text": "周五前交周报", "type": "text"}
s, h = req("POST", "/api/webhook/wechat", wechat, sig="dev-smoke")
check("webhook wechat 200", s == 200, h)

s, h = req("GET", "/api/messages")
check("messages 需鉴权(401)", s == 401, s)

s, h = req("GET", "/api/accounts", token=TOKEN)
accounts = h.get("data", []) if isinstance(h, dict) else []
check(
    "/api/accounts 返回四类数据源且带模式字段",
    s == 200 and len(accounts) == 4
    and all(a.get("mode") == "mock" and a.get("policy") for a in accounts),
    [f"{a.get('platform')}:{a.get('mode')}/{a.get('policy')}" for a in accounts],
)

s, h = req("GET", "/api/messages", token=TOKEN)
check("list 3 条消息", s == 200 and len(h["data"]) == 3, len(h.get("data", [])))
fid = [m for m in h["data"] if m["platform"] == "feishu"][0]["traceId"]

s, h = req("POST", f"/api/messages/{fid}/reply", {"text": "收到，周五前交周报"}, token=TOKEN)
check("reply 202 且入队 processing→replied", s == 202 and h["message"]["status"] == "replied", h["message"]["status"])

time.sleep(0.3)
s, h = req("GET", f"/api/messages/{fid}", token=TOKEN)
check("回写后状态 synced", h["data"]["status"] == "synced", h["data"]["status"])
delivery = h["data"].get("delivery") or {}
check(
    "Mock 回写如实标注 delivery.mode=mock",
    delivery.get("mode") == "mock",
    delivery,
)

s, h = req("GET", f"/api/messages/trace/{fid}", token=TOKEN)
log = h.get("log", [])
events = [e["event"] for e in log]
for ev in ["received", "processing", "replied", "sent", "synced"]:
    check(f"trace 含 {ev}", ev in events, events)
sent_detail = next((e.get("detail", "") for e in log if e["event"] == "sent"), "")
check("sent 日志点名是模拟发送", "模拟发送" in sent_detail, sent_detail)

# ---------------- 人工处理动作：状态流转（含回执）/ 优先级 / 跨平台转发 ----------------
s, h = req("GET", "/api/messages", token=TOKEN)
wid = [m for m in h["data"] if m["platform"] == "wechat"][0]["traceId"]
s, h = req(
    "PATCH", f"/api/messages/{wid}/status",
    {"status": "processing", "notify": True, "note": "已安排同事跟进"}, token=TOKEN,
)
check(
    "状态流转 200 且回执已发（Mock 如实标注）",
    s == 200 and h["data"]["notified"] is True and h["data"]["notifyMode"] == "mock",
    h.get("data"),
)
s, h = req("GET", f"/api/messages/trace/{wid}", token=TOKEN)
check(
    "trace 含 status_notified（回执可回放）",
    "status_notified" in [e["event"] for e in h["log"]],
    [e["event"] for e in h["log"]],
)

s, h = req("PATCH", f"/api/messages/{fid}/priority", {"priority": "urgent"}, token=TOKEN)
check(
    "优先级人工修改（old→new + source=manual）",
    s == 200 and h["data"]["message"]["priority"] == "urgent"
    and h["data"]["message"]["prioritySource"] == "manual",
    h.get("data"),
)

s, h = req(
    "POST", f"/api/messages/{fid}/forward",
    {"platform": "dingtalk", "note": "请钉钉同事跟进"}, token=TOKEN,
)
check(
    "跨平台转发 202 且正文带来源标记",
    s == 202 and h["message"]["platform"] == "dingtalk"
    and "[转发自 feishu]" in h["message"]["body"],
    h.get("message", {}).get("body"),
)

# ---------------- 自动回复：规则命中 → 走同一条回写链路 ----------------
s, h = req(
    "POST", "/api/auto-rules",
    {"keyword": "周报", "replyText": "收到，稍后回复", "priority": 10}, token=TOKEN,
)
check("新建自动回复规则 201", s == 201 and h["data"]["keyword"] == "周报", h.get("data"))

auto_msg = {
    "schema": "2.0",
    "event": {"message": {
        "message_id": "om_smoke_auto", "message_type": "text",
        "content": json.dumps({"text": "周报今天要交"}),
        "sender": {"sender_id": {"user_id": "u_smoke"}},
    }},
}
s, h = req("POST", "/api/webhook/feishu", auto_msg)
check("自动回复：新消息入库", s == 200 and h.get("ok"), h)
time.sleep(1.0)
s, h = req("GET", "/api/messages", token=TOKEN)
am = next((m for m in h.get("data", []) if m.get("externalId") == "om_smoke_auto"), {})
replies = am.get("replies") or []
check(
    "自动回复命中规则且只回一次",
    len(replies) == 1 and replies[0].get("text") == "收到，稍后回复",
    replies,
)
s, h = req("GET", f"/api/messages/trace/{am.get('traceId', '')}", token=TOKEN)
check(
    "trace 含 auto_reply（自动回复可回放）",
    "auto_reply" in [e["event"] for e in h.get("log", [])],
    [e["event"] for e in h.get("log", [])],
)

# ---------------- 通用接入通道（任何采集器按统一格式推消息，幂等） ----------------
ingest_body = {
    "platform": "feishu",
    "externalId": "ext_smoke_1",
    "body": "来自外部采集器的消息",
    "sender": {"id": "collector", "name": "采集器"},
}
s, h = req("POST", "/api/ingest", ingest_body, token=TOKEN)
check("通用接入 202 且首推非重复", s == 202 and h["data"]["duplicate"] is False, h.get("data"))
s, h = req("POST", "/api/ingest", ingest_body, token=TOKEN)
check("通用接入同 externalId 幂等", h["data"]["duplicate"] is True, h.get("data"))

# ---------------- 统计看板 / 只读诊断 ----------------
s, h = req("GET", "/api/stats/overview", token=TOKEN)
data = h.get("data") or {}
check(
    "看板：总数与四平台分布",
    s == 200 and data.get("totals", {}).get("messages", 0) >= 4
    and len(data.get("byPlatform", [])) == 4,
    data.get("totals"),
)
check(
    "看板：规则命中数可见",
    data.get("rules", {}).get("total", 0) >= 1 and data.get("rules", {}).get("hits", 0) >= 1,
    data.get("rules"),
)

s, h = req("GET", "/api/doctor/summary", token=TOKEN)
check(
    "只读诊断摘要：四平台通道齐全",
    s == 200 and len(h.get("data", {}).get("platforms", [])) == 4,
    h.get("data", {}).get("platforms"),
)

s, h = req("GET", "/api/health")
check("健康计数 received>=3 & sent>=1", h.get("received", 0) >= 3 and h.get("sent", 0) >= 1, h)
check("健康计数 sentMock>=1（模拟发送单独可见）", h.get("sentMock", 0) >= 1, h.get("sentMock"))

print("SMOKE OK")
