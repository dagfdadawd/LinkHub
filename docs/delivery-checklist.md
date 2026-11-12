# LinkHub 交付 / 打包 checklist

> 原则：**交付包 = `git archive` 白名单产物**——只含 git 已跟踪文件；凭据、日志、本机状态文件、`node_modules` 一律不进包。打包后必须解压再自检一遍。
> 相关文档：[quickstart.md](quickstart.md) · [demo-script.md](demo-script.md) · [swap-accounts.md](swap-accounts.md) · [ai-integration.md](ai-integration.md) · [risk-register.md](risk-register.md) · [README.md](../README.md)

## 0. 一句话流程（在 `unimsg-connector/` 下）

```bash
git status                  # 必须干净：所有改动先 commit（含新增的 docs/、scripts/deliver.mjs）
pnpm run deliver            # 生成 LinkHub-deliver-<时间>.zip 到仓库上一级目录
pnpm run deliver -- --out D:\deliver\LinkHub.zip   # 可选：自定义输出路径（--allow-dirty 仅本地试打包）
```

`scripts/deliver.mjs` 会做三道检查，任一不过直接拒绝打包：
① 工作区不干净（`git status` 有输出）→ 拒绝（`--allow-dirty` 例外，但未提交改动不会进包）；
② 已跟踪文件命中黑名单（`.env` / `.env.*` / `*.log` / `*.log.err` / `.mail-watermarks.json` / `node_modules/` / `*.zip`，以及 `.gitignore` 覆盖的运行期状态文件——飞书本人身份令牌 / 接收水位等；`.env.example`、`.env.sample` 除外）→ 拒绝；
③ 打包用 `git archive --format=zip HEAD`，从根上排除一切未跟踪文件。

## 1. 打包前 checklist

- [ ] **所有改动已 commit**：`git status --porcelain` 无输出；新增文件（`scripts/deliver.mjs`、`docs/*.md`、`.github/` 等）都已 `git add` 并提交
- [ ] **交付包不得含**：`unimsg-connector/.env`、`.env.bak*`、`packages/web/.env`、`*.log` / `*.log.err`、`.mail-watermarks.json`（邮箱 UID 水位）、**`.feishu-user-token.json`（飞书本人身份令牌）**、**`.feishu-user-receive.json`（飞书接收水位）**、`node_modules/`、`dist/`、本地 zip、`~/.dws` 或其他 dws 凭据副本
- [ ] **凭据检查**（结果应只看到 `.env.example`；`packages/web/.env` 也不应出现）：
  ```bash
  # Git Bash / macOS / Linux
  git ls-files | grep -Ei '(^|/)\.env|\.log|mail-watermarks|feishu-user|node_modules|^dist/'
  # Windows PowerShell
  git ls-files | Select-String -Pattern '(^|/)\.env|\.log|mail-watermarks|feishu-user|node_modules|^dist/'
  ```
- [ ] **纯前端 Mock 最短路径**：确认交付包/演示目录里没有 `packages/web/.env`（它有 `VITE_API_BASE` 会让“只起前端”变成连后端，页面报「数据加载异常」）；交付包由 `git archive` 生成，天然不含该文件
- [ ] 跑一次 `pnpm run deliver`，记下输出里的 **commit hash** 与 **zip 路径**，确认 `[deliver] ✔ 打包完成`
- [ ] **抽检交付 zip**：解压一份，确认里面只有 `.env.example`，没有 `.env` / `.env.bak*` / 日志 / `.mail-watermarks.json` / `node_modules/`
- [ ] 用 `git archive` 的 zip，**不要右键压缩整个目录**（会带上 `.env.bak`、日志、`node_modules`）

## 2. 交付前全量自检（最后一遍）

```bash
cd unimsg-connector
pnpm typecheck        # shared / server / web 全部 Done
pnpm test             # 服务端单测全部通过（条数以实际输出为准）
pnpm test:web         # 前端单测全部通过（条数以实际输出为准）
pnpm e2e              # 20 项 PASS + SMOKE OK；macOS / Linux / Git Bash 用 pnpm e2e:sh
pnpm run doctor       # 全 PASS 最好；飞书 21001 已于 2026-11-12 复测本机租户恢复（code=0）；若换租户再出现 21001，仍按外部限制如实说明（退出码 1）
```

契约自检（必须用 **Mock 后端**，否则回复会走真实通道导致断言失败）：

```bash
# 终端 1：Git Bash / macOS / Linux
FEISHU_MODE=mock DINGTALK_MODE=mock WECOM_MODE=mock MAIL_MODE=mock DINGTALK_STREAM=false MAIL_ENABLED=false pnpm --filter @unimsg/server start
# Windows PowerShell 先逐行执行：$env:FEISHU_MODE="mock"; $env:DINGTALK_MODE="mock"; $env:WECOM_MODE="mock"; $env:MAIL_MODE="mock"; $env:DINGTALK_STREAM="false"; $env:MAIL_ENABLED="false"
# 终端 2
node packages/web/scripts/verify-contract.mjs http://127.0.0.1:3001 dev-token   # 期望 `<N> PASS / 0 FAIL`（N 视是否配置邮箱账号：有邮箱 81、无邮箱 75；以实际输出为准）
```

本人身份基线（全 Mock 启动时应符合，用于证明「没有真实凭据也不会假成功」）：

- `GET /api/accounts` 中飞书 / 钉钉带 `identity` 字段，`effectiveSend` / `effectiveReceive` 均为 `"mock"`，`user.state` 为 `not_linked` / `unavailable`；
- 后端日志**没有** dws 个人事件子进程 / 飞书轮询启动行（`*_MODE=mock` 时身份通道不启动）；
- 账号页飞书 / 钉钉身份块显示「模拟」，不显示「本人」。

```bash
# 快速核对（后端已按上方全 Mock 启动）
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/accounts
# 看 feishu / dingtalk 的 identity.effectiveSend / effectiveReceive / user.state
```

## 3. 解压后自检（收包人视角，附进交付说明）

```bash
# 解压 LinkHub-deliver-xxxx.zip 后
cd unimsg-connector
corepack enable                          # 只需一次；之后必须重开终端，pnpm 才进 PATH（已有 pnpm>=9 可跳过）
pnpm install --frozen-lockfile           # 重开终端后再执行
pnpm typecheck
pnpm e2e                                   # Windows；macOS / Linux / Git Bash：pnpm e2e:sh
```

> ⚠️ 不要只跑 `corepack pnpm install --frozen-lockfile` 就接着敲 `pnpm typecheck`：依赖装上了，但 `pnpm` 仍不在 PATH，后续命令会全部 `command not found`。要么按上面 `corepack enable` + **重开终端**，要么后续每条命令都写成 `corepack pnpm ...`（根目录脚本内部还会再调用 `pnpm -r`，所以推荐前者）。

期望：`e2e` 20 项 PASS + `SMOKE OK`（`e2e` 需要 Python 3；没有 Python 时先装，或至少 `pnpm typecheck` 通过）。说明：包内没有 `.env`，四个平台会 `auto → Mock`（正常）；要通过界面看效果按 [quickstart.md](quickstart.md) 路径 A，要接真实账号按路径 B。

## 4. 演示前检查（若交付后要现场演示）

- [ ] 端口 3001 / 5173 空闲（Windows：`netstat -ano | findstr :3001`；macOS / Linux：`lsof -i :3001`）
- [ ] 网络 / 代理正常；如演示企微真实发送，先确认当前出口 IP 仍在「企业可信 IP」内（`pnpm run doctor` 会打印出口 IP）
- [ ] **本人身份（如要演示）**：账号页飞书 / 钉钉身份块显示「接收 / 发送身份」符合预期；飞书需提前完成授权并提前发一条测试消息（轮询 5–30s 才出现）；钉钉优先用 **fake-dws 离线桩**（`DWS_BIN=node scripts/fake-dws.mjs`），不要现场等真人授权；如确要现场登录（本机）：弹窗点「用浏览器登录（推荐）」，设备码只作远程备选（约 15 分钟有效，过期需重新获取）；
- [ ] **本人身份话术准备**（如实说，不现场承诺）：飞书轮询有 5–30s 延迟、只读本人可见会话；钉钉 dws 是共创阶段、需企业管理员开启 CLI 访问 + 首次真人授权（本机浏览器登录 / 远程设备码，设备码有有效期）、凭据绑定设备；以本人身份发出的钉钉消息带 AI 发送角标（不隐藏）；
- [ ] `API_TOKEN`：演示保持 `dev-token`；**不要留空**（空值会回退默认 `dev-token` 并告警、**仍强制鉴权**，不会关闭鉴权）；对外暴露必须改成强随机值，`NODE_ENV=production` 且仍为默认/空 token 会拒绝启动
- [ ] 浏览器无痕窗口 / 清缓存；投屏前关闭 `.env` 终端窗口（启动日志里的邮箱地址已脱敏，但仍不建议整屏投屏）
- [ ] 完整分镜与纯 Mock 兜底见 [demo-script.md](demo-script.md)

## 5. 交接信息模板（复制到交付说明）

| 项 | 填什么 |
|---|---|
| 版本 | commit `<git log -1 --format="%H">`（或 tag） |
| 运行环境 | Node `<node -v>`、pnpm `<pnpm -v>`（package.json 固定 pnpm 9.15.9，可用 corepack） |
| 真实可用 | 钉钉 Stream 收 + 机器人回写；邮箱 IMAP 收 + SMTP 发（多账号 / STARTTLS）；**飞书本人身份收发已实测通过（2026-11-12）**：真实 OAuth → 单聊 + 群聊轮询入库 → 以本人身份发送（飞书侧核对 `sender_type=user`）；钉钉**本人身份收发**代码就绪（单测 + fake-dws 桩），真实端到端待平台条件（见下行） |
| 受限能力 | 飞书 `21001`（**历史：本机租户 2026-11-12 已解除**；换租户 / 换环境仍可能遇到，需企业认证 / 合规租户）；企微 `60020`（需企业可信 IP + 回调 Token/AESKey + 公网）；**飞书本人身份**已实测通过（2026-11-12），仍受平台边界限制：管理员需开用户身份权限（含 `im:chat:read` / `offline_access`）、轮询 5–30s、只读本人可见会话、单聊枚举依赖未公开参数 `types`；**钉钉本人身份**需企业管理员开启 CLI 访问 + 首次真人授权、凭据绑定设备（Windows 不能跨机复制） |
| AI 能力 | 大模型意图 / 摘要 / 回复草稿**已接真实调用**（OpenAI 兼容协议，默认 MiMo `mimo-v2.6-flash`；失败/超时/低置信回退内置规则并标注来源），见 [ai-integration.md](ai-integration.md)；OCR 仍为占位实现 |
| 未实现 | PostgreSQL/Redis 持久化（当前为单实例内存 + 文件快照）、OCR 真实调用、高可用/水平扩展、多租户 / 多员工共享单实例身份（详见 README「承诺 vs 实现」） |
| 独立部署包 | `unimsg-connector/Dockerfile` + `docker-compose.yml` + `.dockerignore`；步骤见 [deploy.md](deploy.md)，可 `docker save/load` 离线搬运；**镜像默认不含 dws**，容器内钉钉本人身份需自建 glibc 镜像 |
| 文档索引 | README / quickstart / personal-identity / demo-script / swap-accounts / deploy / ai-integration / risk-register / delivery-checklist |
| 已知风险 | 全部见 [risk-register.md](risk-register.md) |
