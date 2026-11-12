# LinkHub 5 分钟快速上手

> 目标：**不配任何平台账号，也能看到完整闭环**；以后换成自己的账号只改 `.env`，不改代码。
> 从交付包根目录开始，先 `cd unimsg-connector`；下文命令都在该目录下执行（仓库根目录没有 `package.json`，在根目录跑 `pnpm` 会报错）。
> README 顶部也有同样的一张「30 秒选路径」表，两边内容一致。
>
> **Windows 用户更省事**：直接双击仓库根目录的 `start.bat`（或 `start-docker.bat` 走 Docker），脚本会自动完成下面的依赖安装、环境变量配置、启动后端与前端、打开浏览器；停止用 `start.bat stop`。详见 [README 的「Windows 一键启动」小节](../README.md)。
>
> **账号配置只在 `unimsg-connector/.env`**，该文件被 `.gitignore` 排除，**clone / pull / 同步队友代码都不会带过来**，换工作区后会静默退回全 Mock。若发现「我明明配过」，把旧工作区的 `.env` 复制过来，或双击 `setup-accounts.bat` 重新填，再用 `start.bat doctor` 自检。

## 先判断你属于哪类人

| 你想做什么 | 走哪条路 | 预计耗时 |
|---|---|---|
| **只想看效果**（零账号、零平台配置） | [路径 A：零账号演示](#path-a) | 约 5 分钟 |
| **要换成自己的账号**（飞书 / 钉钉 / 企微 / 邮箱任选一个即可） | [路径 B：换账号](#path-b) | 约 10 分钟 |
| **要用本人账号收发**（推荐，免把机器人拉进每个群） | [路径 D：连接本人账号](#path-d) | 飞书约 10 分钟；钉钉约 15 分钟（企业先开 CLI 访问 + 首次真人授权） |
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

> 真实后端 + 空收件箱时，首页会显示「3 步上手」引导（含可复制的 `python scripts/smoke.py <地址>`、`pnpm run doctor` 与起服务命令；第 2 步直接引导「连接本人账号（推荐，免拉机器人进群）」）；也可以直接点空态里的「注入飞书示例 / 注入钉钉示例 / 注入企业微信示例」按钮注入一条示例消息（走真实入站链路，不会真的发到平台）。

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

成功信号：左下角变为「真实后端 · 已接入 LinkHub Server」（侧栏底部短标识「已连接」）；账号页 4 张卡显示 `Mock 模拟`；回复后的「投递方式」显示 `模拟发送（未调用真实平台）`。
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
#    企微：WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET（要收消息再加 WECOM_TOKEN / WECOM_AES_KEY）
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
- **连通层（这才是判据）**：`pnpm run doctor --platform=<平台>` 输出 `[PASS]` 且退出码 0（`✔ 自检通过：PASS x / FAIL 0`；0 = 全 PASS/SKIP，1 = 有 FAIL，2 = 参数错，3 = 自检异常）。若 doctor FAIL 而账号页显示 `real`，**以 doctor 为准**（典型：假凭据 `10003`、权限未开、租户 `21001`、网络/代理）。若终端退出码和报告结论对不上，重跑一次即可（历史版本在 Windows + Node 24 下有过强制退出导致异常码的问题，已修复）。
  - 注意：四个平台**都没填凭据**时，结论是「⚠ 尚未配置任何平台」而不是「✔ 自检通过」（退出码仍为 0）——这是提醒你去填账号，不是自检失败。
  - 不知道命令在哪：账号页真实模式的卡片上就有可复制的 `pnpm run doctor --platform=<平台>`（提示语「变量齐了 ≠ 平台能连通」）。

两个平台的外部限制要提前知道：飞书可能报 `21001`（需企业认证 / 合规租户）、企微可能报 `60020`（出口 IP 要加入「企业可信 IP」）。doctor 会给中文修复建议；逐平台步骤见 [swap-accounts.md](swap-accounts.md)。
改完 `.env` 必须**重启后端**；改了前端 `.env` 必须**重启 Vite**。账号页会在 `.env` 修改时间晚于服务启动时间时提示「.env 已修改，需要重启后端才生效」，看到就重启，不要反复改拼写。

<a id="path-d"></a>
## 路径 D：连接本人账号（推荐，免拉机器人进群）

> 目标：飞书、钉钉用**你本人账号**收消息、发消息——不需要把机器人逐个拉进同事的群。
> 本节是最短操作顺序；平台后台的完整点选位置、权限清单、限制与排错见 [personal-identity.md](personal-identity.md)。
>
> **先接受两个前提**：飞书本人接收是**轮询**（默认 20s，通常 5–30s 延迟、只能读你本人可见的会话）；钉钉本人身份依赖官方开源 CLI `dws`，**需要企业管理员开启 CLI 访问 + 首次真人浏览器授权**。做不到这两点就先用机器人 / Mock，不要硬上。

### D1 飞书（约 10 分钟，需应用管理员先开权限）

1. **后台一次性配置**（应用管理员）：用户身份权限（发送：`im:message`、`im:message.send_as_user`、`im:resource`；接收：以用户身份获取单聊 / 群聊消息权限）→ 安全设置添加重定向 URL `http://localhost:3001/api/feishu/oauth/callback`（端口不同则以 `FEISHU_REDIRECT_URI` 为准）→ 打开「刷新 user_access_token」→ 发布版本。缺一不可。
2. `.env` 保持默认即可：`FEISHU_IDENTITY=auto`、`FEISHU_USER_RECEIVE=auto`（轮询间隔 `FEISHU_USER_RECEIVE_SECONDS=20`）。
3. **重启后端** → 打开「平台账号」页 → 飞书卡片 → **「连接本人账号」** → 在飞书授权页用本人账号点同意。
4. 成功信号：飞书卡片「身份 · 谁在收、谁在发」块里 **接收 = 本人、发送 = 本人**，并显示「已连接：<账号名>」；给本人发一条单聊消息，**5–30 秒内**出现在收件箱（标「本人账号接收」）；回复后对方收到**你本人**发的消息。
5. 失败：授权报 `20027` / `20010` / `20029` 或收不到消息 → 按卡片 hint 与 [personal-identity.md §4.6](personal-identity.md#46-飞书本人身份常见报错) 处理；租户 `21001` 属平台策略，改配置无解。

### D2 钉钉（约 15 分钟，需企业管理员 + 首次真人授权）

1. **装 dws**（已装可跳过）：

   ```powershell
   irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex
   dws version
   ```

2. **让组织允许 CLI 访问**：企业管理员在钉钉开发者平台 →「CLI 访问管理」→ 开启（未尽时 `dws auth login` 会引导发起申请）；或走 Custom App 模式（自建应用 + 重定向 URL + 发布后 `dws auth login --client-id <AppKey> --client-secret <AppSecret>`）。
3. **首次登录（真人授权）**：

   ```bash
   dws auth login                 # 本机有浏览器
   dws auth login --device        # 容器 / SSH 无头环境：在另一台设备上完成授权
   dws auth status --readonly --format json   # 期望 authenticated: true
   ```

4. `.env` 保持默认：`DINGTALK_IDENTITY=auto`、`DINGTALK_USER_RECEIVE=auto`、`DINGTALK_USER_EVENT_KINDS=all-direct,at-me`（全部单聊 + @我）。
5. **重启后端** → 「平台账号」页 → 钉钉卡片应显示**本人**身份与 dws 档案；若显示未登录，点 **「连接本人账号」** → 在「连接钉钉本人账号」弹窗点 **「开始登录」**（或按提示复制命令到终端登录）→ 完成后点 **「我已登录，刷新状态」**。
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

<a id="path-c"></a>
## 路径 C：现场演示 / 交付评审 / 部署

- 现场演示 → [demo-script.md](demo-script.md)（含演示前 10 分钟检查清单与纯 Mock 兜底）
- 打包交付 → [delivery-checklist.md](delivery-checklist.md)（`pnpm run deliver` + 交付前后自检）
- 完整真实接入（后台点什么、填哪些变量、常见报错）→ [swap-accounts.md](swap-accounts.md)
- 本人账号收发（飞书 OAuth / 钉钉 dws、平台限制、回退、排错）→ [personal-identity.md](personal-identity.md)
- 承诺 vs 实现、已知边界与风险 → [README.md](../README.md) 的「设计文档承诺 vs 当前实现」与 [risk-register.md](risk-register.md)

部署三条底线：企微回调需要公网可达；**飞书推荐用长连接（`FEISHU_STREAM=true`）免公网回调**（详见 [swap-accounts.md](swap-accounts.md) §3）；企微发信出口 IP 必须在「企业可信 IP」；生产必须改强随机 `API_TOKEN`（`NODE_ENV=production` 且仍是默认 `dev-token` 会拒绝启动；也**不要**把它留空，空值会回退默认 `dev-token` 并告警、**仍强制鉴权**）。
本人身份另有两条底线：飞书**重定向 URL 必须与 `FEISHU_REDIRECT_URI` 完全一致**（协议 / 域名 / 端口 / 路径 / 斜杠）；钉钉 **dws 必须安装在 LinkHub 运行的环境中并完成登录**（容器部署需在容器内登录，详见 [deploy.md](deploy.md)）。

## 常见卡点一张表

| 现象 | 原因 | 一句话解决 |
|---|---|---|
| `pnpm: command not found` | 没装 pnpm 或没进 PATH | `corepack enable` → **重开终端** → `pnpm -v` 确认；或 `npm i -g pnpm@9`（只跑 `corepack pnpm install` 不够：依赖装了但 `pnpm` 仍不在 PATH） |
| 首次 install 成功，前端却报 `Cannot find module ... rollup` | 依赖目录不完整（少见；本机曾出现一次，重装未复现） | 在 `unimsg-connector/` 下执行 `pnpm install --force` 后重启 Vite |
| 报 Node 版本 / `tsx` 不兼容 | Node < 20 | 装 Node 20 或 22 LTS，重开终端再试 |
| `启动失败：端口 3001 已被占用` | 上次进程没关 / 别的软件占用 | 改 `.env` 的 `SERVER_PORT=3101` 后重新 `start.bat`（它会自动同步前端 `VITE_API_BASE`，并用实际端口做健康检查）；手动起服务时再同步 `VITE_API_BASE`；确认占用者是 LinkHub 才用 `netstat -ano | findstr :3101` + `taskkill`（macOS/Linux 用 `lsof -i :3101` + `kill`）；e2e 用 `pnpm e2e -Port 3102` |
| 配了账号，页面却全是 Mock | `.env` 放错目录（必须在 `unimsg-connector/.env`，仓库根的不加载）或变量名拼错（如 `FEISHU_APPID`） | 照 `.env.example` 检查拼写；`pnpm run doctor` 会提示「疑似拼错的变量」；改完**重启后端** |
| 账号页显示「真实接口 / 已配置」，但实际发不出去 | **变量齐 ≠ 平台能连通**：假凭据 / 权限未开 / 租户策略 / 网络都会这样 | 以 `pnpm run doctor --platform=<平台>` 的 PASS/FAIL 为准；FAIL 会带错误码与修复建议。账号页只用来确认"填了/缺什么变量" |
| 改了 `.env`，刷新页面没变化 | 后端只在启动时读 `.env` | **重启后端**（`start.bat stop` 后重开，或 `Ctrl+C` 后重新 `pnpm --filter @unimsg/server start`）；账号页会提示「.env 已修改，需要重启后端才生效」 |
| 真实模式发送失败了，但不知道原因 | 之前失败原因只在回放日志里；现在已上浮 | toast 统一「已提交，正在发送…」，异步失败弹「发送失败：<原因>」+「查看详情」；消息详情红色区显示「发送失败（已写入死信队列）」+「原因：…」+「重试发送」/「查看闭环日志」（用同一条内容重试，不用改文案） |
| `doctor` 里全是 SKIP | 当前是 Mock 状态，doctor 按约定不跑真实探针 | 不是失败；填好凭据会自动变 `real`，或显式设 `*_MODE=real` 强制自检 |
| 接口 401 / 页面提示未授权 | 前端 `VITE_API_TOKEN` 与后端 `API_TOKEN` 不一致 | 两处改成同一个值（默认 `dev-token`），重启后端与 Vite |
| 前端显示「数据加载异常」 | 后端没起、地址/端口不对、或 `packages/web/.env` 指向旧地址 | 先 `curl http://127.0.0.1:3001/api/health` 确认后端；核对 `VITE_API_BASE`；改完重启 Vite |
| 页面提示 403「Origin 不在 CORS 白名单」 | `.env` 配了 `CORS_ORIGINS` 但没含前端地址 | 把 `http://127.0.0.1:5173` 加进 `CORS_ORIGINS`，或清空该变量 |
| 群里 @ 了机器人，收件箱却没消息 | 钉钉/企微**只推送「@机器人」的群消息**，普通群消息平台不推送；且群里必须加的是「企业内部应用机器人」，自定义 Webhook 机器人只能发不能收 | 在群里 **@机器人** 发一句；终端出现 `[stream] 收到钉钉消息：群聊「…」` 就说明通了；没有这行 = 平台没推（检查机器人是否属于同一个应用、版本已发布、消息接收模式 = Stream） |
| 群里明明有机器人在回话，收件箱却是空的 | 那个在回话的可能是**钉钉自带的「AI小钉」/群助手**，不是本项目的应用机器人（第三方接不进平台自带助手） | 群设置 → 机器人 → 添加机器人 → 选「企业内部应用机器人」→ 选中本项目应用；再 **@这个机器人** 发消息，终端应出现 `[stream] 收到钉钉消息：群聊「…」` |
| 账号页飞书 / 钉钉身份显示「未连接 / 机器人」 | 本人身份没连接，或 `auto` 下回退机器人 | 看身份块下方 `hint`：飞书点「连接本人账号」；钉钉先 `dws auth status --readonly --format json` 确认已登录，再点「连接本人账号」→「我已登录，刷新状态」 |
| 飞书本人接收要等 5–30 秒 | 本人接收是**轮询**（默认 20s 一轮），不是推送 | 正常现象；可调小 `FEISHU_USER_RECEIVE_SECONDS`（最小 5），接口调用量会随之增加 |
| 飞书本人接收收不到某个群 / 会话 | 只能读**本人可见**会话，读不到别人视角的消息 | 平台边界，无法绕过；确认该会话有本人参与、权限已开并重新授权 |
| 钉钉提示「未找到 dws」/ 登录时提示组织未开启 CLI 访问 | 本机没装 dws；或企业管理员没开「CLI 访问管理」 | 按[路径 D](#path-d) 安装 dws；让管理员在钉钉开发者平台 →「CLI 访问管理」开启，或走 Custom App 模式 |
| 钉钉登录打不开浏览器 / 授权后没反应 | 无头 / 容器 / SSH 环境用了默认 loopback 回调 | 改用 `dws auth login --device`，在另一台有浏览器的设备上完成授权 |
| 换机器 / 重建容器后钉钉身份变回机器人 | dws 凭据与设备绑定，跨机不可解密 | 在新机器 / 容器内重新 `dws auth login`；不要复制 `~/.dws` |
| `e2e` 提示找不到 Python | e2e 冒烟脚本需要 Python 3 | 安装 Python 3 并确保 `python` / `python3` 在 PATH（Windows 安装时勾选 Add to PATH）；不跑 e2e 不影响起服务 |
| 中文路径下个别命令报错 | 少数工具链对非 ASCII 路径兼容差 | 把项目移到纯英文路径（如 `C:\dev\LinkHub`）后重试 |
| `doctor` / 接口连接超时 | 公司代理、VPN、防火墙拦截 | 临时关代理或换手机热点重试；`pnpm install` 慢可换 registry 镜像（见上） |

## 下一步看什么

- 换真实账号 / 排错：[swap-accounts.md](swap-accounts.md)
- 现场演示讲稿：[demo-script.md](demo-script.md)
- 交付打包：[delivery-checklist.md](delivery-checklist.md)
- 全量风险与边界：[risk-register.md](risk-register.md)
