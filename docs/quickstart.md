# LinkHub 5 分钟快速上手

> 目标：**不配任何平台账号，也能看到完整闭环**；以后换成自己的账号只改 `.env`，不改代码。
> 从交付包根目录开始，先 `cd unimsg-connector`；下文命令都在该目录下执行（仓库根目录没有 `package.json`，在根目录跑 `pnpm` 会报错）。
> 根目录 [README.md](../README.md) 顶部有「30 秒跑起来」入口与文档导航，两边内容一致。
>
> **Windows 用户更省事**：直接双击仓库根目录的 `start.bat`（或 `start-docker.bat` 走 Docker），脚本会自动完成下面的依赖安装、环境变量配置、启动后端与前端、打开浏览器；停止用 `start.bat stop`；改完代码 / `.env` 想重启用 `start.bat restart`（只停 LinkHub 自己的旧进程，不误杀别的程序）；想知道端口被谁占着用 `start.bat ports`。详见 [reference.md 的「Windows 一键启动」小节](reference.md)。
>
> **账号配置只在 `unimsg-connector/.env`**，该文件被 `.gitignore` 排除，**clone / pull / 同步队友代码都不会带过来**，换工作区后会静默退回全 Mock。若发现「我明明配过」，把旧工作区的 `.env` 复制过来，或双击 `setup-accounts.bat` 重新填，再用 `start.bat doctor` 自检。

## 先判断你属于哪类人

| 你想做什么 | 走哪条路 | 预计耗时 |
|---|---|---|
| **只想看效果**（零账号、零平台配置） | [路径 A：零账号演示](#path-a) | 约 5 分钟 |
| **要换成自己的账号**（飞书 / 钉钉 / 微信 / 邮箱任选一个即可） | [路径 B：换账号](#path-b) | 约 10 分钟 |
| **个人版首次使用**（普通用户，用自己的账号收发） | [路径 E：连接账号授权中心](#path-e) | 邮箱约 2 分钟；钉钉 / 飞书需本人授权 5–10 分钟（管理员项另计） |
| **要用本人账号收发**（推荐，免把机器人拉进每个群） | [路径 D：连接本人账号](#path-d) | 飞书约 10 分钟；钉钉约 10–15 分钟（企业先开 CLI 访问；本机浏览器登录，远程 / 容器用设备码） |
| **要现场演示 / 交付给评审 / 部署** | [路径 C：演示与交付](#path-c) | 按场景 5–30 分钟 |

## 30 秒前置检查

```bash
node -v            # 需要 v20 及以上
pnpm -v            # 需要 9.x；没有 pnpm：corepack enable 后重开终端（见下方说明）
python --version   # 仅跑 e2e 需要 Python 3（没有也不影响起服务）
```

- **装不上 pnpm / `pnpm: command not found`**：Node 20+ 自带 corepack。先 `corepack enable`（把 `pnpm` 放进 PATH，**之后必须重开终端**），再 `pnpm -v` 确认；仍不行再 `npm i -g pnpm@9`。不要只执行 `corepack pnpm install` 就接着敲 `pnpm ...`——依赖装上了，但 `pnpm` 仍不在 PATH，后续命令会全部 `command not found`。
- **`pnpm install` 很慢（可选）**：`pnpm config set registry https://registry.npmmirror.com` 换国内镜像；公司有私有源则按团队规范配置。
- 项目当前在中文路径下也可正常运行；若个别工具报奇怪的路径错误，把项目移到纯英文路径（如 `C:\dev\LinkHub`）再试。

<a id="path-a"></a>
## 路径 A：零账号 5 分钟看效果

```bash
cd unimsg-connector
corepack enable              # 只需一次；之后重开终端，pnpm 才进 PATH（已有 pnpm>=9 可跳过）
pnpm install                 # 约 1–3 分钟，看网络
pnpm typecheck               # 约 10 秒
pnpm e2e                     # 约 10–20 秒；macOS / Linux / Git Bash 改用：pnpm e2e:sh
pnpm --filter @unimsg/server start   # 约 2 秒；保持这个终端不关
# 另开一个终端（同样先 cd unimsg-connector）：
pnpm --filter @unimsg/web dev        # 约 2 秒；浏览器打开 http://127.0.0.1:5173
```

| 步骤 | 成功信号 | 预计耗时 |
|---|---|---|
| `pnpm install` | 出现 `Done`，没有 `ERR_` / `ELIFECYCLE` | 1–3 分钟 |
| `pnpm typecheck` | `shared` / `server` / `web` 三行 `Done` | 约 10 秒 |
| `pnpm e2e` | 20 条 `PASS` + `SMOKE OK` + `[e2e] PASS` | 约 10–20 秒 |
| 起后端 | `server listening ... :3001` + `运行模式: ...=mock(auto)`（无 `.env` 时全部 Mock） | 约 2 秒 |
| 起前端 | 5173 页面打开，左下角显示「Mock 数据 / 前端演示模式 · 未接后端」（侧栏底部短标识「演示」），收件箱有内置演示消息 | 约 2 秒 |

> 真实后端 + 空收件箱时，首页会显示客户化的「3 步上手」引导：主 CTA **「去连接账号」**、次 CTA **「先体验演示（注入示例消息）」**，开发者命令收进折叠区；也可以直接点空态里的「注入飞书示例 / 注入钉钉示例 / 注入微信示例」按钮注入一条示例消息（走真实入站链路，不会真的发到平台）。

> **两种「看效果」方式别混用**：不配 `VITE_API_BASE` 时前端用内置 Mock 数据；一旦存在 `packages/web/.env` 且写了 `VITE_API_BASE`，前端就会去连后端。
> 如果页面出现「数据加载异常」，多半是目录里带着别人的 `packages/web/.env`：先改名/删除它再重启前端（交付包默认不带这个文件）。
> 另一个常见来源：仓库根的 `start.bat` **每次启动都会重写 `packages/web/.env`**（写回当前后端端口 `VITE_API_BASE=http://127.0.0.1:<SERVER_PORT>`；只有非 127.0.0.1 的自定义地址才会原样保留，本地端口会被刷新）。所以用过一键启动后再单独起前端，就必然去连后端——后端没起便报「数据加载异常」。
> 想纯前端 Mock 演示：`mv packages/web/.env packages/web/.env.bak`（PowerShell：`Rename-Item packages/web/.env .env.bak`）再重启 Vite；要接回后端把名字改回来即可。

### 想把界面接到刚起的后端，看更真实的闭环

```bash
# 终端 1（若未启动）
pnpm --filter @unimsg/server start
# 终端 2：写两行前端配置后重启 Vite
printf 'VITE_API_BASE=http://127.0.0.1:3001\nVITE_API_TOKEN=dev-token\n' > packages/web/.env
# Windows PowerShell 写法： "VITE_API_BASE=http://127.0.0.1:3001`nVITE_API_TOKEN=dev-token" | Set-Content packages/web/.env
pnpm --filter @unimsg/web dev
```

成功信号：左下角页脚显示 **「服务就绪 · 本地后端已连接（不代表平台账号已连接）」**（侧栏底部短标识「服务就绪」）；账号页 4 张卡显示「未配置（演示模式）」；回复后的「投递方式」显示「模拟发送（未调用真实平台）」。
新后端收件箱为空是正常的，可灌入演示消息：`python scripts/smoke.py http://127.0.0.1:3001`（要求后端是全新无 `.env` 的 Mock 状态）。

> 如果你拿到的是**带 `.env` 的工作区**（别人配过真实账号），后端启动后会按 `.env` 走真实/受限通道，不再是全 Mock；想纯 Mock 演示，启动前临时设置 `FEISHU_MODE=mock` 等四个环境变量（见 [demo-script.md](demo-script.md) 的纯 Mock 兜底路线），或直接用全新解压的交付包。

停止：两个终端分别 `Ctrl + C`。

<a id="path-b"></a>
## 路径 B：换成自己的账号（约 10 分钟）

```bash
cd unimsg-connector
cp .env.example .env                 # Windows PowerShell：Copy-Item .env.example .env
# 2) 只填“目标平台”那一段，其他平台留空 = auto 自动 Mock：
#    飞书：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFY_TOKEN（长连接则不需要 VERIFY_TOKEN）
#          本人身份收发：保持 FEISHU_IDENTITY=auto，在账号页点「连接本人账号」
#    钉钉：DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_ROBOT_CODE / DINGTALK_STREAM=true
#          本人身份收发：保持 DINGTALK_IDENTITY=auto，本机安装并登录 dws（见路径 D）
#    微信：WECHAT_MODE=real（真实收发才写；默认 mock）+ WECHAT_BRIDGE_URL（默认 127.0.0.1:8787，一般不用改）
#          另需本机登录微信桌面端 3.9.x 并启动 scripts/wechat-rpa/rpa_bridge.py（4.x 自绘界面读不到消息，只能发）
#    邮箱：MAIL_QQ_ADDRESS / MAIL_QQ_AUTH_CODE（授权码，不是登录密码；可配多个账号）
# 3) 先自检，再重启后端
pnpm run doctor
pnpm --filter @unimsg/server start
```

> ⚠️ 必须写 **`pnpm run doctor`**，不要写 `pnpm doctor`：pnpm 9 自带同名内置命令会抢走它，实测没有输出、退出码 0，看起来像成功但本项目自检根本没运行。
> 只想看某一平台：`pnpm run doctor --platform=dingtalk,mail`。

> `API_TOKEN` 不要留空：演示保持默认 `dev-token`，对外部署必须改成强随机值。**留空会回退 dev-token 并打印告警，仍强制 Bearer 鉴权**（不会出现"空令牌 = 不鉴权"）；`NODE_ENV=production` 且仍是默认/空令牌时服务会拒绝启动。

**成功信号（分两层看，别混）**：

- **变量层（不代表连通）**：后端启动日志出现 `运行模式: ...=real(auto) 收✓ 发✓`；`curl .../api/health` 的 `modes` 中该平台为 `real`；`/api/accounts` 中该平台 `configured=true / mode=real`。这些只说明 **env 变量填齐了**——**填假的 App ID 也会显示 `real` / 卡片 Tag「已配置（未验证）」**，不能当成"已连上"。
- **连通层（这才是判据）**：`pnpm run doctor --platform=<平台>` 输出 `[PASS]` 且退出码 0（`✔ 自检通过：PASS x / FAIL 0`；0 = 全 PASS/SKIP，1 = 有 FAIL，2 = 参数错，3 = 自检异常）。若 doctor FAIL 而账号页显示 `real`，**以 doctor 为准**（典型：假凭据 `10003`、权限未开、租户 `21001`（历史：本机租户 2026-11-12 已解除；换租户仍可能）、网络/代理）。若终端退出码和报告结论对不上，重跑一次即可（历史版本在 Windows + Node 24 下有过强制退出导致异常码的问题，已修复）。
  - 注意：四个平台**都没填凭据**时，结论是「⚠ 尚未配置任何平台」而不是「✔ 自检通过」（退出码仍为 0）——这是提醒你去填账号，不是自检失败。
  - 不知道命令在哪：账号页真实模式的卡片上就有可复制的 `pnpm run doctor --platform=<平台>`（提示语「变量齐了 ≠ 平台能连通」）。

外部限制要提前知道：飞书历史上可能报 `21001`（**本机租户 2026-11-12 已解除**；换租户 / 换环境仍需企业认证 / 合规租户）。微信走 RPA 通道、无官方 API 限制，但需本机**微信桌面端 3.9.x**（4.x 是 Qt 自绘界面、不暴露控件树：自动轮询不可用，可「按需拉取」）与桥就绪。doctor 会给中文修复建议；逐平台步骤见 [swap-accounts.md](swap-accounts.md)。
改完 `.env` 必须**重启后端**；改了前端 `.env` 必须**重启 Vite**。账号页会在 `.env` 修改时间晚于服务启动时间时提示「.env 已修改，需要重启后端才生效」，看到就重启，不要反复改拼写。

<a id="path-d"></a>
## 路径 D：连接本人账号（推荐，免拉机器人进群）

> 目标：飞书、钉钉用**你本人账号**收消息、发消息——不需要把机器人逐个拉进同事的群。
> 本节是最短操作顺序；平台后台的完整点选位置、权限清单、限制与排错见 [personal-identity.md](personal-identity.md)。
>
> **先接受两个前提**：飞书本人接收是**轮询**（默认 20s，通常 5–30s 延迟、只能读你本人可见的会话）；钉钉本人身份依赖官方开源 CLI `dws`，**需要企业管理员开启 CLI 访问 + 首次真人授权**（本机推荐浏览器登录，服务器 / 容器用设备码）。做不到这两点就先用机器人 / Mock，不要硬上。

### D1 飞书（约 10 分钟，需应用管理员先开权限）

1. **后台一次性配置**（应用管理员）：用户身份权限（发送：`im:message`、`im:message.send_as_user`、`im:resource`；接收：以用户身份获取单聊 / 群聊消息权限 + 列会话 `im:chat:read`；持续授权：`offline_access`）→ 安全设置添加重定向 URL `http://localhost:3001/api/feishu/oauth/callback`（端口不同则以 `FEISHU_REDIRECT_URI` 为准）。**持续授权（自动续期）由用户身份权限 `offline_access`（后台名称「持续访问已授权的数据」）决定**：开通它并重新授权后，OAuth 会返回 `refresh_token` + `refresh_token_expires_in`（2026-11-12 实测已验证）；旧版控制台曾有「刷新 user_access_token」开关，新版已无此项（安全设置只有「重定向 URL」「IP 白名单」）。测试应用改动免审即时生效，正式应用需发布版本。
2. `.env` 保持默认即可：`FEISHU_IDENTITY=auto`、`FEISHU_USER_RECEIVE=auto`（轮询间隔 `FEISHU_USER_RECEIVE_SECONDS=20`）。
3. **重启后端** → 打开「平台账号」页 → 飞书卡片 → **「连接本人账号」** → 在飞书授权页用本人账号点同意。
4. 成功信号：飞书卡片「身份 · 谁在收、谁在发」块里 **接收 = 本人、发送 = 本人**，并显示「已连接：<账号名>」；给本人发一条单聊消息，**5–30 秒内**出现在收件箱（标「本人账号接收」）；回复后对方收到**你本人**发的消息。
5. 失败：授权报 `20027` / `20010` / `20029` 或收不到消息 → 按卡片 hint 与 [personal-identity.md §4.6](personal-identity.md#46-飞书本人身份常见报错) 处理；租户 `21001` 属平台策略（**本机租户 2026-11-12 已解除**，其他租户仍可能），改配置无解。

### D2 钉钉（约 15 分钟，需企业管理员 + 首次真人授权）

1. **装 dws**（已装可跳过）：

   ```powershell
   irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex
   dws version
   ```

2. **让组织允许 CLI 访问**：企业管理员在钉钉开发者平台 →「CLI 访问管理」→ 开启（未尽时 `dws auth login` 会引导发起申请）；或走 Custom App 模式（自建应用 + 重定向 URL + 发布后 `dws auth login --client-id <AppKey> --client-secret <AppSecret>`）。
3. **首次登录（真人授权）**：

   ```bash
   dws auth login                 # 本机有浏览器：推荐（loopback 自动回调，不用手输码）
   dws auth login --device        # 服务器 / SSH / 容器：设备码登录（约 15 分钟有效，过期需重新获取）
   dws auth status --readonly --format json   # 期望 authenticated: true
   ```

4. `.env` 保持默认：`DINGTALK_IDENTITY=auto`、`DINGTALK_USER_RECEIVE=auto`、`DINGTALK_USER_EVENT_KINDS=all-direct,at-me`（全部单聊 + @我）。
5. **重启后端** → 「平台账号」页 → 钉钉卡片：已登录会直接显示**本人**身份与 dws 档案；未登录则点 **「连接本人账号」** → 在「连接钉钉本人账号」弹窗选 **「用浏览器登录（推荐）」**（本机：浏览器打开钉钉授权页，扫码 / 确认后自动完成，不用手输码；没弹出就点「打开授权页」）或 **「使用设备码登录（远程/无浏览器）」**（另一台设备打开授权链接、输入授权码，约 15 分钟内完成；过期点「重新获取授权码」）→ 成功后弹窗自动关闭（也可手动点「我已登录，刷新状态」）。
6. 成功信号：身份块 **接收 = 本人、发送 = 本人**；手机钉钉给自己 / 同事发单聊消息 → 收件箱（标「本人账号接收」）；在 LinkHub 回复 → 对方收到**你本人**发的消息（带钉钉平台的 AI 发送角标，dws 默认行为，本项目不隐藏）。
7. 失败：提示「未找到 dws」/ 组织未开 CLI 访问 / 换机器后未登录 → 按 [personal-identity.md §5.8](personal-identity.md#58-钉钉本人身份常见报错) 处理。

### D3 验证与回退

```bash
# 在 unimsg-connector/ 下
pnpm run doctor --platform=feishu      # 飞书应用凭据 + 用户身份探针（只读）
pnpm run doctor --platform=dingtalk    # dws version / 登录状态 / 事件目录（只读）
curl http://127.0.0.1:3001/api/health              # identities：每平台收/发身份摘要
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/accounts
# 看飞书/钉钉的 identity.effectiveSend / effectiveReceive / user.hint
```

- 想**退回机器人**：`FEISHU_IDENTITY=bot` / `DINGTALK_IDENTITY=bot` 重启即可（详见 [personal-identity.md §9](personal-identity.md#9-回退到机器人身份)）。
- **不想登录真实钉钉**也能看效果：用仓库自带 fake-dws 离线桩，见 [personal-identity.md §7](personal-identity.md#7-离线演示用-fake-dws-模拟已登录不碰真实钉钉)。

<a id="path-e"></a>
## 路径 E：个人版首次使用（白号 / 零账号）

> 适用：**全新安装、没有任何平台账号或凭据**（白号）。目标：先能看演示，再逐步接入你自己的账号。
> 白号默认状态：四个平台都是「演示模式 / Mock」（不会真实收发）、收件箱 0 条、钉钉 `dws` 已内置（未登录）、邮箱 0 个。
> **重要变化**：平台应用凭据可以在页面里填了——「连接账号」页的 **「填写…应用凭据」** 会保存到本机 `linkhub-config.json`，**保存后需要重启后端 / 重开 App 才生效**；只有「钉钉/飞书本人身份登录」是热应用的（登录后立即生效，不用重启）。`.env` 里显式写过的值优先，页面不能覆盖（会提示）。

1. **先跑起来**：桌面版双击启动；命令行版在 `unimsg-connector/` 下 `pnpm --filter @unimsg/server start` + `pnpm --filter @unimsg/web dev`。首次打开收件箱顶部会出现横幅 **「首次使用：先连接你自己的账号」**：点 **「去连接账号」** 进入连接页；也可以点 **「先体验演示」** 先注入示例消息看闭环；点 **「稍后再说」** 后横幅不再打扰（之后仍可从左侧导航 **「连接账号」** 进入）。
2. **页面先看一遍**：顶部进度 **「已就绪 x / 4」**（白号是 `0 / 4`，待处理数 = 未就绪数），四张卡按 **邮箱 → 钉钉 → 飞书 → 微信** 排列。白号口径：**3 项可自助（邮箱、钉钉、微信）+ 1 项需管理员（飞书）**，不是四个平台都需要管理员。状态 Tag 含义：

| 状态 Tag | 含义 | 白号时你会看到 |
|---|---|---|
| **已就绪** | 该平台已配置且通道真实可用 | 一开始没有 |
| **需本人授权** | 应用/软件已就绪，等你本人登录授权 | 钉钉登录后、飞书凭据配好后会出现 |
| **需管理员** | 缺平台应用凭据，或通道仍为模拟 | 缺飞书应用凭据时；已登录钉钉但通道还是模拟时 |
| **需安装** | 缺本机依赖（钉钉 `dws`） | 包内没内置 dws 时 |
| **演示模式** | 该平台被显式设为 Mock（如 `.env` 写了 `*_MODE=mock`） | 只有你主动设 Mock 才会出现 |
| **异常** | 读取该平台状态失败 | 很少 |

> **白号不要再期待「刷新就能变需管理员/已就绪」**：缺凭据必须先把凭据填进来（页面表单或 `.env`），并且**重启后端**；「刷新状态」只重新读取当前状态，不会凭空补凭据。

3. **邮箱（可自助，推荐第一步）**：点 **「添加邮箱账号」** → 选服务商（QQ 邮箱 / 网易 163 / 网易 126 / 网易 yeah / Gmail / Outlook / Microsoft 365 / iCloud / 自定义 / 企业邮箱）→ 按说明到服务商网页版开启 IMAP/SMTP 并生成**授权码**（不是登录密码）→ 填「邮箱地址」+「授权码」→ 点 **「测试连接」**（会真实连一次 IMAP/SMTP 做登录自检，不保存、不发信）→ 通过后点 **「保存账号」**（没测试直接保存会二次确认，账号会标「未验证」，验证通过前不会真实收信）。
   - **验证与生效**：只有「测试连接」成功过的账号才标 **已验证**（保存时也可以先测试再保存）；**添加账号并点「测试连接」验证通过后会自动启用真实收信（无需改 `.env`、无需重启）**；如果卡片提示「仍为模拟模式」：若页面提供 **「启用真实邮箱（自动开关）」** 就点它（立即生效）；没有该按钮时以验证通过后自动真实收信为准，也可到「平台应用配置」检查邮箱运行模式。未验证的账号不算就绪，也不会收信；列表里未验证的本地账号可以点 **「测试验证」** 重新跑一次。
   - 注意：「测试连接」**会真实连接一次 IMAP/SMTP 服务器**做登录自检（不保存账号、不发信）；请只在填好授权码后点。
   - 收信：首轮只建立 UID 基线、不导入历史邮件；之后默认每 45s 轮询一次，新邮件出现在收件箱（标「邮箱」）。
   - 账号存在本机：`DATA_DIR/mail-accounts.json`，无 `DATA_DIR` 时 `unimsg-connector/.linkhub-mail-accounts.json`（已 gitignore；含授权码，仅本机、不下发前端）。列表里「本地」可删，「来自 .env」要改 `.env`。
   - 卡住：按「测试连接」返回的中文原因处理（授权码填错 / 没开 IMAP / Gmail 用应用专用密码 / 部分 Microsoft 365 租户需管理员开启 SMTP AUTH）。
4. **钉钉（推荐，无需机器人应用）**：
   - 卡片若为 **「需安装」**：桌面版已内置 dws，正常不会出现；命令行版运行 `pnpm run fetch:dws`（默认 v1.0.68-beta.1 下到 `tools/`，约 24MB，自动校验 `dws version`）。
   - 点卡片上的 **「用钉钉本人账号登录（推荐，无需机器人应用）」**：**只打开登录弹窗，不会预先改任何配置**；在**运行 LinkHub 这台机器**上用浏览器扫码/登录并确认（服务器/容器用设备码，约 15 分钟有效，过期点「重新获取授权码」）。**取消 / 未完成授权不会改变任何配置**；**登录成功后后端才自动启用本人身份**（`identity.dingtalk=user` 热应用并持久化，无需重启），个人事件接收自动启动。
   - 成功后：卡片变 **「已就绪」**，身份块「接收 = 本人、发送 = 本人」，个人事件接收通道自动启动，可直接真实收发，**不需要配 `DINGTALK_CLIENT_ID/_SECRET` 机器人凭据**。
   - 若卡片仍是 **「需管理员」**（已登录但通道模拟）：点 **「启用本人身份模式（无需重启）」**（后端动作名「仅用本人身份」），或检查 `.env` 是否显式 `DINGTALK_MODE=mock` / `DINGTALK_IDENTITY=auto|bot`（显式 `.env` 优先，GUI 不能覆盖）。
   - 管理员前提：企业管理员需在钉钉开放平台开启 **「CLI 访问管理」**；把「复制管理员开通清单（CLI 访问 + 登录命令）」发给管理员。终端等价登录命令：`cd unimsg-connector` 后执行 `tools\dws.exe auth login --recommend`（`--recommend` 会登录后无交互批量授权推荐权限；登录后回到页面点「刷新状态」）。
5. **飞书（需要企业管理员先建应用；凭据可页面填）**：
   - 管理员按卡片 **「复制管理员开通清单（权限 + 回调 URL + .env 键名 + 重启）」** 操作：飞书开放平台创建企业自建应用 → 权限管理开通消息权限（清单列出具体 scope）→ 安全设置添加**重定向 URL**（页面给出实际值，形如 `http://localhost:<端口>/api/feishu/oauth/callback`）→ 事件订阅：默认用长连接（可免公网回调，**此时 Verify Token / Encrypt Key 都可不填**）；只有改用 HTTP 回调模式才必须填 Verification Token → **发布应用**。
   - 回到 LinkHub → 飞书卡片点 **「填写飞书应用凭据（App ID / App Secret）」** → 粘贴 App ID / App Secret（长连接可不填 Verify Token / Encrypt Key）→ **保存** → **重启后端 / 重开 App**。
   - 重启后卡片变 **「需本人授权」** → 点 **「连接飞书本人账号」** → 浏览器里用本人飞书账号授权 → 回来自动刷新为「已就绪」（本人接收是轮询，5–30s 延迟、只读本人可见会话）。
   - 手填 `.env` 等价键：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFY_TOKEN` / `FEISHU_ENCRYPT_KEY`（`.env` 优先于页面配置）。
   - 卡住：卡片不显示「连接飞书本人账号」= 凭据还没生效（确认已重启、缺哪些键见卡片 hints）；授权报错按 personal-identity §4.6；租户 `21001` 属平台策略。
6. **微信（RPA 补充通道，无需管理员）**：微信个人版没有官方收发 API，按赛题 Supplemental 的 RPA 路径接入。你需要：Windows 上登录并打开**微信桌面端 3.9.x**（4.x 自绘界面不暴露控件树，读不到消息，只能发）→ `pip install pyautogui pyperclip pywin32 uiautomation` → 启动本地桥 `python scripts/wechat-rpa/rpa_bridge.py --mode rpa` → `.env` 设 `WECHAT_MODE=real`。**不需要任何平台凭据**；桥地址默认 `http://127.0.0.1:8787` 一般不用改。详见 [swap-accounts.md §5](swap-accounts.md)。
7. **生效方式对照（白号最容易搞错）**：

| 你改了什么 | 怎么生效 |
|---|---|
| 钉钉 / 飞书 **本人身份登录/授权** | **热应用立即生效**，不用重启；接收通道自动启停 |
| 身份策略 / 「仅用本人身份」开关（`identity.*`） | **热应用立即生效**，不用重启（`PUT /api/app-config` 返回 `hotApplied:true`） |
| 页面「填写…应用凭据」（飞书 / 钉钉 / 微信 / AI 模型） | **保存后必须重启后端 / 重开 App**；页面会显示「需要重启」。AI 模型：协议类型填 `openai`（火山方舟 / DeepSeek / 通义等都填这个）、模型名填控制台里的**模型 ID** 且该模型已开通；重启后旧消息不会自动重算，在详情页点「重新生成」即可用新配置验证 |
| 直接改 `.env` | **必须重启**（后端只在启动时读 `.env`） |
| 邮箱添加/删除账号、启用真实邮箱 | 热加载，不用重启；下一轮轮询开始收信 |
| 页面配置被 `.env` 显式值挡住 | 页面会提示「部分配置来自 .env，未被本次保存覆盖」——要改 `.env` 并重启 |

8. **验证是否真的通了**：
   - 邮箱：给刚添加的地址发一封信 → 约 45s 内出现在收件箱；回复后对方收到你本人邮箱的来信。
   - 钉钉：连接后给自己发一条单聊 → 收件箱标「本人账号接收」；回复 → 对方看到发送者是你本人。
   - 飞书：授权后别人给你发单聊 → 5–30s 内出现，标「本人账号接收」。
   - 卡片「已就绪」只代表本机后端探测到的真实状态；**重启后仍显示「演示模式」说明是显式 `*_MODE=mock`，需要去掉并再重启**。
9. **回退 / 换账号**：不想连某平台就让它保持演示模式，不影响其它平台；换邮箱/钉钉/飞书账号回本页重新添加或重新授权；想直接改 `.env` 的路径见 [swap-accounts.md §0.1](swap-accounts.md)。

> 依据：白号首次使用审计与两轮复测证据见 [docs/qa/white-account/](qa/white-account/)（white-auditor-report / white-user-report / white-user-round2-report / white-api-round2-report；只读审计报告，未修改）。平台能力边界（飞书轮询/可见范围、钉钉 CLI 访问、微信 RPA 依赖、`21001` 等）见 [personal-identity.md §3](personal-identity.md#3-平台边界先读避免踩空)。
<a id="path-c"></a>
## 路径 C：现场演示 / 交付评审 / 部署

- 现场演示 → [demo-script.md](demo-script.md)（含演示前 10 分钟检查清单与纯 Mock 兜底）
- 打包交付 → [delivery-checklist.md](delivery-checklist.md)（`pnpm run deliver` + 交付前后自检）
- 完整真实接入（后台点什么、填哪些变量、常见报错）→ [swap-accounts.md](swap-accounts.md)
- 本人账号收发（飞书 OAuth / 钉钉 dws、平台限制、回退、排错）→ [personal-identity.md](personal-identity.md)
- 承诺 vs 实现、已知边界与风险 → [reference.md](reference.md) 的「设计文档承诺 vs 当前实现」与 [risk-register.md](risk-register.md)
- 环境变量全表、API 一览、测试记录、目录结构 → [reference.md](reference.md)

部署三条底线：**飞书推荐用长连接（`FEISHU_STREAM=true`）免公网回调**（详见 [swap-accounts.md](swap-accounts.md) §3）；微信走本机 RPA 桥、无需公网；生产必须改强随机 `API_TOKEN`（`NODE_ENV=production` 且仍是默认 `dev-token` 会拒绝启动；也**不要**把它留空，空值会回退默认 `dev-token` 并告警、**仍强制鉴权**）。
本人身份另有两条底线：飞书**重定向 URL 必须与 `FEISHU_REDIRECT_URI` 完全一致**（协议 / 域名 / 端口 / 路径 / 斜杠）；钉钉 **dws 必须安装在 LinkHub 运行的环境中并完成登录**（容器部署需在容器内登录，详见 [deploy.md](deploy.md)）。

## 常见卡点一张表

| 现象 | 原因 | 一句话解决 |
|---|---|---|
| `pnpm: command not found` | 没装 pnpm 或没进 PATH | `corepack enable` → **重开终端** → `pnpm -v` 确认；或 `npm i -g pnpm@9`（只跑 `corepack pnpm install` 不够：依赖装了但 `pnpm` 仍不在 PATH） |
| 首次 install 成功，前端却报 `Cannot find module ... rollup` | 依赖目录不完整（少见；本机曾出现一次，重装未复现） | 在 `unimsg-connector/` 下执行 `pnpm install --force` 后重启 Vite |
| 报 Node 版本 / `tsx` 不兼容 | Node < 20 | 装 Node 20 或 22 LTS，重开终端再试 |
| `启动失败：端口 3001 已被占用` | 上次进程没关 / 别的软件占用 | 先 `start.bat ports` 只读看占用者：是 LinkHub 就用 `start.bat restart`（只停自己的旧进程并重开，最安全）；是别的程序就改 `.env` 的 `SERVER_PORT=3101` 后重新 `start.bat`（它会自动同步前端 `VITE_API_BASE`，并用实际端口做健康检查）；手动起服务时再同步 `VITE_API_BASE`；确认占用者是 LinkHub 才用 `netstat -ano | findstr :3101` + `taskkill`（macOS/Linux 用 `lsof -i :3101` + `kill`）；e2e 用 `pnpm e2e -Port 3102` |
| 配了账号，页面却全是 Mock | `.env` 放错目录（必须在 `unimsg-connector/.env`，仓库根的不加载）或变量名拼错（如 `FEISHU_APPID`） | 照 `.env.example` 检查拼写；`pnpm run doctor` 会提示「疑似拼错的变量」；改完**重启后端** |
| 账号页显示「真实接口 / 已配置」，但实际发不出去 | **变量齐 ≠ 平台能连通**：假凭据 / 权限未开 / 租户策略 / 网络都会这样 | 以 `pnpm run doctor --platform=<平台>` 的 PASS/FAIL 为准；FAIL 会带错误码与修复建议。账号页只用来确认"填了/缺什么变量" |
| 改了 `.env`，刷新页面没变化 | 后端只在启动时读 `.env` | **重启后端**（`start.bat restart` 最省事，它会只停 LinkHub 自己的旧进程再重开；或 `Ctrl+C` 后重新 `pnpm --filter @unimsg/server start`）；账号页会提示「.env 已修改，需要重启后端才生效」 |
| 真实模式发送失败了，但不知道原因 | 之前失败原因只在回放日志里；现在已上浮 | 演示模式下回复成功 toast 为 **「已模拟发送（不会真的发到平台）…可在「全链路回放」查看状态回流」**；真实模式失败弹「发送失败：<原因>」+「查看详情」；消息详情失败区显示「原因：…」+「重试发送」/「查看闭环日志」（用同一条内容重试，不用改文案） |
| `doctor` 里全是 SKIP | 当前是 Mock 状态，doctor 按约定不跑真实探针 | 不是失败；填好凭据会自动变 `real`，或显式设 `*_MODE=real` 强制自检 |
| 接口 401 / 页面提示未授权 | 前端 `VITE_API_TOKEN` 与后端 `API_TOKEN` 不一致 | 两处改成同一个值（默认 `dev-token`），重启后端与 Vite |
| 前端显示「数据加载异常」 | 后端没起、地址/端口不对、或 `packages/web/.env` 指向旧地址 | 先 `curl http://127.0.0.1:3001/api/health` 确认后端；核对 `VITE_API_BASE`；改完重启 Vite |
| 页面提示 403「Origin 不在 CORS 白名单」 | `.env` 配了 `CORS_ORIGINS` 但没含前端地址 | 把 `http://127.0.0.1:5173` 加进 `CORS_ORIGINS`，或清空该变量 |
| 群里 @ 了机器人，收件箱却没消息 | **钉钉**只推送「@机器人」的群消息，普通群消息平台不推送；且群里必须加的是「企业内部应用机器人」，自定义 Webhook 机器人只能发不能收（微信 RPA 直接读窗口、不依赖 @；3.9.x 可自动轮询，4.x 需用「按需拉取」） | 在群里 **@机器人** 发一句；终端出现 `[stream] 收到钉钉消息：群聊「…」` 就说明通了；没有这行 = 平台没推（检查机器人是否属于同一个应用、版本已发布、消息接收模式 = Stream） |
| 群里明明有机器人在回话，收件箱却是空的 | 那个在回话的可能是**钉钉自带的「AI小钉」/群助手**，不是本项目的应用机器人（第三方接不进平台自带助手） | 群设置 → 机器人 → 添加机器人 → 选「企业内部应用机器人」→ 选中本项目应用；再 **@这个机器人** 发消息，终端应出现 `[stream] 收到钉钉消息：群聊「…」` |
| 账号页飞书 / 钉钉身份显示「未连接 / 机器人」 | 本人身份没连接，或 `auto` 下回退机器人 | 看身份块下方 `hint`：飞书点「连接本人账号」；钉钉先 `dws auth status --readonly --format json`；未登录时点「连接本人账号」，弹窗内用「用浏览器登录（推荐）」或设备码登录 |
| 飞书本人接收要等 5–30 秒 | 本人接收是**轮询**（默认 20s 一轮），不是推送 | 正常现象；可调小 `FEISHU_USER_RECEIVE_SECONDS`（最小 5），接口调用量会随之增加 |
| 飞书本人接收收不到某个群 / 会话 | 只能读**本人可见**会话，读不到别人视角的消息 | 平台边界，无法绕过；确认该会话有本人参与、权限已开并重新授权 |
| 钉钉提示「未找到 dws」/ 登录时提示组织未开启 CLI 访问 | 本机没装 dws；或企业管理员没开「CLI 访问管理」 | 按[路径 D](#path-d) 安装 dws；让管理员在钉钉开发者平台 →「CLI 访问管理」开启，或走 Custom App 模式 |
| 钉钉设备授权页提示 `Invalid or expired user code` | 设备码已过期 / 已使用 / 登录流程已重启 | 本机改用「用浏览器登录（推荐）」；或点「重新获取授权码」拿新码并在有效期内输入，不要继续输旧码 |
| 打开「连接账号」提示「授权中心暂不可用」 | 后端版本旧 / 改完 `.env` 没重启 | 重启后端到最新版本后再打开；也可先去「平台账号」页手动查看各平台状态 |
| 页面里填完应用凭据，状态没变 | 应用凭据 / 运行模式**保存后必须重启** LinkHub 才生效（页面会显示「已保存，需要重启」） | 命令行版重启后端；桌面版菜单「文件 → 重启本地服务」或关闭 App 重开；然后点「我已重启，重新检测」 |
| 邮箱保存了账号，但仍显示演示模式 | 账号未验证，或邮箱通道被显式 Mock | 先点「测试连接」验证（通过后标「已验证」并自动真实收信）；仍不行点「启用真实邮箱（自动开关）」；若 `.env` 写了 `MAIL_MODE=mock`，需改 `.env` 并重启 |
| 连接账号页钉钉卡片显示「需安装」 | 本机没有 `dws` | 点「一键下载 dws 到 tools/」或运行 `pnpm run fetch:dws`（桌面版已内置 dws，正常不需要） |
| 邮箱「测试连接」失败 | 授权码错误 / 没开 IMAP / 服务商要求应用专用密码 | 按返回的中文原因修正；Gmail 用「应用专用密码」，Outlook/Microsoft 365 部分租户需管理员开 SMTP AUTH |
| 换机器 / 重建容器后钉钉身份变回机器人 | dws 凭据与设备绑定，跨机不可解密 | 在新机器 / 容器内重新 `dws auth login`；不要复制 `~/.dws` |
| `e2e` 提示找不到 Python | e2e 冒烟脚本需要 Python 3 | 安装 Python 3 并确保 `python` / `python3` 在 PATH（Windows 安装时勾选 Add to PATH）；不跑 e2e 不影响起服务 |
| 中文路径下个别命令报错 | 少数工具链对非 ASCII 路径兼容差 | 把项目移到纯英文路径（如 `C:\dev\LinkHub`）后重试 |
| `doctor` / 接口连接超时 | 公司代理、VPN、防火墙拦截 | 临时关代理或换手机热点重试；`pnpm install` 慢可换 registry 镜像（见上） |

## 下一步看什么

- 换真实账号 / 排错：[swap-accounts.md](swap-accounts.md)
- 现场演示讲稿：[demo-script.md](demo-script.md)
- 交付打包：[delivery-checklist.md](delivery-checklist.md)
- 全量风险与边界：[risk-register.md](risk-register.md)
