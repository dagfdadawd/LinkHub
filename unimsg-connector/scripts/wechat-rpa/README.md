# 微信个人版 · RPA 桥

微信个人版没有官方收发 API，这个桥用 RPA（模拟键鼠操作微信桌面端）把它接进 LinkHub，
与飞书/钉钉/邮箱三个"官方 API 平台"并列为第四个平台通道。

## 一句话理解

```
收：微信桌面端 --(桥轮询读消息)--> POST /api/webhook/wechat --> LinkHub 收件箱
发：LinkHub 回复 --> connector.send() --> 桥 /send --(模拟键鼠)--> 微信桌面端
```

桥是独立 Python 进程，只监听 `127.0.0.1:8787`，不碰 LinkHub 源码运行。

## 两种模式（如实区分，绝不把模拟说成真实）

| 模式 | 依赖 | 行为 | 用途 |
|---|---|---|---|
| `mock`（默认） | 无（纯 Python 标准库） | 不发真消息、不碰微信窗口；`/send` 只回 `rpa-mock` 凭证（后端会核对 `mode`，不会当成真实送达） | 链路自测、离线演示 |
| `rpa` | `pyautogui` + `pyperclip` + `pywin32` + `uiautomation` + **微信 3.9.x** | 真实操作本机微信桌面端收发（发送键鼠模拟，接收 UI Automation 读窗口） | 真实接入 |

## 快速开始（MOCK，零依赖，马上能跑）

```bash
# 1) 起桥（终端 1）
python rpa_bridge.py --mode mock --port 8787

# 2) 另开终端，注入一条模拟入站消息（会在 LinkHub 收件箱出现）
curl -X POST http://127.0.0.1:8787/mock/inject \
  -H "Content-Type: application/json" \
  -d '{"from":"张三","text":"明天 10:00 交周报","conversation":"项目群"}'

# 3) 看运行状态
curl http://127.0.0.1:8787/health
```

前提：LinkHub 后端在 `http://127.0.0.1:3001`（默认），且 `WECHAT_MODE=mock`（默认即是）。

## 真实接入（RPA，Windows）

### 网站内配置（A 形态：后端与微信同一台电脑）

不需要手改 `.env`：

1. 「平台应用配置」→「微信（RPA）」→ 运行模式选「真实 RPA（real）」；
2. RPA 桥地址保持默认 `http://127.0.0.1:8787`（改过 `--port` 才同步）；
3. 点「启动桥」——后端会用固定参数拉起 `rpa_bridge.py --mode rpa`；
4. 保存模式后重启 LinkHub（`WECHAT_MODE` 是启动配置）；
5. 页面上的「检测桥」会显示 `mode`、`client.kind`、`receiveMode`。

前提仍是每个用户自己的电脑：安装 Python 依赖、登录微信桌面端。B 形态（中心服务器多人共用）不能在中心侧操作别人的微信，需要另装本机 Agent。

### 版本要求（先看这个，否则会白折腾）

| 微信版本 | 窗口类名 | 自动接收 | 按需拉取 | 发送 |
|---|---|---|---|---|
| **3.9.x**（`WeChat.exe`） | `WeChatMainWndForPC` | ✅ UI Automation 读窗口，可自动轮询 | ✅ | ✅ 键鼠（Ctrl+F → 粘贴 → 回车） |
| 4.x（`Weixin.exe`） | `Qt51514QWindowIcon` | ❌ 无控件树，读不到 | ✅ 拖选复制（原文零误差） | ⚠️ 键鼠同一套实现；能提交但无法核对当前会话（返回 `verified:false`） |

微信 4.x 的界面是 Qt 5 自绘。实测（4.2.0.53）：主窗口的可访问性树只有 2 个空 `Pane`，
渲染子窗口 `MMUIRenderSubWindowHW` 的 `childCount=0`，**UIA 和 MSAA 都拿不到任何控件** ——
这是腾讯没把自绘层暴露给辅助技术，不是「没登录」也不是「依赖没装」。
（`Weixin.dll` 里连 `QWindowsAccessib` / `QT_ACCESSIBILITY` 字符串都没有，**编译期就裁掉了**，
所以设环境变量、重装同版本都不会有控件树。）

桥启动时会自己识别版本并如实上报，不会含糊其辞：

```json
{
  "client":  { "kind": "weixin4", "uiaUsable": false, "reason": "检测到微信 4.x（Weixin，Qt 自绘）…接收走按需拉取" },
  "receive": { "supported": false, "reason": "微信 4.x 不暴露控件树，自动轮询不可用；接收请用 POST /pull 按需拉取" },
  "pull":    { "available": true, "mode": "clipboard-drag", "selfName": null },
  "sendReal": true
}
```

### 4.x 怎么「收」：`POST /pull` 按需拉取

不走控件树，走**选中复制**这条正规路径：

1. 把微信窗口置前（最小化到托盘时会临时拉出来，拉完再收回去）；
2. 在消息区拖选（起点依次试几个「最可能有气泡」的位置——微信只有按在气泡上才进入选择模式）；
3. `Ctrl+C` → 读剪贴板 → 按「昵称 / 时间 / 正文」解析 → 去重 → 转发给 LinkHub；
4. 还原剪贴板与前台窗口。

```bash
curl -X POST http://127.0.0.1:8787/pull -H "Content-Type: application/json" \
  -d '{"conversation":"项目群","selfName":"我的微信昵称"}'
```

返回里带能力边界（如实照抄，不夸大）：

```json
{
  "ok": true, "parsed": 3, "forwarded": 3, "duplicates": 0, "failed": [],
  "scope": [
    "只覆盖当前打开的这个会话（4.x 无控件树，无法从外部切换会话）",
    "只覆盖可视区（滚出屏幕的历史拉不到）",
    "执行期间会抢前台并短暂选中文本，结束后已还原剪贴板与前台窗口"
  ]
}
```

要点：

- **`selfName` 建议一定要给**：复制文本里自己发的消息也带昵称；给了才能把自己发的消息标成
  `direction=out`（显示在右侧、不计未读），不给就分不清谁说的（`/health` 的 `pull.warning` 会提示）。
  自己发的消息**不会被丢弃**，会和对方消息一起返回。
- **`conversation` 由人确认**：4.x 从外部读不到当前会话标题，名字填错会把消息挂到错的会话上。
  返回里的 `conversationVerified:false` 就是在提醒这一点；用 `--self-name` 可以在启动时固定自述昵称。
- **`parsed=0` 是失败**：拖选区不对/会话为空时桥返回 422，不会假装「拉取成功」。
- 文件类消息会按名字到 `msg/file/<YYYY-MM>/` 找工作副本，找到就签发一个不透明 `token`，
  LinkHub 通过桥的 `GET /file?token=…` 下载；消息里不出现本机绝对路径。
  找不到就不给 token（界面不会显示假的下载按钮）；桥重启后旧 token 失效，需重新拉取该会话。
- 4.x 启动时**不会**启动自动轮询（那注定读到 0 条），只保留发送与 `/pull`。

### 3.9.x 前置准备（要自动接收就装 3.9）

1. Windows 上登录 **微信 PC 桌面端 3.9.x**，并保持打开（不是最小化到托盘）。
2. 安装依赖：`pip install pyautogui pyperclip pywin32 uiautomation`
3. `.env` 设 `WECHAT_MODE=real`（桥地址默认 `http://127.0.0.1:8787`，可改 `WECHAT_BRIDGE_URL`）。

启动：

```bash
python rpa_bridge.py --mode rpa --port 8787
# 只读当前打开的会话（不抢焦点）：
python rpa_bridge.py --mode rpa --no-switch
# 连没有未读徽标的会话也扫（会更频繁切换会话）：
python rpa_bridge.py --mode rpa --scan-all
```

**发送**：LinkHub 里对微信消息点回复，桥会先聚焦微信窗口 → 按会话名定位联系人 → 剪贴板粘贴文本/文件 → 回车。
多个附件会一次粘贴（构造多文件 `CF_HDROP`），不再只发第一个；附件按原文件名发送，发送结束清理临时目录。

发送结果的真实性：

- 聚焦失败立即中止，不会把按键/文件粘贴打到别的窗口。
- 3.x 搜完会话名会用 UIA 读当前选中会话校验；对不上直接失败，避免发错人/错群。
- 4.x 没有控件树，只能确认聚焦，无法核对当前会话；`/send` 返回 `verified:false`，
  LinkHub 保持 `sent` 并显示「已提交未核对」，不会写成 `synced`。
- 微信 webhook 在 `WECHAT_MODE=real` 时只接受 `x-signature: dev-rpa`，并且只接受本机回环来源；
  `mock`、缺失签名、其它 `dev*`、LAN/公网来源一律 401，避免公共 webhook 被注入。

**接收**：桥用 **UI Automation** 轮询微信窗口消息（`uiautomation`），按会话去重后转发
`POST /api/webhook/wechat`（`x-signature: dev-rpa`）。

接收的硬限制（不是 TODO，是 RPA 的物理限制，写清楚免得误解）：

- 微信只把「当前打开的会话」暴露给可访问性树，所以要自动收多个会话**必须逐一点击会话列表**（会抢焦点）。
  不想被抢焦点就用 `--no-switch`，代价是只能收当前会话。
- 群聊发送方依赖气泡文案里的 `昵称: 正文` 前缀；没有前缀时按会话名归因。
- 只读可访问性文本：图片给 `[图片]`，文件给 `[文件] 名字`。
  文件会到微信文件目录（`~/Documents/WeChat Files`、`~/Documents/xwechat_files`，可用 `WECHAT_FILE_ROOT` 覆盖）
  按文件名 + 最近 2 小时修改时间找本机落盘路径，写入附件 `localPath`，供 LinkHub 下载。
  图片是微信加密的 `.dat`，无法直接还原，只展示占位文案（不提供下载）。
- 没有可靠消息 ID：`externalId` 用「会话 + 发送方 + 正文 + 消息列表位置」的稳定指纹；
  同一会话两条「好的」在不同位置会得到不同 ID，不会互相覆盖；桥重启重读同一位置仍会被去重。
  列表被裁剪/滚动导致位置变化时，极端情况下可能重复入库（比丢消息可接受）。
- 找不到微信窗口/控件时不会瞎猜，`/health` 的 `receive.supported` 会是 `false` 并带原因；
  LinkHub 的「连接账号」页与 `pnpm run doctor --platform=wechat` 会据此显示**未就绪**，不会报假 ready。

## 离线自测（不碰真实微信）

```bash
cd scripts/wechat-rpa
python -m unittest -v test_rpa_bridge.py
```

覆盖：附件原名落盘、拉取 0 条返回 422、纯附件先聚焦、聚焦失败中止、4.x 发送标未核对。

## 控制台中文乱码（Windows）

脚本启动时已把 `stdout/stderr` 切到 UTF-8。若仍乱码，启动前设置环境变量：

```bash
set PYTHONIOENCODING=utf-8            # cmd
$env:PYTHONIOENCODING="utf-8"         # PowerShell
```

## 稳定性与反自动化（赛事要求写明，务必遵守）

- 每条消息随机延迟 300–900ms，**严禁高频群发**。
- 发送前聚焦窗口，发送后核对；失败如实返回错误，由 LinkHub 写入 failed，不假装成功。
- 微信改版/分辨率变化会导致控件定位失效：`receive.supported` 会变 false，需要重新适配
  `WechatUiaReader._lists()` / `_text_of()`；接口结构不变，其它链路无需改动。
- 个人号有**账号风控风险**，只作补充通道，不做 7×24 稳定运行。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 模式、后端地址、队列长度、**`receive` 自动接收能力**、**`pull` 按需拉取能力**、`client` 版本身份 |
| GET | `/file?token=…` | 按桥签发的不透明 token 回吐入站文件字节；仍校验白名单目录，50MB 上限。旧版 `?path=` 保留兼容 |
| GET | `/queue` | MOCK 态已注入队列 |
| POST | `/send` | LinkHub 出站调用：`{text, conversation, senderId, attachments, traceId}`；返回 `mode: mock\|rpa` |
| POST | `/pull` | **按需拉取当前会话**（4.x 用）：`{conversation, conversationType?, selfName?}` → 拖选复制 → 解析 → 转发；返回 `parsed/forwarded/duplicates/failed/scope` |
| POST | `/ingest` | 入站消息转发到 LinkHub webhook（手工补录/调试） |
| POST | `/mock/inject` | MOCK 态手动注入一条入站消息 |
