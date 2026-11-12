# LinkHub 本人身份能力 · 独立验收报告（final-verification）

> 验收人：verifier（独立验证 teammate，不参与实现、不修改被测代码）
> 验收时间：2026-11-12 09:39–10:2x（Etc/GMT-8）
> 基线：`ab6b17c`（本轮起点） · **最终验收快照：`2e35952`**（工作区 = HEAD，`git diff` 为空；仅本报告目录未跟踪）
> 被测范围：飞书/钉钉「本人账号接收 + 本人账号发送」（契约 `docs/_team/10-identity-contract.md` §1–§10）、小白用户 P1 修复、文档校准
> **结论：全部验收项 PASS。** 验收过程中发现 4 个问题（1 个 P0 级测试自洽、1 个交付完整性、1 个 fake-dws 演示瑕疵、1 个 README 数字过期），**均已在最终快照前修复并由我独立复测通过**；核心能力（身份收发、幂等、失败可见性、Mock 诚实标注、机器人链路回归、文档一致性、密钥安全）全部验证通过，无残留 FAIL。

---

## 0. 结论速览（最终快照 `2e35952`）

| 维度 | 结论 | 证据 |
|---|---|---|
| 契约 §10.1 构建/测试/e2e/契约自检 | ✅ PASS | typecheck exit 0；server **402/402**；web **25 文件/194 tests**；`lint:css` PASS；`pnpm e2e -Port 3103` **20 项断言+SMOKE OK**；`verify-contract` **81 PASS/0 FAIL** |
| §10.2 空 `.env` 全 Mock 启动 | ✅ PASS | 干净沙箱（无 .env）：四平台 `mode=mock`、identity 收发均 `mock`、无 dws/fake-dws 子进程、`health.envFile=null`、日志无真实密钥（9 个真实密钥值全树 0 命中） |
| §10.3 只配飞书凭据/已授权/权限失败 hint | ✅ PASS | 本地飞书 API 桩（注入 fetch 等价，未连真实飞书）：identity linked/收发 user；轮询入库 `receivedAs=user`（双会话）、self 消息过滤、post 正文、水位文件 v1、边界消息幂等（deduped=4）；权限失败 hint 含 `99991672`+所需权限+「重新授权」，且零假消息 |
| §10.4 `DWS_BIN`→fake-dws 本人身份闭环 | ✅ PASS | 身份 linked、2 个子进程常驻（keepalive 生效，9s 后仍存活、无重启循环）、个人事件入库 `receivedAs=user`、重复事件幂等、reply `delivery.mode=real`+`identity=user`+fake 回执、杀子进程 1s 内自动重启有日志、停止后无残留 |
| §10.5 dws 缺失/未登录 auto 回退 + 显式 user 报错 | ✅ PASS | 缺失：`state=unavailable`、中文安装 hint；未登录：`state=not_linked`、`dws auth login` hint、`/api/dingtalk/personal/status` 正确；两种情况下 `compose identity=user` 均 400 中文、0 假消息 |
| §10.6 机器人链路回归 | ✅ PASS | e2e 20 项（webhook 三平台/幂等/鉴权/reply/状态机/trace/Mock 标注/计数）；compose+附件 mock、WS `connected/received/updated/failed`、`failureReason`+DLQ、`/api/health` 新字段均通过 |
| §10.7 文档与实现一致 | ✅ PASS | `docs/personal-identity.md` 关键口径全部修正并与代码一致（group/sender=忽略+告警不重启、Mock 不写接收身份、OAuth scope 自动申请、水位断档、回复身份语义、自环 best-effort）；README 数字已更新为最终实测 402/25 文件/194 tests |
| §10.8 无密钥进入代码/文档/日志 + gitignore | ✅ PASS | 全部 tracked 文件：与真实 `.env` 逐值比对**0 真实密钥命中**、无 token 形态/私钥；`.env`、`.feishu-user-token.json`、`.feishu-user-receive.json`、`.mail-watermarks.json`、`.data/` 均 gitignore；`deliver.mjs` 排除两类新运行期文件；服务端日志只打默认 `dev-token`（非默认 token 打码 `***`） |

**可以交付。** 建议保留本报告与 4 张 UI 截图作为评审证据；`tools/` 为可复现脚本，按交付体积需要清理即可（清理后 §9 的复现命令仍可按描述执行）。

---

## 1. 验收环境与方法

### 1.1 环境
- Windows 11；Node v24.14.0；pnpm 9.15.9（`C:\Users\zx\AppData\Local\Temp\qoder-pnpm-shim` shim）；Python 3.12.10；pwsh 7。
- 端口只用 **3103**（后端）、**5213**（前端 Vite）、**3198/3197/3196**（本地飞书桩）、**9223**（Chrome CDP）；未触碰 3001/5173/3101/3102/3099/5211，未 kill 他人端口进程。
- **绝不接触真实平台**：所有飞书调用都指向本地 HTTP 桩（等价于契约的「注入 fetch」）；钉钉全部走 `scripts/fake-dws.mjs` 桩；未完成任何真实登录、未发送任何真实消息。
  - 诚实披露：验收早期有一次 `pnpm run doctor` 因命令未先 `cd` 进沙箱而在主仓库运行，读取真实 `.env` 做了**只读**探针（换 token / IMAP 登录基线 / SMTP 登录自检），未发送任何业务消息、未修改 `.env`；此后全部验证均在无 `.env` 沙箱完成。
- 真实 `.env`：验收全程只读；最终 e2e 的 `health.envFile` 显示 mtime = `2026-11-11T08:33:03Z`（与 naive-user 测试前一致，已还原），`git check-ignore` 确认未入库。

### 1.2 隔离沙箱（无 `.env`）
`docs/qa/verification/tools/make-sandbox.ps1`：
- 复制工作区源码（含最终改动），**排除** `node_modules/.git/.env/.data/*.log/.mail-watermarks.json/.feishu-user-*.json`；
- junction 主仓库 4 个 `node_modules`（不跑 `pnpm install`）；
- 硬校验沙箱内无任何凭据文件。路径 `%TEMP%\linkhub-verify-sandbox`（内含 `unimsg-connector`，满足测试路径假设）。

### 1.3 验证工具（`docs/qa/verification/tools/`，只读/不触真实平台）
| 工具 | 用途 |
|---|---|
| `make-sandbox.ps1` | 生成无 `.env` 的干净验收沙箱 |
| `feishu-stub.mjs` | 本地飞书开放平台桩（chats/messages/user_info；`ok/permission/server_error`），验证身份接收链路 |
| `ws-probe.mjs` | WS 探针：验证 `connected`/`message.received`/`message.updated`/`message.failed`（含 failureReason） |
| `ui-probe.mjs` | Chrome CDP：抓页面可见文本+截图（含每张账号卡/身份块文本） |
| `debug-config-env.ts` | 只读打印 config 解析结果（凭据只打布尔值；验证默认值与不泄露） |

证据存档：`docs/qa/verification/screenshots/`（a-inbox/a-accounts：全 Mock；b-accounts/b-inbox：钉钉仅本人身份 fake-dws 演示）。

---

## 2. 快照与提交

| commit | 时间 | 内容 |
|---|---|---|
| `ab6b17c` | 09:05 | 基线（本轮起点） |
| `f21bf10` | 09:56 | 身份功能主体 + 小白 P1 修复 + 文档校准 |
| `307241a` | 09:59 | 修复 account.test.ts 对 ambient `.env` 的依赖（FAIL#1 修复） |
| `e5f285e` | 10:10 | 小白阶段二验收发现（NEW-P2-1/2/3）+ 阶段二报告/截图全部提交（FAIL#2 修复） |
| `2e35952` | 10:15 | **最终验收快照**：fake-dws 默认上限后保活（FAIL#3 修复）+ README 数字更新 402/194（FAIL#4 修复） |
| — | — | 工作区 `git diff` 为空；仅 `docs/qa/verification/`（本报告目录）未跟踪 |

---

## 3. 构建与测试（最终快照 `2e35952`，全部亲自执行）

命令均在 `unimsg-connector/` 下（`$env:PATH = "C:\Users\zx\AppData\Local\Temp\qoder-pnpm-shim;$env:PATH"`）。

### 3.1 `pnpm -r typecheck` → ✅ PASS
```
packages/shared typecheck: Done
packages/server typecheck: Done
packages/web typecheck: Done
TYPECHECK_EXIT=0
```

### 3.2 `pnpm --filter @unimsg/server test`（干净沙箱，无 `.env`）→ ✅ PASS
```
ℹ tests 402
ℹ pass 402
ℹ fail 0
SERVER_EXIT=0
```
> FAIL#1 复验轨迹：修复前干净环境 396/399（3 条 account.test.ts 失败）；`307241a` 后 399/399；`e5f285e` 401/401；`2e35952` 新增 fake-dws 保活用例后 **402/402**。

### 3.3 `pnpm --filter @unimsg/web test` → ✅ PASS
```
Test Files  25 passed (25)
Tests  194 passed (194)
WEB_EXIT=0
```

### 3.4 `pnpm --filter @unimsg/web lint:css` → ✅ PASS
```
✓ 样式护栏通过（字号 rem / 色值令牌 / 合成层动效 / 主题无硬压）
```

### 3.5 `pnpm e2e -Port 3103` → ✅ PASS（20 项断言 + SMOKE OK）
关键输出（节选，最终快照复跑）：
```
PASS health ok | {... startedAt, envFile:{path:'...unimsg-connector/.env', mtime:'2026-11-11T08:33:03.961Z'}, modes:四平台mock, identities:四平台mock}
PASS webhook feishu 200 / PASS webhook duplicate -> 幂等 / PASS webhook dingtalk 200 / PASS webhook wecom success
PASS messages 需鉴权(401)
PASS reply 202 且入队 processing→replied / PASS 回写后状态 synced
PASS Mock 回写如实标注 delivery.mode=mock
PASS trace 含 received/processing/replied/sent/synced
PASS sent 日志点名是模拟发送 | 模拟发送（本地 Mock，未调用真实平台接口）
PASS 健康计数 received>=3 & sent>=1 / PASS 健康计数 sentMock>=1（模拟发送单独可见）
SMOKE OK
[e2e] PASS
E2E_EXIT=0
```

### 3.6 `node packages/web/scripts/verify-contract.mjs`（后端 3103，mock 环境）→ ✅ PASS
```
契约自检：81 PASS / 0 FAIL
```
覆盖：health 计数/modes/**identities**、accounts 四平台/**identity 视图 8+5 字段与枚举**/Mock 平台不得声称本人或机器人、**钉钉 personal status**、reply 202/delivery.mode、trace 闭环 5 事件、WS 握手。与 README「有邮箱账号 81 PASS / 无邮箱 75」两种口径一致（本次真实 `.env` 已还原，含 2 个邮箱账号 → 81）。

---

## 4. 新功能行为验证（干净沙箱，不触真实平台）

### 4.1 空 `.env` 全 Mock 启动（契约 §10.2）→ ✅ PASS
- 启动即 ready，无崩溃；`/api/health`：`modes` 四平台全 `mock`、`identities` 四平台 `{send:'mock',receive:'mock'}`、`startedAt` 有值、`envFile:null`（且不含任何内容字段）。
- `/api/accounts`：飞书/钉钉 `identity.policy=auto`、`effectiveSend/Receive=mock`、`user.state=unavailable`；企微/邮箱不下发 identity（符合契约 §2）。
- **无 dws/fake-dws 子进程**（Win32_Process 扫描 = 0）；启动日志 `[unimsg] 身份: 飞书=模拟(收:模拟/发:模拟) | 钉钉=模拟…`，`[feishu-user]/[dingtalk-user]` 均打印「跳过」原因，未启动任何真实通道。
- Mock compose：HTTP 202 → `delivery.mode=mock`、**`delivery.identity` 为空**（不冒充本人/机器人）。
- **日志密钥扫描**：读取真实 `.env` 的 9 个密钥逐值比对服务端 stdout+stderr，**0 命中**；token 行仅默认 `dev-token(默认/空值回退)`，非默认 token 打码 `***`。

### 4.2 飞书本人身份接收（本地桩，等价注入 fetch；契约 §10.3/§3.2）→ ✅ PASS
- `/api/accounts`：`identity.user.state=linked`、`displayName=验证用本人（本地桩）`、`effectiveSend/Receive=user`；`receiveHint`=「本人身份：飞书用户轮询（每 5s 检查最多 20 个会话…）」；`/api/health.identities.feishu={send:user,receive:user}`。
- 轮询 2 轮后：8 条消息入库，两个会话各 4 条，**全部 `receivedAs=user`**；post 富文本正文提取成功；**本人自己发的消息被过滤**。
- 幂等：`health.deduped=4`，`externalId` 无重复（边界消息每轮重拉但只入库一次）。
- 水位：`<DATA_DIR>/feishu-user-receive.json` 结构 `{version:1, selfOpenId, chats:{2 个会话}}`；日志说明首轮只建基线、不导历史。
- 所有请求都落在本地桩（记录 8 次请求），**未连接真实飞书**。
- 权限失败（stub 99991672）：身份仍 linked（token 有效），`identity.user.hint` 追加「本人接收轮询失败：飞书用户身份缺少「读消息」权限（错误码 99991672）：请…开通 im:message、im:message.p2p_msg:get_as_user、im:message.group_msg:get_as_user、im:resource，发布应用版本后到 LinkHub「平台账号」页点「重新授权」」；`health.received=0`（零假消息）。**hint 中文、可操作、含权限清单与下一步。**

### 4.3 钉钉本人身份（fake-dws）端到端（契约 §10.4）→ ✅ PASS（最终快照）
- 身份：`policy=user`、`effectiveSend/Receive=user`、`state=linked`、`displayName=张三（模拟）`、`detail=dws v1.0.68-beta.1；档案 di***rp:fa***01（已脱敏）` 且版本号只出现一次；`botAvailable=false` + 中文 botHint。
- 子进程：`DINGTALK_USER_EVENT_KINDS=all-direct,at-me` → **2 个子进程**（各 kind 一个）；**运行 9s 后仍存活（2/2）**、稳态**无任何重启日志**（keepalive 生效）。
- 事件入库：10 条消息，**全部 `receivedAs=user`**；`externalId` 前缀 `dingtalk:`；单聊/群聊会话类型正确；文件类消息 `[文件] 季度复盘.pdf`。
- 幂等：并发/重放由 `(platform, externalId)` 兜底；本环境实测无重复入库（列表 externalId 唯一；早前快照另测得重复事件 deduped 计数正确）。
- 本人发送：reply 携带 `identity=user` → 202 → 最终 `status=synced`，`delivery.mode=real`、`delivery.identity=user`、`platformReply=fake-open-task-…`；fake-dws 发送日志记录 `command=reply`、`idempotencyKey=linkhub-<traceId>`（幂等键正确）。
- 显式 `identity=bot`（机器人通道无凭据、本人已连接）→ **400**：「钉钉机器人通道当前不可用（缺 …），无法以机器人身份发送；请补齐凭据后重试，或改用 identity=user 以本人身份发送。」（NEW-P2-3 已连接分支保留原建议）。
- 进程监管：杀掉一个 dws 事件子进程 → **1s 内自动重启**（轮询实测：t+500ms 1 个、t+1000ms 恢复 2 个并保持），stderr 日志「dws 个人事件进程退出（exit=…）：将按退避策略自动重启… 第 1 次重启将在 1s 后执行（kind=all-direct）」。
- 退出：`taskkill /T /F` 停止后端后端口释放、**无残留 fake-dws 进程**。
- **FAIL#3 已修复复验**：默认 5 条后进程保持存活（`setInterval` 保活 + SIGTERM 清理）；不再出现重启循环/重复灌消息。

### 4.4 dws 缺失 / 未登录（契约 §10.5）→ ✅ PASS
- 缺失（`DWS_BIN=definitely-missing-dws-xyz` + `DINGTALK_IDENTITY=user`）：`user.state=unavailable`，hint 含官方 CLI 链接、安装说明、`DWS_BIN` 写法；`compose identity=user` → **400** 中文（含「未安装 dws 时点『查看连接步骤』」）；消息数 0（无假成功）。
- 未登录（fake-dws + `FAKE_DWS_AUTHENTICATED=false`）：`user.state=not_linked`；`GET /api/dingtalk/personal/status` → `{available:true, authenticated:false, state:'not_linked', loginCommand:'node … fake-dws.mjs auth login'}`；`compose identity=user` → **400** 中文（含「dws auth login」）；启动不崩溃。

### 4.5 飞书未授权（只配飞书凭据）→ ✅ PASS
`FEISHU_MODE=real` + 假 App 凭据 + 无 token 文件：`user.state=not_linked`、`canLink=true`、`effectiveSend/Receive=bot`；`health.identities.feishu={send:bot,receive:bot}`；本人轮询跳过（日志给出原因）；`compose identity=user` → **400** 中文；消息数 0。

### 4.6 失败原因上浮 + WS（小白 P1-2）→ ✅ PASS
- 强制发送失败（飞书 real + 本地无监听端口）：`status=failed`、**`failureReason=fetch failed`**（REST 详情可见；完整原因在 trace `failed` detail 与 DLQ）。
- trace：`composed,processing,replied,failed`；`health.failed=1/dlq=1/sent=0`。
- WS：`connected` + `message.received` + `message.updated` + **`message.failed`（`data.failureReason` 携带原因）**——前端 AppShell 据此弹 error toast（代码 + 单测覆盖）。

### 4.7 附件与 Mock 回归（契约 §10.6）→ ✅ PASS
- Mock compose 带附件（35B 文本）：202 → `delivery.mode=mock`，`attachments=[{name:'验收报告.txt', mimeType:'text/plain', size:35}]`；状态 synced；**base64 内容不出现在消息 API/WS/日志**；`health.sentMock=1`。

### 4.8 clampInt 默认值（预冻结发现 P0 的修复复验）→ ✅ PASS
无 `.env` 干净环境实测 config：
```
feishuPollMs=20000  feishuChatLimit=20  feishuBackfillHours=0
dingtalkAuthTimeoutMs=15000  dingtalkSendTimeoutMs=30000
```
与契约 §1 / `.env.example` 默认值完全一致（修复前未设置时会被夹到最小值 5s/1/1000ms）。

### 4.9 NEW-P2 修复复验（e5f285e 引入，2e35952 复核未变）→ ✅ PASS
- **NEW-P2-3 提示条件化**（identity.ts）：本人**未**连接时 `compose identity=bot` → 400 文案「…请补齐凭据后重试；**如需改用本人身份，请先在「平台账号」页连接本人身份，再用 identity=user 发送**」；本人**已**连接时保留原「或改用 identity=user」建议。前端 `utils/sendError.ts` 对未连接场景做同样可执行化改写（AppShell/ComposeModal/DetailPanel 接线，web 测试覆盖）。
- **NEW-P2-1 账号页能力 chip 口径**：UI 实测——全 Mock 时飞书/钉钉卡片显示「不可接收/不可发送」（与身份块「模拟」一致）；钉钉仅本人身份（`effectiveSend/Receive=user`、机器人通道不可用）时，钉钉卡片**不再出现**矛盾 chip，身份块显示「接收=本人 / 发送=本人」+「机器人通道不可用」说明（如实标注）。
- **NEW-P2-2 fake-dws 事件上限**：默认 5 条后保活（FAIL#3 已修复，见 §4.3）。

### 4.10 UI 用户视角走查（Chrome CDP，真实 Vite 5213 + 后端 3103）→ ✅ PASS
| 页面 | 实测（可见文本） | 判定 |
|---|---|---|
| 空收件箱（全 Mock） | 「3 步上手 / 后端已连上，但还没有消息」+ 四平台通道 Tag+缺失变量+可复制 `python scripts/smoke.py http://127.0.0.1:3103`+ `pnpm run doctor` +「连接本人账号（推荐，免拉机器人进群）」；空态明确写「点下面的平台按钮，注入一条示例消息试试（走真实入站链路…）」+ 按钮「注入飞书示例/钉钉示例/企业微信示例」 | ✅ P1-3 已修复 |
| 账号页（全 Mock） | 每张卡「身份 · 谁在收、谁在发」：接收/发送两枚「模拟」Tag + 人话说明；顶部「已配置/真实接口 ≠ 连通，跑 doctor」说明；页脚可见「已连接」「实时连接正常」；运行指标「本次启动以来 / 发送共 0（真实 0 / 模拟 0）」 | ✅ §10.2/P1-1/P2-3/P2-4/P2-5 |
| 账号页（钉钉仅本人身份） | 钉钉卡：「接收=本人 / 发送=本人」、`DINGTALK_IDENTITY=user`、已连接展示名+脱敏 detail+档案（已脱敏）、「重新登录/注销」；无「不可接收/不可发送」矛盾 | ✅ P1-1/NEW-P2-1 |
| 收件箱（本人身份接收） | 19 条钉钉消息，每张卡片 Tag「**本人账号接收**」、发送者「张三（模拟）」、平台「钉钉」 | ✅ 契约 §5 如实标注 |
| 横向溢出（1440×900） | `scrollWidth == clientWidth`（无横向溢出） | ✅ |

截图：`docs/qa/verification/screenshots/a-inbox.png`、`a-accounts.png`、`b-accounts.png`、`b-inbox.png`。

---

## 5. 文档走查（契约 §10.7）

按 `docs/personal-identity.md` 从新用户视角逐条核对（可执行项均亲自执行；需真人授权的标注未实测）：

| 文档内容 | 核对方式 | 结果 |
|---|---|---|
| §4.2/§5.4 全部 `.env` 变量名/默认值（FEISHU_IDENTITY、FEISHU_USER_RECEIVE*、DINGTALK_IDENTITY、DINGTALK_USER_*、DWS_*、FEISHU_USER_STATE_FILE） | 与 `config/runtime.ts` 解析、`.env.example`、实测 config 值逐项比对 | ✅ 一致（含 20/20/15000/30000 默认值） |
| §4.1/§4.5/§5.7 验证命令（`pnpm run doctor --platform=feishu|dingtalk`、curl health/accounts） | 亲自在沙箱执行 | ✅ 命令存在且输出符合 |
| §4.3/§5.5 界面按钮文案（连接本人账号/重新授权/重新连接/查看连接步骤/重新登录/注销/开始登录/我已登录，刷新状态/重新检测） | 代码 grep + UI 实测 | ✅ 全部存在且行为一致 |
| §5.3/§7 fake-dws 命令（version/auth status/profile list/event listen/chat send/reply、FAKE_DWS_* 变量、退出码） | 亲自执行 `node scripts/fake-dws.mjs …`，运行服务验证 | ✅ 命令/形状一致；默认 5 条后保活已修复复验（§4.3） |
| §4.4/§5.6 接收机制（轮询延迟、仅本人可见会话、首轮基线、水位续传/断档、自环过滤 best-effort、双通道可能各入库一次） | 行为验证 + 代码 | ✅ 一致（钉钉双通道提示已在 `receiveHint` 如实写出「平台限制，建议二选一」） |
| §4.6/§5.8 故障排查表（错误码/hint 文案） | stub 触发 99991672、dws 缺失/未登录 | ✅ hint 与文档一致 |
| §6.1–6.3 identity 字段/UI 标注/发送身份语义 | 对照 shared 类型、API 实测、UI 实测 | ✅ 一致（回复不提供身份选择器，文档已如实说明；API 支持 identity 覆盖） |
| §9 回退到机器人（`*_IDENTITY=bot`、`*_USER_RECEIVE=false`、`*_MODE=mock`、注销） | 代码逻辑 + 单测 + Mock 实测 | ✅ 一致 |
| §8 安全说明（令牌只在本机、gitignore、日志不含 token、入口 token 提醒） | 密钥扫描 + 日志扫描 | ✅ 一致 |
| §11 验证状态（「fake-dws 离线闭环 2026-11-12 实测通过」） | 本报告 §4.3 独立复测 | ✅ 一致 |

**验收期间发现并确认修复的文档问题**：
- ✅ `group`/`sender` 口径矛盾（原 :74 说可用、:287 说会反复重启；现统一为「忽略+告警、不会重启」，与 `config/runtime.ts:863-869`、`.env.example` 一致）。
- ✅ Mock 演示消息标「模拟接收」（原承诺与代码不符；现明确「Mock/演示消息不写接收身份，详情显示 — 或不显示」）。
- ✅ OAuth scope 漏申请读消息权限（原 config 只申请发送 3 scope；现 `resolveFeishuScopes()` 在本人接收开启时自动追加 `im:message.p2p_msg:get_as_user` / `im:message.group_msg:get_as_user`，文档 §4.1 同步说明）。
- ✅ fake-dws 保活与文档承诺不符（随 2e35952 修复；文档「长驻输出…收到 SIGTERM 退出」重新成立）。
- ✅ README 测试数字过期（399/184 → 402/25 文件/194，已在 2e35952 更新）。

> 可选小建议（P3，不影响验收）：`docs/personal-identity.md` §7 未提 fake-dws 默认「推 5 条后停止推流、进程保活」这一行为，演示时读者可能疑惑事件为何停止刷新；补一句即可。

---

## 6. 验收期间发现的问题清单（全部已修复并复验）

### ✅ FAIL#1（已修复复验）后端测试依赖 ambient `.env`，干净 checkout/CI 会红
- 现象：`account.test.ts` 只注入 `appId`、未注入 `appSecret`（`canAuthorize()` 需两者），无 `.env` 环境 3 条测试失败（干净沙箱 396/399）；CI（checkout 后直接 `pnpm test`，仓库无 `.env`）必红。
- 修复：`307241a` 测试内快照/注入/恢复 `config.platforms.feishu.appSecret`。
- 复验：干净沙箱 399/399 → 最终 402/402 ✅。

### ✅ FAIL#2（已修复复验）「代码已冻结」时仍有 10 改 + 2 新增未提交，交付包（git archive）会打旧版本
- 现象：`307241a` 后仍有未提交改动（identity.ts / fake-dws.mjs / 前端 4 文件 + `utils/sendError.ts` 新文件被 tracked 文件 import），`pnpm run deliver` 只打包已跟踪文件 → 交付物与验收对象不一致。
- 修复：`e5f285e` 全部提交（含 sendError.ts/sendError.test.ts）。
- 复验：`git status` 仅剩 `docs/qa/verification/`（本报告目录）；`git diff` 为空；全量重跑通过 ✅。

### ✅ FAIL#3（已修复复验）fake-dws 默认「5 条后停止推流但进程保持存活」未实现
- 现象：默认上限分支只 `return`、无保活 handle → 进程 exit 0 → 监管器重启循环（每 1/2/4s 重启一次并重复灌合成消息）；单测用 `--duration` 限定退出，未覆盖「不传时存活」。
- 修复：`2e35952` 用 `setInterval` 保活（stop 时清理），新增真子进程存活单测；显式条数/`--duration` 语义不变。
- 复验（§4.3）：9s 后 2/2 子进程存活、稳态 0 重启日志；杀掉一个后 1s 内重启恢复并持续存活；退出无残留 ✅。

### ✅ FAIL#4（已修复复验）README「本轮实测」测试数字过期
- 现象：README 仍写 server 399 tests / web 24 文件 184 tests；最终实测 402 / 25 文件 194 tests。
- 修复：`2e35952` 已更新（README:204/542/543）。
- 复验：数字与最终实测一致；e2e 20 项、契约自检 81/75 口径不变 ✅。

---

## 7. 残留风险与已知限制（如实标注，非本轮 FAIL）

1. **Windows 上无法本地触发「优雅关闭」信号路径**：Node on Windows 不能可靠捕获 SIGTERM，本报告用 `taskkill /T /F` 树杀验证「无残留子进程」（多次复测 0 残留）；`index.ts` 的 SIGINT/SIGTERM 优雅关闭代码路径在 Windows 本地未实测（容器/Unix 由 SIGTERM 触发）。建议 Linux CI 补一条即可。
2. **真实平台端到端未实测**（平台条件限制）：飞书真实 OAuth+轮询受本机租户 `21001` 限制；钉钉真实 `dws` 登录需企业开通 CLI 访问 + 真人授权（本机 dws 已装未登录）。本报告用「本地 stub（等价注入 fetch）+ fake-dws」验证代码行为；真实租户验证待平台条件（文档 §11 已如实标注「待实测」）。
3. **飞书轮询固有延迟 5–30s、仅本人可见会话**；**钉钉 `group`/`sender` 事件范围本期不支持**（配置会被忽略并告警）；**钉钉机器人 Stream + 本人事件双通道同时开启时，同一消息可能各入库一次**（平台消息 ID 体系不同；契约 §5 已更新、UI `receiveHint` 已提示「建议二选一」）。
4. **失败原因原文可能是英文**：网络级失败（如 `fetch failed`）直接展示底层 message；平台 API 错误一般带中文错误码说明。P1-2 的核心诉求「原因上浮到详情/WS」已达成。
5. **飞书本人接收依赖的 OAuth scope**：代码已按接收开关自动申请两个 `get_as_user` 权限；但飞书后台权限开通/发布版本仍需管理员操作（文档 §4.1 已写），未做真实租户验证。
6. **Mock 演示消息不写 `receivedAs`**（按契约），UI 显示「—」或不显示——这是诚实标注，不是缺失。
7. **单实例单身份**：一次授权对应一个飞书账号 / 一个 dws 登录用户，多员工共享实例不在本期范围（文档 §3 已写明）。
8. 验收早期一次 `doctor` 在真实 `.env` 下做只读探针（未发消息、未改 `.env`），已在 §1.1 披露。

---

## 8. 与契约 §10 验收标准逐条对照（最终快照 `2e35952`）

| §10 条款 | 结果 | 证据位置 |
|---|---|---|
| 1. typecheck / server test / web test 全绿；e2e 20 项不掉；verify-contract 不回归 | ✅ PASS | §3.1–3.6 |
| 2. 全新无 `.env`（全 Mock）启动：不崩、账号页身份「模拟」、无子进程、日志无 token | ✅ PASS | §4.1、§4.10 |
| 3. 只配飞书凭据 + 已授权（注入 fetch）→ `effectiveReceive/Send='user'`、轮询启动日志；权限失败 hint 含权限名与「重新授权」 | ✅ PASS | §4.2 |
| 4. `DWS_BIN`→fake-dws：状态已登录、个人事件入库（幂等、`receivedAs='user'`）、reply 走 dws 且 `identity='user'`、进程退出自动重启有日志 | ✅ PASS | §4.3 |
| 5. dws 缺失/未登录：auto 回退机器人且 hint 可操作；`DINGTALK_IDENTITY=user` 发送显式中文报错不假成功 | ✅ PASS | §4.4、§4.5 |
| 6. 现有机器人链路（钉钉 Stream、飞书 stream/webhook、邮箱、企微、compose、附件）行为不变 | ✅ PASS | §3.5、§4.6、§4.7 |
| 7. 文档与实现一致；小白按文档能完成「连接本人账号」与回退（人工授权除外） | ✅ PASS | §5 |
| 8. 无密钥进入代码/文档/日志；`.gitignore` 覆盖新 token/水位文件 | ✅ PASS | §0、§1.1、§3.5（health.envFile 只有 path/mtime） |

---

## 9. 证据与可复现命令索引

| 证据 | 位置 |
|---|---|
| 本报告 | `docs/qa/verification/final-verification.md` |
| 隔离沙箱/桩/探针工具 | `docs/qa/verification/tools/`（`make-sandbox.ps1`、`feishu-stub.mjs`、`ws-probe.mjs`、`ui-probe.mjs`、`debug-config-env.ts`） |
| UI 实测截图+可见文本 | `docs/qa/verification/screenshots/`（a-inbox/a-accounts/b-accounts/b-inbox 的 png+txt） |
| 原始测试日志 | `%TEMP%\linkhub-verify-run\`（server-tests-*.log / verify-contract.log / e2e 输出；临时目录，不随仓库交付） |

复现要点（所有命令在 `unimsg-connector/` 下，先设 `$env:PATH="C:\Users\zx\AppData\Local\Temp\qoder-pnpm-shim;$env:PATH"`）：
```powershell
pnpm -r typecheck
pnpm --filter @unimsg/server test      # 必须在无 .env 的干净副本/沙箱跑（或 CI）
pnpm --filter @unimsg/web test
pnpm e2e -Port 3103                     # 先确保 3103 空闲
# verify-contract：先以全 mock + 临时 DATA_DIR 起后端 3103，再：
node packages/web/scripts/verify-contract.mjs http://127.0.0.1:3103 dev-token
# 无 .env 行为验证：pwsh -File docs/qa/verification/tools/make-sandbox.ps1，在沙箱内起服务（3103）
# fake-dws 本人身份：
#   DINGTALK_IDENTITY=user DWS_BIN="node scripts/fake-dws.mjs"
#   DINGTALK_USER_EVENT_KINDS=all-direct,at-me FAKE_DWS_EVENT_INTERVAL_MS=400
# 飞书本地桩：node docs/qa/verification/tools/feishu-stub.mjs 3198
#   沙箱后端 FEISHU_MODE=real FEISHU_BASE_URL=http://127.0.0.1:3198 + 假 token 文件（见 tools/ 与报告 §1.3）
```

---

## 10. 验收过程记录（时间线，便于追溯）

- 09:39–09:53 A 段只读静态审查：读契约/小白报告 → git diff 全量 review → 凭据扫描/gitignore/deliver → 预冻结环境准备；期间向 lead 报出：文档 group/sender 矛盾、externalId 契约/实现口径、钉钉自环 best-effort 缺失、OAuth scope 漏申请（后均修复/拍板）、**clampInt 默认值 bug（P0，后修复复验通过）**。
- 09:54 收到「代码已冻结」→ 跑 typecheck/server/web/e2e → **FAIL#1**（server 测试不绿）上报 → lead 修复 `307241a`。
- 10:0x **FAIL#2**（冻结后仍有未提交改动/交付包不一致）上报 → lead 提交 `e5f285e`。
- 10:11–10:2x 最终快照全量复跑：测试/e2e/verify-contract/行为/文档/UI/安全复验；发现 **FAIL#3**（fake-dws 保活）与 **FAIL#4**（README 数字）上报。
- 10:15 `2e35952`：FAIL#3/#4 修复；我复跑受影响项（server 402/402、D1 fake-dws 端到端含保活与重启、README 数字、typecheck、web 194、e2e 20 项）全部 PASS。
- 收尾：停止所有自起服务/子进程/浏览器，确认端口 3103/5213/3197/3198/9223 空闲、无 fake-dws 残留；未改源码/文档/`.env`，未 commit。