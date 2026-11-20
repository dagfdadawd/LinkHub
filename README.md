<div align="center">

# LinkHub

飞书、钉钉、微信、邮箱的消息，收进一个收件箱。赛题 A 参赛作品。

不填任何凭据也能跑完整个流程（全平台 Mock，界面照实标「模拟」）；想接真账号，改 `unimsg-connector/.env` 里对应那一段就行。

</div>

<p align="center">
  <a href="docs/images/inbox.png"><img src="docs/images/inbox.png" width="250" alt="统一收件箱"></a>
  <a href="docs/images/accounts.png"><img src="docs/images/accounts.png" width="250" alt="平台账号与身份"></a>
  <a href="docs/images/trace.png"><img src="docs/images/trace.png" width="250" alt="全链路回放"></a>
</p>

<p align="center"><sub>收件箱（四平台混排，标清本人 / 机器人 / 模拟）　·　平台账号（真实还是模拟，一眼可知）　·　全链路回放（按 traceId 看一条消息的完整经过）</sub></p>

## 这是什么

飞书、钉钉、微信三个平台的消息，加上邮箱，各自散着，回一条要切四次窗口。LinkHub 把它们收拢到一个入口：在同一个界面里读、回、转待办、指定平台发送（带附件），每一步都记进日志，事后能按 traceId 翻出来。

有几件事是特意做的：

不填凭据也能走完全流程，每一步都标着「模拟发送」，不会假装成功。换账号只改一段 `.env`，四个平台互不影响，代码不用动。同一台机器可以开多个账号，侧栏一点就切，各看各的消息。飞书走 OAuth、钉钉走官方 CLI `dws`，以员工本人身份收发，不用把机器人一个个拉进群。

## 跑起来

Windows 下双击仓库根目录的 `start.bat`。它会装依赖、起前后端、打开浏览器，大概一分钟，不需要预装 pnpm。

命令行（Node.js ≥ 20，pnpm 可以用 corepack 提供）：

```bash
cd unimsg-connector
corepack enable && pnpm install       # 已装 pnpm 可跳过 corepack

pnpm --filter @unimsg/server start    # 后端 :3001
pnpm --filter @unimsg/web dev         # 另开终端，前端 :5173
```

不配凭据就是全平台 Mock，功能都能点。想一键验证链路跑通：`pnpm e2e`（需要 Python 3）。

第一次启动不需要登录：本机还没有账号时直接进收件箱。想要自己的账号（多开、消息隔离），从侧栏「登录」注册一个，只存用户名和密码，不收手机号、邮箱，也没有验证码。

## 能做什么

| 环节 | 能力 |
|---|---|
| **接收** | 飞书长连接 / HTTP 回调、钉钉 Stream / HTTP 回调、微信 RPA 本地桥轮询、邮箱 IMAP 轮询；本人身份另走飞书 OAuth 轮询、钉钉 `dws` 个人事件 |
| **展示** | 收件箱按平台 / 状态筛选，WebSocket 实时推送；「本人 / 机器人 / 模拟」来源如实标注 |
| **下载** | 收到的图片 / 文件可直接下载：钉钉本人文件走 `fileId`（`dws drive download`）、飞书走 `file_key`（本人或机器人 token）；微信 RPA 附件经桥的 `GET /file` 回吐（只允许微信文件目录 / 桥 outbox）、邮件附件需到邮箱客户端查看 |
| **处理** | 直接回复、标记完成、手动加待办、引用回复；AI 做意图识别 / 摘要 / 回复草稿（真实调用大模型，失败才回退规则并标注） |
| **回写** | 按平台格式异步发送文本与附件，`delivery` 记录真实通道与身份；失败可见原因并可重试 |
| **回流** | 平台状态事件回写本地状态机（`received → processing → replied → sent → synced`），异常进死信队列 |

## 页面一览

| 页面 | 路径 | 作用 |
|---|---|---|
| 收件箱 | `/inbox` | 三栏工作台：渠道筛选 / 会话列表 / 详情与回复，右侧可切「全链路」看 trace |
| 待办 | `/todos` | 从消息里长出来的待办，按截止时间排序，完成后落库 |
| 回放 | `/trace` | 按 traceId 查一条消息的全生命周期事件 |
| 平台账号 | `/accounts` | 每个平台的运行模式（真实 / 模拟）、身份（本人 / 机器人）、凭据状态 |
| 连接账号 | `/connect` | 分步向导：选平台 → 填凭据 → 自检 → 生效提示 |
| 登录 / 注册 | `/login` | 本机账号；`/login?add=1` 是「再登一个」，不覆盖当前账号 |

## 多账号

一台机器可以挂多个账号（家用号、工作号、测试号），互不打扰。

注册默认没有门槛，随时可以再开一个，不用邀请码，也不用改配置。想收紧的话，设 `AUTH_REGISTRATION=closed` 关掉注册，或者设 `AUTH_SIGNUP_CODE` 加一道邀请码。

加账号走侧栏账号菜单的「添加账号」。登录页不会把你踢回收件箱，登完自动切到新账号，原来的还留在名单里。菜单里列着本机已登录的账号（显示名加 @用户名，当前的打勾），点谁切谁；切换会换令牌、重连实时通道、重拉数据。

消息按账号隔离，切过去只看得到那个账号自己的收件箱；平台连接收到的新消息归「机器主人」账号。退出当前账号时如果还有别的账号，会自动落到下一个，不会把整台机器登出。

## 平台支持

| 平台 | 收消息方式 | 真实接入状态 |
|---|---|---|
| 飞书 | 长连接 / HTTP 回调；本人 OAuth 轮询 | ✅ 机器人 + 本人身份均可真实收发 |
| 钉钉 | Stream 长连接 / HTTP 回调；本人 `dws` 个人事件 | ✅ 机器人 Stream 真实收发；🟡 本人身份需企业开 CLI 访问 + 真人授权 |
| 微信 | RPA 本地桥（免公网，需本机微信桌面端） | 🟡 桥与连接器就绪，默认模拟演示。`WECHAT_MODE=real` 且桥就绪后：3.9.x 自动轮询接收，4.x 用「按需拉取」（拖选复制当前会话） |
| 邮箱 | 本机 IMAP 轮询（任意数量 / 任意服务商） | ✅ 发 → 收 → 回 → 收 四跳闭环 |

> 未配置或凭据不全的平台自动回退本地 Mock，界面与接口都会标注「模拟」；`real` 模式缺凭据时发送直接报错，不会静默假成功。

## 换成自己的账号

```bash
cd unimsg-connector
cp .env.example .env          # Windows：Copy-Item .env.example .env
# 2) 只填目标平台那一段，其余留空（留空 = auto 自动回退 Mock）
pnpm run doctor               # 3) 只读自检：凭据 / 连通性 / 出口 IP / 修复建议
```

各平台最少要填的变量：

| 平台 | 最少变量 |
|---|---|
| 飞书 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（HTTP 回调另需 `FEISHU_VERIFY_TOKEN`；长连接设 `FEISHU_STREAM=true`） |
| 钉钉 | `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` / `DINGTALK_ROBOT_CODE` / `DINGTALK_STREAM=true` |
| 微信 | `WECHAT_MODE=real` + `WECHAT_BRIDGE_URL`（默认 `http://127.0.0.1:8787`，通常无需改）；另需本机启动 RPA 桥并登录微信桌面端（3.9.x 可自动收；4.x 用「按需拉取」） |
| 邮箱 | `MAIL_<KEY>_ADDRESS` / `MAIL_<KEY>_AUTH_CODE`（授权码，不是登录密码） |

> 单平台自检：`pnpm run doctor --platform=feishu|dingtalk|wechat|mail`。
> 必须写 `pnpm run doctor`。`pnpm doctor` 会被 pnpm 内置同名命令抢占，**没有任何输出、退出码 0**，看起来像成功。
> 逐平台后台操作、errcode 排错与邮箱服务商预设见 [docs/swap-accounts.md](docs/swap-accounts.md)。

## 常用命令

在 `unimsg-connector/` 下执行：

| 命令 | 作用 |
|---|---|
| `pnpm start` / `pnpm dev` | 启动后端（`dev` 为 watch 模式） |
| `pnpm --filter @unimsg/web dev` | 启动前端（:5173） |
| `pnpm run doctor` | 只读自检；有 FAIL 时退出码 1 |
| `pnpm test` / `pnpm test:web` | 服务端 / 前端单元测试 |
| `pnpm typecheck` | shared + server + web 三个包的 TypeScript 检查 |
| `pnpm e2e` / `pnpm e2e:sh` | 一键端到端冒烟（Windows / macOS · Linux） |
| `pnpm run deliver` | 交付打包（自动排除 `.env`、日志、`node_modules`） |
| `docker compose up -d --build` | 单容器部署，同源访问 `http://<IP>:3001` |

Windows 根目录脚本：

| 命令 | 作用 |
|---|---|
| `start.bat` / `start-docker.bat` | 一键启动（本地 / Docker） |
| `start.bat mock` / `start.bat doctor` / `start.bat accounts` | 纯离线演示 / 账号自检 / 编辑账号配置 |
| `start.bat restart` / `start.bat ports` / `start.bat stop` | 安全重启（只停 LinkHub 自己的进程）/ 查看端口占用 / 停止服务 |

## 目录结构

```
unimsg-connector/
├── packages/
│   ├── shared/     # 前后端共用类型：Platform、状态机、Delivery、消息模型
│   ├── server/     # Express + ws：路由 / 服务 / 连接器 / 流 / 自检
│   │   └── src/
│   │       ├── routes/      # auth、messages、accounts、webhook、wechatPull…
│   │       ├── services/    # 消息闭环、发送、身份、账号、AI、附件…
│   │       ├── connectors/  # 飞书 / 钉钉 / 微信 / 邮箱 + dws + 用户身份
│   │       ├── stream/      # 长连接与回调
│   │       └── doctor/      # 只读自检
│   └── web/        # React 18 + Vite + Ant Design：收件箱 / 待办 / 回放 / 账号
├── desktop/        # 桌面版（Electron 壳 + 轻量版）
├── scripts/        # e2e / 打包 / 抓图 / dws 辅助
└── tools/          # 内置 dws 等本地二进制
```

## 技术栈

Node.js ≥ 20 · TypeScript · Express 4 + ws · React 18 + Vite 5 + Ant Design 5 · 内存仓储 + 可选文件快照 · OpenAI 兼容大模型 · 官方 `dws` CLI。

## 已知限制

**钉钉**群聊只推 @机器人 的消息，这是平台规则，没法承诺群内所有消息都能聚合。

**微信**个人版没有官方收发 API，走 RPA 通道。默认是模拟演示；真实收发需要本机登录微信桌面端、启动本地 RPA 桥，并设 `WECHAT_MODE=real`。3.9.x 能自动轮询接收；4.x 是 Qt 自绘界面、没有控件树，改用「按需拉取」（收件箱 → 微信 → 从微信拉取当前会话，拖选复制原文）。效果受窗口布局和分辨率影响，也有账号风控风险，所以只当补充通道。

**钉钉本人身份**依赖官方 `dws`（共创阶段），需要企业管理员开「CLI 访问管理」并完成首次真人授权。凭据绑定设备，不能跨机复制。

**飞书本人接收是轮询**（默认 20s，延迟通常 5–30s），只能读本人可见的会话；权限要管理员开通并生效。

**邮箱**走 IMAP 加授权码，附件需要到邮箱客户端查看；企业邮箱如果关了 IMAP，得先开通。

**持久化**默认是内存加可选文件快照（设 `DATA_DIR`）。PostgreSQL / Redis 只提供了 DDL 和仓储接口，没有接入运行时，重启会丢消息。

**OCR** 是占位实现，赛题 A 不依赖它。

## 文档导航

| 我想…… | 看这里 |
|---|---|
| 5 分钟上手 / 常见卡点 | [docs/quickstart.md](docs/quickstart.md) |
| 换成自己的账号（逐平台 checklist） | [docs/swap-accounts.md](docs/swap-accounts.md) |
| 用本人账号收发（飞书 OAuth / 钉钉 dws） | [docs/personal-identity.md](docs/personal-identity.md) |
| 现场演示 / 录视频 | [docs/demo-script.md](docs/demo-script.md) |
| 交付打包 / 上线前检查 | [docs/delivery-checklist.md](docs/delivery-checklist.md) |
| 独立服务器部署 | [docs/deploy.md](docs/deploy.md) |
| 桌面版（Electron / 轻量版） | [docs/desktop-app.md](docs/desktop-app.md) |
| AI 服务集成说明 | [docs/ai-integration.md](docs/ai-integration.md) |
| 完整技术参考：环境变量全表 / API 一览 / 目录结构 | [docs/reference.md](docs/reference.md) |
| 赛题设计文档（初赛精简版 / 决赛完整版） | [documents/](documents/) |

## License

见 [LICENSE](LICENSE)。
