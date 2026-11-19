# -*- coding: utf-8 -*-
"""接口测试截图辅助：干净地展示 /api/messages 的请求与返回。"""
import sys, json, urllib.request

sys.stdout.reconfigure(encoding="utf-8")

BASE = "http://127.0.0.1:3001"
PATH = "/api/messages?limit=5"
TOKEN = "dev-token"

print("请求: GET " + BASE + PATH)
print("鉴权: Authorization: Bearer " + TOKEN)
print("-" * 66)
try:
    req = urllib.request.Request(BASE + PATH, headers={"Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(req, timeout=5) as r:
        d = json.load(r)
except Exception as e:
    print("请求失败:", e)
    sys.exit(1)

items = d.get("data", d.get("items", [])) if isinstance(d, dict) else d
print("返回: HTTP 200 | ok=%s | 共 %d 条" % (d.get("ok"), len(items)))
print("-" * 66)
print("%-9s %-9s %-7s %s" % ("traceId", "平台", "类型", "内容(前30字)"))
for m in items:
    tid = str(m.get("traceId", ""))[:8]
    plat = str(m.get("platform", ""))
    typ = str(m.get("type", ""))
    body = str(m.get("body", m.get("text", ""))).replace("\n", " ").replace("\r", " ")
    body = body[:30] + ("..." if len(body) > 30 else "")
    print("%-9s %-9s %-7s %s" % (tid, plat, typ, body))
