# LinkHub 白号首次使用修复 · 独立复审计（Round 2）报告

> 审计员：独立第二审计（只读主实例 + 独立 3189 临时实例）
> 审计时间：2026-11-12 16:26–16:37（UTC+8）
> 审计对象：仓库当前未提交工作区（`unimsg-connector`，git `bb3801f` + 本次修复改动，55 files changed）
> 约束：未 commit；未改 `.env`/备份/业务代码；主实例 3001 **只做 GET**；写入/破坏性测试全部在 3189 临时实例 + 临时 `DATA_DIR` 完成，测后清理。

---

## 0. 结论摘要

**核心修复是真实的、可用的；没有发现 P0 阻断。** 白号首屏现在能给出 `needs_user_auth/needs_admin` 的可执行路径，不再落进 Mock 死胡同；`/api/app-config` 能真实保存/热应用/持久化；邮箱导入、Mock 新建发送、454 个后端测试均通过。

但仍有 **2 项 P1、3 项 P2**，以及 **8 项前后端契约不一致/轻微 Schema 差异**，主要集中在「热应用无需重启」这一承诺与 GET `restartRequired` 的全局判定之间：

- **P1-1**：`PUT identity.dingtalk='user'` 返回 `hotApplied:true, restartRequired:false`，但同一进程随后 `GET /api/app-config` 返回 `restartRequired:true`（settings 文件 mtime > 进程启动时间）。前端 `ConnectPage` 会据此显示「需要重启」，与「无需重启」直接矛盾。审计时（16:30 后）3001 也出现了该状态。
- **P1-2**：前端 3 处保存结果处理只看 `restartRequired`，不看 `hotApplied`/`saved`/`ignoredByEnv`。当 `DINGTALK_IDENTITY` 被 `.env` 显式锁定时，后端实际 `hotApplied:false/ignoredByEnv`，前端仍提示「已切换/已保存并立即生效」，且 `ConnectPage` 不展示 `ignoredByEnv`，属于静默假成功（条件触发：用户曾在 `.env` 写死 `DINGTALK_IDENTITY`）。
- **P2**：邮箱白号 hint 的「显式 `MAIL_MODE=mock`」不实（实际 `modes.mail.source=none`）；邮箱已验证+mock 的「启用真实邮箱」写 `modes.mail=real` 是静态配置需重启，hint 却说无需重启；飞书 linked+mock 时凭据已配置，summary 仍让用户「填入应用凭据并重启」。

**回归**：`pnpm --filter @unimsg/server test` → **454/454 pass，0 fail**，约 4.4s。`GET /api/accounts`、`/api/messages`、`/api/health`、`/api/onboarding` 均正常，onboarding 不含 token/secret。

---

## 1. 环境 / 方法 / 约束

### 1.1 主实例（只读）

| 项 | 值 |
|---|---|
| 前端 | `http://127.0.0.1:5173`（GET `/` → 200） |
| 后端 | `http://127.0.0.1:3001`，Bearer `dev-token` |
| `.env` 形态 | 仅 `SERVER_PORT=3001`、`API_TOKEN=dev-token`、`DATA_DIR=C:/Users/zx/AppData/Local/Temp/linkhub-white-data`（未改） |
| 用法 | 仅 GET；所有 PUT/DELETE/写入在 3189 完成 |

> **并发写入声明（重要）**：审计期间 3001 被**本审计之外的进程**写入（时间与并行 UI 复验吻合），**不是本审计写入**：
> - 16:30:17 出现 `DATA_DIR/mail-accounts.json`（空账号列表，37 B）；
> - 16:30:50 出现 `DATA_DIR/linkhub-config.json`，内容为 `{"version":1,"identity":{"dingtalk":"user"}}`。
>
> 本审计对 3001 只发过 GET。3001 的白号基线快照取自 **16:26:46–16:26:47**（写入之前）；16:30 之后的 3001 状态仅用于说明 P1-1 的现场复现，不作为基线。受该写入影响，3001 当前钉钉 actions 从 `dingtalk-personal-login` 变为 `dingtalk-login`（两条前端都处理，不影响本审计结论）。并行 UI 复验目录 `docs/qa/white-account/screenshots-round2/` 与本审计无关。

### 1.2 3189 独立临时实例

```
$env:PATH="C:\Users\zx\AppData\Local\Temp\qoder-pnpm-shim;$env:PATH"
$env:SERVER_PORT='3189'
$env:API_TOKEN='test-token'
$env:DATA_DIR='C:\Users\zx\AppData\Local\Temp\linkhub-audit-round2-3189'
pnpm --filter @unimsg/server start   # workdir: unimsg-connector
```

- 仓库 `.env` 未改；3189 仅在进程环境覆盖这 3 个变量（`config` 读取仓库 `.env`，dotenv 不覆盖已有进程环境变量）。
- 其余平台仍走白号 mock；测试令牌 `test-token` 未用于任何真实平台。
- 临时 `DATA_DIR` 创建于 16:27:50，测后删除；端口 3189 已确认释放。

### 1.3 未执行项 / 不伪造的东西

- **未执行真实登录/扫码/输真实凭据**；飞书 linked 态用**临时 DATA_DIR 中的合成 token 文件**构造，仅用于验证「linked+mock 不得 ready」的代码分支，不涉及真实 OAuth。
- 未对 3001 做任何 PUT/DELETE；未保存真实邮箱账号。
- 未执行真实 IMAP/SMTP 登录；邮箱 `/test` 使用 `.invalid` 假域名（DNS 立即失败）。
- 未构造「真实平台 ready」态（白号不可达）；`feishu-status` 的 ready 分支用源码 + 单测核对。

---

## 2. 白号基线（写入前）

### 2.1 3001（16:26:46 / 16:26:47）

| 接口 | 实测 |
|---|---|
| `/api/health` | `envFile.path=".env"`、`settingsFile={path:"linkhub-config.json",present:false,mtime:null}`、`modes` 全 mock、`identities` 全 mock |
| `/api/onboarding` | `firstRun:true`、`overall:{ready:0,total:4,needsAction:4}`；states：`mail=needs_user_auth`、`dingtalk=needs_user_auth`、`feishu=needs_admin`、`wecom=needs_admin`；`dws.available:true/version:v1.0.68-beta.1/source:tools` |
| `/api/accounts` | 200，4 平台，均 mock/未配置 |
| `/api/mail/accounts` | 200，0 个账号，`filePath` 指向临时 DATA_DIR |

### 2.2 3189（16:28:24，写入前）

与 3001 白号基线完全一致：`firstRun:true`、`ready 0/4`、`needsAction 4`、states 同上；`/api/app-config` 全字段 `source:none`，`platforms.feishu.missing=["FEISHU_APP_ID","FEISHU_APP_SECRET"]`；`/api/health` `envFile.path=".env"`、`settingsFile.present=false`。

---

## 3. 检查项表格（期望 / 实际 / 证据 / 结果）

### 3.1 onboarding 真伪与自洽

| # | 检查项 | 期望 | 实际 | 证据 | 结果 |
|---|---|---|---|---|---|
| A01 | 白号 `firstRun` | true | true | 3001 16:26:47、3189 16:28:24 响应 | **PASS** |
| A02 | 白号 `overall` | `ready=0,total=4,needsAction=4` | 完全一致 | 两实例响应；`services/onboarding.ts:678-680` 非 ready 即计数 | **PASS** |
| A03 | 白号 states | mail/dingtalk=`needs_user_auth`，feishu/wecom=`needs_admin` | 完全一致，且无 `mock` 状态 | 两实例响应 | **PASS** |
| A04 | `dingtalk-personal-login` 结构 | PUT 身份热应用 + then 登录 | `path:/api/app-config, method:PUT, payload:{identity:{dingtalk:"user"}}`；`then:[{path:"/api/dingtalk/personal/login",method:"POST",payload:{mode:"browser"}}]` | 3001 16:26 响应；源码 `onboarding.ts:303-312` | **PASS** |
| A05 | `*-configure` 可达 | dingtalk/feishu/wecom 均有填凭据入口 | 三者均为 `kind:"form", path:"/api/app-config", method:"PUT"` | 3001 响应；前端 `ConnectPage.tsx:349-353` 按 `-configure` 打开 `AppConfigModal` | **PASS** |
| A06 | `*-admin` 链接 GET 可达 | 官方后台/文档可打开 | 钉钉 `https://open-dev.dingtalk.com/` 200；飞书 `https://open.feishu.cn/app` **GET 200**（HEAD 404，历史 P2-11 已知误报）；企微 200；QQ 邮箱 200；GitHub release 200 | 实际 `Invoke-WebRequest -Method Get` | **PASS** |
| A07 | `*-admin-checklist` 含「凭据写回 + 重启」 | 三平台都有 | 钉钉 569 B、飞书 680 B、企微 460 B；三者都含「写回 LinkHub」和「**重启后端**」字样 | `GET /api/onboarding` 取文本；源码 `onboarding.ts:141-182` | **PASS** |
| A08 | `feishu-status` 不再 404 | path=`/api/accounts` | 源码 `onboarding.ts:588-593` 明确 `/api/accounts`；单测 `onboarding.test.ts:245` 断言 | 源码 + 454 测试通过 | **PASS（静态+单测）**；白号不可达 ready 分支，未做 live |
| A09 | doctor 命令带 cwd | 命令含 `cd unimsg-connector` | 四条命令均为 `cd unimsg-connector && pnpm run doctor --platform=<mail/dingtalk/feishu/wecom>`；label 还提示 `corepack pnpm` 回退 | `GET /api/onboarding` actions；源码 `onboarding.ts:118-125` | **PASS** |
| A10 | linked+mock 不得 ready | 非 ready | 3189 构造：飞书 `linked=true`、`modes.feishu=mock`、凭据已配置 → onboarding `feishu=needs_admin`，overall 仍 0/4/4；`/api/health` modes.feishu=mock、identities 飞书 mock；`/api/accounts` effectiveSend/Receive=mock | 3189 16:30:5x；见 §6 | **PASS** |
| A11 | 钉钉 linked+mock 不得 ready | 非 ready | 单测 `services/onboarding.test.ts`「钉钉 P0-2：linked + mock 绝不得 ready」通过；源码 `onboarding.ts:348-363` | 454 测试输出 | **PASS（静态+单测）** |
| A12 | 不再 Mock 死胡同 | 非 ready 有可执行 action | 白号 4 步均给出配置/登录/清单/doctor 动作；无 `mock` state | 3001/3189 响应 | **PASS** |
| A13 | linked+mock 文案准确性 | 应说明「运行模式是 mock」 | **FAIL（P2）**：3189 中飞书凭据已配置、`modes.feishu=mock`，summary 却是「填入应用凭据并重启后才会真实收发」。实际应提示「去掉 `FEISHU_MODE=mock`/切 real」 | 3189 linked+mock 响应；源码 `onboarding.ts:500-515` | **FAIL（文案原因）** |

### 3.2 `/api/app-config`（3189 写入）

| # | 检查项 | 期望 | 实际 | 证据 | 结果 |
|---|---|---|---|---|---|
| B01 | GET 无 secret 明文 | 无明文 | 基线/热应用/凭据保存后 GET 均无明文；`masked` 仅末 4 位（`****_123`、`****ABC9`）；grep 响应无 secret | 3189 多次 GET；见 §6 | **PASS** |
| B02 | `source=none` | 白号初态 none | identity/modes/llm/platforms 全 `source:none` | 3189 16:28:24 | **PASS** |
| B03 | `source=local` | 保存后 restart 仍 local | 凭据/identity 保存后 GET `source:local`；重启后仍 local（`isLocalAppliedEnvKey`） | 3189 16:29 后 GET | **PASS** |
| B04 | `source=env` | 显式进程 env 优先 | 以 `LLM_MODEL=env-audit-model` 启动 → `llm.model.source=env, configured=true, masked=****odel` | 3189 16:32 | **PASS** |
| B05 | missing 键名 | 缺哪个列哪个 | 白号飞书 `FEISHU_APP_ID/FEISHU_APP_SECRET`；凭据保存后 missing 变空 | 3189 GET | **PASS** |
| B06 | 未知分组/未知键 → 400 中文 | 400 | `foo` → 400「未知配置分组」；`platforms.feishu.bogus` → 400「未知配置项」 | 3189 PUT | **PASS** |
| B07 | 非法枚举/类型/超长 → 400 中文 | 400 | `identity.dingtalk=root` → 400「只能是 auto / bot / user」；number → 400「必须是字符串」；`stream='yes'` → 400「必须是 true/false」；129 字符 appId → 400「过长（最多 128 字符）」；空 patch → 400「没有需要保存的配置项」 | 3189 PUT | **PASS** |
| B08 | `null` 清除 | 可清除 | `llm.model` 写后清 → GET `source:none, configured:false`；`modes.wecom` 同理（均立即反映）。清除**已生效的凭据**（appId/appSecret）时，同进程 GET 仍显示旧 effective 值（`source:local,configured:true`）直到重启（`restartRequired:true`），重启后为 none；这是 effective view 语义，见下方备注 | 3189 PUT/GET + 重启 | **PASS（凭据需重启生效）** |
| B09 | identity 热应用 | `hotApplied:true, restartRequired:false` | PUT 200：`saved:true, hotApplied:true, hotAppliedKeys:["identity.dingtalk"], restartRequired:false, changedKeys:["identity.dingtalk"], staticKeys:[]`；GET 立即 `source:local,value:user`；onboarding 钉钉 `effectiveSend:user`；重启后仍 user | 3189 16:28:29 PUT；重启后 GET | **PASS** |
| B10 | 凭据 PUT 需重启 | `restartRequired:true`，重启后生效 | PUT 200 `saved:true, hotApplied:false, restartRequired:true`；GET 掩码；重启后 `source:local, configured:true, restartRequired:false`，health modes.feishu=real | 3189 16:29 PUT + 16:29:23 重启 | **PASS** |
| B11 | GET 的 `restartRequired` 与 PUT 自洽 | identity-only 后 GET 也应为 false | **FAIL（P1）**：PUT 返回 false，同进程 GET 立即返回 **true**（settings mtime > startedAt）。前端会显示「需要重启」 | 3189 16:28:29 PUT；16:28:30 GET；源码 `localConfig.ts:450` vs `appConfig.ts:145-146`；前端 `ConnectPage.tsx:124-125` | **FAIL** |
| B12 | health `envFile.path` basename | `.env`，不泄绝对路径 | 3189/3001 均为 `.env`；`settingsFile.path` 均为 `linkhub-config.json` | `/api/health` | **PASS** |
| B13 | settingsFile 存在性/mtime | 真实反映 | 3189 初态 `present:false,mtime:null`；写后 `present:true` 且 mtime 更新；重启后 mtime 保留 | `/api/health`、`/api/app-config` | **PASS** |
| B14 | 响应/日志无 secret | 不打印明文 | 对 health/accounts/app-config/onboarding/mail/messages 的响应 grep `fake_secret_ABC9/fake-access-token-xyz/fake-refresh-token-xyz/test-token/fake-auth-code-123` 均 0 命中；3189 启动日志也无这些串 | 3189 全量 GET + 日志 | **PASS** |

> **B08 备注**：`null` 对未 merge 进 `process.env` 的键（`llm.model` / `modes.*`）会立即反映；对启动时已 merge 进 `process.env` 的凭据（appId/appSecret），GET 反映的是“当前进程 effective 值”，文件已清除但进程仍用旧值，直到重启才变 none。后端用 `restartRequired:true` 明示了这一点；但若前端/契约把 GET 当“文件里已保存的配置”，会产生歧义。列为 P3 观察。

### 3.3 `/api/health`

| # | 检查项 | 期望 | 实际 | 证据 | 结果 |
|---|---|---|---|---|---|
| C01 | 公开 health 不泄绝对路径 | `envFile.path=".env"` | 3189/3001 均为 `.env` | `GET /api/health` | **PASS** |
| C02 | settingsFile 只给文件名/存在性/mtime | 不泄绝对路径/内容 | `path:"linkhub-config.json"`、`present`、`mtime`；无内容 | 同上 | **PASS** |
| C03 | modes/identities 摘要 | 真实 | 白号全 mock；3189 保存 fake 凭据后 feishu real；linked+mock 时 mock | health 多次 | **PASS** |

### 3.4 邮箱接口（3189）

| # | 检查项 | 期望 | 实际 | 证据 | 结果 |
|---|---|---|---|---|---|
| D01 | GET 字段 | `verified/verifiedAt/source/removable` | 保存未验证假账号后：`source:file`、`removable:true`、`verified:false`、`verifiedAt` 缺省（optional）；地址 `a******@example.com`；不含授权码 | 3189 POST 后 GET | **PASS（verifiedAt 仅验证后下发）** |
| D02 | `POST /test` 假数据 | 200 + 结果 ok:false + 中文 hint | HTTP 200；顶层 `ok:true`，`data.ok:false`；IMAP/SMTP 各带中文 `detail/hint`（DNS 解析失败），0.1s；无授权码回显 | 3189 `/api/mail/accounts/test` | **PASS（前端读 `data.ok`）** |
| D03 | 保存未验证账号 | 成功 + 警告 | 201；`warnings:["账号已保存但未验证：…"]`；账号状态未验证 | 3189 POST | **PASS** |
| D04 | `POST /:key/verify` 假账号 | ok:false 不崩 | HTTP 200；`ok:false, verified:false, error:"测试连接未通过…"`；GET 仍 `verified:false` | 3189 | **PASS** |
| D05 | 删除清理 | 可删 + 列表归零 | DELETE 200；GET 0 条；临时 `mail-accounts.json` 随临时目录清理 | 3189 | **PASS** |
| D06 | 不保存真实账号 | 只用假数据 | 使用 `audit.fake@example.com` + `imap.invalid/smtp.invalid`，无真实凭据 | 3189 | **PASS** |

### 3.5 Mock 新建发送（3189）

| # | 检查项 | 期望 | 实际 | 证据 | 结果 |
|---|---|---|---|---|---|
| E01 | 无 conversationId 的 Mock 新建发送 | 成功且 `delivery.mode=mock`，不得 400 | 清除 fake 凭据恢复 mock 后：`POST /api/messages/compose {platform:"feishu",text:"测试"}` → **202**；ack `message.status=replied`、`conversation.id=mock:demo`；轮询后 `status=synced`、`delivery.mode=mock`、无 `delivery.identity`、无 failure | 3189；源码 `services/message.ts:317-336` | **PASS** |
| E02 | 真实模式无会话 | 应 400，不伪造 | 测试过程中 fake 凭据把 feishu 变 real 时，同一请求返回 400「缺少目标会话…」；随后清除凭据恢复 mock，返回 202 | 3189 两次对照 | **PASS（模式守卫符合语义）** |
| E03 | 非法入参 | 400 中文 | 缺 text → 400「文本与附件不能同时为空」；bad platform → 400「platform 必须是 feishu / dingtalk / wecom / mail 之一」 | 3189 | **PASS** |

### 3.6 回归 / 安全 / 主实例

| # | 检查项 | 期望 | 实际 | 证据 | 结果 |
|---|---|---|---|---|---|
| F01 | server 单测 | 454 左右全过 | **454 tests / 454 pass / 0 fail / 0 skipped**，duration 4402.7ms | `pnpm --filter @unimsg/server test`（16:27 启动，16:28 完成） | **PASS** |
| F02 | `/api/accounts` | 200，4 平台 | 3001/3189 均 200；3001 4 条 | GET | **PASS** |
| F03 | `/api/messages` | 200 | 3001 200/count 0；3189 200 | GET | **PASS** |
| F04 | `/api/health` | 200 且结构正常 | 200；见 §3.3 | GET | **PASS** |
| F05 | `/api/onboarding` 不含 token/secret | 不含 | 3001/3189 响应 grep `dev-token/test-token/authCode/accessToken` 均 0 命中 | GET + grep | **PASS** |
| F06 | 鉴权 | 无 Bearer 401 | 3001 `/api/onboarding` 无 token → 401 `{ok:false,error:"unauthorized"}` | 3001 GET | **PASS** |
| F07 | 3001 只读约束 | 本审计不写 | 本审计仅 GET；3001 的写入来自并行 UI 复验（见 §1.1） | 审计命令记录 | **PASS（本审计）** |
| F08 | 仓库无残留 | 无临时 config/token/state | 仓库根无 `.linkhub-config.json`、`.linkhub-mail-accounts.json`、`.feishu-user-token.json`；3189 临时目录已删；git status 无本审计新增业务改动 | `Get-ChildItem` + `git status` | **PASS** |

---

## 4. 仍失败项（P0 / P1 / P2）

### P0（阻断首次使用 / 假成功红线）：**0 项**

linked+mock 不得 ready 的 P0-2 红线已实测通过（飞书 live 构造 + 钉钉单测）；白号不再进入 Mock 死胡同。

### P1-1　GET `/api/app-config.restartRequired` 与「身份热应用无需重启」矛盾

- **现象**：
  - 16:28:29 `PUT /api/app-config {"identity":{"dingtalk":"user"}}` → 200 `hotApplied:true, restartRequired:false`；
  - 紧接着同进程 `GET /api/app-config` → `identity.dingtalk={source:"local",value:"user"}`，但 `restartRequired:true`。
- **原因**：PUT 的 `restartRequired` 只看 `staticKeys`（非 `identity.*`）；GET 的 `restartRequired` 只看 `settingsFile.mtime > processStartedAtMs`，不区分「仅 identity 热应用」。
- **前端影响**：`ConnectPage.load()`（`ConnectPage.tsx:124-125`）只要 `config.restartRequired` 就 `setShowRestart(true)`；`enablePersonalOnly`（`214-230`）保存后又会 `load(true)`；`AppConfigModal.recheck()`（`221-235`）也据此判断。于是用户点「仅用本人身份」后，会同时看到「热应用，无需重启」和「需要重启」两块矛盾提示。
- **现场复现（3001）**：16:30:50 的非本审计写入把 `identity.dingtalk=user` 写入 3001 后，3001 `GET /api/app-config` 同样返回 `restartRequired:true`，而 identity 已是 local/user（16:37 复核仍为 true）。
- **建议**：GET 的 `restartRequired` 应排除已热应用的 `identity.*`（或返回 `pendingExitKeys` / `savedAt` + 逐键生效状态）；前端不要仅凭 settings mtime 弹重启。
- **级别**：P1（不阻断功能，但直接违反 `docs/quickstart.md:211` 的「热应用立即生效，不用重启」承诺，并会诱导用户做无意义重启）。

### P1-2　前端忽略 `hotApplied` / `saved` / `ignoredByEnv`，`.env` 锁定时会静默假成功

- **后端事实**（`routes/appConfig.test.ts:192-211` 通过）：当 `DINGTALK_IDENTITY` 在 `.env` 显式设置时，`PUT identity.dingtalk=user` 返回 `ignoredByEnv:["DINGTALK_IDENTITY"]`、`hotApplied:false`、`restartRequired:false`；运行中 `config.identity.dingtalk.policy` 仍是旧值（热应用不覆盖 env）。
- **前端问题**：
  - `ConnectPage.enablePersonalOnly()`（`214-230`）只判断 `result.restartRequired`，不判断 `hotApplied`；只要 false 就 toast「已切换…（热应用，无需重启）」并继续拉起登录。
  - `ConnectPage.runApiAction()` 通用分支（`375-386`）同样只判断 `restartRequired`，false 就 toast「已保存并立即生效」；不展示 `ignoredByEnv`/`warnings`，也不看 `saved`。
  - `AppConfigModal.save()`（`199-211`）在 `restartRequired:false` 时 `setApplied(true)`；`hotApplied:false` 时只说「已保存并生效」；`saved:false` 时也不改变这个结论（只显示一条 ignoredByEnv Alert）。
- **后果**：用户如果曾按旧文档在 `.env` 写死 `DINGTALK_IDENTITY`，点「仅用本人身份」会看到成功提示、但实际身份策略没变；随后登录可能仍按旧策略工作，属于本项目反复强调的「静默假成功」。
- **建议**：以 `saved && (hotApplied || !restartRequired)` 作为成功条件；`ignoredByEnv.length>0` 必须显式提示「这些键被 .env 锁定，本次未生效」；`saved:false` 不得提示已保存/已生效。
- **级别**：P1（条件触发，但违反“不假称已连接/已生效”的核心原则）。

### P2-1　白号邮箱 hint 说「显式 MAIL_MODE=mock」，实际不是显式

- 3001 白号（写入前）onboarding mail hint：
  > 「当前邮箱通道为模拟模式（显式 MAIL_MODE=mock）：添加并验证账号后，去掉 .env 的 MAIL_MODE=mock 并重启即可真实收信。」
- 实际：`GET /api/app-config` 的 `modes.mail.source="none"`、`configured:false`；mock 是 `auto` 因无账号/无凭据回退，不是显式 `MAIL_MODE=mock`。
- 同时「去掉 .env 并重启」与本次修复的「本地导入账号 → 热重算 runtime → 无需重启」流程矛盾（`services/mailAccounts.ts:371-388` 的 P0-3 重算）。
- **影响**：直接调用 API/其他客户端的用户会得到错误操作指引；前端 `ConnectPage.customerHint` 会把含 `MAIL_MODE/.env` 的 hint 替换成客户版，因此 UI 可能看不到原文，但契约本身仍不诚实。
- **建议**：区分「无账号 → auto 回退 mock」「显式 MAIL_MODE=mock」「已验证但 MAIL_ENABLED=false」三种文案；白号文案改为「添加并验证账号后自动启用，无需改 .env/重启」。
- **级别**：P2（文案/指引错误，UI 有一定缓解）。

### P2-2　邮箱「一键启用真实邮箱」写的是静态 `modes.mail=real`，与「无需重启」文案冲突

- `onboarding.ts:256-278`（已验证账号 + mode mock）下发：
  - `id:"mail-enable-real"`、`path:"/api/app-config"`、`payload:{modes:{mail:"real"}}`；
  - hint：「启用真实邮箱后无需重启，验证过的账号下一轮就会开始收信。」
- 后端 `appConfig.ts:137-146`：`modes.*` 属于 `staticKeys` → `restartRequired:true`；`modes` 不在 `hotApplyIdentity` 里。
- 若 `MAIL_MODE` 是 `.env` 显式设置，PUT 还会被 `ignoredByEnv` 忽略（`applyConfigPatch` 对 mode 直接跳过），该“一键启用”动作根本不能生效。
- **影响**：已验证邮箱用户点按钮后会被告知「需要重启」（与卡片 hint 矛盾）；显式 env 场景则会保存失败/无效。
- **建议**：要么把 `modes.mail=real` 做成可热应用（并重算 runtime），要么把 hint 改成「保存后需重启」；显式 env 场景不要下发该动作，直接提示改 `.env`/重启。
- **级别**：P2（条件触发，但会误导已走到邮箱验证的用户）。

### P2-3　飞书 linked+mock 的 summary 归因错误

- 3189 构造：飞书凭据已配置、`modes.feishu=mock`、合成 token 使 `linked=true`；onboarding feishu 状态正确为 `needs_admin`（不 ready），但 summary 是：
  > 「已授权飞书本人身份，但飞书通道仍是模拟模式：填入应用凭据并重启后才会真实收发。」
- 实际此时凭据已配置，缺的是「把运行模式从 mock 切到 real」（去掉 `FEISHU_MODE=mock`/重启）。用户按 summary 去填凭据不会有帮助。
- **建议**：`onboarding.ts:500-515` 分支按 `runtime.configured`/`runtime.policy` 区分「缺凭据」与「显式 mock」两种原因；后者提示修改 `FEISHU_MODE` 或 `.env` 后重启。
- **级别**：P2（状态判定正确，但修复指引错误）。

---

## 5. 与前端契约不一致清单（共 8 项）

> 计数口径：影响「后端 action/字段 ↔ 前端处理」或「同一字段前后端校验/展示」的差异；不含纯文档排版问题。

| # | 契约点 | 后端 | 前端 | 影响 | 级别 |
|---|---|---|---|---|---|
| 1 | `restartRequired` 语义 | PUT identity-only=false；GET 因 settings mtime=true | `ConnectPage.tsx:124-125` 只看 GET 值就 `setShowRestart(true)` | 热应用后出现假「需重启」 | **P1** |
| 2 | `hotApplied`/`saved` | 环境锁定 identity 时 `hotApplied:false`、`ignoredByEnv`；全被 env 锁定时 `saved:false` | `ConnectPage.tsx:214-230/375-386`、`AppConfigModal.tsx:199-211` 只看 `restartRequired`，不读 `hotApplied/saved/ignoredByEnv` | 未生效也提示成功（静默假成功） | **P1** |
| 3 | 邮箱一键启用 vs 重启 | `modes.mail=real` 是静态键 → `restartRequired:true` | onboarding hint 写「无需重启」；`ConnectPage.enableMailReal` 会按后端提示重启 | 文案与行为矛盾 | **P2** |
| 4 | 白号邮箱 mock 文案 | 实际 `modes.mail.source=none`（auto 回退） | hint 写「显式 MAIL_MODE=mock」「改 .env + 重启」 | 指引错误；前端 `customerHint` 已部分遮盖 | **P2** |
| 5 | 飞书 linked+mock 归因 | 凭据已配置、policy=mock | summary 让用户「填入应用凭据」 | 修复方向错误 | **P2** |
| 6 | 字段长度/环境键提示 | `robotCode` max 128、`provider` max 64、`verifyToken` max 512；LLM Key env=`LLM_API_KEY` | `appConfigFields.ts:157-162`：robotCode 256、provider 128、verifyToken 256；LLM `apiKey` 的 envKey 标成 `OPENAI_API_KEY`（第 112 行） | 前端可能提前拦截合法值/放过后端 400；envKey 提示误导 | **P3** |
| 7 | 文件路径暴露 | health 只给 basename；onboarding/app-config/mail 仍给绝对路径（`envFile.path`、`settingsFile.path`、`filePath`） | 前端只显示/使用，未必展示 | 认证接口信息暴露更多本机路径，与 health 的 P2-10 修复不一致 | **P3** |
| 8 | 轻微 Schema/展示差异 | `verifiedAt` 仅 verified 时下发；`settingsFile.mtime` 可为 null；`stream` 字段后端支持 | `httpApi.ts:482-488` 的 `normalizeFileInfo` 要求 mtime 为 string，null 时整个 settingsFile 被丢弃；`AppConfigModal` 无 `stream` 开关；`MailAccountView.verifiedAt` optional | 不影响主流程；严格契约下字段缺失 | **P3** |

**补充说明（不计入 8 项）**：
- `GET /api/mail/accounts/test` 的顶层 `ok:true` + `data.ok:false` 是前端 `normalizeMailTestResult` 明确支持的既有契约（`httpApi.ts:174-183`），不算不一致；若外部按“顶层 ok:false”理解，需要看 `data`。
- `feishu-admin` HEAD 404 / GET 200 是历史 P2-11，已知；GET 可达即算通过。
- 钉钉管理员清单里的登录命令含本机绝对路径 `...\tools\dws.exe auth login`；脚本明确写「在本机终端执行」，同机可用；若把清单转给另一台机器的管理员会失效（P3 可移植性，未单列）。

---

## 6. 3189 临时实例验证记录

### 6.1 启动/停止

| 时间（UTC+8，约） | 操作 | 结果 |
|---|---|---|
| 16:27:50 | 创建 `C:\Users\zx\AppData\Local\Temp\linkhub-audit-round2-3189` | 空目录 |
| 16:27:56 | 以 `SERVER_PORT=3189 API_TOKEN=test-token DATA_DIR=<temp>` 启动 `pnpm --filter @unimsg/server start` | 监听 0.0.0.0:3189；健康 200；白号 4 平台 mock |
| 16:28:24 | 基线 GET（onboarding/app-config/health/mail） | 见 §2.2 |
| 16:28:29 | PUT `identity.dingtalk=user` | hotApplied true / restartRequired false；GET 立刻显示 restartRequired true（P1-1） |
| 16:28:3x | 杀掉 3189 监听进程并重启 | identity 持久化为 local/user；restartRequired false |
| 16:29:05 | PUT `platforms.feishu.appId/appSecret`（obviously-fake） | restartRequired true；GET 掩码无明文 |
| 16:29:23 | 重启 | 凭据生效（source local/configured），health modes.feishu=real；无 secret 泄漏 |
| 16:30:18 | PUT null 清除 feishu appId/appSecret | 文件清空；同进程 GET 仍显示 old effective（备注 B08）；重启后 source none |
| 16:30:36 | 重启 | feishu 回 mock；compose 可用 |
| 16:30:44 | PUT feishu fake 凭据 + `modes.feishu=mock`；写合成 `feishu-user-token.json` | 为 linked+mock 构造 |
| 16:30:51 | 重启 | `/api/accounts` feishu `linked=true,effectiveSend=mock`；onboarding feishu `needs_admin`；overall 0/4/4 |
| 16:31–16:32 | 安全检查 + 三份管理员清单文本 + 链接 GET | 无 token/secret；清单均含写回+重启 |
| 16:32 | 以 `LLM_MODEL=env-audit-model` 重启 | GET source env；PUT 被 ignoredByEnv（saved:false） |
| 16:33 | 停止监听进程；删除临时 DATA_DIR | 端口 3189 无监听；`Test-Path` false；无匹配 node 残留进程 |
| 16:34 | `git status` 检查 | 无本审计新增业务文件；临时证据 JSON 已删除 |

### 6.2 linked+mock 构造方法（可复现，未真实登录）

1. 通过 3189 的 `PUT /api/app-config` 写入 obviously-fake 凭据：`platforms.feishu.appId="cli_test_fake_123"`、`appSecret="fake_secret_ABC9"`，并写 `modes.feishu="mock"`。
2. 在临时 `DATA_DIR` 写 `feishu-user-token.json`：
   ```json
   {
     "appId": "cli_test_fake_123",
     "accessToken": "fake-access-token-xyz",
     "refreshToken": "fake-refresh-token-xyz",
     "tokenType": "Bearer",
     "scope": "im:message",
     "accessExpiresAt": <未来 1 小时，ms>,
     "refreshExpiresAt": <未来 24 小时，ms>,
     "authorizedAt": "<当前 ISO>"
   }
   ```
   该文件只用于让 `feishuUserIdentity()` 读到 `state=active/linked`；**没有发起任何 OAuth 或真实登录**。
3. 重启 3189 后：
   - `/api/accounts` → `mode:"mock", configured:true, identity.user.state:"linked", linked:true, effectiveSend:"mock", effectiveReceive:"mock"`；
   - `/api/health` → `modes.feishu:"mock"`, `identities.feishu:{send:"mock",receive:"mock"}`；
   - `/api/onboarding` → `feishu.state:"needs_admin"`（**不是 ready**），overall 仍 `0/4/4`；
   - onboarding/accounts 响应均不含 `fake-access-token-xyz`。
4. 测后删除整个临时目录，合成 token 不留在仓库。

### 6.3 清理确认

- 端口 3189：`Get-NetTCPConnection -LocalPort 3189` 无结果。
- 进程：无命令行匹配 `linkhub-audit-round2-3189` 的 node 进程。
- 临时目录：`Test-Path C:\Users\zx\AppData\Local\Temp\linkhub-audit-round2-3189` → **False**。
- 仓库：无 `.linkhub-config.json` / `.linkhub-mail-accounts.json` / `.feishu-user-token.json` 残留。

---

## 7. 结论：修复是否真实可用？

**核心修复真实，白号首用主链路可用，但「无需重启」的承诺尚未完全自洽。**

### 7.1 已真实修好的部分

- 白号 onboarding 不再把客户送进 Mock 死胡同：4 个平台分别给出 `needs_user_auth` / `needs_admin`，并下发可执行的登录、填凭据、管理员清单、doctor 命令。
- `/api/app-config` 真的能保存凭据、脱敏展示、重启后生效；`identity.dingtalk=user` 真的热应用；`source=none/env/local`、`missing`、`null` 清除、400 中文校验均可用。
- 邮箱账号导入/测试/验证/删除、未验证警告、Mock `compose` 无会话发送、linked+mock 不 ready 的 P0-2 红线均通过。
- 454 个后端测试全过；主实例只读 GET 正常；onboarding 不泄 token/secret。

### 7.2 仍需修（按优先级）

1. **P1-1**：修 GET `restartRequired`（identity-only 热应用后不得为 true），或前端不要只凭它弹重启。
2. **P1-2**：前端按 `saved/hotApplied/ignoredByEnv` 判断成功；`.env` 锁定时必须明确提示“未生效”，不得 toast 成功。
3. **P2-1**：白号邮箱 hint 去掉“显式 MAIL_MODE=mock / 改 .env 重启”，改成“添加并验证后自动启用”。
4. **P2-2**：统一 `mail-enable-real` 的文案与重启语义（要么热应用 modes.mail，要么明说需重启；显式 env 时不下发）。
5. **P2-3**：飞书 linked+mock 的 summary 按 `runtime.configured/policy` 区分“缺凭据”和“显式 mock”。
6. **P3**：字段 maxLength/envKey 对齐、认证接口绝对路径收敛、`verifiedAt`/settingsFile/stream 的 Schema 说明。

### 7.3 建议的验收口径（下一轮）

- 用 3189 重跑本文 §3 表格；重点断言：
  - `PUT identity.dingtalk=user` 后同一进程 `GET restartRequired === false`；
  - `.env` 设置 `DINGTALK_IDENTITY=bot` 时，前端/接口不得提示“已切换成功”；
  - `mail-enable-real` 的 hint 与 PUT 返回的 `restartRequired` 一致；
  - 白号 onboarding 的 mail hint 不含“显式 MAIL_MODE=mock”。

---

## 8. 附录：关键证据位置

| 证据 | 位置 |
|---|---|
| onboarding 状态机/动作 | `packages/server/src/services/onboarding.ts:118-182, 303-363, 500-515, 588-593, 678-680` |
| app-config 热应用/重启判定 | `packages/server/src/routes/appConfig.ts:33-68, 135-146` |
| GET `restartRequired` 判定 | `packages/server/src/services/localConfig.ts:450` |
| 字段校验/脱敏/source | `packages/server/src/services/localConfig.ts:348-368, 527-581` |
| health basename | `packages/server/src/routes/health.ts:20-30` |
| 邮箱字段/验证/删除 | `packages/server/src/services/mailAccounts.ts:228-247, 299-317`；`routes/mailAccounts.ts:85-104, 164-207, 209-228` |
| Mock 无会话发送 | `packages/server/src/services/message.ts:317-336`；`routes/messages.ts:97-113` |
| 前端 action 分发 | `packages/web/src/features/connect/ConnectPage.tsx:124-125, 214-230, 349-398, 560-598` |
| 前端保存结果处理 | `packages/web/src/features/connect/AppConfigModal.tsx:199-235` |
| 前端字段定义/上限 | `packages/web/src/features/connect/appConfigFields.ts:38-114, 157-162` |
| AppConfig 归一化 | `packages/web/src/services/httpApi.ts:436-469, 500-588` |
| 单测断言 | `packages/server/src/services/onboarding.test.ts:132-166, 210-246`；`packages/server/src/routes/appConfig.test.ts:131-211`；`packages/server/src/services/compose.test.ts` |
| 回归结果 | `pnpm --filter @unimsg/server test` → 454 pass / 0 fail（本次审计 16:27 运行） |

---

**审计结论一句话**：白号修复不是“纸面修复”。onboarding、凭据配置、邮箱导入、Mock 新建发送、linked+mock 不 ready 都已真实跑通；但「身份热应用无需重启」在 GET/前端仍有 P1 级自相矛盾，`.env` 锁定时前端还有静默假成功，需在下一轮修掉后才能把“无需重启”作为对外承诺。