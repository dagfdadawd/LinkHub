# 本人账号收发（本人身份模式）

> **一句话**：飞书、钉钉从「机器人收发」改为「用员工**本人账号**收、用本人账号发」——同事不需要再把自己的机器人拉进每个群；机器人身份保留为兼容 / 兜底，任何状态下界面和接口都会如实标注当前是「本人 / 机器人 / 模拟」。
>
> 本文是**平台配置 + LinkHub 操作**的完整说明。想先看离线效果，直接跳 [§7 离线演示](#7-离线演示用-fake-dws-模拟已登录不碰真实钉钉)。
>
> 相关文档：[reference.md 身份模式](reference.md) · [quickstart.md](quickstart.md) · [swap-accounts.md](swap-accounts.md) · [demo-script.md](demo-script.md) · [deploy.md](deploy.md)

---

## 0. 先对号入座

| 你想做什么 | 读哪几节 | 平台前提 |
|---|---|---|
| **个人版首次使用**（从图形向导进入） | [quickstart 路径 E](quickstart.md#path-e)、[§3.4 管理员事项](#34-管理员事项汇总授权中心可一键复制) | 邮箱可自助；飞书 / 微信需企业管理员开通，钉钉还要企业开 CLI 访问 |
| 只想离线看「本人身份」长什么样 | [§2](#2-能力总览)、[§7](#7-离线演示用-fake-dws-模拟已登录不碰真实钉钉) | 无（本地桩） |
| 用**飞书**本人身份收发 | [§3 边界](#3-平台边界先读避免踩空)、[§4 配置](#4-飞书本人身份配置)、[§6 LinkHub 操作](#6-linkhub-内操作与状态标注) | 飞书自建应用 + 管理员开用户身份权限 |
| 用**钉钉**本人身份收发 | [§3 边界](#3-平台边界先读避免踩空)、[§5 配置](#5-钉钉本人身份配置dws-cli)、[§6 LinkHub 操作](#6-linkhub-内操作与状态标注) | 本机装 dws + 企业管理员开启 CLI 访问 + 首次真人授权（本机推荐浏览器登录；远程/无浏览器用设备码） |
| 连接失败 / 收不到消息 | [§10 故障排查](#10-故障排查总表) | — |
| 想退回机器人模式 | [§9 回退](#9-回退到机器人身份) | — |

---

## 1. 为什么要从机器人改成本人身份

机器人方案在真实企业里跑不通，不是因为技术难，而是**使用成本不可接受**：

| 维度 | 机器人身份（旧方案） | 本人身份（本方案） |
|---|---|---|
| 同事用之前要做什么 | **每个人**把自己的机器人拉进自己所在的每个群；群主 / 管理员逐群添加 | 不需要拉机器人进群；在 LinkHub 账号页连接本人账号一次（单实例场景） |
| 群里能收什么 | 平台只推「@机器人」的消息，普通群消息收不到 | 飞书：用户可见的会话（单聊 + 群聊）可读；钉钉：按订阅范围收本人事件（单聊 / @我 / 指定群等） |
| 发出去显示谁 | 显示为机器人应用 | 显示为**你本人** |
| 权限前提 | 应用 + 机器人能力发布 | 应用 + **用户身份权限**（飞书）；本机 CLI + 企业管理员开启 CLI 访问（钉钉） |
| 平台限制 | 群消息必须 @ 机器人；消息与会话受机器人可见范围限制 | 只覆盖**本人可见 / 本人被推送**的消息；飞书轮询有延迟；钉钉需本机 CLI 在线 |
| 如实标注 | Mock / 真实模式分开标注 | **本人 / 机器人 / 模拟**三态分开标注，绝不混淆 |

**为什么不能承诺「全公司零配置」**：LinkHub 目前是**单实例单身份**设计——一次授权对应一个飞书账号 / 一个 dws 登录用户，每个员工各自部署 / 各自连接自己的实例。它解决的是「不用逐群拉机器人」，不是「一套服务接管全公司所有人的个人消息」；多租户共享实例不在本期范围。

---

## 2. 能力总览

| 平台 | 本人身份**发送** | 本人身份**接收** | LinkHub 实现方式 | 当前状态 |
|---|---|---|---|---|
| 飞书 | ✅ 官方支持（`user_access_token` + `im/v1/messages`）；以本人身份发出后，飞书侧 `sender.sender_type=user` | ⚠️ 官方无「个人消息推送事件」，用用户 token **轮询**本人所在会话的增量消息；单聊 + 群聊均以 `receivedAs=user` 入库（列会话需带 `types=p2p,group`） | 用户 OAuth 授权 → 轮询器 + 水位持久化 | 接收是轮询（5–30s）；单聊枚举依赖未公开参数 `types`，有降级兜底，见 §3.1 |
| 钉钉 | ✅ 官方开源 CLI [`dws`](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) 的 `dws chat message send`（以当前登录用户身份发） | ✅ 同上，`dws event +listen-im` 个人事件订阅（Stream 长连接，NDJSON） | 子进程调用本机 `dws`，LinkHub 管理登录态 / 事件流 / 重启 | 代码 / 单测 / fake-dws 桩就绪；真实登录需企业开启 CLI 访问（见 §3.2） |
| 微信 / 邮箱 | — | — | 不适用本人身份（平台无对应能力），保持现有机器人 / IMAP 通道 | 不变 |

机器人身份**保留**：飞书长连接 / Webhook、钉钉 Stream 机器人都还在，配置一个不删。任何平台都可以随时切回机器人（见 §9）。

---

## 3. 平台边界（先读，避免踩空）

这一节是**平台侧的客观限制**，不是 LinkHub 的 bug，也不承诺能绕过。写文档 / 答辩 / 演示时请如实说明。

### 3.1 飞书：轮询、用户可见范围、租户策略

- **接收是轮询，不是实时**：飞书官方没有面向"个人消息"的推送事件，本项目用用户身份 token 轮询本人所在会话，**默认 20 秒一轮**（`FEISHU_USER_RECEIVE_SECONDS`，最小 5），新消息通常 **5–30 秒**内出现，取决于轮询间隔与平台接口耗时。不要承诺"秒级实时"。
- **只能读本人可见的会话**：列会话 / 读消息都用授权用户的身份，**读不到你本人不所在的群、也读不到别人视角的消息**。这是"本人身份"的语义边界，不是缺陷。
- **首轮默认不灌历史**：`FEISHU_USER_BACKFILL_HOURS=0` 时首轮只记录每个会话的水位基线，只入库之后的新消息；需要回看最近 N 小时可设 `24` 等。
- **需要用户身份权限**：除发送所需的用户身份权限外，接收还需要「以用户身份获取单聊消息 / 群聊消息」与「查看群信息」（`im:chat:read`，列会话的硬前提；缺它列会话直接报 `99991679`）等权限（见 §4.1），由应用管理员开通并发布版本。
- **企业认证 / 租户策略 `21001`**：部分租户（常见于未完成企业认证）换应用 `tenant_access_token` 会被平台策略直接拒绝，报 `21001 Access denied due to platform policy`。这是**租户级策略**：换 Secret、改代码、加 IP 白名单都无效，换租户 / 换环境 / 平台策略调整都可能再现，处理方式只有「企业认证或换合规租户」。遇到时先按本节排查，否则后面的授权步骤都会失败。
- **列会话必须带 `types=p2p,group` 才能看到单聊**：飞书公开文档对 `GET /open-apis/im/v1/chats` 的说明是「不包含单聊」；不带 `types` 只返回群聊，加上 `types=p2p,group` 才会带上单聊。该参数**未收录于公开 API 文档**（飞书官方 CLI 在用），存在被平台调整的风险；LinkHub 已做**进程内降级兜底**：平台一旦报参数错误（`232001` / invalid request parameter），自动永久退回不带 `types` 的纯群列表并告警——单聊收不到，但群聊接收不中断（见 §4.4、§4.6）。
- **单实例单账号**：一次授权绑定一个飞书账号；换账号需重新授权（令牌文件按 App ID 校验，换 App 会要求重新授权）。

### 3.2 钉钉：dws 共创阶段 + 企业 CLI 访问 + 首次真人授权 + 凭据绑定设备

钉钉本人身份走官方开源 CLI `dws`，它负责 OAuth 登录、token 刷新、个人事件 Stream 长连接，LinkHub 只做子进程编排。代价是**多了几道平台前置条件**：

1. **这是个"共创阶段"的官方工具**：项目文档明确说明涉及企业数据访问，**需企业管理员授权后方可使用**；默认需要管理员在钉钉开发者平台开启「CLI 访问管理」。未开启时，`dws auth login` 会引导你向管理员发起申请，审批通过后才能登录。这不是改 `.env` 能解决的。
2. **替代路径：Custom App（自有应用）模式**：企业可在钉钉开放平台创建自建应用、配置重定向 URL（`http://127.0.0.1`、`https://login.dingtalk.com`）、发布后，用该应用的 Client ID / Secret 登录（命令见 §5.2）。适合企业统一管控，但仍需应用管理员操作。
3. **首次登录必须真人授权，优先用浏览器**：本机有浏览器时用 `dws auth login`（启动 `127.0.0.1` loopback 本地回调，浏览器打开钉钉授权页，扫码 / 账号登录并确认后自动完成，**不用手输设备码**）；授权地址只能**在运行 LinkHub 的这台机器**上打开。只有服务器 / SSH / 容器 / 无浏览器环境才用设备码 `dws auth login --device`：设备码有效期通常约 15 分钟（以界面倒计时为准），过期即失效、必须重新获取，继续输旧码会提示 `Invalid or expired user code`。**没有任何"服务端代登录"的捷径**。
4. **凭据与设备绑定，不能跨机复制**：dws 的 token 在 Windows 上用系统凭据保护（DPAPI）、并以设备信息派生密钥加密，官方文档明确「跨设备无法解密」。**不要**把一台机器的 `~/.dws` / 凭据目录拷到另一台机器，**换机器 / 重建容器 = 重新登录**。（Linux 沙箱间官方提供 `dws auth export/import`；Windows 跨机迁移未验证，不写进操作步骤。）
5. **容器部署需在容器内登录**：dws 必须运行在 LinkHub 进程所在环境；容器里没有 dws / 没登录时，LinkHub 会按策略回退机器人或显式报错（见 §9），不会假装本人身份可用。
6. **接收范围按订阅事件**：默认订阅「全部单聊 + @我」（`DINGTALK_USER_EVENT_KINDS=all-direct,at-me`）；全量群消息（`all-group`）量大、按需开启。**`group`（指定群）/ `sender`（指定发送人）暂不支持**——它们需要 dws 的群 / 人目标参数（`--chat-id` / `--user`），本期不做；配置了会被**忽略并在启动日志告警**，回退到 `all-direct,at-me`，不会导致子进程反复重启。
7. **dws 进程需保持运行**：LinkHub 会拉起并监管 `dws event +listen-im` 子进程；进程崩溃会自动退避重启。dws 未登录 / 被卸载时，收发都会如实降级并在账号页给出修复命令。
8. **以本人身份发出的消息会带「AI 发送角标」**：dws 发送默认带钉钉平台的 AI 发送角标（`--ai-tag` 默认 `true`），LinkHub **保留这个默认**、不关闭也不伪造——对方能看出这条消息是由自动化工具以你本人身份发出的。这是透明标注，不是缺陷；若企业要求去掉，需要改 dws 调用参数（属于产品策略决定，不在本文范围）。

### 3.3 两者共同的边界

- **真实凭据只在本机 / 服务端**：飞书 token 存服务端令牌文件，钉钉 token 存本机 dws 凭据存储；都不下发前端、不写日志、不进 git（见 §8）。
- **双通道同时开启会重复入库**：① 钉钉机器人 Stream（`DINGTALK_STREAM=true`）与本人身份个人事件同时开启时，同一条钉钉消息可能**各入库一次**——两套平台消息 ID 体系不同，跨通道幂等键不通用；② 飞书机器人长连接（`FEISHU_STREAM=true`）与本人轮询同时开启时，在「机器人与本人同处的单聊」里同一条消息也可能被两条通道各入库一次（同一 `externalId` 幂等，只留一条）。**建议二选一**：要用本人身份就关掉机器人通道（`*_STREAM=false`），或反过来；这是已知限制，不是 bug。
- **Mock 永远是 Mock**：平台 `*_MODE=mock` 时本人身份通道不启动，界面统一显示「演示」（接收标「演示接收」、发送标「模拟发送」），不会显示成"本人已连接"。
- **多员工共享一个实例不支持**：单身份模型；需要多人使用请各自部署（或等后续多租户能力）。
- **平台策略会变**：飞书权限名、钉钉 CLI 访问策略以官方后台当时展示为准；本文写作时已做只读探测，但平台侧可能调整。

---

### 3.4 管理员事项汇总（授权中心可一键复制）

白号（零凭据）首先遇到的不是「点一下登录」，而是**缺平台应用凭据**：飞书必须由企业管理员创建应用并提供凭据（微信走 RPA 补充通道，无需管理员）；钉钉本人身份只需要管理员开启 **CLI 访问管理**（**不需要机器人应用**）。授权中心把每个平台的「缺什么、去哪开通、怎么填回 LinkHub」做成可复制清单（`GET /api/onboarding` 的 `actions[].text`，与本节一致，可整段发给管理员）。

| 平台 | 管理员要做什么 | 官方后台 | 拿到凭据后填哪里 |
|---|---|---|---|
| 飞书 | 创建**企业自建应用** → 权限管理开通消息权限（清单列出具体 scope；本人接收另需 `im:message.p2p_msg:get_as_user` / `im:message.group_msg:get_as_user`）→ 安全设置添加**重定向 URL**（`http://localhost:<端口>/api/feishu/oauth/callback`，页面给出实际值）→ 事件订阅：**默认用长连接**（可免公网回调，此时 Verify Token / Encrypt Key 都可不填）；只有改用 HTTP 回调模式才必须填 Verification Token → **发布应用** | <https://open.feishu.cn/app> | 连接账号 → 飞书卡片 **「填写飞书应用凭据（App ID / App Secret）」**：App ID / App Secret（可选 Verify Token / Encrypt Key）→ 保存 → **重启 LinkHub**；或写 `.env` 的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFY_TOKEN` / `FEISHU_ENCRYPT_KEY` |
| 钉钉 | **本人身份（推荐）**：管理员在钉钉开放平台开启 **「CLI 访问管理」**（无需创建机器人应用）——这是个人身份收发的唯一企业侧前提。**如还要机器人通道**：创建企业内部应用（Client ID / Secret / RobotCode）并配事件订阅 AES | <https://open-dev.dingtalk.com/> | 本人身份：无需填凭据，直接在连接账号 → 钉钉点 **「用钉钉本人账号登录（推荐，无需机器人应用）」**；机器人凭据可选填 **「填写钉钉应用凭据」** 或 `.env` 的 `DINGTALK_CLIENT_ID` / `_SECRET` / `_ROBOT_CODE` |
| 微信 | **不需要管理员**（RPA 补充通道）：微信个人版无官方收发 API。本机登录并打开**微信桌面端 3.9.x**（4.x 是 Qt 自绘界面、无控件树：自动轮询不可用，改用「按需拉取」）→ `pip install pyautogui pyperclip pywin32 uiautomation` → 启动 `scripts/wechat-rpa/rpa_bridge.py --mode rpa` | 无（不走平台后台） | 连接账号 → 微信卡片确认桥地址即可（默认 `http://127.0.0.1:8787`）；`.env` 设 `WECHAT_MODE=real` 才真实收发，默认 Mock |
| 邮箱 | **不需要管理员**：自己到邮箱网页版开启 IMAP/SMTP 并生成授权码 | 各服务商设置页（页面给深链） | 连接账号 → 邮箱卡片 **「添加邮箱账号」**（地址 + 授权码 → 测试连接 → 保存账号） |

> - **凭据填进 LinkHub 才算数**：管理员在平台后台开通 ≠ LinkHub 有凭据；页面保存的是本机 `linkhub-config.json`（`DATA_DIR/linkhub-config.json`，无 `DATA_DIR` 时 `unimsg-connector/.linkhub-config.json`，已 gitignore、权限收紧、**secret 只回末 4 位**）。**保存应用凭据后必须重启**才生效；只有「钉钉/飞书本人身份登录」是热应用（登录即可用，无需重启）。
> - `.env` 里显式写过的键**优先**，页面不能覆盖（会提示「部分配置来自 .env，未被本次保存覆盖」）。
> - **不要指望只点「刷新状态」**：刷新只重新读取当前状态，不会补凭据、也不会让缺配置的平台变成可用。
> - 管理员清单是**纯文本**（无 Markdown 星号），可整段复制；飞书清单第 7 步按钮名是「填写飞书应用凭据（App ID / App Secret）」、第 8 步是「连接飞书本人账号」；钉钉清单里的终端命令是可移植写法 `tools\dws.exe auth login --recommend`。
> - **白号口径**：2 项可自助（邮箱、钉钉）+ 1 项需管理员（飞书），按这个顺序做最省事。

### 3.5 仅本人身份（无需机器人应用）

钉钉可以**完全不配机器人应用**，只用本人账号收发：

- 身份策略设为 `user`（`DINGTALK_IDENTITY=user`；可在「平台应用配置」里打开「仅用本人身份（无需机器人凭据）」热应用，或写 `.env` / `linkhub-config.json` 后重启）；
- 只要有内置/已安装的 `dws`，并且你本人完成一次登录（连接账号 → 钉钉 →「用钉钉本人账号登录（推荐，无需机器人应用）」），本人接收（个人事件订阅）与本人发送就能工作，**不需要 `DINGTALK_CLIENT_ID/SECRET`**；
- **「一登即用」时序**：点「用钉钉本人账号登录（推荐，无需机器人应用）」**只打开登录弹窗，不会预先改任何配置**；**取消 / 未完成授权不改变任何设置**。**登录成功后**后端才自动热应用 `identity.dingtalk=user` 并持久化（无需重启），个人事件接收通道自动启动；外部终端完成登录时最多约 1 分钟自动对齐；
- **注销自动回退**：如果 `identity.dingtalk=user` 是「登录成功后自动启用」而来，注销 dws 时会自动回退 `auto`（不会把「已启用本人身份但未登录」的状态留着）；显式配置（`.env` / 页面保存）不会被自动改动。

**「只用真人」的完整配置（钉钉）**：`.env` 同时设 `DINGTALK_IDENTITY=user` 与 `DINGTALK_STREAM=false`，`DINGTALK_MODE` 保持 `auto`（**不要设 `mock`**，显式 mock 会把本人身份通道一起打成演示），改完重启后端。凭据 `DINGTALK_CLIENT_ID / SECRET / ROBOT_CODE` 建议保留作兜底：显式 `user` 时收发都走 dws，不会用到机器人；若 dws 是以 Custom App 模式登录的，这些凭据还可能是登录态的一部分。**不需要去开放平台停用或删除机器人应用**——走不走机器人由 LinkHub 侧开关决定，后台关掉只会让机器人 Stream 连不上，也不会把消息变成真人发。

此配置下 `doctor --platform=dingtalk` 的「平台模式」表里，钉钉「收信」列仍显示 ✖（该列只统计机器人凭据通道，不假装能收）；探针会给出 `[PASS] 钉钉收消息通道（本人事件流）`，自检整体通过。真实收信能力以「钉钉本人身份（dws CLI）」探针为准。

## 4. 飞书本人身份配置

### 4.1 后台一次性配置（应用管理员 / 所有者操作）

在[飞书开放平台](https://open.feishu.cn/)开发者后台，基于**已有的自建应用**补充配置（机器人通道的配置保留不动）：

1. **权限管理 → 用户身份权限**开通（在「开通权限」抽屉里按用户身份权限勾选后点「确认开通权限」，测试应用免审、即时生效）：
   - `im:message`（获取与发送单聊、群组消息）
   - `im:message.send_as_user`（以用户身份发消息）——**本人发送必需**
   - `im:resource`（上传图片 / 文件；只发文本也建议一起开；**缺它授权页可能报 `20027` 当前应用权限不足**）
   - `im:chat:read`（查看群信息）——**列会话（含单聊）的硬前提**：缺它对 user token 调 `GET /open-apis/im/v1/chats` 直接报 `99991679`（required one of [im:chat:readonly, im:chat, im:chat.group_info:readonly, im:chat:read]），一条会话都列不出来，轮询等于空转。
   - 本人接收另需：`im:message.p2p_msg:get_as_user`（以用户身份获取单聊消息）、`im:message.group_msg:get_as_user`（以用户身份获取群聊消息）；缺权限时日志会给出 `99991672` 与所需权限清单（见 §4.6）。
   - `offline_access`（后台显示为「持续访问已授权的数据」）——**refresh_token / 自动续期必需，也要在「用户身份权限」里开通**：此前未开通时，授权页会报 `20027 当前应用权限不足`（同批还缺 `im:resource`）；补齐后恢复。
   - 注意：权限变更后必须**重新授权**（正式应用还需发布版本使权限生效；**测试应用**改动免审即时生效），旧 token 不带新权限。
   - **授权 scope 由 LinkHub 自动申请**：OAuth 时带 `im:message`、`im:message.send_as_user`、`im:resource`、`offline_access`；**本人接收开启时会额外申请** `im:message.p2p_msg:get_as_user`、`im:message.group_msg:get_as_user`、`im:chat:read`（`FEISHU_USER_RECEIVE=false` 或 `FEISHU_IDENTITY=bot` 时不申请）。后台仍需把这些权限在应用侧开通。
   - **从旧版本升级后必须「重新授权」一次**：旧 token 不含读消息 / 列会话权限，直接轮询会报 `99991672` / `99991679`（不会自己恢复）。
2. **安全设置 → 重定向 URL**：添加与 LinkHub 完全一致的地址，默认
   `http://localhost:<SERVER_PORT>/api/feishu/oauth/callback`
   （默认端口 3001 即 `http://localhost:3001/api/feishu/oauth/callback`）。协议、域名、端口、路径、结尾斜杠**全部要一致**；端口不是 3001 时先设 `FEISHU_REDIRECT_URI`，再把**同一个值**原样填进后台。
   - **常见坑**：这一项为空时，点授权会在飞书授权页报 **`20029 重定向 URL 有误`**；把上面的回调地址登记后即恢复。遇到 `20029` 先查后台这一项，不是 LinkHub 的 bug。
   - **桌面版（分发给多个员工）的回调地址是固定端口池**：安装包启动器只在 **3901–3910** 里挑空闲端口（`LINKHUB_DESKTOP_PORTS` 可覆盖），所以管理员**一次性登记** `http://localhost:3901/api/feishu/oauth/callback` … `http://localhost:3910/api/feishu/oauth/callback` 这 10 条（加上开发版 3001 共 11 条），**全公司所有员工机器都通用**——`localhost` 是每台机器各自的地址，不需要逐机/逐人登记。端口固定是故意的：飞书对重定向地址**逐字符精确匹配**（连 `127.0.0.1` 的无端口写法都不做端口通配），端口乱跳必报 `20029`；本机这组端口全被占用时启动器会明确报错而不会偷换端口。若仍报 `20029`，LinkHub 的失败面板会直接显示**本次真实回调地址 + 复制按钮 +「打开飞书开放平台」入口**，粘进后台即可，无需懂原理。详见 [desktop-app.md §3](desktop-app.md#3-配置真实平台账号)。
3. **持续授权（自动续期）由 `offline_access` 决定**：在「用户身份权限」开通 `offline_access`（后台显示「持续访问已授权的数据」）并重新授权后，OAuth 会返回 `refresh_token` + `refresh_token_expires_in`。旧版控制台曾有「刷新 user_access_token」开关，**新版控制台已无此项**（「安全设置」只有「重定向 URL」「IP 白名单」两页）。
4. **应用发布**：正式应用需重新发布版本并等权限生效（**测试应用**后台横幅提示「修改后无需重新审核即可生效」）；要授权的飞书账号必须在该应用的**可用范围**内（否则授权会报 `20010`）。
5. **租户策略 `21001`**：这是租户级策略，会直接把授权与收发挡在门外——遇到时先按 [§3.1](#31-飞书轮询用户可见范围租户策略) 处理租户策略，否则后面步骤都会失败。

### 4.2 `.env` 配置

```dotenv
# ---- 飞书：本人身份（发送 + 接收）----
# 身份策略：auto（默认，已连接本人就用本人，否则机器人）| bot（固定机器人）| user（固定本人，未授权/失效显式报错）
FEISHU_IDENTITY=auto
# 旧变量 FEISHU_SEND_AS 仍兼容（仅在未写 FEISHU_IDENTITY 时生效，会打印废弃提示）；新配置请只用 FEISHU_IDENTITY
# FEISHU_SEND_AS=auto

# 本人身份接收：auto（默认，身份=本人时自动开启）| true（强制开）| false（只发不收）
FEISHU_USER_RECEIVE=auto
# 轮询间隔秒（最小 5、最大 86400，默认 20）
FEISHU_USER_RECEIVE_SECONDS=20
# 每轮最多检查的会话数（1–100，默认 20；会话很多时按需调大）
FEISHU_USER_CHAT_LIMIT=20
# 首轮回溯小时数（0–720）：0（默认，只立基线不灌历史）| 24（回溯最近 24h）
FEISHU_USER_BACKFILL_HOURS=0
# 接收水位文件（默认：未设 DATA_DIR → unimsg-connector/.feishu-user-receive.json；
# 设了 DATA_DIR（Docker 为 /app/data）→ ${DATA_DIR}/feishu-user-receive.json，随数据卷持久化）
# FEISHU_USER_STATE_FILE=
```

其余既有变量不变：`FEISHU_APP_ID` / `FEISHU_APP_SECRET`（应用凭据）、`FEISHU_REDIRECT_URI`（自定义回调地址）、`FEISHU_USER_TOKEN_FILE`（令牌文件路径，默认 `unimsg-connector/.feishu-user-token.json`，Docker 为 `DATA_DIR/feishu-user-token.json`）、`FEISHU_STREAM`（机器人长连接，保留）。

> 改完 `.env` **必须重启后端**（配置只在启动时读取）；改前端 `.env` 必须重启 Vite。

### 4.3 在 LinkHub 里完成授权

> **白号先补凭据**：没有飞书应用凭据时卡片是「需管理员」，不会出现「连接飞书本人账号」。先在企业管理员协助下创建应用，然后：连接账号 → 飞书卡片 **「填写飞书应用凭据（App ID / App Secret）」**（可选 Verify Token / Encrypt Key）→「保存配置」→ **重启 LinkHub**（或写 `.env` 的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 后重启）→ 卡片变「需本人授权」再走下面步骤。

1. 启动后端 → 打开 LinkHub：从左侧 **「连接账号」** → 飞书卡片点 **「连接飞书本人账号」**，或从 **平台账号**页 → 飞书卡片进入（两条入口是同一 OAuth 流程）；
2. 点 **「连接本人账号」**（已授权过则显示「重新授权」；授权过期 / 异常时显示「重新连接」）；
3. 浏览器打开飞书授权页 → 用**要绑定的本人账号**点同意；
4. 授权成功后回到页面，飞书卡片的「身份 · 谁在收、谁在发」块显示 **接收 = 本人、发送 = 本人**，并显示「已连接：<账号展示名>」与有效期；若授权失败 / 弹窗被拦截，账号页会显示中文提示（「飞书授权未完成」或「浏览器拦截了飞书授权窗口」+ 常见原因清单 +「重新发起授权」/「我知道了」），不再整页跳走、也不会静默。

授权信息只存在服务端令牌文件里；前端 / 接口只拿得到"已连接 / 未连接 / 过期"等状态与脱敏后的展示名。

### 4.4 接收机制（看到什么、多久看到）

- 启动后日志出现身份行与轮询启动说明，例如：`[unimsg] 身份: 飞书=本人(收:用户轮询/发:本人)`（具体文案以实际日志为准）；
- 每轮先列本人会话（请求带 `types=p2p,group`，**单聊 + 群聊都会列到**；平台若拒绝该参数会自动降级为纯群列表并告警，见 §3.1），再对每个会话按时间水位拉增量（每轮最多 `FEISHU_USER_CHAT_LIMIT` 个会话）；单聊消息同样按本人身份入库（`receivedAs=user`）；
- 入库日志形如：`[feishu-user] 本人账号收到消息：单聊「LinkHub」 · 发送者=<脱敏名> · 类型=text`；群聊消息走同一通道，日志标「群聊」；
- 首轮默认只立基线，**不会把历史消息灌进收件箱**；设 `FEISHU_USER_BACKFILL_HOURS=24` 才会回溯；
- **水位同秒重复已收敛**：水位按「秒」下取整，飞书每轮会把水位同一秒的最后一条重新返回；LinkHub 在轮询里把 `create_time <= 水位` 的消息直接计为「已见过」跳过，不再重复 ingest——避免每轮重复写 `redelivered` trace 并触发全量落盘（返回字段 `alreadySeen`，日志形如「…重复 0 条，已见过 2 条」）；
- 自己发出的消息会被**尽可能**过滤（自环保护），不会在自己的收件箱里再出现一条；**飞书拿不到本人 open_id 时会跳过过滤并告警**；
- **双通道并存会重复入库（已知限制）**：机器人长连接（`FEISHU_STREAM=true`）与本人轮询同时开启时，在「机器人与本人同处的单聊」里同一条消息可能被两条通道各入库一次；实践中该单聊里本人发出的消息会先被机器人长连接入库为 `receivedAs=bot`（同一 `externalId` 幂等，只留一条）。**建议演示时二选一**；
- 权限不足时不会静默：账号页身份块 / 日志会给出所需权限与"重新授权"提示；
- 水位文件损坏 / 丢失时会安全回退并**重建基线**，重启后从水位续传；但**断档期间的消息不会自动补回**——需要回填就把 `FEISHU_USER_BACKFILL_HOURS` 设为 `24` 等值后重启（会把该时段消息重新入库）。

### 4.5 验证命令

```bash
# 在 unimsg-connector/ 下
pnpm run doctor --platform=feishu     # 应用凭据 + 用户身份探针（只读，不发送业务消息）
curl http://127.0.0.1:3001/api/health              # identities 摘要（发送/接收身份）
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/accounts
# 看飞书平台 identity 字段：policy / effectiveSend / effectiveReceive / user.hint
curl -X POST -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/feishu/oauth/start
# 返回真实飞书授权链接（data.url）与 redirectUri；浏览器打开它完成本人授权
curl -H "Authorization: Bearer dev-token" "http://127.0.0.1:3001/api/messages?platform=feishu"
# 收件箱里本人身份接收的条目带 receivedAs=user；单聊 conversation.type=p2p
```

### 4.6 飞书本人身份常见报错

| 现象 | 原因 | 处理 |
|---|---|---|
| 账号页身份为「未连接」，发送走机器人 | 还没点「连接本人账号」，或令牌文件被删 | 点「连接本人账号」/「重新授权」 |
| 发送失败「飞书用户授权已过期 / 请重新授权」 | refresh_token 失效 / 过期（约 7 天）、后台未开通 `offline_access`（持续访问已授权的数据）、令牌文件损坏 | 点「重新授权」；核对后台 `offline_access` 是否已开通（新版控制台**没有**「刷新 user_access_token」独立开关，自动续期由它决定）；`FEISHU_IDENTITY=auto` 下不会悄悄换回机器人 |
| 授权页报 `20027` / 权限不足 | 应用「用户身份权限」未开通 `offline_access`（后台显示「持续访问已授权的数据」）和 / 或 `im:resource`；也可能只是版本未发布 | 在后台「权限管理 → 用户身份权限」的「开通权限」抽屉里勾选 `offline_access` 与 `im:resource`，点「确认开通权限」（测试应用免审、即时生效），再回 LinkHub 重新授权 |
| 授权页报 `20010` | 当前飞书账号不在应用可用范围 | 让管理员把账号加入应用可用范围 |
| 授权页报 `20029` / redirect_uri 不合法 | 后台「安全设置 → 重定向 URL」为空（或与 LinkHub 实际回调不一致） | 在后台登记 `FEISHU_REDIRECT_URI` 的**同一个值**（默认 `http://localhost:3001/api/feishu/oauth/callback`，协议 / 域名 / 端口 / 路径 / 斜杠逐字符一致），保存后重新发起授权 |
| 列会话 / 接收报 `99991679` | 用户身份缺 `im:chat:read`（查看群信息），列 `/im/v1/chats` 被拒（required one of [im:chat:readonly, im:chat, im:chat.group_info:readonly, im:chat:read]） | 先在后台「权限管理 → 用户身份权限」开通 `im:chat:read`，再回 LinkHub「重新授权」（旧 token 不带新 scope；只重新授权、不开权限仍会报同样错误） |
| 点「连接本人账号」后飞书页报错、回到 LinkHub 没反应 | 回跳会提示「飞书授权未完成」/「浏览器拦截了飞书授权窗口」并给常见原因与「重新发起授权」 | 按提示检查：应用未发布/不在可用范围、重定向 URL 不一致、用户身份权限未开通；改完**重启后端**再重新授权 |
| 接收不到消息、日志提示权限错误（如 `99991672` / `230027`） | 缺用户身份读消息权限 / 未重新授权 | 按提示补齐 §4.1 的读消息权限，**重新授权**（正式应用需发布版本使权限生效；测试应用改动免审），权限变化后旧 token 不带新权限。后端 hint 原文：`飞书用户身份缺少「读消息」权限（错误码 99991672）：请在飞书开放平台「权限管理 → 用户身份权限」开通 im:message、im:message.send_as_user、im:resource、im:message.p2p_msg:get_as_user、im:message.group_msg:get_as_user、im:chat:read，发布应用版本后到 LinkHub「平台账号」页点「重新授权」。` |
| 能收但很慢（5–30s） | 轮询机制的固有延迟 | 正常现象；需要更快就减小 `FEISHU_USER_RECEIVE_SECONDS`（最小 5），但会增大接口调用量 |
| 收件箱只有部分会话的消息 | 只读本人可见会话；本人不在的群读不到 | 平台边界，无法绕过 |
| 首轮启动后历史消息没出现 | `FEISHU_USER_BACKFILL_HOURS=0` 默认只立基线 | 需要历史就设 `24` 等值后重启（注意会把该时段消息入库） |
| `21001` | 租户策略 / 企业认证（租户级策略，其他租户仍可能遇到） | 见 §3.1，改配置无解，只能企业认证或换合规租户 |

---

## 5. 钉钉本人身份配置（dws CLI）

### 5.1 安装 dws（`dws` 已在 PATH 可跳过）

官方仓库：[`DingTalk-Real-AI/dingtalk-workspace-cli`](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)（Apache-2.0）。官方提供两种安装方式（二选一）：

```powershell
# Windows（PowerShell，官方安装脚本，推荐）
irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex

# 或：从官方 Releases 页面下载对应平台的 dws 可执行文件，放到 PATH 目录
#   下载页：https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases
#   例如放到 C:\Users\<你的用户名>\.local\bin\dws.exe，或改 .env 的 DWS_BIN 指向绝对路径
```

```bash
# 验证（任何平台）
dws version     # 输出形如 Version: v1.0.x
```

本项目验证过的版本为 **v1.0.68-beta.1**；`event +listen-im`、`auth status --readonly` 等命令在较老版本可能不存在，遇到「命令不存在」先 `dws upgrade`。

### 5.2 让组织允许 CLI 访问（企业管理员操作）

两种方式任选，**都需要管理员**：

**方式 A：开启组织 CLI 访问（推荐）**

1. 企业管理员进入钉钉**开发者平台** → 「**CLI 访问管理**」→ 开启；
2. 成员执行 `dws auth login`；若组织未开启，CLI 会引导向管理员发起申请，管理员收到申请卡片后一键审批；
3. 审批通过后，重新执行 `dws auth login`。

**方式 B：Custom App（自有应用）模式**（企业统一管控 / 无法开 CLI 访问时）

1. 钉钉开放平台 → 应用开发后台 → 创建应用；
2. 应用**安全设置** → 添加重定向 URL：`http://127.0.0.1`、`https://login.dingtalk.com`；
3. 发布应用；
4. 登录时用该应用凭据：

```bash
dws auth login --client-id <AppKey> --client-secret <AppSecret>
```

> `--client-id` / `--client-secret` 是**应用级**凭据，不是个人账号密码；不要写进仓库（可以放在本机环境变量里由你手动执行，不要交给 LinkHub 存）。

### 5.3 首次登录（真人授权，只需一次）

有两种登录方式——**本机优先用浏览器登录**（推荐）；只有 LinkHub 跑在服务器 / SSH / 容器、本机没有浏览器时，才用设备码：

```bash
# 方式 A · 浏览器登录（推荐，本机有浏览器）：dws 启动本机 127.0.0.1 loopback 回调并自动打开浏览器
dws auth login

# 方式 B · 设备码登录（远程 / 无浏览器 / 容器）：把授权链接发到另一台设备，输入设备码
dws auth login --device

# 多组织 / 多账号时可用 --profile 指定；LinkHub 里对应 DWS_PROFILE
```

- **浏览器登录（推荐）**：在浏览器打开的钉钉授权页扫码 / 账号登录并确认，dws 自动回调完成，**不用手输设备码**。授权地址是 `127.0.0.1` 本机回调，**必须和 LinkHub 在同一台机器上打开**；在别的机器打开会失败。浏览器方式通常给约 **10 分钟**操作窗口。
- **设备码登录（远程 / 无浏览器）**：命令/界面会显示授权码与有效期（通常约 **15 分钟**，以界面倒计时为准）。在另一台有浏览器的设备打开授权链接、输入授权码并确认。**过期后必须重新获取新码**；继续输旧码，钉钉页面会提示 `Invalid or expired user code`。
- LinkHub 账号页的「连接钉钉本人账号」弹窗内置了这两种方式（§5.5），不必先手动敲命令；两种方式二选一即可。

登录成功后验证（只读，不触发刷新）：

```bash
dws auth status --readonly --format json
# 期望 authenticated: true；未登录时为 false + "未登录"

dws profile list --format json
# 期望能看到当前组织 / 账号档案（profile 形如 corpId:userId）
```

> **安全提醒**：`dws auth login --client-secret` 会出现在命令历史里；在共享电脑上操作后清理 shell 历史，或按企业规范使用。登录凭据由 dws 加密保存在本机（Windows DPAPI + 设备绑定），**不要复制到别的机器**。

### 5.4 `.env` 配置

```dotenv
# ---- 钉钉：本人身份（收 + 发，走本机 dws）----
# 身份策略：auto（默认，已登录就用本人，否则机器人）| bot（固定机器人）| user（固定本人，未登录显式报错）
DINGTALK_IDENTITY=auto
# 本人身份接收：auto（默认，身份=本人时自动开启）| true | false
DINGTALK_USER_RECEIVE=auto
# 个人事件订阅范围（逗号分隔）：
#   all-direct = 全部单聊（默认）  at-me = @我（默认）  all-group = 全部群消息（量大，按需）
#   注意：group / sender 暂不支持（需要 dws 目标参数），配了会被忽略并在启动日志告警，回退默认范围
DINGTALK_USER_EVENT_KINDS=all-direct,at-me
# dws 可执行文件（默认 dws，在 PATH 里）；可带参数，如 node scripts/fake-dws.mjs（离线演示/测试用）
DWS_BIN=dws
# 指定 dws 登录档案（多账号时用；一般留空）
DWS_PROFILE=
# dws 命令超时（毫秒；登录 1000–120000，发送 1000–600000）
DWS_AUTH_TIMEOUT_MS=15000
DWS_SEND_TIMEOUT_MS=30000
```

> **只配本人身份也可以（钉钉，推荐白号）**：不需要机器人应用凭据。最省事的路径是「连接账号 → 钉钉 →『用钉钉本人账号登录（推荐，无需机器人应用）』」——它会自动把身份切到 `user`（热应用、无需重启）并完成登录；也可以手动设 `DINGTALK_IDENTITY=user`（页面「仅用本人身份」或 `.env`，后者需重启）后再登录。飞书不同：必须先有 App 凭据（页面「填写飞书应用凭据」或 `.env`）才能发起 OAuth。

> **不用改 .env 的图形化方式**：「平台账号」页右上或连接账号页的按钮 **「平台应用配置」** 打开弹窗：钉钉勾「仅用本人身份（无需机器人凭据）」→ 保存（**热应用、无需重启**）；机器人凭据 / 飞书 / 微信 / AI 模型填表 →「保存配置」（保存在本机 `linkhub-config.json`，**需要重启 LinkHub 生效**）。`.env` 显式写过的键优先，页面会提示「部分配置来自 .env，未被本次保存覆盖」。

原有的机器人配置（`DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` / `DINGTALK_ROBOT_CODE` / `DINGTALK_STREAM`）**保留不动**，用于机器人兜底。

### 5.5 在 LinkHub 里连接（白号按这个顺序）

> 白号（零凭据）只需「`dws` + 本人登录」两步，**不需要机器人应用凭据**。企业侧前提：管理员已开启「CLI 访问管理」（未开通时登录会提示组织未开，可把清单发给管理员）。

1. 打开「连接账号」（左侧导航）→ 钉钉卡片。白号初始显示「需本人授权」；dws 未内置时先点「一键下载 dws 到 tools/」（桌面版已内置 dws，正常不需要）。
2. 点卡片主按钮 **「用钉钉本人账号登录（推荐，无需机器人应用）」**：
   - **只打开登录弹窗，不会预先改配置**；**取消 / 未完成授权不改变任何设置**；**登录成功后**后端才自动启用本人身份（`identity.dingtalk=user` 热应用并持久化，无需重启）；
   - 弹窗内点 **「用浏览器登录（推荐）」** → 在**运行 LinkHub 这台机器**的浏览器里扫码 / 登录并确认（没弹出就点「打开授权页」或复制授权链接；服务器 / 容器 / SSH 用「使用设备码登录（远程/无浏览器）」，约 15 分钟有效，过期点「重新获取授权码」）；
   - 也可以终端执行 `tools\dws.exe auth login --recommend`（在 `unimsg-connector/` 下），完成后回到页面点「刷新状态」。
3. 登录成功后：钉钉卡片变 **「已就绪」**，身份块 接收 / 发送 = 本人，个人事件接收通道自动启动；**不需要重启后端**，也不需要 `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET`。
4. 若登录成功但卡片仍提示「需管理员 / 仍是模拟」：点 **「启用本人身份模式（无需重启）」**（后端动作名「仅用本人身份」）。若 `.env` 里显式写了 `DINGTALK_MODE=mock` 或 `DINGTALK_IDENTITY=auto/bot`，**显式 `.env` 优先、GUI 不能覆盖**，需要改 `.env` 后重启。
5. 已连接后仍可在「平台账号」页查看钉钉身份块、重新登录 / 注销（按钮以页面实际显示为准）；**注销时若「仅本人身份」是登录成功后自动启用的，会自动回退 `auto`**（显式配置不动）；终端等价命令也可用 `tools\dws.exe auth status --readonly --format json` 核对登录态。

> 登录按钮只负责**展示 / 引导 / 拉起** `dws auth login`，后端不会、也无法代你登录；凭据由 dws 加密保存在本机（Windows DPAPI + 设备绑定，**不能跨机复制**）。容器 / 无浏览器环境见 [deploy.md](deploy.md)。
### 5.6 接收机制（看到什么范围）

- LinkHub 为 `DINGTALK_USER_EVENT_KINDS` 里的每个范围拉起一个 `dws event +listen-im --kind <kind> --events message -f ndjson -y` 子进程（Stream 长连接），逐行解析 transport envelope（业务字段在 `data` JSON 字符串里）并入库；
- 默认 `all-direct,at-me`：本人收到的**全部单聊**消息 + **@我**的群消息；`all-group`（本人所在全部群的消息）可以直接配置但量大、按需开启；
- **`group` / `sender` 暂不支持**：它们需要 dws 的群 / 人目标参数（`--chat-id` / `--user`），本期不做；配置了会被**忽略并在启动日志告警**，回退到 `all-direct,at-me`，**不会**导致子进程反复重启；
- 事件流带平台消息 ID，入库走幂等键，dws 重放 / 重连不会重复入库；
- **自环过滤是 best-effort**：真实 `dws contact user get-self` 只返回 `result[0].orgEmployeeModel`（orgUserName / userId），**不返回 openDingTalkId**；个人事件本身只推送「本人收到的消息」，一般不会回显本人已发送的消息，因此拿不到 openDingTalkId 时只少一层兜底过滤，不会阻断接收；
- **平台整体 Mock 时**：本人身份通道不启动，身份统一显示「演示」而不是「机器人」（`effectiveReceive/effectiveSend=mock`），不会冒充真实接收；
- **钉钉双通道重复（已知限制）**：机器人 Stream 与本人事件同时开启时，同一条群 / 单聊消息可能各入库一次（两套消息 ID 体系），建议二选一（见 §3.3）；
- **登录 / 注销后自动启停接收通道**：无需重启后端——登录成功或注销后，后端会自动启动 / 停止本人身份接收通道；如果是在外部终端完成的登录（没有弹窗回调），最多约 1 分钟自动对齐。
- **停止服务请用 `Ctrl+C` 或 `start.bat stop`**：LinkHub 会先关闭 dws 子进程的 stdin（dws 官方优雅停机方式）注销事件订阅，再回收进程；用任务管理器/直接关控制台**硬杀**后端时，订阅可能残留到 dws 的空闲超时（约 300 秒）才释放。
- LinkHub 启动时若 dws 未登录 / 不存在，**不会崩溃**：auto 下回退机器人并在账号页给出中文修复提示；显式 `user` 时启动报错并提示；
- 子进程崩溃会指数退避重启（1s → 2s → 4s … 上限 60s），日志说明第几次重启；后端退出时一并清理，不残留子进程。

### 5.7 验证命令

```bash
# 在 unimsg-connector/ 下
pnpm run doctor --platform=dingtalk     # dws version / auth status / 事件目录可用性（只读）
curl http://127.0.0.1:3001/api/health   # identities 摘要
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/accounts
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/dingtalk/personal/status
# 看 authenticated / loginInProgress / loginMode / loginExpiresInSec / hint（进行中的登录会带 loginUrl / loginCode / loginId）
# 也看钉钉平台 identity.user.state / displayName / hint
```

### 5.8 钉钉本人身份常见报错

| 现象 | 原因 | 处理 |
|---|---|---|
| 账号页提示「未找到 dws」 | 本机没装 dws，或 `DWS_BIN` 指向错误路径 | 按 §5.1 安装；`DWS_BIN` 保持 `dws`（PATH 中）或写绝对路径 |
| `dws auth login` 提示组织未开启 CLI 访问 | 企业管理员没开「CLI 访问管理」 | 按 §5.2 申请 / 开启，或走 Custom App 模式 |
| 钉钉设备授权页提示 `Invalid or expired user code` | 设备码已过期 / 已被使用 / 登录流程已重启（旧码随之失效） | **改用「用浏览器登录（推荐）」**（本机，无需手输码）；或点「重新获取授权码」拿新码，**在有效期内**重新输入；不要继续输旧码 |
| 点「用浏览器登录」后浏览器没弹出授权页 | 浏览器拦截弹窗 / 默认浏览器未打开 / LinkHub 不在本机（远程 `127.0.0.1` 回调不可达） | 弹窗里点「打开授权页」，或复制授权链接到**运行 LinkHub 这台机器**的浏览器打开；远程 / 容器 / SSH 改用设备码方式 |
| 浏览器登录页打开了但没反应 / 回调失败 | 授权页不是在本机打开的（`127.0.0.1` 回调指向运行 LinkHub 的机器）；或授权被取消 | 在本机浏览器重新打开授权链接；远程环境改用设备码；必要时点「重新发起」 |
| 终端 / 外部完成登录后账号页仍显示未登录 | LinkHub 没收到登录完成回调（例如在别的终端登录） | 最多约 1 分钟自动对齐（45s 兜底检查）；也可点弹窗「我已登录，刷新状态」或刷新账号页 |
| 弹窗提示「没有拿到设备码」/「没有拿到授权链接」 | 上一次登录流程已被重置或已过期 | 点「重新获取授权码」重新发起，或点「刷新状态」同步 |
| `dws auth status` 报 `local_state_requires_repair` | 本机凭据状态需要修复（如系统凭据被改） | 重新执行 `dws auth login`；必要时按官方文档迁移 / 重建 |
| 换机器 / 重建容器后「未登录」 | dws 凭据与设备绑定，跨机不可解密 | 在新机器 / 容器内重新 `dws auth login` |
| auto 下账号页显示「机器人」而非本人 | dws 未登录 / 未安装 / 身份策略不是 auto | 看 `identity.user.hint`；先修 dws 登录，再看策略是否 `bot` |
| `DINGTALK_IDENTITY=user` 时发送报错 | 显式固定本人但本人不可用 | 这是**正确行为**（不悄悄换身份）；按 hint 连接 dws 或改回 `auto` / `bot` |
| 收不到某些群消息 | 默认只订阅单聊 + @我；普通群消息平台不推送 | 需要的话显式配置事件范围；全量群消息受平台能力限制，不承诺 |
| 事件流反复重启 | dws 崩溃 / 未登录 / 网络断开 | 看后端日志的退避重启说明与 stderr 摘要；先修登录态与网络 |

---

## 6. LinkHub 内操作与状态标注

### 6.1 状态字段（`GET /api/accounts` 的 `identity`）

飞书 / 钉钉两个平台的账号信息里带 `identity` 视图（不含任何令牌）：

| 字段 | 含义 |
|---|---|
| `policy` | 配置策略：`auto` / `bot` / `user`（来自 `FEISHU_IDENTITY` / `DINGTALK_IDENTITY`） |
| `effectiveSend` | 本次发送实际身份：`user`（本人）/ `bot`（机器人）/ `mock`（平台整体模拟） |
| `effectiveReceive` | 本次接收实际身份：`user` / `bot` / `mock` |
| `user.state` | 本人身份状态：`unavailable`（本机不具备条件）/ `not_linked`（未授权）/ `linked`（已连接可用）/ `expired`（过期）/ `error`（异常） |
| `user.linked` | 是否已连接且当前可用 |
| `user.displayName` / `detail` / `expiresAt` | 脱敏展示名 / 补充说明 / 到期时间 |
| `user.hint` | 中文、可操作的下一步（含修复命令） |
| `user.canLink` / `linkMethod` | 现在能否发起连接；飞书=`oauth`，钉钉=`cli` |
| `user.loginCommand` | 钉钉：需要在终端执行的命令（无浏览器 / 容器部署时展示） |
| `botAvailable` / `botHint` | 机器人通道是否可用与说明 |
| `receiveHint` / `sendHint` | 本次收发走什么通道的人话说明，例如「本人身份：飞书用户轮询（20s）」「机器人长连接」 |

### 6.2 界面里看身份

| 位置 | 显示 | 说明 |
|---|---|---|
| 平台账号页 · 飞书 / 钉钉卡片 | 「**身份 · 谁在收、谁在发**」块：`接收` / `发送` 两行，各一枚 Tag（**本人**绿 / **机器人**蓝 / **演示**橙；接收侧显示「演示接收」、发送侧显示「模拟发送」）+ 人话说明；未连接时给出下一步；已连接显示「已连接：<展示名>」与有效期 | 连接入口在块下方：飞书「连接本人账号 / 重新授权 / 重新连接」；钉钉「连接本人账号 / 查看连接步骤」，已连接时「重新登录 / 注销」；卡片右上角还会显示当前策略，如 `FEISHU_IDENTITY=auto` |
| 平台账号页 · 钉钉未登录时的「连接钉钉本人账号」弹窗 | 两个入口按钮：**「用浏览器登录（推荐）」**（本机 `127.0.0.1` loopback，不用手输码）与 **「使用设备码登录（远程/无浏览器）」**（授权码 + 有效期倒计时）；进行中展示授权链接 / 设备码 / 剩余时间 | 浏览器模式：「打开授权页」、可复制授权链接、「我已登录，刷新状态」、「改用设备码登录」、「重新发起」；设备码模式：大号授权码 + 复制、倒计时、「重新获取授权码」、「改用浏览器登录」；过期提示「授权码已过期，请重新获取」；打开弹窗会恢复进行中的登录（同一 `loginId`，不会重复生成） |
| 收件箱 · 消息卡片 / 详情 | Tag「**本人账号接收**」/「**机器人接收**」 | 来自 `receivedAs`；**Mock / 演示消息不写接收身份**（详情显示「—」或不显示），绝不冒充真实接收 |
| 收件箱 · 详情「投递方式」 | 「**本人发送**」/「**机器人发送**」/「**模拟发送**」 | 来自 `delivery.identity` 与 `delivery.mode` |
| 新建发送 · 发送身份 | 「发送身份」单选：`本人（<展示名>）` / `机器人`；**两种身份都可用时才可切换**，只有一种时直接展示当前身份 + 原因；Mock 下显示「演示」且不可选 | 提交 `identity` 字段；默认跟随后端策略（当前是本人 / 机器人） |
| 全链路回放 | 事件与消息上同样显示接收 / 发送身份标签 | 便于演示"这条是谁收的、谁发的" |

### 6.3 发送身份语义（重要）

- 默认按该平台的 `policy` 解析：`auto` 已连接 → 本人，否则机器人；`bot` → 机器人；`user` → 本人（不可用显式报错）；
- **新建发送**在飞书 / 钉钉两种身份都可用时可选择发送身份（提交 `identity`），服务端会校验该身份当前可用，不可用返回 400 中文错误（例：当前钉钉本人身份未连接…请连接或改用机器人），**绝不悄悄换身份**；**回复**界面不提供身份选择器，按平台策略发送（后端 API 支持 `identity` 覆盖），界面展示实际生效身份；
- 真实发送成功后 `delivery.identity` 记录实际身份；Mock 发送不写身份（只标模拟）。

---

## 7. 离线演示：用 fake-dws 模拟已登录（不碰真实钉钉）

评审现场 / 断网环境不想登录真实钉钉时，可以用仓库自带的 **fake-dws 本地桩**演示"钉钉本人身份收发"的完整闭环。它只模拟 dws 命令输出，**不连接钉钉、不发送任何真实消息**，用于测试与演示。

```powershell
# 在 unimsg-connector/ 下（PowerShell；确保当前环境没有真实机器人凭据，或至少 DINGTALK_STREAM=false）
$env:DWS_BIN="node scripts/fake-dws.mjs"
$env:DINGTALK_IDENTITY="user"     # 「仅本人身份」模式：不配机器人凭据也能走本人通道（auto 会判 Mock，必须显式 user）
$env:FAKE_DWS_EVENT_INTERVAL_MS="1000"   # 可选：模拟事件间隔（默认 3000ms，首条 300ms）
pnpm --filter @unimsg/server start
```

```bash
# 在 unimsg-connector/ 下（bash / macOS / Linux）
DWS_BIN="node scripts/fake-dws.mjs" DINGTALK_IDENTITY=user pnpm --filter @unimsg/server start
```

`.env` 里的写法（与 `.env.example` 注释一致，值可带空格、无需引号）：

```dotenv
DWS_BIN=node scripts/fake-dws.mjs
DINGTALK_IDENTITY=user
```

- fake-dws 是**有状态的本地桩**：默认视为**已登录**（展示名 `张三（模拟）`）；`FAKE_DWS_AUTHENTICATED=false` 或先执行 `node scripts/fake-dws.mjs auth logout` 可演示「未登录 → auto 回退机器人」；`node scripts/fake-dws.mjs auth login` 可模拟登录成功；可用 `FAKE_DWS_STATE_FILE=<路径>` 指定隔离的登录状态文件，避免上一次演示的登录态残留；
- 它支持 `version` / `auth status --readonly --format json` / `profile list --format json` / `contact user get-self -f json`（真实形状：`result[0].orgEmployeeModel`，无 `openDingTalkId`）/ `event +listen-im --kind <k> --events message -f ndjson`（输出**真实 transport envelope**，业务字段在 `data` JSON 字符串里；长驻输出模拟事件，**默认只推 5 条示例事件后停止推流、进程保持存活**，避免离线演示把收件箱灌成重复消息；可用 `--max-events N` 或 `FAKE_DWS_MAX_EVENTS=N` 显式控制，`0`=不限；对不支持的 flag（如 `--flatten`）与真 CLI 一样报 `unknown flag` 并 exit 3；stdin 关闭 / SIGTERM 退出）/ `chat message send` / `chat message reply`（返回与真实 dws 同形状的成功 JSON，并把发送记录写到本地 NDJSON）；`FAKE_DWS_FAIL=not-logged-in|permission|validation` 可复现失败分支；退出码与真实 dws 对齐（0 成功 / 2 用法 / 3 校验 / 5 未登录）；
- `auth login` 在 fake-dws 下也会模拟登录：`browser` 模式输出模拟的 loopback 授权链接、`device` 模式输出模拟授权码与「授权码将在 900 秒后过期」，并在 `FAKE_DWS_LOGIN_DELAY_MS`（默认 1200ms）后自动变为已登录——可离线走通「账号页弹窗登录 → 已连接 → 接收通道自动启动」的完整演示，不需要真实钉钉。
- **fake 下能跑不代表真实可用**：fake-dws 对 `group` / `sender` 不做目标参数校验；而 LinkHub 的配置解析会**忽略这两个范围并告警**（本期不支持按群 / 按人订阅）——不要用 fake 的现象推断真实通道行为。

- 启动后账号页钉钉卡片应显示「已连接本人账号」与 dws 档案展示名（动态来源是本地桩），个人事件子进程会输出模拟事件并入库，回复会走桩发送并返回成功回执；
- **演示时必须说明**：这是本地桩 / 离线演示，不是真实钉钉；真实收发需要按 §5 完成 dws 安装、企业 CLI 访问与真人授权；
- fake-dws 同时被自动化测试使用（`DWS_BIN` 指向它做真子进程冒烟），不影响真实配置：不设 `DWS_BIN` 时默认就是 `dws`。

> 具体演示分镜见 [demo-script.md](demo-script.md)。

---

## 8. 安全说明

- **令牌只在本机 / 服务端**：
  - 飞书 `access_token` / `refresh_token` 存服务端令牌文件（默认 `unimsg-connector/.feishu-user-token.json`；Docker 为 `DATA_DIR/feishu-user-token.json`），POSIX 下权限 0600；接口、日志、前端都拿不到，只下发状态与脱敏展示名；
  - 钉钉 token 由 dws 存在本机系统凭据（Windows DPAPI + 设备绑定），LinkHub 不读取、不落盘、不下发；LinkHub 只解析 `dws` 的 JSON 输出（不含 token）。
- **gitignore 覆盖**：`unimsg-connector/.feishu-user-token.json`、`.feishu-user-receive.json`（接收水位）、`.mail-watermarks.json` 等都已在 `.gitignore` 中；交付打包（`pnpm run deliver`）也会排除。
- **不要**把 `.env`、令牌文件、`~/.dws` 目录、`dws auth export` 包提交 / 截图 / 发群。
- **单实例约束**：
  - 飞书 refresh_token 单次有效，不要让多个后端进程共享同一个令牌文件（并发刷新会互相失效）；
  - 钉钉 dws 的登录档与本地事件消费者也是单机状态；同一台机器不要同时跑多个实例抢同一 dws profile。
- **入密码牌**：连接身份 / 发起授权走 Bearer 鉴权接口，默认 `dev-token` 只适合本机演示；对外暴露前必须把 `API_TOKEN` 改成强随机值，否则任何能访问服务的人都能触发授权流程 / 覆盖身份。
- **日志**：身份日志只打印「本人 / 机器人 / 模拟」与脱敏账号名，不打印 token；doctor 的身份探针是只读的，不发送业务消息。

---

## 9. 回退到机器人身份

本人身份出问题时，机器人通道仍然可用，随时可回退：

| 想做什么 | 做法 | 结果 |
|---|---|---|
| 某平台固定用机器人 | `.env` 设 `FEISHU_IDENTITY=bot` / `DINGTALK_IDENTITY=bot`，重启后端 | 发送 / 接收都走原机器人通道，账号页显示「机器人」；已连接的本人身份保留但不使用 |
| 只关本人接收、保留本人发送 | 设 `FEISHU_USER_RECEIVE=false` / `DINGTALK_USER_RECEIVE=false`，重启 | 接收走机器人通道，发送仍按本人身份 |
| 临时离线演示 | 四个平台 `*_MODE=mock`（或 `start.bat mock`） | 全平台模拟，界面标「模拟」 |
| 撤销飞书授权 | 账号页点「重新授权」覆盖，或删除令牌文件后重启 | 未连接状态；`auto` 回退机器人 |
| 撤销钉钉登录 | 账号页点「注销」，或终端执行 `dws auth logout` | dws 未登录；**若「仅本人身份」是登录成功后自动启用的，会自动回退 `auto`**（显式配置不动）；`user` 显式报错 |

> 回退后机器人能力仍取决于原有配置：钉钉需要 `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` / `DINGTALK_ROBOT_CODE`，要收消息还需 `DINGTALK_STREAM=true` 或 HTTP 回调；飞书需要应用凭据与长连接 / 回调配置。具体见 [swap-accounts.md](swap-accounts.md)。

---

## 10. 故障排查总表

| 现象 | 可能原因 | 解决 |
|---|---|---|
| 两个平台都显示「演示」 | 平台 `*_MODE=mock`，或凭据不全 `auto` 回退 | 看 `/api/accounts` 的 `mode` / `missing` / `reason`；补齐凭据或显式 `real`；Mock 是合法状态 |
| 账号页身份块显示「未连接」但发送成功 | 发送走了机器人（`auto` 下本人不可用） | 看身份块「发送」一行与 `sendHint`；想固定本人就设 `*_IDENTITY=user`（会暴露不可用错误） |
| 已连接但收不到消息 | 飞书：权限不足 / 只读本人可见会话 / 水位基线 / 轮询间隔；钉钉：事件范围没订阅到 / dws 掉线 | 分别按 §4.6 / §5.8 排查；看后端日志的身份行与接收器日志 |
| 发送失败「本人身份未连接」 | 显式选了本人身份但不可用 | 连接钉钉 dws / 飞书授权，或改用机器人身份 |
| 换了 App / 换了钉钉组织后身份异常 | 飞书令牌按 App ID 校验，换 App 需重新授权；dws 换组织需 `dws auth login` / `--profile` | 重新连接；多组织用 `DWS_PROFILE` 指定 |
| 服务启动报「飞书用户身份不可用」 | `FEISHU_IDENTITY=user` 且未授权 | 按提示授权，或改 `auto` / `bot` |
| 页面 400「当前身份不可用」 | 新建发送指定了不可用的身份 | 改选可用身份，先完成连接 |
| 升级后日志出现 `FEISHU_SEND_AS` 废弃提示 | 旧变量别名生效 | 改成 `FEISHU_IDENTITY`，删除旧变量 |
| 配了 `group` / `sender` 但没生效 | 本期不支持按群 / 按人订阅（需要 dws 目标参数） | 启动日志会告警并回退默认范围；改用 `all-direct` / `at-me` / `all-group` |
| 钉钉同一条消息出现两条（机器人一条、本人一条） | 机器人 Stream 与本人事件同时开启：两套平台消息 ID 体系，跨通道幂等键不通用 | 二选一：`DINGTALK_STREAM=false` 关机器人 Stream，或 `DINGTALK_USER_RECEIVE=false` 关本人接收（已知限制） |
| 容器里钉钉永远回退机器人 | 容器没装 dws / 没登录 | 容器内安装并 `dws auth login --device`；详见 [deploy.md](deploy.md) |

---

## 附录 A：`identity` 字段样例

> 采集环境：本机 `:3099` + 独立 `DATA_DIR` + `DWS_BIN=node scripts/fake-dws.mjs` + `DINGTALK_IDENTITY=user`（不配机器人凭据）——**本地桩，不是真实钉钉/飞书**；只用于说明字段结构与取值，所有值为脱敏 / 模拟。

**A1. 平台整体 Mock（飞书 `FEISHU_MODE=mock`）**——`identity` 的发送/接收统一为 `mock`：

```json
{
  "platform": "feishu",
  "configured": true,
  "policy": "mock",
  "mode": "mock",
  "identity": {
    "policy": "auto",
    "effectiveSend": "mock",
    "effectiveReceive": "mock",
    "user": {
      "state": "not_linked",
      "linked": false,
      "hint": "尚未连接飞书本人身份：当前用机器人收发；推荐连接本人账号（免把机器人拉进每个群），连接后自动切换为本人",
      "canLink": true,
      "linkMethod": "oauth"
    },
    "botAvailable": true,
    "botHint": "飞书机器人通道可用（收发）",
    "receiveHint": "本地模拟接收（不连真实平台）",
    "sendHint": "模拟发送（本地 Mock，界面标注「模拟发送」，不调用真实平台）"
  }
}
```

**A2. 仅本人身份（钉钉无机器人凭据 + fake-dws 已登录）**——`mode` 仍是 `mock`，但 `identity` 收发都是 `user`：

```json
{
  "platform": "dingtalk",
  "configured": false,
  "policy": "auto",
  "mode": "mock",
  "identity": {
    "policy": "user",
    "effectiveSend": "user",
    "effectiveReceive": "user",
    "user": {
      "state": "linked",
      "linked": true,
      "displayName": "张三（模拟）",
      "detail": "dws v1.0.68-beta.1；档案 di***rp:fa***01（已脱敏）",
      "hint": "已登录钉钉本人身份：发送以本人身份发出，接收走 dws 个人事件（all-direct,at-me）",
      "canLink": true,
      "linkMethod": "cli",
      "loginCommand": "node <仓库>/scripts/fake-dws.mjs auth login"
    },
    "botAvailable": false,
    "botHint": "钉钉机器人通道不可用：缺 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_AES_TOKEN / DINGTALK_AES_KEY（可运行 pnpm run doctor 自检）",
    "receiveHint": "本人身份通道独立于机器人通道（机器人通道当前为 Mock）：本人身份：dws 个人事件（all-direct,at-me）",
    "sendHint": "本人身份通道独立于机器人通道（机器人通道当前为 Mock）：本人身份发送（用户授权有效）"
  }
}
```

**A3. `/api/health` 的身份摘要**（与 `modes` 分开：`modes` 描述机器人/既有通道，`identities` 描述本人身份）：

```json
{
  "modes": { "feishu": "mock", "dingtalk": "mock", "wechat": "mock", "mail": "mock" },
  "identities": {
    "feishu": { "send": "mock", "receive": "mock" },
    "dingtalk": { "send": "user", "receive": "user" },
    "wechat": { "send": "mock", "receive": "mock" },
    "mail": { "send": "mock", "receive": "mock" }
  }
}
```

**A4. 入库消息的身份字段**（本人身份接收 + 本人发送后）：

```json
{
  "platform": "dingtalk",
  "externalId": "dingtalk:fake-open-message-45-1794447105615",
  "receivedAs": "user",
  "status": "synced",
  "delivery": {
    "mode": "real",
    "platformReply": "fake-open-task-1794447120120",
    "identity": "user",
    "at": "2026-01-01T00:00:00.000Z"
  }
}
```

> 复现方式（不碰真实账号）：`pnpm --filter @unimsg/server start` 前设置 `SERVER_PORT=3099`、`DATA_DIR=<临时目录>`、`FEISHU_MODE=mock`、`WECHAT_MODE=mock`、`MAIL_MODE=mock`、`MAIL_ENABLED=false`、`DINGTALK_STREAM=false`、`DINGTALK_IDENTITY=user`、`DWS_BIN=node scripts/fake-dws.mjs`、`FAKE_DWS_STATE_FILE=<临时文件>`、`LLM_PROVIDER=mock`；再用 `Authorization: Bearer <你的 API_TOKEN>` 调 `/api/accounts`。

> 文档与实现不一致时，以代码 / `.env.example` / 实际界面为准，并请提 issue 或反馈给维护者修正本文。
