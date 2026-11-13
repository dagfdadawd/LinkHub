# LinkHub · 多平台连接器与统一消息管理

> 赛题 A · 3 人团队 · 四类数据源（飞书 / 钉钉 / 企业微信 / 邮箱）统一接入

**可替换性是本项目的核心卖点：换账号 = 改 `unimsg-connector/.env`，零代码改动。**

LinkHub 把飞书、钉钉、企业微信、邮箱的消息与待办收拢到一个统一入口，支持直接处理、真实回写、状态回流与全链路日志回放。每个平台独立用 `*_MODE=auto|real|mock` 决定走真实接口还是本地模拟，默认 `auto`（凭据够就走真实接口、不够自动回退 Mock）；邮箱支持**任意数量、任意服务商**。一条 `pnpm run doctor` 完成凭据 / 网络 / 出口 IP 自检并给出中文修复建议；**Mock 结果一律标注「模拟发送」，绝不假成功**。

- 换账号零代码：飞书 / 钉钉 / 企业微信 / 邮箱各自一段 `.env`，互不影响。
- **本人账号收发（本轮新增）**：飞书、钉钉支持用员工**本人账号**收消息、发消息，不用再把机器人逐个拉进同事的群；机器人身份保留为兼容 / 兜底，界面与接口始终如实标注「本人 / 机器人 / 模拟」。飞书用 OAuth 用户身份（轮询接收），钉钉用官方开源 CLI `dws`（个人事件订阅 + 本人发送）。完整步骤与平台限制见 [docs/personal-identity.md](docs/personal-identity.md)。
- 混搭可用：只配钉钉、只配邮箱、或四个平台全真实，都能正常启动；没配的平台自动 Mock；本人身份与机器人身份可随时切换。
- 零账号可演示：不填任何凭据也能跑通「接收 → 处理 → 回写 → 同步 → 回放」，且每一步都标明是模拟；钉钉本人身份还可用 `fake-dws` 本地桩离线演示。
- 自检不猜谜：`pnpm run doctor` 给出 Node / `.env` / 平台模式 / 逐平台探针（含本人身份状态与 dws 登录态）/ 出口公网 IP 与修复建议。

> 换账号的完整分步 checklist（后台点什么、填哪些变量、常见报错）见 [docs/swap-accounts.md](docs/swap-accounts.md)。

## 从这里开始（30 秒选路径）

| 你想做什么 | 直接怎么做 | 预计耗时 | 详细步骤 |
|---|---|---|---|
| **Windows 上只想双击看效果** | 双击仓库根目录的 `start.bat`，自动起后端 + 前端并打开浏览器 | 约 1 分钟 | 下文「Windows 一键启动」 |
| **个人版首次使用**（白号 / 零账号，用自己的账号收发） | 双击桌面 App（或 `start.bat`）→「连接账号」：**2 项可自助**（邮箱页面添加、钉钉用「用钉钉本人账号登录（推荐，无需机器人应用）」）+ **2 项需管理员**（飞书 / 企微建应用后，在页面「填写应用凭据」并重启） | 邮箱约 2 分钟；钉钉本人登录约 5 分钟；飞书 / 企微需管理员配合（凭据填好后重启生效） | [docs/quickstart.md 路径 E](docs/quickstart.md#path-e) + [docs/desktop-app.md](docs/desktop-app.md) |
| **我只想看效果**（零账号、零平台配置） | `cd unimsg-connector` → `corepack enable`（重开终端）→ `pnpm install` → `pnpm e2e` → 起后端+前端 | 约 5 分钟 | [docs/quickstart.md](docs/quickstart.md) |
| **我要换成自己的账号**（飞书 / 钉钉 / 企微 / 邮箱任选） | 复制 `.env.example` 为 `.env`，只填目标平台 → `pnpm run doctor` → 启动 | 约 10 分钟 | 下文「换一个账号，只要 3 步」+ [docs/swap-accounts.md](docs/swap-accounts.md) |
| **我要用本人账号收发**（推荐，免把机器人拉进每个群） | 先按平台要求开权限 / 装 dws，再到「平台账号」页连接本人身份 | 飞书约 10 分钟（需管理员开权限）；钉钉约 10–15 分钟（企业先开 CLI 访问；本机用「浏览器登录（推荐）」，服务器/无浏览器用设备码） | [docs/personal-identity.md](docs/personal-identity.md) |
| **我要现场演示 / 录视频** | 按分镜脚本走，含演示前 10 分钟检查清单、本人身份分镜与纯 Mock 兜底 | 5–8 分钟 | [docs/demo-script.md](docs/demo-script.md) |
| **我要交付/打包给评审** | `pnpm run deliver`（git archive，自动排除 `.env`/日志/node_modules）+ 打包后自检 | 约 5 分钟 | [docs/delivery-checklist.md](docs/delivery-checklist.md) |
| **我要在纯净服务器独立部署** | `cd unimsg-connector && docker compose up -d --build` → 打开 `http://<IP>:3001` | 约 5 分钟 | [docs/deploy.md](docs/deploy.md) |

> 新手常见卡点（pnpm 未装、端口占用、`.env` 拼错、401、代理超时等）有一张「现象 → 原因 → 一句话解决」表，见 [docs/quickstart.md](docs/quickstart.md#常见卡点一张表)。
> 完整风险清单（按严重度排序、含修复状态）见 [docs/risk-register.md](docs/risk-register.md)。

## 换一个账号，只要 3 步

```bash
cd unimsg-connector
cp .env.example .env        # Windows PowerShell 可用：Copy-Item .env.example .env

# 2) 只填“目标平台”那一段，其余留空即可（留空 = auto 回退 Mock）
#    飞书：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFY_TOKEN / FEISHU_ENCRYPT_KEY
#          本人身份收发：FEISHU_IDENTITY=auto + 账号页点「连接本人账号」（详见 docs/personal-identity.md）
#    钉钉：DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_ROBOT_CODE / DINGTALK_STREAM=true
#          本人身份收发：DINGTALK_IDENTITY=auto + 本机安装 dws，账号页用「浏览器登录（推荐）」或设备码登录（详见 docs/personal-identity.md）
#    企微：WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET（要收消息再加 WECOM_TOKEN / WECOM_AES_KEY）
#    邮箱：MAIL_<KEY>_ADDRESS / MAIL_<KEY>_AUTH_CODE（可配任意多个账号、任意服务商）

# 3) 先自检，再启动（自检只读：只换 token / IMAP 立基线 / SMTP 登录自检，不发任何业务消息）
pnpm run doctor
pnpm --filter @unimsg/server start
```

每个平台单独自检（`pnpm run doctor` 在 `unimsg-connector/` 下执行）：

| 平台 | 最少要填的变量 | 单平台自检 |
|---|---|---|
| 飞书 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFY_TOKEN` | `pnpm run doctor --platform=feishu` |
| 钉钉 | `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` / `DINGTALK_ROBOT_CODE` / `DINGTALK_STREAM=true` | `pnpm run doctor --platform=dingtalk` |
| 企业微信 | `WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET`（收消息另加 `WECOM_TOKEN` / `WECOM_AES_KEY`） | `pnpm run doctor --platform=wecom` |
| 邮箱 | `MAIL_<KEY>_ADDRESS` / `MAIL_<KEY>_AUTH_CODE`（授权码，不是登录密码） | `pnpm run doctor --platform=mail` |

> 账号页**只反映「变量填齐了没有」**，不证明平台真的能连通：填一个假的 App ID / Secret，账号页同样会显示「已配置（未验证）」/「真实接口」。**能否连通以 `pnpm run doctor` 的 PASS / FAIL 为准**（假凭据会 FAIL 并给出错误码与修复建议）。账号页真实模式的卡片上会直接给出可复制的 `pnpm run doctor --platform=<平台>`（提示语「变量齐了 ≠ 平台能连通」；真实模式 Tag 为「已配置（未验证）」）；doctor 只读，不发送任何业务消息。

> ⚠️ 不要写 `pnpm doctor`：pnpm 9 自带同名内置命令会抢占它，实测**没有任何输出、退出码 0**——看起来像成功了，实际本项目自检根本没运行。必须带 `run`，即 `pnpm run doctor`；在脚本里推荐写全路径 `pnpm --filter @unimsg/server run doctor`。

## 运行模式（auto / real / mock）

环境变量：`FEISHU_MODE`、`DINGTALK_MODE`、`WECOM_MODE`、`MAIL_MODE`，取值 `auto | real | mock`，**默认 `auto`**。

| 模式 | 语义 | 凭据不全时 |
|---|---|---|
| `auto`（默认） | 凭据足够（具备真实收或真实发能力）就走真实接口，否则本地 Mock | 自动回退 Mock，并在 `/api/accounts` 的 `reason` 里说明原因 |
| `real` | 强制真实接口，即使只具备一半能力也按真实通道处理 | 发送时**显式报错**并列出缺失变量（`assertRealSendable`），绝不静默假成功 |
| `mock` | 强制本地模拟，即使填了凭据也不外呼（适合离线演示 / 断网评审） | 不适用 |

`auto` 的判定（代码在 `packages/server/src/config/runtime.ts`）：

1. 平台具备「能收」或「能发」任一真实能力 → `mode=real`；两者都不具备 → `mode=mock`。
2. 邮箱特殊：`MAIL_ENABLED=false` 关闭轮询时，`auto` 直接回退 `mock`（避免“配置齐了却收不到”的歧义）；需要只发不收时请显式设 `MAIL_MODE=real`。
3. 旧全局 `MOCK` 变量**已废弃**：仅在没写 `*_MODE` 时作为默认策略（`MOCK=true→mock`、`MOCK=false→real`），启动日志与 `doctor` 都会打印废弃警告。请删除 `MOCK`，改用四个 `*_MODE`。
4. 非法取值（如 `FEISHU_MODE=enable`）会回退默认策略并给出警告，不会静默生效。

解析结果统一带 `policy / mode / configured / canSend / canReceive / missing / warnings / reason`，`/api/accounts`、启动日志、`doctor` 三处消费同一份数据，不会互相矛盾。

**Mock 绝不伪装成真实成功**，四处都会如实标注：

- 消息对象写入 `delivery.mode = "mock"`（真实发送为 `"real"`，并带平台返回凭证）；
- 闭环日志 `sent` 事件写「模拟发送（本地 Mock，未调用真实平台接口）」，`synced` 写「模拟状态回流（本地 Mock）」；
- `/api/health` 的 `sentMock` 单独计数，`modes` 标注每个平台本次实际通道；
- 前端账号页显示「真实接口 / 未配置（演示模式）」Tag、身份标签「本人 / 机器人 / 演示」与「模拟发送」计数，收件箱详情的「投递方式」同样醒目展示。

### 三个典型配置示例

**A. 只配钉钉（Stream 长连接，本机免公网）**

```dotenv
DINGTALK_MODE=auto
DINGTALK_CLIENT_ID=dingxxxxxxxxxxxxxxxx
DINGTALK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DINGTALK_ROBOT_CODE=dingxxxxxxxxxxxxxxxx
DINGTALK_STREAM=true
# 飞书 / 企微 / 邮箱不填 → auto 自动 Mock，不影响钉钉真实收发
```

**B. 只配邮箱（多账号、任意服务商）**

```dotenv
MAIL_MODE=auto
MAIL_POLL_SECONDS=45
MAIL_ACCOUNTS=qq,work          # 可省略；省略时自动发现所有 MAIL_<KEY>_ADDRESS
MAIL_QQ_ADDRESS=you@qq.com
MAIL_QQ_AUTH_CODE=xxxxxxxxxxxxxxxx
MAIL_QQ_FOLDERS=INBOX,Junk     # 反垃圾可能把信扔进垃圾箱，可选一起监听
MAIL_WORK_ADDRESS=you@company.com
MAIL_WORK_AUTH_CODE=xxxxxxxxxxxxxxxx
MAIL_WORK_PROVIDER=custom      # 126/yeah/gmail/outlook/icloud 等有内置预设
MAIL_WORK_IMAP_HOST=imap.company.com
MAIL_WORK_SMTP_HOST=smtp.company.com
MAIL_WORK_SMTP_PORT=587        # 587 自动按 STARTTLS 处理
```

**C. 四个平台全真实（其余参数用默认即可）**

```dotenv
FEISHU_MODE=real
DINGTALK_MODE=real
WECOM_MODE=real
MAIL_MODE=real
# 然后补齐各平台的凭据段；缺凭据时发送会显式报错，按错误/doctor 建议补
```

## 身份模式：本人账号 vs 机器人

> 机器人方案要求「每个同事把自己的机器人拉进自己的每个群」，不可接受。本轮新增**本人账号收发**：飞书 / 钉钉可以以员工本人身份收消息、发消息；机器人身份保留为兼容 / 兜底。完整配置步骤、平台限制与排错见 **[docs/personal-identity.md](docs/personal-identity.md)**。

| 维度 | 机器人身份（保留） | 本人身份（本轮新增） |
|---|---|---|
| 用前要做什么 | 每个人把机器人拉进自己的群 | 在账号页连接本人账号（飞书 OAuth / 钉钉 dws 登录），不用拉群 |
| 接收范围 | 只收「单聊 + 群里 @机器人」 | 飞书：本人可见会话（轮询，5–30s 延迟）；钉钉：本人事件（默认全部单聊 + @我） |
| 发送显示 | 机器人应用 | 你本人 |
| 平台前提 | 应用 / 机器人能力发布 | 飞书用户身份权限；钉钉本机 dws + 企业管理员开 CLI 访问 + 首次真人授权（本机推荐浏览器登录，远程/无浏览器用设备码） |
| 状态标注 | 真实 / 模拟 | **本人 / 机器人 / 模拟** 三态如实标注，绝不混淆 |

配置（`.env` 关键项；完整变量 / 取值范围见下文「身份能力」表与 `.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `FEISHU_IDENTITY` / `DINGTALK_IDENTITY` | `auto` | 身份策略：`auto`（已连接本人就用本人，否则机器人）/ `bot` / `user`（未连接显式报错，绝不悄悄回退）；飞书旧变量 `FEISHU_SEND_AS` 仍兼容 |
| `FEISHU_USER_RECEIVE` / `DINGTALK_USER_RECEIVE` | `auto` | 本人身份接收开关：`auto` / `true` / `false` |
| `DINGTALK_USER_EVENT_KINDS` | `all-direct,at-me` | 钉钉个人事件范围；`all-group` 量大按需开启，`group` / `sender` 当前不支持（见配置说明） |
| `DWS_BIN` | `dws` | 钉钉 dws 可执行文件；可带参数，如 `node scripts/fake-dws.mjs`（离线演示 / 测试） |

行为要点：

- 平台 `*_MODE=mock` 时本人身份通道不启动，`effectiveSend / effectiveReceive` 统一为 `mock`，界面标「模拟」——不会把模拟说成本人；
- `auto` 下本人不可用会**回退机器人**并在账号页 `identity.user.hint` 给出中文原因与修复命令；显式 `*_IDENTITY=user` 时**绝不悄悄回退**（发送显式报错、接收启动报错）；
- 收发身份如实落库：接收消息带 `receivedAs`（本人 / 机器人），真实发送成功写 `delivery.identity`；「新建发送」可显式指定身份，不可用时 400 中文报错；
- 钉钉可以**只配本人身份**：`DINGTALK_IDENTITY=user` + 已登录 dws、不配机器人凭据也能真实收发（机器人通道保持 Mock）；飞书仍需 App 凭据才能发起 OAuth 授权。

平台限制（务必如实说明，详见 [docs/personal-identity.md](docs/personal-identity.md) §3）：

- **飞书**：接收是**轮询**（默认 20s，通常 5–30s 延迟）、**只能读本人可见会话**；用户身份读消息权限（含列会话必需的 `im:chat:read`）需管理员开通并使权限生效（正式应用需重新发布版本；测试应用改动免审即时生效）；**2026-11-12 本机租户已实测恢复正常**（`app_access_token` / `tenant_access_token` 均 `code:0`，此前记录的 `21001` 已解除）——`21001` 仍是平台策略，其他未认证租户 / 环境仍可能被拦截。
- **钉钉**：`dws` 是官方**共创阶段**开源 CLI，需企业管理员开启「CLI 访问管理」（或 Custom App 模式）+ **首次真人授权**；登录推荐本机浏览器 loopback（与 LinkHub 同机），远程 / 容器用设备码（约 15 分钟有效、过期需重新获取，否则钉钉提示 `Invalid or expired user code`）；凭据绑定设备，**Windows 不能跨机复制**，容器部署需在容器内登录。
- **共同**：当前是**单实例单身份**（一次连接一个飞书账号 / 一个 dws 登录用户），多员工共享同一实例不在本期范围。

## 只有部分平台账号时的行为矩阵

| 平台 | 配置状态 | 收 | 发 | 实际通道 / UI 标注 |
|---|---|---|---|---|
| 飞书 | 什么都没填 | ✗ | ✗ | `mock`；账号页「未配置（演示模式）」，回写标「模拟发送」 |
| 飞书 | 只有 App ID + Secret（缺 Verification Token，且未开长连接） | ✗ | ✓ | `real`；警告「只能发不能收」，收到回调会验签失败 |
| 飞书 | App ID + Secret + `FEISHU_STREAM=true`（长连接，免公网） | ✓ | ✓ | `real`；长连接明文推送，无需 Verification Token / 公网回调 |
| 飞书 | 上述凭据 + 账号页完成用户授权（`FEISHU_SEND_AS=auto/user`） | ✓ | ✓ | `real`；回写显示为授权用户本人；授权失效时显式失败，不悄悄换机器人 |
| 飞书 | App ID + Secret + Verification Token（可选 Encrypt Key） | ✓ | ✓ | `real`；**2026-11-12 本机租户实测 `21001` 已解除**；其他租户被拦时 `doctor` 会 FAIL 并给建议 |
| 钉钉 | 什么都没填 | ✗ | ✗ | `mock`；账号页「未配置（演示模式）」 |
| 钉钉 | Client ID/Secret + RobotCode（未开 Stream、无 AES） | ✗ | ✓ | `real`；警告「暂时收不到消息」 |
| 钉钉 | 上述 + `DINGTALK_STREAM=true`（或 HTTP 回调 Token/AES） | ✓ | ✓ | `real`；本机长连接即可收，无需公网 |
| 企业微信 | 什么都没填 | ✗ | ✗ | `mock` |
| 企业微信 | CorpID + Secret + AgentId（缺 Token/AESKey） | ✗ | ✓ | `real`；警告「只能发不能收」+ 可信 IP（60020）风险 |
| 企业微信 | 全部填齐 | ✓ | ✓ | `real`；出口 IP 必须已加入「企业可信 IP」 |
| 邮箱 | 什么都没填 | ✗ | ✗ | `mock`；账号页「未配置（演示模式）」，回写标「模拟发送」 |
| 邮箱 | 至少一个账号 | ✓ | ✓ | `real`；默认有账号即开 IMAP 轮询（`MAIL_ENABLED=false` 可关收） |
| 邮箱 | 有账号 + `MAIL_ENABLED=false` + `MAIL_MODE=auto` | ✗ | ✓（模拟） | `mock`（auto 下轮询关闭按模拟处理）；显式 `MAIL_MODE=real` 才真实发送 |
| 飞书 | 机器人凭据齐全 + 已连接本人身份（`FEISHU_IDENTITY=auto/user`） | ✓（用户轮询，5–30s 延迟） | ✓ | `real`；身份「本人」；只覆盖本人可见会话 |
| 钉钉 | 机器人凭据齐全 + dws 已登录（`DINGTALK_IDENTITY=auto/user`） | ✓（个人事件，默认单聊 + @我） | ✓ | `real`；身份「本人」；需 dws 子进程在线 |
| 飞书 / 钉钉 | 本人身份已连接，但显式 `*_IDENTITY=bot` | 机器人 | 机器人 | `real`；身份「机器人」；本人连接保留但不使用 |
| 飞书 / 钉钉 | 显式 `*_IDENTITY=user` 但本人身份不可用 | 启动报错 | 发送报错 | 中文错误 + 修复提示，**绝不悄悄换回机器人** |
| 任一平台 | 显式 `*_MODE=mock` | ✗ | ✗ | `mock`；即使填了凭据也不外呼 |
| 任一平台 | 显式 `*_MODE=real` 但缺凭据 | — | 报错 | `real`；发送抛错并列出缺失变量，不产生假的「已发送」 |

## 当前进度

| 模块 | 状态 |
|---|---|
| 共享消息契约（`shared/src/message.ts`） | ✅ 完成（含 `conversation`、`delivery`、邮箱 `mailMeta`；`SendResult.mode` 强制如实标注通道） |
| 运行时可替换性（`config/runtime.ts`） | ✅ 完成：四平台独立 `*_MODE`、`auto` 自动判定、`missing/warnings/reason`，旧 `MOCK` 废弃兼容 |
| 平台适配器（飞书 / 钉钉 / 企业微信 / 邮箱） | ✅ 代码与单测全部完成；钉钉 Stream 真实收发、邮箱四跳闭环已实测；**飞书 2026-11-12 真实端到端已通过**（租户策略 `21001` 本机已解除）；企微卡「企业可信 IP」 |
| **本人身份收发（飞书 / 钉钉）** | ✅ 代码 / 单测 / fake-dws 桩完成：统一身份解析（`auto/bot/user`）、飞书用户身份轮询接收（水位持久化）、钉钉 dws 个人事件 + 本人发送（子进程监管 / 退避重启）、`/api/accounts` identity 视图、发送身份分流与 400 校验、doctor 身份探针；钉钉登录支持**浏览器 loopback（推荐，本机）+ 设备码（远程/容器，带有效期倒计时与重新获取）**，登录/注销后自动启停接收通道、无需重启。**飞书本人身份 2026-11-12 真实端到端已通过**：真实 OAuth → 用户轮询收单聊 + 群聊（`receivedAs=user`）→ 以本人身份发送（飞书侧 `sender_type=user`），本机租户 `21001` 已解除；钉钉真实端到端仍待企业开 CLI 访问 + 本人授权——见 [docs/personal-identity.md](docs/personal-identity.md) 与 [飞书验收记录](docs/verification/feishu-personal-e2e-2026-11-12.md) |
| 授权中心 / 个人版首启向导（白号修复后） | ✅ 「连接账号」页（`/connect`）+ `GET /api/onboarding` 聚合：邮箱 → 钉钉 → 飞书 → 企微，状态「已就绪 / 需本人授权 / 需安装 / 需管理员 / 演示模式 / 异常」按真实运行态判定（缺凭据→`needs_admin`、已登录但通道 mock 不判 ready、`needsAction`=非 ready 数）；**新增 `GET/PUT /api/app-config` 图形化填平台应用凭据 / 模式 / AI 模型**（本机 `linkhub-config.json`，secret 只回末 4 位，`.env` 优先，保存后重启生效；**`identity.*` 热应用**）；钉钉白号「**用钉钉本人账号登录（推荐，无需机器人应用）**」一登即用（未授权 / 取消不改变配置；**登录成功后**才自动热应用「仅本人身份」、接收自动启动）；邮箱页面添加账号 + **验证后自动真实收信**（未验证不算就绪，可「测试验证」/「启用真实邮箱」）；`dws` 自动发现 + `pnpm run fetch:dws`、桌面版构建内置；首启横幅/3 步上手改为客户语言（去连接账号 / 先体验演示）、待办/追踪空态有入口；见 [docs/quickstart.md 路径 E](docs/quickstart.md#path-e) 与 [白号报告目录](docs/qa/white-account/)（审计 / 用户两轮 / API 二轮） |
| 邮箱数据源 | ✅ 任意数量 / 任意服务商（8 个常见服务商预设 + `custom`）；IMAP 收 + SMTP 发；993/465 隐式 TLS 与 143/587/25 STARTTLS 均支持 |
| `doctor` 自检 | ✅ 环境 + 模式 + 逐平台探针（飞书 token / 钉钉 token + 机器人 + 通道 / 企微 gettoken / 邮箱 IMAP+SMTP 登录）+ 大模型连通性（`llm:chat`，仅在未加 `--platform=` 时执行）+ 出口公网 IP + 中文修复建议；支持 `--json`、`--platform=`、`--help` |
| 真实平台 API 接入 | ✅ 钉钉 Stream 端到端（真实收 + 回写）；✅ 邮箱四跳闭环；✅ **飞书适配器完成且 2026-11-12 真实端到端实测通过**（机器人 / 用户本人双身份，OAuth 一键授权；本机租户 `21001` 已解除，其他租户仍可能被拦截）；🟡 企微 `gettoken` 通过，真实发送卡「企业可信 IP」 |
| 消息中枢：状态机 / 幂等 / 异步回写 / 回流 | ✅ 完成（状态回流单向防倒退） |
| 安全：Bearer 鉴权 + WebSocket 握手校验 | ✅ 完成 |
| 闭环日志（traceId 全链路可回放） | ✅ 完成（Mock 与真实通道分开描述） |
| 边界降级：限流退避、OCR 置信度、意图失败回退、DLQ | ✅ 完成 |
| 单元测试 / 端到端冒烟 | ✅ **2026-11-12 本轮实测**：`typecheck` 通过；server **466 tests** 全过（2026-11-12 本轮实测，含本轮新增「`types` 被拒自动降级」「水位内消息不重复 ingest」用例）；web **304 tests**（34 文件）全过；`pnpm e2e` **20 项断言 PASS + SMOKE OK**；契约自检 **81 PASS / 0 FAIL**（含 2 个邮箱账号；含 `identity`、钉钉 personal status 等新接口，N 视是否配置邮箱账号：有邮箱 81 / 无邮箱 75） |
| 上手与交付文档 | ✅ [quickstart.md](docs/quickstart.md)（5 分钟上手）/ [personal-identity.md](docs/personal-identity.md)（本人身份收发配置与边界）/ [demo-script.md](docs/demo-script.md)（演示脚本）/ [delivery-checklist.md](docs/delivery-checklist.md)（交付打包）/ [ai-integration.md](docs/ai-integration.md)（AI 服务集成说明）/ [risk-register.md](docs/risk-register.md)（风险台账）；README 顶部有「30 秒选路径」 |
| 健壮性加固（本轮） | ✅ webhook 空/畸形事件 400 不入库、端口占用中文提示、CORS 白名单、状态回流防倒退、日志脱敏、空 `API_TOKEN` 不关鉴权、邮箱嵌套 MIME/水位持久化/中文目录 |
| 大模型真实调用（意图 / 摘要 / 回复草稿） | ✅ OpenAI 兼容协议（默认小米 MiMo `mimo-v2.6-flash`）；失败一律回退规则识别并如实标注来源；见 [ai-integration.md](docs/ai-integration.md) |
| OCR 真实调用 | 🚧 仍为占位实现（赛题 A 不依赖 OCR；配置项已预留） |
| PostgreSQL / Redis 实装 | 🚧 仅有 DDL 与仓储接口，实际始终走内存 |
| 前端统一入口 | ✅ 收件箱 / 待办 / 全链路回放 / 平台账号；首启「3 步上手」改为客户语言（主 CTA 去连接账号、次 CTA 先体验演示，开发者命令折叠）、侧栏导航有文字标签、页脚写明「服务就绪 · 本地后端已连接（不代表平台账号已连接）」、账号页给出「变量齐 ≠ 连通」说明与可复制 doctor 自检命令、`.env` 改而未重启有提示、飞书 OAuth 失败回跳有中文反馈、页脚有可见连接状态（已连接 / 重连中 / 未连接 / 异常 / 演示）；飞书 / 钉钉账号卡有「身份 · 谁在收、谁在发」块（本人 / 机器人 / 模拟 Tag + 连接入口），收件箱与回放标注 `receivedAs` / `delivery.identity`，新建发送可选发送身份，发送失败原因显示在详情并可重试 |
| 小白用户上手修复（本轮，来自 docs/qa/naive-user-report.md 阶段一） | ✅ P1：账号页自检命令与「已配置 ≠ 连通」、首启引导挂载、`pnpm run doctor` 全文档写全、`.env` 改而未重启提示、飞书 OAuth 失败回跳反馈、发送失败原因上浮 + 重试；P2：页脚可见连接状态、运行指标「本次启动以来」并拆真实/模拟、空态注入按钮可点性、回复成功后冷却防重复；P3：启动器 Token 打码、前端固定 5173 如实写；平台限制项（企微 `60020`、钉钉企业 CLI 授权）与历史租户策略 `21001`（2026-11-12 本机租户已解除，仍保留为其他租户的排查项）仍如实标注 |
| 前端设计系统与可访问性 | ✅ 设计令牌化（标签色板从一个品牌色派生明暗两套、圆角与字号成尺阶）、标签文字对比度 ≥4.5 有回归测试锁定、移动端安全区 + 44px 命中区、`pnpm --filter @unimsg/web lint:css` 样式护栏 |

## 功能特性（对应业务闭环五要素）

- **接收**：四类数据源统一接入。飞书 **长连接（WebSocket，免公网回调，事件明文推送）** 或 Webhook（校验 Verification Token，配置 Encrypt Key 时 AES 解密，支持 `url_verification` challenge）；钉钉 **Stream 长连接**（本机免公网）或 HTTP 回调（`timestamp + HMAC` 签名 + AES 解密）；企业微信 XML 回调（SHA1 验签 + AES 解密 + GET `echostr` 握手）；邮箱 IMAP 轮询（UID 水位，首轮只立基线）。Mock 下签名带 `mock` 或 `dev*` 前缀即通过。此外飞书 / 钉钉支持**本人身份接收**：飞书用用户身份 token 轮询本人可见会话的增量消息，钉钉用 `dws event +listen-im` 个人事件订阅（默认全部单聊 + @我）；入库消息标 `receivedAs`，与机器人消息区分。
- **展示**：REST 列表 + WebSocket 实时推送，按平台 / 状态筛选；本人 / 机器人接收来源在卡片与详情如实标注。
- **处理**：直接回复、标记完成；意图 / 摘要 / 回复草稿走大模型真实调用（OpenAI 兼容协议，默认 MiMo `mimo-v2.6-flash`），仅真实调用失败（超时 / 404 / 网络 / 响应不合法）才回退内置关键词规则；低置信结果照常采用，只按信息量调整草稿长短并标注低精度。界面按**本次实际生效的厂商**动态标注（如「火山方舟 识别」/「MiMo 识别」，消息上存 `aiProvider` / `aiModel`）或「规则兜底」，历史消息保留当时值；改过配置后可在详情页点「**重新生成**」用当前配置重算（真调后端，不再只是弹提示），见 [docs/ai-integration.md](docs/ai-integration.md)。
- **回写**：按目标平台格式转换后异步发送，结果经 WS 推送，并写入 `delivery`。真实接口：飞书 `im/v1/messages`（机器人或**本人 `user_access_token`**，由 `FEISHU_IDENTITY` 决定）、钉钉机器人 `groupMessages/send` / `oToMessages/batchSend`（或 **dws 以本人身份发送**，由 `DINGTALK_IDENTITY` 决定）、企微 `cgi-bin/message/send`、邮箱 SMTP（带 `In-Reply-To` 串回会话）；真实发送成功后 `delivery.identity` 标注实际身份。
- **回流**：平台状态事件经 Webhook 回流（邮箱由轮询回收），`syncStatus` 更新本地并留痕，支持按 `traceId` 或 `externalId` 定位消息。

### 状态机

```
received → processing → replied → sent → synced
                └────────── 发送失败 → failed（指数退避重试，耗尽写 DLQ）
```

### 关键设计

- **可替换性**：换账号只改 `.env`；每个平台的 `mode / policy / 收 / 发 / missing / warnings / reason` 是纯函数解析结果，可单测、可被 API、日志、doctor 复用。
- **幂等**：以 `(platform, externalId)` 为唯一键，平台重推直接返回已有记录（`duplicate=true`），不重复入库（DDL 中有 `UNIQUE` 约束）。邮箱的 `externalId` 为 `<账号>:<目录>:<UID>`，多账号、多目录互不撞车；飞书的 `externalId` 为平台 `message_id`（机器人通道与本人轮询共用同一 ID，跨通道幂等）；钉钉本人事件为 `dingtalk:<openMessageId>`。
- **异步回写**：`reply` 先同步推进到 `replied`，随即返回 `202 + taskId`，真正发送在后台完成，避免接口阻塞。
- **边界降级**：限流令牌桶 + 指数退避只作用于发送路径（每平台容量 60、每秒补 30，重试上限 `SEND_MAX_RETRY`）；OCR 置信度低于 `OCR_CONFIDENCE_THRESHOLD`（默认 0.7）标记「待人工确认」；LLM 真实调用失败才回退内置关键词规则并标注「规则兜底」，低置信仍采用模型结果（标低精度、草稿更短），绝不伪造意图；重试耗尽写入 DLQ。
- **密钥安全**：平台 / 大模型 / OCR 凭据只从服务端环境变量读取，绝不以 `VITE_` 注入前端，`.env` 已被 `.gitignore` 忽略。

## 前端设计与可访问性

界面不是“套一层 AntD”就算完，而是自成一套令牌与约束——演示时最容易被追问的恰恰是“你这个配色、字号有没有依据”。

- **颜色只有一个来源**：平台与状态标签的品牌色写一次，`utils/format.ts` 的 `tone()` 派生浅底、浅底墨色、暗色底、暗底墨色四支；墨色用 `utils/ink.ts` 的 `readableInk()` 按 WCAG 对比度反推（保留色相、只压明度），同类标签 ≥4.5:1 由单测锁定。暗色主题不再用 `!important` 硬压内联样式，而是换一套同名变量。
- **尺阶**：圆角只有 6 / 8 / 10 / 12 / 16 + 胶囊五档；字号全部用 rem（1rem = 16px），浏览器“默认字号”设置能真正放大界面；间距与圆角保持 px——那是视觉密度，不跟字号缩放。
- **移动端**：`viewport-fit=cover` + `100dvh` + `env(safe-area-inset-*)`，Toast 抬到底部导航之上；`(hover: none) / (pointer: coarse)` 下行内操作常显、命中区 44px（桌面仍是 26px + 悬停出现）。实测 320 / 360 / 375 无横向溢出。
- **动效**：位移一律走 `transform`（图标轨高光不再动 `top`）；`prefers-reduced-motion` 与站内“减弱动效”偏好双路径生效。View Transition 在 `ThemeProvider` / `morph.ts` 的 JS 触发点掐断——`::view-transition-*` 挂在根之上的伪树，CSS 的 `*` 通配够不着，因此另给了独立成块的 reduced 规则；循环动画用 `animation-iteration-count: 1` 截断，避免 `0.001ms × infinite` 变成每秒上千次空转。
- **发送按钮状态色**：未回写的消息用明亮品牌蓝（`--send-ready`），已有回写内容后沉为深石墨（`--send-sent`）；判定取 `message.reply` 这一落库事实而非 WS 推送状态，失败进死信队列时保持亮色以便重试。两种状态只在按钮元素上重绑 `--send*` 令牌，波纹 / hover / 光晕 / spinner 自动跟随，明暗主题各备一套且文字对比度均过 AA。
- **护栏**：`pnpm --filter @unimsg/web lint:css` 跑 `packages/web/scripts/check-styles.mjs`，锁住五条容易退化的规矩（字号 rem、色值走令牌、位移走 transform、暗色块禁 `!important`、圆角用尺阶）。没用 stylelint：现成规则集会在这份样式文件上刷出几百条格式错误，收益低于成本。

## 技术栈

- 运行时：Node.js ≥ 20（本机实测 24.14.0）、TypeScript 5.6
- 后端：Express 4、ws（WebSocket）
- 前端：React 18 + Vite 5 + TypeScript + Ant Design 5（Mock / 真实后端双模式，由 `VITE_API_BASE` 切换）；设计令牌集中在 `packages/web/src/styles/app.css`，标签配色由 `utils/ink.ts` 按对比度推导
- 真实接入：飞书 / 钉钉 / 企微适配器使用 Node 内置 `fetch` + 进程内 token 缓存；钉钉收消息使用官方 `dingtalk-stream`（唯一的额外依赖）；邮箱使用自研 IMAP/SMTP 客户端（`node:tls` / `node:net`，零额外依赖）
- 本人身份：飞书用官方 OAuth `user_access_token`（用户授权 + 自动续期）；钉钉用**官方开源 CLI `dws`**（本机安装、子进程调用，事件 NDJSON 用 Node 内置能力解析），不新增 npm 依赖
- 仓储：内存实现（当前唯一实现）；PostgreSQL 仅有 `001_init.sql` 与仓储接口，尚无 PgRepository；Redis 未接入
- 智能：LLM 走 OpenAI 兼容协议（默认 MiMo `mimo-v2.6-flash`，超时 15s，失败回退规则）；OCR 仍是规则占位

## 目录结构

```
LinkHub-test/
├── README.md
├── LICENSE
├── start.bat                  # Windows 一键启动（local / mock / accounts / doctor / docker / stop / stopdocker）
├── start-docker.bat           # 双击快捷方式：等价于 start.bat docker
├── setup-accounts.bat         # 双击快捷方式：等价于 start.bat accounts（编辑平台账号 .env）
├── docs/
│   ├── quickstart.md           # 5 分钟上手（三类用户分流 + 常见卡点表）
│   ├── personal-identity.md    # 本人身份收发：飞书 OAuth / 钉钉 dws 配置、平台边界、排错、回退
│   ├── swap-accounts.md        # 换账号指南：逐平台 checklist / errcode 排错 / 邮箱预设表
│   ├── demo-script.md          # 5–8 分钟现场演示脚本（含演示前检查与纯 Mock 兜底）
│   ├── delivery-checklist.md   # 交付/打包 checklist
│   ├── deploy.md               # 独立部署指南（Docker 从零到一 / 离线搬运 / 数据卷）
│   ├── ai-integration.md       # AI 服务集成说明（MiMo 调用方式 / 降级矩阵 / 集成位置 / 实测）
│   ├── desktop-app.md         # 桌面版（轻量版 / Electron）：使用、构建、内置 dws、FAQ
│   └── risk-register.md        # 用户风险台账（31 条，按 P0–P3 排序）
├── .github/workflows/ci.yml    # typecheck + 测试 + web build + e2e:sh
├── documents/                  # 设计文档（初赛精简版 / 决赛完整版）
├── test.photos/                # 历史冒烟截图（2026-11-02 旧版，界面已改版，仅作记录）
└── unimsg-connector/           # pnpm monorepo 源码
    ├── Dockerfile / docker-compose.yml / .dockerignore   # 独立部署包
    ├── packages/shared/src/message.ts      # 前后端共享契约（含 delivery / 出站附件 / compose）
    ├── packages/web/                       # 前端（React + AntD，账号页含模式标注、首启 3 步引导）
│   ├── src/features/connect/           # 「连接账号」授权中心（四平台状态 / 动作 / 邮箱表单 / 首启横幅）
    │   ├── src/features/compose/ComposeModal.tsx  # 新建发送：指定平台/会话（邮箱可选发件账号）+ 文本 + 附件
    │   ├── src/utils/attachments.ts        # File → base64 出站附件、体积校验
    │   ├── src/styles/app.css               # 设计令牌（色板 / 圆角 / 字号尺阶）与全部样式
    │   ├── src/utils/ink.ts                 # 对比度计算与墨色推导（标签文字色）
    │   ├── src/utils/format.ts              # tone()：一个品牌色派生整套明暗标签色板
    │   ├── scripts/check-styles.mjs         # 样式护栏（rem / 令牌 / transform / 禁 !important / 圆角尺阶）
    │   └── README.md                       # 前端说明（模式 / 环境变量相关小节）
    ├── packages/server/src/
    │   ├── config/runtime.ts  # 运行模式解析 / 邮箱多账号解析（可替换性核心）
    │   ├── config.ts          # 服务端私有配置（凭据只在此读取）
    │   ├── doctor.ts          # pnpm run doctor 入口
    │   ├── doctor/            # 探针（probes）、报告渲染（report）、环境变量拼写检查（env-check）
    │   ├── connectors/        # 飞书 / 钉钉 / 企微 / 邮箱适配器（crypto / real 为真实接入工具）
│   │                      # dwsBin.ts（dws 自动发现：tools / ~/.local/bin / PATH）
    │   │                      # feishuUserAuth.ts（飞书用户 token）/ feishuUserReceive.ts（用户消息拉取映射）
    │   │                      # dingtalkPersonal.ts（dws CLI 封装与纯解析器）
    │   ├── core/              # 闭环日志 / 幂等 / 指标
    │   ├── services/          # 消息中枢 / 回流 / LLM / OCR / 限流 / outbound（附件校验与能力）
    │   │                      # identity.ts（统一身份解析：策略 → 收发身份 + 状态视图）
    │   ├── stream/            # 钉钉 Stream 长连接 / 邮箱 IMAP 轮询器（水位持久化）
    │   │                      # feishuUserPoller.ts（飞书用户轮询）/ dingtalkPersonalStream.ts（dws 子进程监管）
    │   ├── routes/            # health / webhook / messages（含 compose、capabilities、accounts）
│   │                      # onboarding.ts（授权中心聚合）/ mailAccounts.ts（邮箱账号增删测）
    │   │                      # dingtalkPersonal.ts（dws login / status / logout）
    │   ├── middlewares/auth.ts
    │   ├── db/                # 仓储（内存 + 可选文件快照）+ migrations/001_init.sql
    │   └── app.ts / index.ts / ws.ts
    ├── scripts/               # smoke.py + e2e.ps1 / e2e.sh + deliver.mjs（交付打包）
    │                          # shot.mjs（CDP 截图走查）/ push-via-api.mjs（github.com 不可达时改走 API）
    │                          # fake-dws.mjs（dws 离线桩：version / auth status / 事件流 / 发送，供离线演示与测试）
│                          # fetch-dws.mjs（一键下载 dws 到 tools/，桌面构建前置）
    ├── .env.example           # 配置模板（配置的权威来源）
    ├── .mail-watermarks.json  # （运行时生成，已 gitignore）邮箱 UID 水位，重启续传
    ├── .feishu-user-token.json    # （运行时生成，已 gitignore）飞书本人身份令牌，只存服务端
    └── .feishu-user-receive.json  # （运行时生成，已 gitignore）飞书本人身份接收水位，重启续传
```

## 快速开始

### Windows 一键启动（演示 / 评审现场最省事）

`start.bat` 已放在仓库根目录，**双击即可**，不用装全局 pnpm、不用手敲命令：

| 想做什么 | 操作 | 实际动作 |
|---|---|---|
| 本地一键启动 | 双击 `start.bat` | 自动装依赖 → 起后端（端口读 `.env` 的 `SERVER_PORT`，默认 `:3001`）+ 前端 `:5173` → 等两者就绪 → 打开浏览器 |
| 纯离线演示（强制 Mock） | `start.bat mock` | 同上，但四平台全部强制 Mock，不调用任何真实平台接口 |
| 配置 / 修改平台账号 | 双击 `setup-accounts.bat`（或 `start.bat accounts`） | 已有 `.env` 原样打开、没有则从模板创建，用记事本编辑 |
| 账号自检 | `start.bat doctor` | 只读自检：凭据 / 收发能力 / 出口公网 IP / 中文修复建议 |
| Docker 一键启动 | 双击 `start-docker.bat`（或 `start.bat docker`） | `docker compose up -d --build`，同源访问 `http://127.0.0.1:<HOST_PORT，默认 3001>` |
| 停止本地服务 | `start.bat stop` | 结束**占用后端端口（读 `.env` 的 `SERVER_PORT`，默认 3001）与 5173 的进程**。它按端口找占用者，**可能是别的程序，会被一并结束**；不确定时直接关掉那两个服务控制台窗口更安全 |
| 停止 Docker | `start.bat stopdocker` | `docker compose down`，数据卷保留 |

脚本自动处理：Node ≥ 20 检测、无全局 pnpm 时回退 `corepack pnpm`、首次运行 `pnpm install --frozen-lockfile`、**统计 `.env` 里非空凭据组数并打印账号状态**（0 组就明确提示「全 Mock」，不会再出现「以为配了其实没配」）、每次启动重写 `packages/web/.env` 让 `VITE_API_TOKEN` 永远与后端 `API_TOKEN` 一致、`VITE_API_BASE` 指向当前 `SERVER_PORT`（避免 401 与端口漂移；指向非 `127.0.0.1` 的自定义 `VITE_API_BASE` 则不覆盖）、按 `SERVER_PORT` + 5173 做端口占用检查（重复双击不会起第二份；被别的程序占用时提示改 `SERVER_PORT` 或关掉该程序，而不是先强杀）、轮询 `/api/health` 与前端首页后再打开浏览器。启动器里的 Token 默认**打码显示**（形如 `dev-******`），完整值只在 `unimsg-connector/.env` 里。

> **端口限制（如实说明）**：一键启动的**前端端口固定 5173**（`start.bat` 暂不支持改前端端口），后端端口可改 `.env` 的 `SERVER_PORT`。5173 被别的软件占用时脚本只会提示先关掉占用程序，不会自动换端口；确实要换前端端口，请手动起 `pnpm --filter @unimsg/web dev --port <端口>`（Vite 参数），并确保 `packages/web/.env` 的 `VITE_API_BASE` 指向后端实际端口、`VITE_API_TOKEN` 与后端 `API_TOKEN` 一致。
> `start.bat` 的窗口提示是英文（cmd.exe 代码页限制，避免中文被拆成命令执行）；`Press any key to close THIS launcher window (services keep running)` 的意思是「按任意键只关这个启动器窗口，后端/前端服务继续运行」。完整中文说明以本文档为准。

### 个人版首次使用：连接账号 / 授权中心

启动后（桌面版双击即可）左侧导航有 **「连接账号」**（`/connect`），按推荐顺序 **邮箱 → 钉钉 → 飞书 → 企业微信** 列出每个平台的**真实状态**（已就绪 / 需本人授权 / 需安装 / 需管理员 / 演示模式 / 异常）、一句现状、可执行动作与管理员清单。白号（零账号）的完整操作步骤见 [docs/quickstart.md 路径 E](docs/quickstart.md#path-e)；**白号口径是「2 项可自助（邮箱、钉钉）+ 2 项需管理员（飞书、企微）」**，不是四个平台都需要管理员。

- **首屏引导**：首次打开收件箱有横幅「首次使用：先连接你自己的账号」，按钮 **「去连接账号」/「先体验演示」/「稍后再说」**；「先体验演示」会注入一条示例消息（走真实入站链路、不会真的发到平台），先看闭环再连账号。
- **邮箱**：页面直接「添加邮箱账号」（服务商 → 授权码 → 测试连接 → 保存账号）；只有测试通过的账号才标「已验证」，验证过的账号会自动把邮箱从演示模式切到真实收信，**无需改 `.env`、无需重启**。
- **钉钉（无需机器人应用）**：卡片点 **「用钉钉本人账号登录（推荐，无需机器人应用）」** → **只打开登录弹窗，不会预先改配置**（未授权 / 取消不改变任何设置）→ 浏览器登录 → **登录成功后后端才自动启用本人身份**（`identity.dingtalk=user` 热应用并持久化，无需重启）、个人事件接收自动启动；注销时若该「仅本人身份」是自动启用的，会自动回退 `auto`（显式配置不动）。仅需企业管理员开启「CLI 访问管理」；`dws` 已随桌面版内置，命令行版可 `pnpm run fetch:dws`。
- **飞书 / 企业微信**：需要企业管理员先创建平台应用；拿到凭据后点 **「填写飞书应用凭据（App ID / App Secret）」/「填写企业微信凭据（Corp ID / Agent ID / Secret）」**，保存到本机 `linkhub-config.json`，**重启后端 / 重开 App 才生效**；飞书重启后再点「连接飞书本人账号」完成 OAuth。
- **两种配置来源与优先级**：`.env`（手改，**优先级最高**）→ 页面保存的 `linkhub-config.json`（`DATA_DIR/linkhub-config.json`；无 `DATA_DIR` 时为 `unimsg-connector/.linkhub-config.json`，已 gitignore、权限收紧、**secret 只回末 4 位、永不下发明文**）。「平台应用配置」弹窗按 **飞书 / 钉钉 / 企业微信 / AI 模型（可选）** 分 Tab；每个字段标来源 **「来自 .env（不可覆盖）/ 本地配置 / 已配置 / 未配置」**。页面不能覆盖 `.env` 里显式写死的值，会提示「部分配置来自 .env，未被本次保存覆盖」。
- **生效规则（白号最容易搞错）**：**只有静态配置**（应用凭据 / 运行模式 / stream / AI Key 等）保存后**必须重启**；**`identity.*` 热应用**（钉钉/飞书本人身份登录成功后自动启用、钉钉「仅用本人身份」开关）**不触发重启**；邮箱账号增删/验证后启用真实收信 → 热加载。**`.env` 改而未重启**的提示只针对 `.env`（页面保存的本地配置有自己的「需要重启」提示）；`.env` 显式值优先，页面保存不会覆盖（`ignoredByEnv` 会提示）。
### 账号配置在哪？为什么「我明明配过」却没生效

平台配置有**两个来源**：① `unimsg-connector/.env`（手改，**显式值优先**，被 `.gitignore` 排除、从不入库）；② 页面「连接账号 → 填写应用凭据 / 模式」保存的 **`linkhub-config.json`**（有 `DATA_DIR` 时在 `DATA_DIR/linkhub-config.json`，否则 `unimsg-connector/.linkhub-config.json`；同样 gitignore、权限收紧、secret 不下发）。页面保存后**必须重启**才生效（钉钉/飞书本人身份登录例外，热应用）。这带来两个常见误会：

1. 从 GitHub clone / pull 或换目录后，`.env` 与本地 `linkhub-config.json` 都不会跟过来 → 后端回退全 Mock；
2. 页面填了凭据但没重启 → 状态不会变（页面会提示「需要重启」）。

因此：

- 从 GitHub clone / pull、同步队友代码、或换一个工作区目录之后，**凭据不会跟过来**，后端会静默回退到全 Mock；
- 团队文档里「2026-11-04 实测 163 + QQ 邮箱 PASS 4 / FAIL 0」「企微 `gettoken` 实测 PASS」这类记录，是在**当时那份带 `.env` 的工作区**里跑出来的，换目录后需要把 `.env` 复制过去；
- 换机器 / 换副本时手动复制这一个文件即可，代码零改动；或直接双击 `setup-accounts.bat` 重新填。

判断「配置是否真的生效」分两层，别混：
1. **变量层（账号页 / `/api/accounts` / 启动日志）**：只说明 env 是否填齐、解析成 `mode=real` 还是 `mock`、缺哪些变量。**变量齐 ≠ 平台能连通**——假 App ID 也会显示「已配置 / 真实接口」。
2. **连通层（`pnpm run doctor`）**：真正调用平台换取 token / 登录 IMAP / 连 SMTP，给出 PASS / FAIL 与错误码；**这才是「生没生效」的判据**。也可以看 `start.bat` 输出的 `[acct] N credential group(s)` 确认变量组数。

当前仓库文档的已知限制（企微缺 `WECOM_TOKEN`/`WECOM_AES_KEY` 且卡可信 IP `60020`；飞书租户策略 `21001` 在本机租户已于 2026-11-12 实测解除，但其他租户 / 环境仍可能遇到）依然是真实边界，配了 `.env`、账号页显示 `real` 也不等于所有平台都能真实收发。

> 两个服务各开一个控制台窗口；关掉窗口或执行 `start.bat stop` 即停止。
> Docker 模式需要先启动 Docker Engine；入口令牌默认 `linkhub-local-demo-2026-change-me`，改 `LINKHUB_DEPLOY_TOKEN` 后需重新 `--build`，详见 [docs/deploy.md](docs/deploy.md)。
> `.bat` 刻意保持纯 ASCII + CRLF（与 `scripts/e2e.ps1` 同因）：cmd.exe 按 OEM 代码页解析批处理，中文注释会被拆成命令执行，中文说明一律以本文档为准。

环境要求：Node.js ≥ 20、pnpm ≥ 9（或用 Node 自带 corepack）、Python 3（仅 `e2e` 冒烟脚本需要）。

```bash
cd unimsg-connector
pnpm install
```

未全局安装 pnpm 时，用 Node 自带的 corepack：先 `corepack enable` 让 `pnpm` 进入 PATH（**之后需重开终端**），再 `pnpm install`；也可以只用一条 `corepack pnpm install` 装依赖，但后续 `pnpm ...` 命令仍需走 `corepack pnpm ...`（根目录脚本内部会再调用 `pnpm -r`，所以推荐一次性 `corepack enable`）。本仓库实测 pnpm 9.15.9。

### 本地演示（无需域名 / 无需平台账号）

两种跑法任选：

- **纯前端 Mock**：只起前端，内置数据，可完整走通「收件箱 → 回复 → 回放」。

  ```bash
  pnpm --filter @unimsg/web dev      # http://127.0.0.1:5173
  ```

- **前后端联调（推荐）**：先起后端，再给前端配两行环境变量；左侧页脚显示 **「服务就绪 · 本地后端已连接（不代表平台账号已连接）」**（断开时「正在重连本地后端…」/「本地后端未连接」），侧栏底部短标识「服务就绪 / 重连中 / 未连接」。

  ```bash
  pnpm --filter @unimsg/server start
  # macOS / Linux / Git Bash：
  printf 'VITE_API_BASE=http://127.0.0.1:3001\nVITE_API_TOKEN=dev-token\n' > packages/web/.env
  # Windows PowerShell：
  # "VITE_API_BASE=http://127.0.0.1:3001`nVITE_API_TOKEN=dev-token" | Set-Content packages/web/.env
  pnpm --filter @unimsg/web dev
  ```

  没有任何平台凭据时，四类数据源都会以 `mock` 通道运行：`/api/health` 的 `modes` 全为 `mock`，回写会在消息里标注「模拟发送」。想灌几条演示消息，可在另一个终端用 `scripts/smoke.py`（先启动后端），或直接调 `POST /api/webhook/feishu|dingtalk|wecom`。

- **一键端到端（自动起服务 → 冒烟 → 关闭）**：

  ```bash
  pnpm e2e
  ```

  > 端口冲突时改端口用 `pnpm e2e -Port 3102`。不要写成 `pnpm e2e -- -Port 3102`：pnpm 9 会把 `--` 原样传给脚本，PowerShell 解析参数失败。
  > 想手动验证，服务启动后另开终端执行 `python scripts/smoke.py http://127.0.0.1:3001`。
  > `scripts/e2e.sh` 会自动探测 `python` / `python3`；都找不到时提示安装 Python 3。e2e 会强制四个平台 `mock` 并关闭邮箱轮询，完全离线可复现，不受本机真实 `.env` 影响。

## 配置说明

复制 `unimsg-connector/.env.example` 为 `unimsg-connector/.env`（服务会自动从 monorepo 根目录加载），按需填写。**下表与 `.env.example` 逐项对应，是配置的权威来源。**

### 服务与模式

| 变量 | 说明 |
|---|---|
| `SERVER_PORT` | 服务端口，默认 `3001`；`start.bat` / `start.bat stop` 也读它定位后端端口（前端固定 `5173`） |
| `SERVER_HOST` | 监听地址；留空 = 所有网卡（局域网/容器可访问）。只想本机访问可设 `127.0.0.1`（注意：局域网访问时默认 `dev-token` 有风险，见安全提示） |
| `API_TOKEN` | 入口鉴权令牌（默认 `dev-token`，生产务必修改；REST 用 Bearer，`/ws?token=` 用同名令牌）。**留空会回退 `dev-token` 并告警、仍强制鉴权**；`NODE_ENV=production` 且仍为空/默认时拒绝启动 |
| `CORS_ORIGINS` | CORS 白名单，逗号分隔 Origin（如 `http://127.0.0.1:5173`）。**留空 = 放行所有来源**（兼容本地演示）；填了则名单外 Origin 返回 403 JSON |
| `DATABASE_URL` / `REDIS_URL` | 预留项：不影响存储实现；填 `DATABASE_URL` 只会让启动日志显示 `postgres(未启用·当前内存)` |
| `FEISHU_MODE` / `DINGTALK_MODE` / `WECOM_MODE` / `MAIL_MODE` | 每平台运行模式，`auto`（默认）/ `real` / `mock`，见上文「运行模式」 |
| `MOCK` | **已废弃**，仅为兼容旧配置保留；只在没写 `*_MODE` 时作为默认策略，会打印废弃警告 |

### 边界降级与智能

| 变量 | 说明 |
|---|---|
| `OCR_CONFIDENCE_THRESHOLD` | OCR 置信度阈值，默认 `0.7`；低于阈值标记「待人工确认」 |
| `SEND_MAX_RETRY` | 发送最大重试次数，默认 `3` |
| `RETRY_BASE_MS` | 重试退避基数，默认 `1000`（ms） |
| `LLM_TIMEOUT_MS` | 大模型单次调用超时，默认 `15000`（ms）。实测 flash 单次 2.9–9.3s，8s 会把长尾全部打成降级 |
| `PLATFORM_TIMEOUT_MS` | 平台 HTTP 调用超时，默认 `8000`（ms）。与 LLM 解耦，避免 LLM 长尾传染平台接口 |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_ENDPOINT` / `LLM_MIN_CONFIDENCE` | 大模型：`mock`（默认，规则识别）/ `openai`（OpenAI 兼容协议，火山方舟 / 通义 / DeepSeek / 智谱 / MiMo 通用）。**这个字段填的是协议类型，不是厂商中文名**；页面填「火山引擎 / deepseek / 通义」等也会自动归一到 `openai`，厂商由端点推断。默认模型 `mimo-v2.6-flash`、端点 `https://api.xiaomimimo.com/v1`、精度分档线 `0.6`（低于它**仍采用模型结果**，只标低精度，不再回退规则）；`LLM_MODEL` 必须填控制台里的**模型 ID**（不是显示名）且该模型已开通，否则 404 回退规则。未填 Key 自动回退规则，绝不假装真实调用；**推理模型（豆包 seed 等）默认把输出预算全部耗在思维链、返回空正文**，服务端已对火山方舟自动关闭深度思考并在 `finish_reason=length` 时放大输出预算重试，详见 [ai-integration.md](docs/ai-integration.md) |
| `LLM_BASE_URL` | 页面「AI 模型 Base URL」与旧版配置的兼容别名；服务端同时读 `LLM_ENDPOINT` 与它，**前者优先**。页面保存的值现在直接写入 `LLM_ENDPOINT`，不再出现「填了却不生效」 |
| `OCR_PROVIDER` / `OCR_API_KEY` / `OCR_SECRET_ID` | OCR 配置：`mock`（默认）/ `tencent`；**真实调用尚未实现，填了也仍走 Mock** |

### 身份能力（本人收 / 发）

飞书 / 钉钉的「本人账号 vs 机器人」配置。完整步骤、平台前置条件与排错见 [docs/personal-identity.md](docs/personal-identity.md)。

| 变量 | 说明 |
|---|---|
| `FEISHU_IDENTITY` | 飞书身份策略：`auto`（默认，已连接本人就用本人，否则机器人）/ `bot`（固定机器人）/ `user`（固定本人，未连接 / 失效显式报错）。旧变量 `FEISHU_SEND_AS` 仍兼容（仅在未写 `FEISHU_IDENTITY` 时生效并提示废弃），建议迁移 |
| `FEISHU_USER_RECEIVE` | 飞书本人接收开关：`auto`（默认，身份为本人时自动开启）/ `true` / `false` |
| `FEISHU_USER_RECEIVE_SECONDS` | 飞书轮询间隔（秒，最小 5、最大 86400，默认 `20`），新消息通常 5–30s 出现 |
| `FEISHU_USER_CHAT_LIMIT` | 飞书每轮最多检查的会话数（1–100，默认 `20`） |
| `FEISHU_USER_BACKFILL_HOURS` | 飞书首轮回溯小时数：`0`（默认，只立基线不灌历史）～`720` |
| `FEISHU_USER_STATE_FILE` | 飞书接收水位文件（默认：未设 `DATA_DIR` → `unimsg-connector/.feishu-user-receive.json`；设了 `DATA_DIR` → `${DATA_DIR}/feishu-user-receive.json`，随数据卷持久化；已 gitignore） |
| `DINGTALK_IDENTITY` | 钉钉身份策略：`auto`（默认，dws 已登录就用本人，否则机器人）/ `bot` / `user`（未登录显式报错） |
| `DINGTALK_USER_RECEIVE` | 钉钉本人接收开关：`auto` / `true` / `false` |
| `DINGTALK_USER_EVENT_KINDS` | 钉钉个人事件订阅范围（逗号分隔）：`all-direct`（全部单聊，默认）、`at-me`（@我，默认）、`all-group`（全部群消息，量大默认不开）；**`group` / `sender` 暂不支持**（需要 dws 目标参数，本期不做），配了会被**忽略并在启动日志告警**、回退默认范围，不会导致重启 |
| `DWS_BIN` | dws 可执行文件（默认 `dws`，在 PATH 中）；可带参数，如 `node scripts/fake-dws.mjs`（离线演示 / 测试） |
| `DWS_PROFILE` | 指定 dws 登录档案（多账号时用，一般留空） |
| `DWS_AUTH_TIMEOUT_MS` / `DWS_SEND_TIMEOUT_MS` | dws 登录 / 发送命令超时（毫秒，默认 `15000` / `30000`） |

> 规则：平台 `*_MODE=mock` 时本人身份收 / 发都不启动，统一标「模拟」；`auto` 下本人不可用会回退机器人并在账号页给修复 hint；显式 `*_IDENTITY=user` 时绝不悄悄回退。

### 飞书

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 自建应用凭证（开发者后台 → 凭证与基础信息） |
| `FEISHU_VERIFY_TOKEN` | 事件订阅 Verification Token（HTTP 回调模式收消息验签必需；长连接模式不需要） |
| `FEISHU_ENCRYPT_KEY` | 事件加密 Encrypt Key（后台开启加密策略时必需；未配置只能收明文回调） |
| `FEISHU_STREAM` | `true` 时用长连接（WebSocket）收机器人消息，免公网回调；需在后台「事件配置 → 订阅方式」选「使用长连接接收事件」并发布版本 |
| `FEISHU_BASE_URL` | 开放平台基址，默认 `https://open.feishu.cn`（国际版 Lark / 代理网关可覆盖） |
| `FEISHU_REDIRECT_URI` | 本人身份 OAuth 回调地址，默认 `http://localhost:<SERVER_PORT>/api/feishu/oauth/callback`；必须与后台「安全设置 → 重定向 URL」完全一致 |
| `FEISHU_USER_TOKEN_FILE` | 本人身份令牌文件路径（默认 `unimsg-connector/.feishu-user-token.json`；设了 `DATA_DIR` 时默认 `DATA_DIR/feishu-user-token.json`，已 gitignore） |
| `FEISHU_ACCOUNTS_BASE_URL` | OAuth 服务域名，默认 `https://accounts.feishu.cn`（国际版 Lark 可改） |

### 钉钉

| 变量 | 说明 |
|---|---|
| `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` | 应用凭证（新版后台叫 Client ID / Secret；旧版 `DINGTALK_APP_KEY` / `_APP_SECRET` 仍兼容） |
| `DINGTALK_ROBOT_CODE` | 机器人编码；留空自动取 Client ID（企业内部应用通常相同） |
| `DINGTALK_STREAM` | `true` 时用 Stream 长连接收机器人消息，本机无需公网（需在后台把机器人消息接收模式选为 Stream 并发布版本） |
| `DINGTALK_AES_TOKEN` / `DINGTALK_AES_KEY` | HTTP 回调模式才需要（事件订阅的 Token / 加密密钥） |
| `DINGTALK_BASE_URL` | 开放平台基址，默认 `https://api.dingtalk.com` |

### 企业微信

| 变量 | 说明 |
|---|---|
| `WECOM_CORP_ID` | 企业 ID（管理后台 → 我的企业 → 企业信息） |
| `WECOM_AGENT_ID` / `WECOM_SECRET` | 自建应用 AgentId / Secret（应用详情页，Secret 点「眼睛」查看，**不要点重置**） |
| `WECOM_TOKEN` / `WECOM_AES_KEY` | 应用「接收消息 → 设置 API 接收」的 Token / EncodingAESKey（43 位）；收消息必需 |
| `WECOM_BASE_URL` | 企微 API 基址，默认 `https://qyapi.weixin.qq.com`；发信出口 IP 必须加入「企业可信 IP」，否则报 60020（`doctor` 会显示当前出口 IP） |

### 邮箱（任意数量 / 任意服务商）

| 变量 | 说明 |
|---|---|
| `MAIL_POLL_SECONDS` | IMAP 轮询间隔秒数，默认 `45`（最小 5）；不是实时推送 |
| `MAIL_STATE_FILE` | UID 水位状态文件路径（默认 `unimsg-connector/.mail-watermarks.json`，已 gitignore）；**重启后续传水位、不再漏信**；异常重建目录（UIDVALIDITY 变化）会自动重导 |
| `MAIL_ENABLED` | 兼容旧行为：不填 = 有账号就开启轮询；`false` = 只发不收 |
| `MAIL_ACCOUNTS` | 显式声明要启用的账号（只加载列出的 key），如 `qq,163,work`；**可省略**，省略时自动发现所有 `MAIL_<KEY>_ADDRESS` |
| `MAIL_<KEY>_ADDRESS` / `MAIL_<KEY>_AUTH_CODE` | 邮箱地址 + **授权码**（网页端开启 IMAP/SMTP 后生成，不是登录密码）；`KEY` 可随意取（`qq` / `163` / `work` / `school2` …） |
| `MAIL_<KEY>_PROVIDER` | 服务商：`qq` / `foxmail` / `163` / `126` / `yeah` / `gmail` / `outlook` / `icloud` / `custom`；也可按邮箱域名自动推断 |
| `MAIL_<KEY>_LABEL` | 展示名称（默认取预设名，如「QQ邮箱」） |
| `MAIL_<KEY>_IMAP_HOST` / `MAIL_<KEY>_SMTP_HOST` | 收发服务器；内置预设可省略，`custom` 或未知服务商必填 |
| `MAIL_<KEY>_IMAP_PORT` / `MAIL_<KEY>_SMTP_PORT` | 端口；不填用预设。`993/465` = 隐式 TLS（默认），`143/587/25` = STARTTLS |
| `MAIL_<KEY>_IMAP_SECURE` / `MAIL_<KEY>_SMTP_SECURE` | 显式覆盖加密方式（`true`=隐式 TLS，`false`=STARTTLS）；一般按端口自动推断即可 |
| `MAIL_<KEY>_FOLDERS` | 监听目录，默认 `INBOX`；反垃圾把信扔进垃圾箱时可写 `INBOX,Junk`（多个用逗号分隔） |

> 邮箱的 `externalId` 形如 `<账号key>:<目录>:<UID>`，所以多账号、多目录同时监听也不会互相吞消息；授权码只存服务端，`/api/accounts` 只返回脱敏地址与端口/加密方式。

## 真实接入配置

逐平台的「后台点什么 → 填哪些 env → 验证命令 → 常见报错」完整 checklist、errcode 排错表、邮箱 provider 预设表与端口/加密表、多账号示例、可信 IP 与飞书企业认证的现实说明，统一见 **[docs/swap-accounts.md](docs/swap-accounts.md)**。下面是速查入口：

| 平台 | 收消息方式 | 需要公网吗 | 关键点 | 验证命令（在 `unimsg-connector/` 下） |
|---|---|---|---|---|
| 飞书 | 长连接（WebSocket，推荐免公网）或事件订阅 HTTP 回调 | 长连接否 / 回调是 | `im.message.receive_v1` 事件 +（`FEISHU_STREAM=true` 免公网；HTTP 回调需 Verification Token 与公网 URL） | `pnpm run doctor --platform=feishu` |
| 钉钉 | Stream 长连接（推荐）或 HTTP 回调 | Stream 否 / 回调是 | 机器人消息接收模式选 Stream，`DINGTALK_STREAM=true`，发布版本 | `pnpm run doctor --platform=dingtalk` |
| 企业微信 | 应用「API 接收」回调 | 是（需公网 URL） | Token / EncodingAESKey + 出口 IP 加入「企业可信 IP」 | `pnpm run doctor --platform=wecom` |
| 邮箱 | 本机 IMAP 轮询 | 否 | 网页端开启 IMAP/SMTP + 生成授权码；可多账号 | `pnpm run doctor --platform=mail` |

- 飞书：`https://<域名>/api/webhook/feishu`（配置回调 URL 时服务自动回 `challenge`）。
- 钉钉 HTTP 回调：`https://<域名>/api/webhook/dingtalk`，把 Token / AES Key 填进 `DINGTALK_AES_TOKEN` / `DINGTALK_AES_KEY`。
- 企业微信：`https://<域名>/api/webhook/wecom`，GET 握手会解密 `echostr` 回明文。
- 邮箱：没有平台回调，真实模式下 `/api/webhook/mail` 一律拒绝（防伪造），邮件只能由本机 IMAP 轮询入库。
- 反向代理场景下把 `https://<域名>/api` 整体转到 `127.0.0.1:3001` 即可，路由本身不依赖前缀。

## API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 健康检查 + 运行指标（`received` / `deduped` / `sent` / `sentMock` / `failed` / `dlq`）+ **`modes`（每平台实际通道）** + **`identities`（每平台发送 / 接收身份摘要）** + `startedAt` + **`envFile:{path:'.env', mtime}|null`** 与 **`settingsFile:{path:'linkhub-config.json', present, mtime}|null`**（公开接口只给文件名 + 时间，**不含绝对路径与内容**），前端据此提示「改了未重启」 |
| GET | `/api/app-config` | Bearer | **平台应用凭据 / 身份策略 / 运行模式 / AI 模型的脱敏视图**：`identity` / `modes` / `llm` / `platforms{feishu,dingtalk,wecom}` 每个字段 `{source: 'env'｜'local'｜'none', configured, masked?, value?, envKey, label}` + `platforms.*.missing/configured` + `redirectHint?` + `settingsFile{path,present,mtime}` + `envFile` + `restartRequired`；**secret 只回末 4 位，绝无明文** |
| PUT | `/api/app-config` | Bearer | 部分更新平台应用凭据 / 身份策略 / 运行模式 / AI 模型（支持 `null`/空串清除），写入本地 `linkhub-config.json`（原子写、非 Windows chmod 600）；返回 `{saved, hotApplied, hotAppliedKeys, restartRequired, staticKeys, changedKeys, ignoredByEnv, warnings, message, settingsFile, savedAt}`。**`identity.*` 热应用**（改运行中配置、`restartRequired:false`，含钉钉「仅用本人身份」）；凭据 / 模式改动 `restartRequired:true`；`.env` 显式值优先，全部被占用时 `saved:false` |
| POST | `/api/webhook/:platform` | 平台签名 | 接收消息或状态回流事件（`feishu` / `dingtalk` / `wecom`；`mail` 仅 Mock 演示） |
| GET | `/api/accounts` | Bearer | 返回 **4 个平台**的 `configured` / `policy` / `mode` / `canReceive` / `canSend` / `missing` / `warnings` / `reason`；邮箱另带 `accounts[]` 明细与 `issues[]`；**飞书 / 钉钉另带 `identity`（`PlatformIdentityView`：策略、收发身份、本人连接状态、hint）** |
| GET | `/api/onboarding` | Bearer | **「连接账号」授权中心聚合视图**：`firstRun` / `startedAt` / `envFile` / `dws{available,version?,source,pathHint?}` / `overall{ready,total,needsAction}`（**`needsAction` = 非 ready 数量**，白号 0/4 时 = 4）/ `steps[]`（邮箱 / 钉钉 / 飞书 / 企微；`state` = `ready` / `needs_user_auth` / `needs_install` / `needs_admin` / `mock` / `error`：**缺凭据→`needs_admin`**、邮箱「有账号但未验证→`needs_user_auth`」、**已登录但通道仍是 mock→绝不判 `ready`**、显式 `*_MODE=mock` 才判 `mock`；`actions` 含 `*-configure`（打开应用凭据表单）、`dingtalk-login`（**只 POST 登录；登录成功后后端才自动热应用 `identity.dingtalk=user`，未授权/取消不改配置**）、`dingtalk-enable-personal-only`、管理员深链与可复制清单（纯文本、无 Markdown 星号）；`kind: api/form/link/copy/command`；命令文本带 `cd unimsg-connector`）；**只读聚合，绝不含 token / 授权码** |
| GET | `/api/mail/accounts` | Bearer | 邮箱账号列表（`.env` + 本地导入）：脱敏地址 / 服务商 / IMAP·SMTP 配置 / `source: 'env'\|'file'` / `removable` / **`verified`（本地账号只有「测试连接」成功过才为 true）**；附 `filePath`、`issues[]`、`providers[]`；**授权码永不下发** |
| POST | `/api/mail/accounts/test` | Bearer | 邮箱连接自检（body `{provider,address,authCode,imapHost?,smtpHost?,imapPort?,smtpPort?,imapSecure?,smtpSecure?,folders?}`）：只做 IMAP + SMTP 登录自检，**不落盘、不发信、不回显授权码**；返回中文 `imap/smtp` 明细与修复 hint |
| POST | `/api/mail/accounts` | Bearer | 保存邮箱账号到本地文件并**热加载轮询（无需重启）**，`201`；body 可带 **`verify:true`**（先跑 IMAP/SMTP 登录自检，通过才保存并标记已验证）；普通保存的账号未验证、**不算就绪**（提示「请点『测试连接』验证」）；同地址覆盖更新；本地文件含授权码、仅本机（`DATA_DIR/mail-accounts.json` 或 `.linkhub-mail-accounts.json`，已 gitignore） |
| POST | `/api/mail/accounts/:key/verify` | Bearer | 对已保存的本地账号跑一次真实 IMAP + SMTP 登录自检：成功写 `verifiedAt` 并热加载（下一轮开始真实收信）；失败 `200 + ok:false` 带中文 `imap/smtp` 原因；`.env` 来源返回 400 |
| DELETE | `/api/mail/accounts/:key` | Bearer | 删除**本地导入**的邮箱账号；`.env` 来源返回 400 中文（提示改 `.env`）；不存在 404 |
| GET | `/api/messages` | Bearer | 消息列表，支持 `?platform=&status=` |
| GET | `/api/messages/:id` | Bearer | 消息详情（`:id` 传 `traceId`；消息内含 `delivery` 投递标注、`receivedAs` 接收身份，发送失败时有 `failureReason` 可读原因 + 详情页「重试发送」） |
| POST | `/api/messages/:id/reply` | Bearer | 回复（`202`，异步回写）；请求可带 `identity: 'bot' \| 'user'` 覆盖发送身份，不可用时 400 中文报错 |
| POST | `/api/messages/compose` | Bearer | 统一入口新建发送（平台 / 目标会话 / 文本 / 附件；可选 `identity` 指定本人或机器人） |
| POST | `/api/messages/:id/done` | Bearer | 标记待办完成（置 `done`，不改状态机状态） |
| POST | `/api/messages/:id/reanalyze` | Bearer | **重新生成 AI 建议**：用当前 LLM 配置重跑分析（历史消息也适用），返回完整消息 + `llm{mode,reason,providerLabel}`，写 `reanalyze_requested` / `reanalyze_done` 闭环日志并广播 `message.updated`；同一条并发请求只跑一次，密钥不出服务端 |
| GET | `/api/messages/trace/:traceId` | Bearer | 全链路回放（消息 + 闭环日志；未知 traceId 返回空数组） |
| POST | `/api/feishu/oauth/start` | Bearer | 获取飞书本人身份授权链接：`{url, redirectUri}`；缺 App 凭据时 400 中文错误 |
| GET | `/api/feishu/oauth/callback` | 公开 | 飞书 OAuth 回调（浏览器跳转，校验 state）；成功/失败都返回中文结果页 |
| POST | `/api/dingtalk/personal/login` | Bearer | 拉起钉钉本人身份登录。可选 body `{mode: 'auto'\|'browser'\|'device', force?: boolean}`（默认 `auto`：优先本机浏览器、启动失败才回退设备码）；返回 `{started, mode, requestedMode, command, instructions, url?, code?, expiresInSec?, expiresAt?, loginId?}`。`browser` 的 `url` 是 `127.0.0.1` 回调授权页（600s 窗口），`device` 返回授权码（默认 900s）；同方式重复调用复用同一个 `loginId`，`force:true` 才换新码；dws 不存在时 400 中文安装指引 |
| GET | `/api/dingtalk/personal/status` | Bearer | dws 登录状态：`{available, version?, authenticated, state, displayName?, detail?, hint, loginCommand?, installHint?}` + 进行中登录字段 `{loginInProgress, loginMode?, loginUrl?, loginCode?, loginExpiresAt?, loginExpiresInSec?, loginInstructions?, loginId?}`（恢复弹窗用；缓存，前端 2s 轮询安全，绝不含 token） |
| POST | `/api/dingtalk/personal/logout` | Bearer | 注销 dws 登录：`{ok:true, authenticated:false}` |
| WS | `/ws?token=<API_TOKEN>` | Token | 推送 `connected` / `message.received` / `message.updated` / `message.failed`（携带 `failureReason`）；token 错误直接 `1008` 关闭 |

鉴权示例：`Authorization: Bearer dev-token`，业务接口也接受 `?token=dev-token`（默认开发 token，生产请在 `.env` 中改 `API_TOKEN`）。

## 测试与验证

实测环境：Windows 11、Node 24.14.0、pnpm 9.15.9（corepack / shim）、Python 3.12.10；**本轮收尾实测 2026-11-12**（保留 2026-11-03 / 11-06 的历史真实接入记录，见下）。

| 命令 | 实测结果 |
|---|---|
| `pnpm typecheck` | **2026-11-12 实测通过**：`shared` / `server` / `web` 三包检查 exit 0 |
| `pnpm --filter @unimsg/server test` | **2026-11-12 本轮实测 466 tests 全过**（exit 0；条数以最终代码实际输出为准；覆盖连接器、真实适配器、身份解析 / 飞书用户轮询 / 钉钉 dws、MIME、IMAP 水位/目录、webhook HTTP 级、app/CORS、doctor 探针/渲染/拼写检查等），约 4s |
| `pnpm --filter @unimsg/web test` | **2026-11-12 实测 34 文件 / 304 tests 全过**（exit 0；覆盖 httpApi / wsRealtime / appStore / mockApi / AccountsPage（含身份 / OAuth / .env 重启）/ PersonalIdentityModal / FirstRunGuide / InboxPage / MessageCard / DetailPanel / ReplyComposer / ComposeModal 身份选择 / format / ink / due / footerState 等） |
| `pnpm e2e -Port 3199`（Windows PowerShell） | **2026-11-12 本轮实测 20 项断言 PASS + `SMOKE OK`**，exit 0（e2e.ps1，本机 3199 端口；约 10s）；强制四平台 `mock` + **独立临时数据目录**（脚本隔离 `DATA_DIR`/`DATA_FILE` 并在结束时清理，不影响本机 `.env`/历史数据），完全离线 |
| `pnpm e2e:sh`（Git Bash，3123 端口） | 同上，**20 项 PASS + `SMOKE OK`**（CI 使用此命令） |
| 契约自检（后端起 mock 后） | `node packages/web/scripts/verify-contract.mjs http://127.0.0.1:3001 dev-token` → 本机 2026-11-12 实测 **81 PASS / 0 FAIL**（含 `modes` / `sentMock` / `mode`+`policy` / 邮箱账号明细 / `delivery` / WS 握手 / 身份 `identity` / 钉钉 personal status；N 视是否配置邮箱账号：有邮箱 81、无邮箱 75，以实际输出为准） |
| `pnpm run doctor` | PASS / FAIL / SKIP 计数**以实际输出为准**（已新增「大模型连通性」探针 `llm:chat`，仅在未加 `--platform=` 时执行）；**历史记录（2026-11-10）**：真实凭据实测唯一 FAIL 为飞书 `21001`（租户策略，代码无解），退出码 1 是「有 FAIL」的约定结果；**2026-11-12 复测本机租户已恢复正常**（`tenant_access_token` 返回 `code:0`，见 [飞书验收记录](docs/verification/feishu-personal-e2e-2026-11-12.md)） |
| `pnpm run doctor --platform=mail` | **PASS 4 / FAIL 0**（两个邮箱账号的 IMAP 登录基线 + SMTP 认证；地址已脱敏） |
| CI（`.github/workflows/ci.yml`） | Ubuntu + Node 22 + pnpm 9.15.9：install → typecheck → server 测试 → web 测试 → web build → `e2e:sh 3121` |

### 本轮健壮性加固验收（2026-11-04 实测）

| 验收项 | 结果 |
|---|---|
| 空 / `{}` / 畸形 JSON webhook | 均 **400** JSON 错误说明，不入库、不占幂等键；正常三平台样例仍 200 / 企微 `success` |
| 状态回流防倒退 | `synced` 后再推 `received` → 状态保持 `synced`（写入 `sync_ignored` 留痕），HTTP 仍 200 |
| 端口占用 | 第二个实例启动 → 中文提示「端口 X 已被占用」+ 结束进程命令，退出码 1，无英文栈 |
| CORS 白名单 | 配置 `CORS_ORIGINS` 后：名单内 Origin 200 + 回显、名单外 **403**、无 Origin 的 curl 放行 |
| 鉴权边界 | `API_TOKEN=` 留空 → 回退 `dev-token` 并告警，**仍强制 Bearer**（无 token → 401）；`NODE_ENV=production` + 默认/空 token → 拒绝启动 |
| 邮箱数据可信 | 嵌套 `multipart/mixed(alternative+attachment)` 正文递归提取（11 条 MIME 单测）；水位持久化 + 单轮多批追平 + UIDVALIDITY 变化自动重导；中文目录 modified UTF-7 有单测 |
| doctor 退出码 | 修复 Windows + Node 24 下「报告 PASS 但退出码 0xC0000409」的强制退出竞态；实测 `--platform=dingtalk/wecom/mail` exit 0、`--platform=feishu` exit 1，稳定可脚本化 |
| 首启引导 | 真实后端 + 空收件箱显示客户化「3 步上手」：主 CTA「去连接账号」、次 CTA「先体验演示（注入示例消息）」，开发者命令折叠；首启横幅「首次使用：先连接你自己的账号」（去连接账号 / 先体验演示 / 稍后再说）；纯前端 Mock 不打扰；后端 500 时不误报「已连上」；页脚按连接状态如实显示 |

`doctor` 实测摘要（2026-11-04，真实凭据、只读探针，未发送任何业务消息）：

- 环境：Node v24.14.0 ✔、`unimsg-connector/.env` 已加载、无旧 `MOCK` / 非法模式警告；邮箱账号 2 个（IMAP 轮询开启）。
- 平台模式：飞书 / 钉钉 / 企业微信 / 邮箱均为 `auto → real`；企微缺 `WECOM_TOKEN` / `WECOM_AES_KEY`（只能发不能收）。
- 探针：钉钉 accessToken、`DINGTALK_ROBOT_CODE`、Stream 通道三条全 **PASS**（Stream 模式下 AES Token/Key 不再被误报为缺失）；企微 `gettoken` **PASS**；163 与 QQ 两个邮箱的 IMAP 登录基线与 SMTP 认证四条全 **PASS**（地址脱敏为 `1******@163.com` / `3******@qq.com`）。
- 唯一 **FAIL**：飞书 `tenant_access_token` 返回 `21001 Access denied due to platform policy`，建议文案已指向「企业认证 / 换合规租户」。（**历史记录（2026-11-04）**：2026-11-12 用同一份 `.env` 复测本机租户已恢复正常，`code:0`。）
- 说明：HTTP 类探针超时 8s；IMAP/SMTP 登录往返较慢，邮箱探针超时放宽到 25s（避免假超时）。
- 出口公网 IP：`pnpm run doctor` 每次都会打印当前出口公网 IP（企业微信可信 IP 绑定的就是它）；本次实测 2026-11-03 → 11-04 同一网络出口 IP 保持不变——电脑重启一般不影响，但重启路由器 / 切换网络 / 开代理后需要重新核对。

### 真实接入实测记录

- **真实模式启动（2026-11-04，`.env` 填真实凭据）**：启动日志实测为
  `[unimsg] 运行模式: 飞书=real(auto) 收✓发✓ | 钉钉=real(auto) 收✓发✓ | 企业微信=real(auto) 收✗发✓ | 邮箱=real(auto) 收✓发✓`；
  钉钉 Stream 已连接（`[stream] 钉钉 Stream 已连接`）；163 与 QQ 两个邮箱 IMAP 基线连接成功（`已连接，基线 UID=…`，QQ 的 `Junk` 目录也纳入监听）。
- **钉钉端到端已跑通（2026-11-03，Stream 模式，本机无公网）**：手机钉钉给机器人发 3 条消息 → 全部实时入库并带出 `conversation`；调 `reply` 接口 → 状态走完 `replied → sent → synced`，`/api/health` 的 `sent` 递增，机器人消息真的回到钉钉会话。钉钉 `POST /v1.0/oauth2/accessToken` 用真实 Client ID/Secret 换取 accessToken 成功；未认证企业也可用。
- **邮箱四跳闭环已机器验证（2026-11-03，本机无公网）**：
  1. 自研 SMTP 客户端从 `smtp.163.com:465` 发信到 QQ → 回执 `250 Mail OK queued as …`；
  2. 轮询从 `imap.qq.com:993` 把它收进中枢 → `externalId=qq:INBOX:<UID>`、`status=received`；
  3. 调 `POST /api/messages/:traceId/reply` → 走 **QQ 的 SMTP** 回写 → 状态 `sent → synced`，`/api/health` 的 `sent` 递增；
  4. 回信落到 163 收件箱后被轮询收回 → `externalId=163:INBOX:<UID>`，`mailMeta.inReplyTo` 是 QQ 真实返回的 Message-ID。
  全程中文主题与正文无损，两个发信账号与两个收信账号都各跑通一次。
- **邮箱多账号与 STARTTLS（本轮新增）**：任意数量账号（`MAIL_ACCOUNTS` 显式列表或自动发现 `MAIL_<KEY>_ADDRESS`）、8 个常见服务商预设 + `custom`、993/465 隐式 TLS 与 143/587/25 STARTTLS 均实现并有单测覆盖；2026-11-04 `doctor --platform=mail` 用真实账号验证了 IMAP 基线 + SMTP 认证（PASS 4/4）。真实服务商 587/143 端到端尚未实测（已有实测链路走 465/993）。
- **飞书 21001（2026-11-03，历史记录；2026-11-12 本机租户已解除）**：`POST /auth/v3/tenant_access_token/internal` 返回 `21001 Access denied due to platform policy`。已排除密钥错误（错误密钥返回 `10014`）、IP 白名单（未开启）、应用未发布（已发布 1.0.0 且状态「已启用」）、测试企业通道（建了测试企业并关联应用，仍 `21001`）——属租户级平台策略，需要企业认证或符合策略的租户。**2026-11-12 14:16 用仓库 `.env` 真实凭据复测**：`POST /open-apis/auth/v3/app_access_token/internal` 与 `/tenant_access_token/internal` 均返回 `code:0`，本机租户已恢复正常（推断为完成企业认证 / 平台策略调整，未证实）；`21001` 仍是平台策略，换租户 / 换环境仍可能遇到，以上排错说明保留。
- **飞书本人身份真实端到端（2026-11-12）**：真实 OAuth 授权（授权账号「八水合甲烷」，open_id `ou_eca152db0e6379f6fc060e0c74c52d76`）→ 用户身份轮询收**单聊 + 群聊**（入库 `receivedAs=user`；列会话需带 `types=p2p,group`：不带只返回 2 个群聊，带上返回 5 个会话 = 2 群 + 3 单聊）→ `POST /api/messages/compose` 以本人身份返回 202 / `status=replied` / `sendIdentity=user`，飞书侧核对 `sender.sender_type=user`、`is_agent=false`（真人本人，不是机器人）；独立测试实例 3101 与用户主应用 3001 各验证一次。完整证据、已知限制与复现命令见 [docs/verification/feishu-personal-e2e-2026-11-12.md](docs/verification/feishu-personal-e2e-2026-11-12.md)。
- **企业微信（代码就绪，卡可信 IP）**：真实适配器与 19 条单测已完成（SHA1 验签、AES 加解密、XML 解析、GET 握手、`gettoken` → `message/send`）；2026-11-04 `gettoken` 实测 **PASS**。当前 `.env` 只配了发信凭据（`WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET`），缺 `WECOM_TOKEN` / `WECOM_AES_KEY` 所以收不到消息；真实发送还要求发信出口 IP 已加入「企业可信 IP」，否则报 **60020**（本轮真实接入即卡在这一步，`doctor` 会直接打印当前出口公网 IP）。
- **Mock 标注已被机器校验**（`scripts/smoke.py` / e2e，以及契约自检）：`delivery.mode=mock`、`health.sentMock>=1`、闭环日志 `sent` 含「模拟发送」、`/api/accounts` 四平台均带 `mode/policy` 且为 `mock`。

### 手工补充验证（沿用历史记录）

- `/api/accounts`：无 token / 错 token 返回 401，Bearer 与 `?token=` 均 200；只返回布尔值、变量名与脱敏邮箱，不返回任何密钥。
- 验签：`x-signature` 篡改为非法值时 401；未知平台 404。
- WebSocket：正确 token 收到 `connected` 与 `message.received`；回复链路依次收到 4 帧 `message.updated`（processing / replied / sent / synced）；错 token、无 token 均 `1008 unauthorized`。
- 异步回写：`reply` 返回 202 + `taskId`，后台完成后状态为 `synced`；失败重试耗尽后 `failed` + DLQ。
- 回流：状态事件经 Webhook 按 `traceId` / `externalId` 均能把状态改为目标值并写入 `sync` 日志。
- 本地全栈联调（2026-11-03，Mock）：后端 3001 + 前端 5173，页面显示「真实后端 · 已接入 LinkHub Server」；Webhook 灌入 4 条消息 → 收件箱计数 4、待办 2；页面内回复后状态走完 `received → processing → replied → sent → synced`，`/api/health` 中 `sent=1`，前端经 WebSocket 实时更新。
- 截图见 `test.photos/`（2026-11-02 旧版界面，仅作历史记录）；当前版本的演示流程与界面说明见 [docs/demo-script.md](docs/demo-script.md)。

## 设计文档承诺 vs 当前实现（验收前必读）

设计文档（`documents/`）是"目标态"，本仓库是"当前态"。为避免评审/验收时按文档核对产生误会，这里如实列出差异：

| 设计文档承诺 | 当前实现 | 说明 / 后续 |
|---|---|---|
| 四类数据源（飞书 / 钉钉 / 企微 / 邮箱）统一接入 | ✅ 已实现（邮箱为超出原设计的新增数据源） | 三平台 + 邮箱，均可 Mock/真实独立切换 |
| 本人账号接收 + 本人账号发送（替代逐群拉机器人） | ✅ 已实现（飞书 OAuth 用户身份轮询 / 钉钉官方 CLI dws 个人事件与本人发送） | 统一身份策略 `*_IDENTITY=auto/bot/user`、状态如实标注、机器人保留兜底；**飞书 2026-11-12 真实端到端已通过**（收单聊 + 群聊、以本人身份发送；本机租户 `21001` 已解除），钉钉真实端到端仍待企业 CLI 访问 + 真人授权，见 [docs/personal-identity.md](docs/personal-identity.md) |
| 完整闭环（接收→展示→处理→回写→回流）+ traceId 回放 | ✅ 已实现并有单测/e2e 覆盖 | `pnpm e2e` 20 项断言 |
| 从统一入口向指定平台发送文本 + 文件 | ✅ 已实现 | 「新建发送」可指定平台/会话并挂附件，邮箱平台还可选择发件账号；回复也支持附件；四平台适配器各自完成媒体上传或 MIME 转换，附件元数据进闭环回放 |
| 独立部署：可在纯净服务器零依赖启动 | ✅ 已实现（单容器方案） | `Dockerfile` + `docker-compose.yml` + [docs/deploy.md](docs/deploy.md)：server 同源托管前端，单端口 3001，含健康检查与数据卷；镜像可 `docker save/load` 离线搬运 |
| 闭环数据重启后仍可回放 | ✅ 已实现（文件快照） | `DATA_DIR` / `DATA_FILE` 开启原子快照，消息 / trace / DLQ 落盘；Docker 默认挂载 `linkhub-data` 卷 |
| PostgreSQL / Redis 持久化 | ❌ 未实现 | 仅有 `001_init.sql` 与仓储接口；当前为单实例内存 + 文件快照，不是关系库 |
| 真实大模型意图识别 | ✅ 已实现（OpenAI 兼容协议，默认 MiMo flash） | 2026-11-11 实测：5 条业务样例 **5/5** 命中（同批关键词规则仅 2/5），平均 5.47s、最大 9.3s；doctor 探针实跑 2.5s PASS。仅真实调用失败才回退规则并标注来源；低置信结果一律采用，按 `aiPrecision` 标注精度 |
| OCR 真实调用 | ❌ 未实现 | 仍是占位实现；赛题 A 不依赖 OCR，配置项已预留 |
| 三平台真实收发 | 🟡 部分 | **历史记录（2026-11-10）**：用真实 `.env` 跑 `doctor`，钉钉 accessToken / 机器人编码 / 收消息通道、企微 access_token、163+QQ 邮箱 IMAP+SMTP 全部 PASS；唯一 FAIL 是飞书租户策略 `21001`（`start.bat doctor` 可复现）。**2026-11-12 复测本机租户 `21001` 已解除**（`tenant_access_token` 返回 `code:0`），并完成飞书本人身份真实端到端（收单聊 + 群聊、发本人）；企微真实发送仍卡可信 IP `60020`。计数以实际输出为准 |
| 入口鉴权（Bearer + WS）| ✅ 已实现 | `/api/*` 与 `/ws` 同一 token；默认 `dev-token` 仅演示用，对外需改 |
| CORS 白名单 | ✅ 已实现 | `CORS_ORIGINS` 白名单（不填保持 `*` 兼容本地；填了名单外 403 JSON） |
| 日志脱敏 | ✅ 已实现 | 闭环日志不含正文；doctor 报告邮箱脱敏；启动日志与 `mock-send` 已不打印邮箱/正文 |
| Webhook 健壮性 | ✅ 本轮加固 | 空 / 畸形事件 400 不入库；状态回流防倒退；畸形 JSON 返 JSON 错误 |

> 风险全量清单（含每条的影响/修复状态/兜底方案）见 [docs/risk-register.md](docs/risk-register.md)；交付前务必走 [docs/delivery-checklist.md](docs/delivery-checklist.md)。

## 已知限制

- **飞书真实收发（历史记录：2026-11-10 曾被租户策略 `21001` 拦住；2026-11-12 本机租户已恢复正常）**：2026-11-10 在带真实凭据的 `.env` 上重跑 `doctor`，仍为 `21001`（`Access denied due to platform policy`），确认是租户级策略而非凭据或代码问题。**2026-11-12 用同一份 `.env` 真实凭据复测**：`POST /open-apis/auth/v3/app_access_token/internal` 与 `/tenant_access_token/internal` 均返回 `code:0`，本机租户已恢复正常，并已完成本人身份真实端到端（收单聊 + 群聊、以本人身份发送）；此前缺失的 `im:message` 等用户身份权限也已在后台开通并实测生效。**`21001` 仍是飞书平台策略**，换租户 / 换环境 / 平台策略变化仍可能再现，换 Secret、改代码、加 IP 白名单都无效，只能企业认证或换合规租户（排错说明保留，见下文「真实接入实测记录」）。
- **企业微信**：真实适配器与 19 条单测已就绪、`gettoken` 已通，但**卡在「企业可信 IP」**——当前出口 IP 不在白名单，真实发送端到端尚未验证（典型报错 60020）；同时缺回调 Token/EncodingAESKey，暂时收不到消息。`pnpm run doctor` 每次都会打印当前出口公网 IP：电脑重启一般不影响（公网出口在网关/运营商侧），但重拨路由器、换网络、开代理后可能变化，演示前先核对即可。
- **个人版（授权中心）里飞书 / 企业微信需要企业管理员开通**：飞书要企业自建应用 + 消息权限 + 重定向 URL + 发布版本；企微要自建应用 + 接收消息 Token/EncodingAESKey + 「企业可信 IP」；钉钉本人身份还要企业开启「CLI 访问管理」。这些个人用户无法自助完成——「连接账号」页会标「需管理员」并给可复制清单与官方后台深链。**拿到凭据后要在页面「填写…凭据」（或写 `.env`）并重启 LinkHub 才生效**；「刷新状态」只重读状态、不会补凭据（钉钉本人身份登录 / 身份策略是热应用，见 §「身份模式」）。邮箱与演示模式不受影响。
- **钉钉**真实收消息依赖 Stream 长连接（本机可用）或公网 HTTP 回调；`DINGTALK_STREAM` 默认关闭，需要显式开启并在后台发布版本。
- **钉钉 / 企业微信群聊只推「@机器人」的消息**（平台规则，不是本项目限制）：普通群消息不会推给机器人，钉钉 Stream 的机器人通道只投递「单聊」和「群内 @机器人」。所以群聊场景能聚合的就是被 @ 的那一条，**不能承诺"群里所有消息都收"**。另外群里要添加的是**企业内部应用机器人**（自定义 Webhook 机器人只能发、不能收）。群内 @ 消息入库后会保留群会话与群名，回复走群消息接口回到原群（界面「会话」一行显示「群聊「群名」· 回复会发回该群」）。参考：[钉钉机器人接收消息](https://open.dingtalk.com/document/robots/receive-message)。
- **本人身份（飞书 / 钉钉）**：身份解析、飞书用户轮询、钉钉 dws 子进程 / 事件解析 / 本人发送都有单测与 fake-dws 桩覆盖；**飞书已于 2026-11-12 完成真实端到端验收**（真实 OAuth → 本人身份轮询收单聊 + 群聊 → 以本人身份发送，飞书侧核对 `sender_type=user`；本机租户 `21001` 已解除），证据见 [验收记录](docs/verification/feishu-personal-e2e-2026-11-12.md)。**钉钉真实端到端仍待实测**：需要企业管理员开启 CLI 访问并本人完成授权（本机 dws v1.0.68-beta.1 已安装但未登录）。边界见 [docs/personal-identity.md](docs/personal-identity.md) §11。
- **飞书本人接收是轮询，不是实时推送**：默认 20s 一轮（`FEISHU_USER_RECEIVE_SECONDS`，最小 5），新消息通常 5–30s 出现；**只能读本人可见的会话**；首轮默认只立基线不灌历史（`FEISHU_USER_BACKFILL_HOURS=0`）；用户身份读消息 / 列会话权限需管理员在后台开通并使权限生效（正式应用需重新发布版本；测试应用免审），**从旧版本升级后需重新授权一次**（OAuth 会额外申请读消息与 `im:chat:read` scope，旧 token 不含，轮询会报 `99991672` / `99991679`）；**单聊枚举依赖未公开参数 `types=p2p,group`**（不带只返回群聊；平台若拒绝该参数会自动降级为纯群列表——单聊收不到、群聊继续，不阻断接收）；机器人长连接与本人轮询同时开启时，同一单聊消息可能被两条通道各入库一次（`externalId` 幂等只留一条），建议演示时二选一。
- **钉钉本人身份依赖官方开源 CLI `dws`（官方处于共创阶段）**：需企业管理员在钉钉开发者平台开启「CLI 访问管理」（或走 Custom App 自有应用模式）；**首次必须真人授权**——本机推荐「用浏览器登录（推荐）」（`127.0.0.1` loopback，浏览器必须与 LinkHub 同机，约 10 分钟操作窗口），服务器 / SSH / 容器用设备码（约 15 分钟有效，过期必须「重新获取授权码」，旧码会报 `Invalid or expired user code`）。凭据加密绑定设备，**Windows 上不能跨机复制**，容器部署需在容器内登录（见 [docs/deploy.md](docs/deploy.md)）。dws 未安装 / 未登录时 `auto` 回退机器人、`user` 显式报错，不会假成功。
- **钉钉本人事件暂不支持按群 / 按人订阅**：`DINGTALK_USER_EVENT_KINDS` 里的 `group` / `sender` 需要 dws 的目标参数（`--chat-id` / `--user`），本期不做；**配置了会被忽略并在启动日志告警**，回退默认 `all-direct,at-me`（不会导致子进程重启）。支持的范围是 `all-direct` / `at-me` / `all-group`。
- **钉钉双通道同时开启会重复入库（已知限制）**：机器人 Stream（`DINGTALK_STREAM=true`）与本人身份个人事件同时开启时，同一条钉钉消息可能**各入库一次**——机器人通道与个人事件的平台消息 ID 体系不同，跨通道幂等键不通用。**建议二选一**：要用本人身份就关机器人 Stream，或关本人接收（`DINGTALK_USER_RECEIVE=false`）。
- **单实例单身份**：一次只绑定一个飞书账号 / 一个 dws 登录用户；不支持多员工共享同一实例，需要各自部署。飞书 `refresh_token` 单次有效，不要让多个后端进程共享同一个令牌文件（并发刷新会互相失效）。
- **邮箱**没有平台回调：真实模式下 `/api/webhook/mail` 一律验签失败，新信只能由本机轮询 ingest，默认 45s 一轮，不是实时。
- 邮箱 UID 水位已持久化到 `.mail-watermarks.json`（`MAIL_STATE_FILE` 可改路径），重启续传、不再跳过停机期间的邮件；单轮最多追 5 批（每批 20），大批量新邮件会跨轮继续，不会跳水位。**升级到本版本之前**已发生过的「目录被清空/重建」无法识别（旧状态没有 UIDVALIDITY）；升级后遇到 UIDVALIDITY 变化会按「宁可重复、不漏信」自动重导（若目录重建但保留原邮件，可能重复导入一次）。
- 邮箱 STARTTLS（143/587/25）已实现并有单测，但真实服务商 587/143 端到端尚未实测；部分服务商（如 Gmail 需应用专用密码，部分 Microsoft 365 租户关闭基础认证）可能拒绝账号密码/授权码登录，遇到时需改用应用专用密码或换服务商。
- 邮箱附件：正文会递归解析嵌套 multipart（不会因带附件而丢正文），附件名只出现在正文摘要/`attachments` 字段，不下载附件内容；中文 IMAP 目录已支持 modified UTF-7 编码（仅对配置的目录 SELECT，未实现目录自动发现）。
- **飞书本人接收的附件大小显示 0（平台未给大小）**：本人轮询拿到的 file/image 消息只带文件名/类型，`size` 记为 0，属已知限制；机器人通道的附件大小不受影响。
- **钉钉自环过滤是 best-effort**：真实 `dws contact user get-self` 只返回 `result[0].orgEmployeeModel`（orgUserName / userId），**不返回 openDingTalkId**；个人事件本身只推「收到」的消息、通常无需过滤，LinkHub 拿不到 `openDingTalkId` 时**不做过滤、不告警、不阻断**（若未来 dws 返回会自动启用）。
- OCR 尚未实现真实调用：`OCR_*` 只是预留配置，实际始终走占位规则（赛题 A 不依赖 OCR）。大模型已接真实调用，见 [ai-integration.md](docs/ai-integration.md)。
- PostgreSQL / Redis 仅有 DDL 与仓储接口，实际走「内存 + 可选文件快照」；多实例部署时限流、token 缓存、消息均不共享，水平扩展 / 高可用未实现（附加分项不申领）。单容器独立部署已提供，见 [docs/deploy.md](docs/deploy.md)。
- 前端默认跑内存 Mock 数据；配 `VITE_API_BASE` / `VITE_API_TOKEN` 后即接本仓库后端。入口令牌是演示性质（`VITE_` 会进前端 bundle），生产需换成登录后签发的短期凭证。
- 默认监听所有网卡（`SERVER_HOST` 留空）+ 默认 `dev-token` 只适合本机演示；公共 Wi-Fi / 局域网演示时同网段可访问接口，**对外暴露前必须改 `API_TOKEN`、按需设 `CORS_ORIGINS` / `SERVER_HOST`**。
- Mock 下不带签名头时按 `mock` 放行、`dev*` 前缀签名同样放行，仅适合本地演示；邮箱真实模式没有回调通道也是防伪造的有意设计。
- 默认（不设 `DATA_DIR` / `DATA_FILE`）所有消息、闭环日志、DLQ 都在内存里，进程重启即清空（邮箱水位除外，已落盘）；设置 `DATA_DIR` 后启用文件快照，重启可恢复，快照为单文件 JSON，不适合大数据量或多写入者并发。
- 真实平台的文件发送通道（飞书 `im/v1/files`、企微 `media/upload`、钉钉 `robot/media/upload`）已按官方接口实现并有单测，但受租户策略 / 企业可信 IP 限制，**尚未端到端实测**；Mock 通道可完整演示并会明确标注「模拟发送」。
- `scripts/e2e-server.log.err`：旧版本曾误提交，本版本已从 git 索引删除，并把 `*.log.err` / `*.log` 加入 `.gitignore`（日志类产物不再进仓库）。
- `test.photos/` 是 2026-11-02 旧版界面截图，当前 UI 已改版（新增账号页模式标注、首启引导等），仅作历史证据保留。

## 常用命令

在 `unimsg-connector/` 目录下执行：

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 开发模式（tsx watch） |
| `pnpm start` | 启动服务（:3001） |
| `pnpm typecheck` | TypeScript 类型检查（shared + server + web） |
| `pnpm test` | 服务端单元测试（条数以实际输出为准，含 doctor / webhook / MIME / 出站附件 / compose / 快照） |
| `pnpm run fetch:dws` | 下载钉钉官方 CLI `dws` 到 `unimsg-connector/tools/`（默认 v1.0.68-beta.1，校验 `dws version`；幂等，`--force` 重装；桌面版构建内置） |
| `pnpm test:web` | 前端单元测试（条数以实际输出为准，含新建发送 / 附件工具） |
| `pnpm --filter @unimsg/web lint:css` | 样式护栏：字号 rem / 色值走令牌 / 位移走 transform / 暗色块禁 `!important` / 圆角用尺阶 |
| `pnpm run doctor` | 只读自检：环境 + 模式 + 逐平台探针 + 大模型连通性 + 出口公网 IP + 中文修复建议；有 FAIL 时退出码 1；四平台都没配凭据时结论为「⚠ 尚未配置任何平台」而非「✔ 自检通过」 |
| `pnpm run doctor --platform=feishu,mail` | 只检查指定平台 |
| `pnpm run doctor --help` | 查看 doctor 全部参数与退出码 |
| `pnpm --filter @unimsg/server run --silent doctor --json` | 机器可读 JSON（stdout 严格合法 JSON；`--silent` 避免 pnpm banner 混入） |
| `pnpm e2e` | 一键端到端冒烟（Windows PowerShell） |
| `pnpm e2e:sh` | 一键端到端冒烟（macOS / Linux / Git Bash） |
| `pnpm run deliver` | 交付打包：`git archive` 生成 zip，自动排除 `.env*` / 日志 / 状态文件 / `node_modules`（工作区不干净会拒绝） |
| 双击 `start.bat` / `start-docker.bat` | Windows 一键启动：本地前后端 / Docker 单容器，自动装依赖、配环境变量、开浏览器（详见上文「Windows 一键启动」） |
| `start.bat mock` / `start.bat accounts` / `start.bat doctor` | 强制离线 Mock / 打开账号配置 / 只读账号自检 |
| `start.bat stop` / `start.bat stopdocker` | 一键停止本地服务 / Docker 栈 |
| `docker compose up -d --build` | 在 `unimsg-connector/` 下执行，一键构建并启动独立部署容器（详见 [docs/deploy.md](docs/deploy.md)） |
| `docker compose logs -f app` / `docker compose down` | 查看容器日志 / 停止并保留数据卷 |
| `pnpm --filter @unimsg/web dev` | 前端开发模式（:5173，不配 `.env` 时为 Mock 数据） |
| `pnpm --filter @unimsg/web build` | 前端生产构建 |
| `node packages/web/scripts/verify-contract.mjs http://127.0.0.1:3001 dev-token` | 前后端契约自检（后端已启动；当前 **81 PASS / 0 FAIL**（以实际输出为准）） |

`e2e` / `e2e:sh` 都可直接追加端口参数，例如 `pnpm e2e -Port 3102`、`pnpm e2e:sh 3102`。

要连真实钉钉收发（Stream 模式，无需公网）：

```bash
DINGTALK_STREAM=true DINGTALK_MODE=auto pnpm --filter @unimsg/server start
```

> Windows PowerShell 请先 `$env:DINGTALK_STREAM="true"` 再启动，或直接写进 `.env`（推荐）。

## 设计文档

- [documents/赛题A_多平台连接器_初赛设计文档_精简版.docx](documents/赛题A_多平台连接器_初赛设计文档_精简版.docx)（初赛，≤10 页）
- [documents/赛题A_多平台连接器_竞赛执行文档_v3.docx](documents/赛题A_多平台连接器_竞赛执行文档_v3.docx)（决赛完整版，≤15 页）

## License

见 [LICENSE](LICENSE)。
