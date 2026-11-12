# LinkHub 个人版白号第三轮重点复验报告

- **对象**：`http://127.0.0.1:3002`（隔离白号实例；四平台 Mock、0 消息、0 邮箱账号、dws 未登录、无 LLM key、临时 DATA_DIR）
- **时间**：2026-11-12 17:23–17:33
- **方式**：普通客户视角 + 单个 headless Chrome（CDP 9238）；未登录真实账号、未扫码、未完成授权、未保存任何飞书/企微/钉钉凭据；邮箱只用假数据并已删除；未改代码、未 commit。
- **环境说明**：启动前发现 9238 上有一个中断会话遗留的 headless Chrome（页面停在 5173），已关闭；本轮从 `about:blank` 重新启动，所有导航仅限 3002；结束后已关闭该 Chrome 并删除临时 profile，未动 3001/5173。目录中更早的 `r3-01~03` / `connect.png` 等截图是上次中断会话的遗留，未作为本轮证据。
- **证据**：本轮有效截图 22 张（`r3-30` ~ `r3-63`），均在 `screenshots-round3/`；API 证据见 `r3b-dingtalk-cancel-evidence.json`、`r3-api-baseline-*.json`、`r3-api-final-*.json`。

## 一、三条重点逐条结论

| # | 重点 | 结论 |
|---|---|---|
| 1 | 钉钉取消登录不再破坏状态 | **已修复** |
| 2 | 干净白号无假「需重启」/假 `.env` 告警 | **已修复** |
| 3 | 首屏管理员计数一致 | **部分修复（P1 残留：展开明细仍错）** |

### 1）钉钉取消登录 —— 已修复

操作：`/connect` → 点「用钉钉本人账号登录（推荐，无需机器人应用）」→ 授权弹窗出现后直接点「关闭」，未扫码、未完成授权。

| 检查点 | 实测 |
|---|---|
| 弹窗出现 | 是；有真实 `login.dingtalk.com` 授权链接、「打开授权页」「改用设备码登录」；见 [r3-41](screenshots-round3/r3-41-dingtalk-login-modal.png) |
| 关闭后页面 | **无**「已保存，需要重启 LinkHub 生效」、**无** `pnpm --filter` 命令、**无**「本人身份未登录/发送会显式失败」；见 [r3-42](screenshots-round3/r3-42-connect-after-dingtalk-cancel.png) |
| 钉钉卡状态 | 仍为「需本人授权」，且保留「填写钉钉应用凭据（可选，用机器人时）」入口 |
| 刷新后 | 仍无重启/`.env` 提示，凭据入口仍在；见 [r3-43](screenshots-round3/r3-43-connect-after-cancel-reload.png) |
| `GET /api/app-config`（取消后、logout 前） | `identity.dingtalk.source=none`、`configured=false`；`restartRequired=false`；`settingsFile.present=false` |
| 打开弹窗时（登录未授权） | `source` 仍为 `none`，确认没有「点登录先预写 user」 |
| `GET /api/onboarding` | 钉钉 `state=needs_user_auth`；actions 含 `dingtalk-login`，也含 `dingtalk-configure` |
| `POST /api/dingtalk/personal/logout` | 返回 `authenticated=false`；之后 `loginInProgress=false`、`state=not_linked` |

证据：`r3b-dingtalk-cancel-evidence.json`（含取消后、弹窗打开时、logout 后的 API 快照）。

> 注：为遵守约束，取消后调用了 logout 清理。logout 后出现了「自动启用回退」的落盘：`identity.dingtalk=auto`（最终 `source=local`，值仍是默认 `auto`，`restartRequired=false`，无 UI 提示）。这是清理动作的落盘，不是点击登录时预写入；取消后的验收值（logout 前）明确为 `source=none`。

### 2）干净白号无假「需重启」/假 `.env` 告警 —— 已修复

在未做任何保存的 `/connect`、`/accounts` 上：

- **动态 Alert / toast：0 个**（两页均无 `.ant-alert`、无 toast）。
- **无**「已保存，需要重启」。
- **无**「.env 已修改」。
- API：`restartRequired=false`；干净基线 `settingsFile.present=false`；`settingsFile` 未因打开页面/打开钉钉弹窗而生成。

页面仅保留**静态说明文案**（不是保存后的告警，属 P2 技术噪音）：

- `/connect` 页脚：「状态由本机后端实时探测；改完 .env 需要重启后端，平台状态才会更新。」
- 飞书卡：「还缺：FEISHU_APP_ID / FEISHU_APP_SECRET（填到 LinkHub 配置或 部署配置 后重启）」。
- 企微卡：「缺少变量：WECOM_CORP_ID / …；拿到凭据后在 LinkHub 填写或写 部署配置 并重启。」
- `/accounts` 飞书身份块：「可到『连接账号 → 平台应用配置』填写应用凭据并重启后端，再回来连接。」
- `/accounts` 各卡：「缺少环境变量：…」；钉钉「登录后…热应用、无需重启」。

证据：[connect 基线](screenshots-round3/r3-11-connect-baseline.png)、[accounts 基线](screenshots-round3/r3-12-accounts-baseline.png)、[取消后 connect](screenshots-round3/r3-42-connect-after-dingtalk-cancel.png)、[accounts clean](screenshots-round3/r3-44-accounts-clean.png)。

### 3）首屏管理员计数一致 —— 部分修复（P1 残留）

| 检查点 | 实测 |
|---|---|
| 顶部横幅 | 「其中 **2 项需管理员开通、2 项可自己登录/添加**。」✅ |
| 「3 步上手」折叠摘要 | 「需要管理员配置（**2 个平台**） · 另有 **2 项可自己登录/添加**」✅ |
| 是否出现「4 个平台都需要管理员」 | 折叠态没有 ✅；**展开后仍出现** ❌ |
| 展开明细 | 仍列 **飞书 / 钉钉 / 企业微信 / 邮箱 4 条**，每条都写「——需要企业管理员在平台后台开通」；见 [r3-31](screenshots-round3/r3-31-inbox-admin-expanded.png) |
| 「稍后再说」 | 横幅立即消失；`localStorage['linkhub.onboarded']='1'`；刷新、离开再回 `/inbox` 均不再出现；见 [r3-32](screenshots-round3/r3-32-inbox-after-dismiss.png)、[r3-33](screenshots-round3/r3-33-inbox-after-reload.png)、[r3-34](screenshots-round3/r3-34-inbox-after-reopen.png) |
| 「先体验演示」 | 用「3 步上手」里的「先体验演示（注入示例消息）」注入成功；toast「已注入一条飞书消息」，列表出现 1 条飞书消息，引导自动隐藏；见 [r3-35](screenshots-round3/r3-35-inbox-demo-injected.png) |

**判定**：用户最先看到的横幅与折叠摘要已按 2+2 统一口径修复；但展开明细仍用旧逻辑，把可自助的钉钉/邮箱也算成「需企业管理员」，等于「4 个平台都需要管理员」仍能看到，属于该 P1 的残留。

## 二、快速回归（主路径）

| 项 | 结果 | 证据 |
|---|---|---|
| 邮箱表单打开 | 正常；QQ 预设，地址/授权码/高级设置齐全 | [r3-50](screenshots-round3/r3-50-email-form.png) |
| 假数据测试失败提示 | 可理解：`连接测试失败` + 「请检查邮箱地址、授权码（不是登录密码）与服务商 IMAP 设置。」+ toast「邮箱连接测试失败，请检查授权码与服务器地址」；原始错误在「技术详情」折叠 | [r3-52](screenshots-round3/r3-52-email-test-failure.png) |
| 保存未验证账号 | 先二次确认「仍然保存」；保存后 toast 明确「已保存为未验证账号」；卡片显示「未验证」标签、「还有 1 个账号未验证」「未验证的账号…不算『已就绪』」，进度仍 `0 / 4`；API `verified:false`、`unverifiedCount:1` | [r3-53](screenshots-round3/r3-53-email-save-confirm.png)、[r3-54 图](screenshots-round3/r3-54-email-saved-unverified.png)、[r3-54 文本](screenshots-round3/r3-54-email-saved-unverified.txt) |
| 删除 | 确认后 toast「已删除本地邮箱账号」；`GET /api/mail/accounts` 回空，进度回 `0 / 4` | [r3-55](screenshots-round3/r3-55-email-delete-confirm.png)、[r3-56](screenshots-round3/r3-56-email-deleted.png) |
| 新建发送（Mock、会话留空） | 弹窗明确「演示模式：留空即可」；留空可发；toast「已模拟发送（不会真的发到平台）…可在「全链路回放」查看状态回流」 | [r3-60](screenshots-round3/r3-60-compose-dialog.png)、[r3-61](screenshots-round3/r3-61-compose-sent.png) |
| 设置 → 关于 | 「本地后端：服务已连接」「账号：0/4 已就绪（不代表已连真实平台）」 | [r3-63](screenshots-round3/r3-63-settings-about.png) |

> 邮箱真实收信/钉钉真实授权成功分支因「不登录真实账号/不完成授权」的约束未验证；本轮只验证表单、失败、未验证、取消、删除等可安全执行的分支。

## 三、其他实际观察到的问题

### P1（本轮唯一 P1，即第 3 条的残留）

1. **「3 步上手」展开明细仍把 4 个平台都写成需管理员**：摘要写「2 个平台」，展开却列出飞书、钉钉、企业微信、邮箱四条，均标注「需要企业管理员在平台后台开通」。这会直接劝退本可自助的邮箱/钉钉路径。证据：[r3-31](screenshots-round3/r3-31-inbox-admin-expanded.png)。

### P2

1. **收件箱计数与列表不一致**：Mock「新建发送」成功后 `全部 2 / 未读 1 / 已读 0`，但列表只显示 1 条（zhangsan 的来信）；自己发的模拟消息被「未读/已读」两组都排除（`isSelfComposedMock`），消息没有进入列表却计入总数。toast 虽指向「全链路回放」，客户仍会觉得消息丢了。证据：[r3-62](screenshots-round3/r3-62-inbox-after-compose.png)；API 中确实有 2 条消息（`r3-api-final-messages.json`）。
2. **邮箱测试失败仍带 `.env` 旧账号文案**：失败 Alert 里有「如果是 .env 里的旧账号，请修改 .env 后重启后端」。干净白号没有 `.env` 邮箱账号，这句是开发者噪音；在意的客户会以为要改配置。证据：[r3-52](screenshots-round3/r3-52-email-test-failure.png)。
3. **`/connect`、`/accounts` 仍有环境变量名/「重启」静态文案**：如「缺少环境变量：FEISHU_APP_ID…」「改完 .env 需要重启后端」「填写应用凭据并重启后端」。不是假告警，但对普通客户仍是技术噪音。
4. **logout 清理后生成了 `linkhub-config.json`**：本轮调用 logout 后文件写入 `identity.dingtalk=auto`，使 `settingsFile.present` 从 `false` 变 `true`（从落盘结果看是「自动启用回退」；值等价默认、热应用、无重启提示）。不影响本轮 3 条结论，但「干净白号」的 `source=none` 基线在清理后会显示为 `local/auto`。

**未发现新 P0。**

## 四、结论

演示体验和「邮箱」自助路径（打开表单 → 假数据失败提示 → 未验证保存 → 删除）已经能顺畅走通，钉钉「点登录后取消」也不再破坏状态；但首屏「需要管理员配置」展开后仍把 4 个平台都写成需管理员（P1），修掉这一处明细文案后，本轮 3 条才算真正全部关闭。