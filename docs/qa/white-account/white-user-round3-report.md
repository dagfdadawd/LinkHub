# LinkHub 个人版「白号」第三轮重点复验报告

- **测试时间**：2026-11-12 17:14–17:45（UTC+8）
- **测试身份**：第一次拿到 LinkHub 个人版的普通客户（非开发者）
- **被测代码**：当前工作区最终代码，HEAD `5556388`（含「展开明细区分管理员/可自助」修复）；17:36 后无源码变更
- **证据**：[screenshots-round3/iso/](screenshots-round3/iso/)（26 张 PNG + 同目录 `.txt`/`.json` 原始数据）；早期 3001 干净基线见 [screenshots-round3/](screenshots-round3/)
- **浏览器**：Chrome Headless 156 + CDP，1440×900，全新临时 profile
- **约束**：未登录真实账号、未扫码/未完成授权、未用真实邮箱授权码；未保存飞书/企微/钉钉凭据；未改代码/配置/`.env`；未 commit；未动 3001/5173。钉钉弹窗只观察后关闭，结束时已 `logout`（`authenticated:false`、`loginInProgress:false`）。

> **环境说明（必须说明的偏差）**：Lead 初始提供的干净白号环境（3001/5173，0/4、全 Mock）在复验开始约 2 分钟后被**外部并行任务重启**：17:19:12 起 3001 变为 real 模式（`modes` 全 real、`envFile` 指回仓库 `.env`、原临时 DATA_DIR 被删除）。为不触碰 3001/5173，本轮完整复验在**同一份最终代码的隔离等价环境**完成：
> - 后端 `http://127.0.0.1:3003`：源码沙箱（无 `.env`）+ 全新 `DATA_DIR` + `dev-token`，四平台 Mock、0 消息、0 邮箱账号、dws 未登录；
> - 前端 `http://127.0.0.1:5174`：Vite dev，`VITE_API_BASE=3003`，同一工作区代码（17:32 快照，17:36 同步最新 `FirstRunGuide` 修复）。
>
> 17:14–17:16 曾在 3001/5173 抓到干净基线（[inbox.png](screenshots-round3/inbox.png)、[connect.png](screenshots-round3/connect.png)、[accounts.png](screenshots-round3/accounts.png)），页面表现与隔离环境一致。3002 是另一个并行验收实例，本轮未触碰。**若把 3001 恢复为干净白号，可用同一流程 5 分钟内复跑。**

---

## 结论速览

| # | 重点检查项 | 结论 |
|---|---|---|
| 1 | 钉钉取消登录不再破坏状态 | **已修复** |
| 2 | 热应用/本地配置不再误判重启、`.env` 告警不乱出现 | **已修复** |
| 3 | 首屏管理员数量一致 + 演示/新建发送 | **已修复** |

**本轮无 P0/P1**；发现 5 条 P2（见第三节）。

---

## 一、三条重点逐条复验

### 1）钉钉取消登录不再破坏状态 —— **已修复**

操作：干净 `/connect`（0/4）→ 点「用钉钉本人账号登录（推荐，无需机器人应用）」→ 授权弹窗出现（含真实 `https://login.dingtalk.com/oauth2/auth?...` 链接、「打开授权页」）→ **不授权，直接点「关闭」**。

| 检查点 | 实测结果 |
|---|---|
| 关闭后是否有假重启提示 | **无**「已保存，需要重启 LinkHub 生效」；可见文本**无** `pnpm` 命令；见 [w3-10](screenshots-round3/iso/w3-10-connect-after-dingtalk-close.png) |
| 钉钉卡状态 | 仍为「**需本人授权**」；**保留**「填写钉钉应用凭据（可选，用机器人时）」和登录按钮（同图） |
| 刷新后 | 仍无重启提示；凭据入口仍在；见 [w3-11](screenshots-round3/iso/w3-11-connect-after-cancel-reload.png) |
| `GET /api/app-config`（关闭后） | `identity.dingtalk.source=none`、`configured=false`；`restartRequired=false`；`settingsFile.present=false` |
| 打开弹窗时 | `source` 仍为 `none` → 确认「点登录先预写 user」已不存在 |
| `GET /api/onboarding` | 钉钉 `state=needs_user_auth`；actions 含 `dingtalk-login`、`dingtalk-configure` |
| `POST /api/dingtalk/personal/logout` | `authenticated:false`、`loginInProgress:false`、`state=not_linked`；`identity` 仍 `none` |

原始数据：[w3-run-evidence.json](screenshots-round3/iso/w3-run-evidence.json)（`apiBefore/apiAfter/onboardingAfter/statusAfter/statusAfterLogout`）、[w3-09 弹窗](screenshots-round3/iso/w3-09-dingtalk-login-modal.png)。

- **异常（P2，不影响状态）**：关闭弹窗后后端 `loginInProgress` 仍为 `true`（CLI 登录尝试约 10 分钟内仍待授权），页面没有「取消登录」入口；本次用 `logout` 清掉。

### 2）热应用/本地配置不再误判重启、`.env` 告警不再乱出现 —— **已修复**

干净白号、未做任何保存，打开 `/connect`、`/accounts`：

- 两页 **`.ant-alert` 数量均为 0**（精确 DOM 扫描：[w3-alert-scan.json](screenshots-round3/iso/w3-alert-scan.json)），没有「已保存，需要重启」「`.env` 已修改」；
- `/connect` 无 `pnpm`、无重启 banner，`已就绪 0 / 4 · 4 项待处理`（[w3-05](screenshots-round3/iso/w3-05-connect-clean.png)、[w3-25 final](screenshots-round3/iso/w3-25-connect-final.png)）；
- `/accounts` 无 `.env 已修改`，四张卡为「未配置（演示模式）」并给可点入口（[w3-06](screenshots-round3/iso/w3-06-accounts-clean.png)、[w3-26 final](screenshots-round3/iso/w3-26-accounts-final.png)）；
- 完成「点钉钉登录 → 关闭 → 刷新」后仍无重启提示；`restartRequired` 始终 `false`，没有生成 `linkhub-config.json`。

**残留（P2）**：页面仍有静态技术文案「改完 .env 需要重启后端」及「填写应用凭据并重启后端」；不是“取消登录却要求重启”的假状态，但 `.env` 仍在客户视图。

### 3）首屏管理员数量一致 + 演示/新建发送 —— **已修复**

- **横幅**：「其中 **2 项需管理员开通、2 项可自己登录/添加**。」
- **「3 步上手」折叠摘要**：「需要管理员配置（**2 个平台**）· 另有 **2 项**可自己登录/添加」——与横幅一致（[w3-01](screenshots-round3/iso/w3-01-inbox-first-run.png)）。
- **展开明细**：只列飞书、企业微信为管理员项；钉钉、邮箱单列为「可以自己添加/登录」的自助项（[w3-02](screenshots-round3/iso/w3-02-inbox-admin-expanded.png)、`guideAdminExpanded` 见 [w3-run-evidence.json](screenshots-round3/iso/w3-run-evidence.json)）。
- **「稍后再说」**：点击后横幅立即消失，`localStorage['linkhub.onboarded']='1'`；刷新后不再出现（[w3-03](screenshots-round3/iso/w3-03-banner-after-dismiss.png)、[w3-04](screenshots-round3/iso/w3-04-banner-after-reload.png)）。
- **「先体验演示」**：toast「已注入一条飞书消息」，列表出现示例消息（[w3-19](screenshots-round3/iso/w3-19-demo-injected.png)）。
- **新建发送（Mock、不填 conversationId）**：弹窗写明「演示模式：留空即可，会生成一条本地模拟发送记录」；发送成功，toast「**已模拟发送（不会真的发到平台）**…可在『全链路回放』查看状态回流」（[w3-20](screenshots-round3/iso/w3-20-compose-dialog.png)、[w3-21](screenshots-round3/iso/w3-21-compose-sent.png)）。

> **历史说明**：17:35 的并行 3002 报告（已在 `5556388` 中提交）发现「展开明细仍列 4 个平台需管理员」；本轮基于 `5556388` 的修复重跑，展开明细已正确，该 P1 已关闭。

---

## 二、快速回归

- **邮箱**：`/connect → 添加邮箱账号` 表单正常；用 obviously-fake 数据（`white.r3.fake@example.invalid` / `fake-auth-code-1234`）点「测试连接」，提示「连接测试失败 / 请检查邮箱地址、授权码（不是登录密码）与服务商 IMAP 设置」，原始错误收进「技术详情（给管理员看）」折叠（[w3-14](screenshots-round3/iso/w3-14-email-test-failure.png)）。
- **未验证保存**：二次确认「仍然保存」→ 卡片显示「已保存 1 个邮箱账号，但还没有验证通过」「未验证」「未验证的账号不会真实收信，也不算『已就绪』」，顶部仍 `0/4 · 4 项待处理`，toast「已保存为未验证账号」（[w3-23](screenshots-round3/iso/w3-23-email-saved-unverified-top.png)）。
- **删除**：确认后 toast「已删除本地邮箱账号」，回到无账号、`0/4`（[w3-24](screenshots-round3/iso/w3-24-email-deleted-top.png)），API 邮箱 `accounts:[]`。
- **设置 → 关于**：`本地后端：服务已连接`、`账号：0/4 已就绪（不代表已连真实平台）`（[w3-07](screenshots-round3/iso/w3-07-settings-about.png)）。
- **控制台错误**：跨 `/inbox`、`/connect`、`/accounts`、设置、新建发送、邮箱全流程 **0 条**（[w3-run-evidence.json](screenshots-round3/iso/w3-run-evidence.json)）。
- 未实测：真实邮箱授权码成功路径、钉钉/飞书真实授权成功后的收发（受“不登录真实账号、不保存凭据”约束）。

---

## 三、其他发现（只列本次实际观察到）

**P0**：无。**P1**：无。

| 级别 | 问题 | 证据 |
|---|---|---|
| P2-1 | 收件箱计数与列表不一致：Mock「新建发送」成功后 `全部 2 / 未读 1 / 已读 0`，列表只显示 1 条；自己发的模拟消息计入总数但两组都不显示 | [w3-21](screenshots-round3/iso/w3-21-compose-sent.png)、[w3-22](screenshots-round3/iso/w3-22-inbox-after-send.png) |
| P2-2 | `.env` 替换为「部署配置」后文案不通顺且不统一：如「无需改 **部署配置**、无需重启」「身份策略已被 **部署配置** 固定」，同页仍有「或写 **.env**」「改完 **.env** 需要重启后端」 | [w3-25 txt](screenshots-round3/iso/w3-25-connect-final.txt)、[w3-09](screenshots-round3/iso/w3-09-dingtalk-login-modal.png) |
| P2-3 | 邮箱测试失败 Alert 仍带「如果是 .env 里的旧账号，请修改 .env 后重启后端」；表单底部「保存后立即生效」与“未验证不生效”冲突 | [w3-14](screenshots-round3/iso/w3-14-email-test-failure.png) |
| P2-4 | 关闭钉钉登录弹窗后 `loginInProgress:true` 仍在后台等待，无取消/提示 | [w3-run-evidence.json](screenshots-round3/iso/w3-run-evidence.json) |
| P2-5 | 钉钉登录弹窗向客户暴露本机终端命令全文（`C:\Users\...\dws.exe auth login`） | [w3-09](screenshots-round3/iso/w3-09-dingtalk-login-modal.png) |

---

## 四、结论

**可以**：现在不登录真实账号也能顺畅走完「注入演示 → 回复/模拟发送 → 全链路回放」；钉钉有清晰可走的本人登录入口，取消/关闭不再破坏状态、不再要求重启；邮箱有可理解、可回退的自助路径；飞书/企微仍是企业管理员路径。三条重点 P1 均已修复，本轮无 P0/P1。