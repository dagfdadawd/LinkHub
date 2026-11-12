# LinkHub 现场演示脚本（5–8 分钟）

> 原则：**只演示当前真实可用的能力**；真实通道与 Mock / 离线桩必须在画面和口头上都讲清楚，绝不把模拟说成真实。
> 操作人标记：**演示人**（讲 + 操作 UI/手机）/ **助手**（终端、起服务、灌消息）。
> 相关文档：[quickstart.md](quickstart.md) · [personal-identity.md](personal-identity.md)（本人身份） · [swap-accounts.md](swap-accounts.md) · [ai-integration.md](ai-integration.md) · [risk-register.md](risk-register.md) · [README.md](../README.md)

## 演示前 10 分钟检查清单

- [ ] `cd unimsg-connector && pnpm run doctor --platform=dingtalk,mail` → 全 PASS（看到 `✔ 自检通过`、退出码 0）
- [ ] `pnpm e2e` 跑一遍 → **20** 条 PASS + `SMOKE OK`（离线全 Mock，证明环境没坏；约 10–20 秒）
- [ ] 起后端（在 `unimsg-connector/` 下，混合演示形态：飞书/企微 Mock，钉钉/邮箱真实）：
  - PowerShell：`$env:FEISHU_MODE="mock"; $env:WECOM_MODE="mock"` 后执行 `pnpm --filter @unimsg/server start`
  - bash：`FEISHU_MODE=mock WECOM_MODE=mock pnpm --filter @unimsg/server start`
  - 成功信号：`运行模式: 飞书=mock(mock) ... 钉钉=real(auto) ... 邮箱=real(auto)`、`[stream] 钉钉 Stream 已连接`、`[mail] ... 已连接，基线 UID=…`
- [ ] 前端：`packages/web/.env` 两行指向 `http://127.0.0.1:3001` / `dev-token` → `pnpm --filter @unimsg/web dev` → 打开 `http://127.0.0.1:5173`，左下角「真实后端 · 已接入 LinkHub Server」（侧栏底部短标识「已连接」），账号页 4 张卡正常
- [ ] 手机钉钉已登录且能找到机器人；另一个邮箱已登录可发信（怕等轮询可提前 5 分钟发一封）
- [ ] **本人身份（如要演示）**：账号页飞书 / 钉钉身份块「身份 · 谁在收、谁在发」显示 接收 / 发送 = 本人。
  - 飞书：提前完成授权（需管理员先开用户身份权限（含 `offline_access`，授权返回 `refresh_token` 即生效）+ 重定向 URL；**测试应用**改动免审即时生效，正式应用需发布版本），并**提前 1 分钟**发一条测试消息（轮询 5–30s 才有）；**2026-11-12 本机租户 `21001` 已解除、本人身份收发已实测通过**；
  - 钉钉：`dws auth status --readonly --format json` 为 `authenticated: true`；未登录就改用下面的 **fake-dws 离线路线**（现场不要等真人授权）。如确要现场登录：**本机优先点弹窗「用浏览器登录（推荐）」**（loopback 自动回调、不用手输码）；设备码仅远程 / 无浏览器备选，注意约 15 分钟有效期，过期点「重新获取授权码」。
  - 另外准备一条**已连接的本人身份消息**在收件箱里，避免现场等轮询。
- [ ] 群聊演示必须在群里 **@机器人**：钉钉/企微只推被 @ 的群消息，普通群消息平台根本不推送（别承诺"群里所有消息都能聚合"）；群里加的必须是**企业内部应用机器人**，自定义 Webhook 机器人只能发不能收
- [ ] 端口 3001 / 5173 空闲，关闭多余终端、录屏/会议软件；浏览器用无痕窗口
- [ ] **不要投屏** `.env`、doctor 全文；终端只显示清屏后的日志尾部（启动日志里的邮箱已脱敏，但仍不建议整屏投影）
- [ ] 如需现场演示企微真实发送：先确认当前出口 IP 仍在「企业可信 IP」内（`doctor` 会打印出口 IP），否则本场不演示

## 分镜脚本（总时长约 7–8 分钟）

| 时间 | 画面 | 操作 | 成功信号 / 话术 |
|---|---|---|---|
| 0:00–0:30 | 首页 | 演示人：一句话痛点「消息散在飞书/钉钉/企微/邮箱四个入口」→ 依次点侧边栏「收件箱 / 待办 / 全链路回放 / 平台账号」 | 「统一消息模型 + 四类数据源，换账号只改配置」 |
| 0:30–1:50 | 收件箱↔手机 | 演示人：手机钉钉**单聊**给机器人发「周五前交周报」（要演示群聊就在群里 @机器人；平台只推 @ 消息）；助手看收件箱 | 2 秒内新消息出现（WebSocket 推送，无需刷新）；点开详情能看到会话（单聊 / 群聊「群名」）、发送人、意图=待办（意图为后台异步填充，稍等 1–10s；详情页标注「MiMo 识别」或「规则兜底」） |
| 1:50–2:40 | 详情→手机 | 演示人：在详情里回复「收到，周五前完成」 | 状态 `replied → sent → synced`；**手机钉钉收到回复**；「投递方式」显示「真实接口」；详情标「机器人发送」（这条走的是机器人通道） |
| 2:40–4:00 | **本人身份收发** | 演示人：打开「平台账号」页 → 钉钉卡片，指「身份 · 谁在收、谁在发」块（接收 / 发送 = 本人）与「已连接」账号（dws 档案）→ 切回收件箱，打开一条**本人账号接收**的消息（提前准备），回复一条；对照手机钉钉看到是**你本人**发出的消息 | 话术：「以前每个人要把机器人拉进自己的每个群；现在用本人账号收发，不用拉群。收到的消息标『本人账号接收』，发出的消息显示是你本人发的」；如实补一句：「消息带 AI 角标，这是钉钉 CLI 的默认透明标记，我们不隐藏」；如这台机器没登录真实钉钉，就用下面的 fake-dws 离线路线并把"本地桩"讲清楚；若现场演示登录流程：本机点「用浏览器登录（推荐）」，设备码仅远程备选并说明有效期 |
| 4:00–5:00 | 邮箱 | 演示人：另一个邮箱给被监听邮箱发中文邮件；等轮询（≤45s，或直接用提前发好的那封）→ 在 UI 回复 | 收件箱出现邮箱消息并带回信；发件邮箱收到 `Re:` 回信；话术「IMAP 收 + SMTP 发，同样不依赖公网回调」；若进垃圾箱如实说明 `FOLDERS=INBOX,Junk` |
| 5:00–5:50 | 收件箱 | 助手执行「Mock 消息注入」两条命令（见下），演示人讲解 | 飞书/企微消息进入收件箱；回复后「投递方式」为**模拟发送（未调用真实平台）**；话术「本场飞书按 Mock 演示是为节奏可控——飞书本机租户 2026-11-12 已解除 21001、本人身份收发已实测通过，可直接真实演示（见下方真实三平台路线）；企微仍卡可信 IP 60020，继续 Mock；**Mock 一定标注，绝不假成功**，这是设计原则」 |
| 5:50–6:30 | 回放页 | 演示人：复制 traceId → 打开「全链路回放」 | 事件链 `received → intent → processing → replied → sent → synced`；Mock 的 sent/synced 写明「模拟发送/模拟状态回流」，真实钉钉那条写「真实接口」；本人身份那条能看出「本人账号接收 / 本人发送」还是「机器人接收 / 机器人发送」 |
| 6:30–7:10 | 账号页 | 演示人：指 4 张卡的 `mode` Tag、`policy`、缺失变量、warnings；再指飞书 / 钉钉的身份块（本人 / 机器人 / 模拟 Tag + hint） | 「钉钉/邮箱=真实接口，飞书/企微=Mock 模拟；身份状态如实标注」；话术「换账号只改 `.env` + 一条 `pnpm run doctor` 自检，不改代码」 |
| 7:10–8:00 | 收尾 | 演示人：如实说边界 | 飞书：本机租户 2026-11-12 已解除 `21001`、本人身份收发已实测通过（**换机器 / 换租户仍需确认该租户策略与企业认证，并开通用户身份权限**）；企微需可信 IP + 回调 Token/AESKey + 公网；**钉钉/企微群聊只能收 @机器人 的消息**（平台限制）；**本人身份**：飞书是轮询（5–30s、只读本人可见会话）、钉钉 dws 需企业开 CLI 访问 + 首次真人授权且凭据绑定设备；PG/Redis 未实现（内存 + 文件快照）、OCR 仍是占位；大模型已接真实调用（失败/超时/低置信回退规则并标注来源）；Docker 单容器部署已提供。边界清单见 [risk-register.md](risk-register.md) |

## 本人身份演示路线（二选一，**不要现场等真人授权**）

**路线 A · 真实钉钉本人身份（已提前登录时）**

- 前提：终端 `dws auth status --readonly --format json` → `authenticated: true`；`.env` 里 `DINGTALK_IDENTITY=auto`（或 `user`）；后端已重启。若现场临时登录：本机点弹窗「用浏览器登录（推荐）」（与 LinkHub 同机的浏览器，127.0.0.1 回调）；LinkHub 跑在服务器 / 容器时用设备码（约 15 分钟有效）。
- 步骤：账号页钉钉卡片确认「本人」→ 用手机给自己 / 同事发一条单聊 → 收件箱出现（标「本人账号接收」）→ 回复 → 对方收到你本人发的消息。
- 话术：讲清「企业管理员开启 CLI 访问 + 首次真人授权 + 凭据绑定本机」这三条平台前提；不要承诺"一键即用"。

**路线 B · fake-dws 离线桩（推荐作为兜底 / 断网现场）**

```powershell
# 在 unimsg-connector/ 下（PowerShell；确保当前环境没有真实机器人凭据，或至少 DINGTALK_STREAM=false）
$env:DWS_BIN="node scripts/fake-dws.mjs"
$env:DINGTALK_IDENTITY="user"     # 仅本人身份模式：不配机器人凭据也能走本人通道（auto 会判 Mock，必须显式 user）
$env:FAKE_DWS_EVENT_INTERVAL_MS="1000"   # 可选：模拟事件间隔（默认 3000ms，首条 300ms）
pnpm --filter @unimsg/server start
```

- 表现：钉钉卡片显示「已连接本人账号」（展示名 `张三（模拟）`）、模拟单聊 / @我事件入库并标「本人账号接收」、回复走桩发送返回成功回执；
- **必须说明**：`fake-dws` 是仓库自带的本地桩（不连接钉钉、不发送真实消息），只用于离线演示与自动化测试；真实收发需按 [personal-identity.md §5](personal-identity.md#5-钉钉本人身份配置dws-cli) 完成企业 CLI 访问与真人授权；
- 界面上的"已连接"来自本地桩，**不是真实钉钉登录**——讲清楚这一句，比假装真实更符合评测要求；
- fake-dws 默认视为已登录；想演示未登录回退，用 `FAKE_DWS_AUTHENTICATED=false` 或先跑 `node scripts/fake-dws.mjs auth logout`。

## Mock 消息注入（仅当后端以 `FEISHU_MODE=mock`、`WECOM_MODE=mock` 启动时）

```bash
node -e "const b={schema:'2.0',event:{message:{message_id:'om_demo_'+Date.now(),message_type:'text',content:JSON.stringify({text:'Demo: weekly report due Friday'}),sender:{sender_id:{user_id:'u_demo'}}}}};fetch('http://127.0.0.1:3001/api/webhook/feishu',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.text().then(t=>console.log('feishu',r.status,t)))"
node -e "fetch('http://127.0.0.1:3001/api/webhook/wecom',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({MsgType:'text',Content:'Demo: weekly report due Friday',MsgId:'wx_demo_'+Date.now(),FromUserName:'u_demo'})}).then(r=>r.text().then(t=>console.log('wecom',r.status,t)))"
```

成功信号：`feishu 200 {"ok":true,...}`、`wecom 200 success`，收件箱各多一条。若返回 401，说明后端不是 Mock 模式（重启时漏了上面两个环境变量）。

## 如果评审要求「三平台真实收发」

- **先讲前提，不现场承诺**：飞书**本机租户已于 2026-11-12 解除 `21001`**（真实 OAuth + 本人身份收发已实测通过），当前可直接真实演示；但**换机器 / 换租户仍需确认该租户策略**——其他租户仍可能报 `21001`（改代码、改 Secret、加 IP 白名单都无效）；飞书长连接（`FEISHU_STREAM=true`）可免公网收消息，但仍依赖应用已发布启用；**本人身份还要额外开通用户身份权限（含 `offline_access`；测试应用免审即时生效，正式应用需发布版本）**。企微要求发信出口 IP 已加入「企业可信 IP」，并配齐回调 `Token` / `EncodingAESKey` + 公网回调地址，否则 `60020` / 收不到消息。钉钉机器人 Stream 与邮箱不依赖公网；**钉钉本人身份需企业管理员开 CLI 访问 + 首次真人授权**。
- **现场自证命令**（助手执行，演示人念结论）：

```bash
pnpm run doctor --platform=feishu        # 预期 PASS（本机租户 21001 已于 2026-11-12 解除）；若换租户后再报 21001，按「企业认证/换合规租户」处理（外部限制，代码无解）
pnpm run doctor --platform=wecom         # gettoken 可能 PASS；若 60020，按建议把出口 IP 加入「企业可信 IP」
pnpm run doctor --platform=dingtalk,mail # 机器人 / 邮箱真实可用：全 PASS；身份探针看 dws 登录态
```

- 话术：能力边界已如实写进 README「设计文档承诺 vs 当前实现」与 [risk-register.md](risk-register.md)，今天不演示未打通的通道，也不拿 Mock / 本地桩冒充真实。

## 纯 Mock 兜底路线（断网 / 凭据失效 / Stream 连不上，约 2 分钟）

1. 停掉真实后端（`Ctrl+C`），以全 Mock 重启：
   - PowerShell：`$env:FEISHU_MODE="mock"; $env:DINGTALK_MODE="mock"; $env:WECOM_MODE="mock"; $env:MAIL_MODE="mock"; $env:DINGTALK_STREAM="false"; $env:MAIL_ENABLED="false"`
   - bash：`FEISHU_MODE=mock DINGTALK_MODE=mock WECOM_MODE=mock MAIL_MODE=mock DINGTALK_STREAM=false MAIL_ENABLED=false pnpm --filter @unimsg/server start`
   - 本人身份在 Mock 下统一显示「模拟」（`effectiveSend/effectiveReceive=mock`），不会说成本人；
2. 灌三平台演示消息：`python scripts/smoke.py http://127.0.0.1:3001`（20 项断言，自带 Mock 标注校验）
3. 刷新 UI → 收件箱出现消息；回复 → 「投递方式：模拟发送」
4. 打开任一条的回放 → 完整闭环 + 「模拟发送 / 模拟状态回流」日志
5. 账号页 4 张卡全部「Mock 模拟」→ 收尾话术：「同一套代码、同一套闭环，零账号也能演示；Mock 从不伪装成真实成功」
6. 想演示本人身份是「模拟态」时的如实标注：用上面 fake-dws 或直接看身份块 Tag（模拟）；**不要**把它说成真实登录。

> 终端也可以直接跑 `pnpm e2e` 作为证据：输出里包含 `PASS Mock 回写如实标注 delivery.mode=mock` 与 `SMOKE OK`。
> 纯前端 Mock（不启后端）：先确认 `packages/web/.env` 不存在/已改名，再 `pnpm --filter @unimsg/web dev`，用顶栏「演示」菜单逐步演示。