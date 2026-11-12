# LinkHub 个人版「白号」首次使用复验报告（第二轮）

- **测试时间**：2026-11-12 16:25–16:45（UTC+8）
- **测试身份**：第一次拿到 LinkHub 个人版的普通客户（非开发者，不知道 `.env`、OAuth、CLI、平台后台）
- **环境**：前端 `http://127.0.0.1:5173`（Vite dev，最新代码），后端 `http://127.0.0.1:3001`（Bearer `dev-token`）；四平台全部 Mock；初始 0 消息、0 邮箱账号、钉钉 `dws` 未登录、飞书未授权、无 LLM key；后端数据目录为全新临时目录（`C:\Users\zx\AppData\Local\Temp\linkhub-white-data`）
- **浏览器**：Chrome Headless 156 + CDP，视口 1440×900，全新临时 profile `%TEMP%\white-r2-chrome`
- **证据目录**：[screenshots-round2/](screenshots-round2/)（45 张 PNG；`ui-probe` 抓取的页面附同名 `.txt`）
- **约束遵守**：未登录任何真实账号、未扫码、未使用真实邮箱授权码；未保存任何飞书/企微/钉钉应用凭据；未修改代码/`.env`/备份；未 commit；未杀 3001/5173。邮箱只用 obviously-fake 数据，结束后已从页面删除；钉钉登录弹窗只观察，结束时已调用 `POST /api/dingtalk/personal/logout`。
- **测试数据**：注入 1 条飞书示例并完成模拟回复/标记完成；新建发送 1 条模拟消息；另外通过后端 webhook 注入 1 条钉钉示例用于验证「取消登录后的发送状态」。这些消息留在本机临时数据目录（无 UI 删除入口）。

> **一句话结论**：上一轮最刺眼的「首屏开发者命令」「四张卡没有连接入口」「进度 0/4 却待处理 0」已经实质性修好；纯演示 5 分钟能走通。但**钉钉「登录」按钮会在授权前预先把身份切到 `user`**，取消后留下假重启提示、错误的 `.env` 告警和发送失败；这是当前最需要修的 P1。邮箱/钉钉的真实成功分支受“不完成真实授权”的约束，只能用状态机与界面证据验证，不能宣称真实收发已经跑通。

---

## 一、基线：白号打开时到底是什么状态

开始时实测：

```json
{
  "firstRun": true,
  "overall": { "ready": 0, "total": 4, "needsAction": 4 },
  "states": "mail:needs_user_auth, dingtalk:needs_user_auth, feishu:needs_admin, wecom:needs_admin"
}
```

`/api/accounts` 四平台均 `configured:false`、`mode:mock`、`canReceive:false`、`canSend:false`；邮箱 0 账号，钉钉 `authenticated:false / state:not_linked`。这是干净的“零账号/零凭据”基线。

---

## 二、修复验证：上一轮 13 条 P0/P1 逐条对照

> 判定口径：**已修复** = 上一轮描述的阻断路径已不再出现，且客户能完成原目标动作；**部分修复** = 主路径改善但仍有残留/未完成端到端验证；**未修复** = 原问题仍可复现。
>
> 统计：**完全修复 8 条、部分修复 5 条、未修复 0 条**。另有 3 条本轮新发现的 P1（见第四节）。

### 2.1 P0

| 编号 | 上一轮问题 | 复验结果 | 证据与说明 |
| --- | --- | --- | --- |
| P0-1 | 首屏把 `python scripts/smoke.py`、`pnpm run doctor`、改 `.env`、docs 链接当新手引导 | **已修复** | 首屏可见文本中没有 `python`/`pnpm`/`.env`/docs 链接；开发者命令收进「开发者：命令行方式（可选）」折叠项；横幅与「3 步上手」都换成「去连接账号 / 先体验演示」。见 [inbox.png](screenshots-round2/inbox.png)、[02-banner-after-reload.png](screenshots-round2/02-banner-after-reload.png)。残留：折叠项标题仍出现“开发者”字样（P2，不影响主路径）。 |
| P0-2 | 首页/飞书清单指向不存在的「连接本人账号 / 连接飞书本人账号」按钮 | **部分修复** | 钉钉卡已出现「用钉钉本人账号登录（推荐，无需机器人应用）」（[21-dingtalk-card-before.png](screenshots-round2/21-dingtalk-card-before.png)）；首屏改成了「去连接账号」，不再无条件指向不存在的按钮。飞书 OAuth 按钮按凭据条件出现，受“不保存凭据”约束未能实地验证；管理员清单第 7 步仍写「点『连接飞书本人账号』」（[09-feishu-admin-checklist.png](screenshots-round2/09-feishu-admin-checklist.png)），需要填完凭据并重启后才可能出现。 |
| P0-3 | 钉钉卡只有复制 doctor 命令，没有任何登录入口 | **已修复（入口）** | 卡片主 CTA 可点，弹窗出现「用浏览器登录（推荐）」、真实钉钉授权链接、`打开授权页`、`改用设备码登录`，没有“必须机器人凭据/改 `.env`”的死路。见 [22-dingtalk-login-modal.png](screenshots-round2/22-dingtalk-login-modal.png)。但取消路径引入了新 P1-A。 |
| P0-4 | 飞书/企微没有 App 凭据输入界面，只能去后台+改 `.env` | **已修复** | 新增「平台应用配置」弹窗，飞书/钉钉/企微三组字段齐全，已有值为空；弹窗明确写「应用凭据需要重启 LinkHub 生效」。见 [06-appconfig-feishu.png](screenshots-round2/06-appconfig-feishu.png)、[07-appconfig-wecom.png](screenshots-round2/07-appconfig-wecom.png)、[43-feishu-card-credentials.png](screenshots-round2/43-feishu-card-credentials.png)、[44-wecom-card-credentials.png](screenshots-round2/44-wecom-card-credentials.png)。未保存任何凭据（避免污染后续复验）。 |
| P0-5 | 邮箱保存成功仍是 Mock，界面没有切真实模式入口；`auto` 对本地账号也不够 | **部分修复（状态机已改，真实收信未实测）** | 现在保存未验证账号会二次确认并明确标「未验证/不会真实收信/不算已就绪」，顶部保持 `0/4 · 4 项待处理`（[15](screenshots-round2/15-email-save-unverified-confirm.png)、[17](screenshots-round2/17-email-unverified-detail.png)）；代码层已按 `verifiedAt` 重算 `config.runtime[MAIL]`，验证通过后应自动变 real（静态核对 `mailAccounts.ts` 的 `recomputeRuntime`）。受“不使用真实授权码”约束，**没有现场验证“真实邮箱收信成功”**。 |

### 2.2 P1

| 编号 | 上一轮问题 | 复验结果 | 证据与说明 |
| --- | --- | --- | --- |
| P1-1 | 进度计数自相矛盾：0/4 却「待处理 0」 | **已修复** | 零账号为 `已就绪 0 / 4` + `还有 4 项待处理` + `已就绪 0 项 · 待处理 4 项`（[connect.png](screenshots-round2/connect.png)）；保存未验证邮箱后仍是 `0/4 · 4 项待处理`（[17](screenshots-round2/17-email-unverified-detail.png)）。前端另有 `max(needsAction, total-ready)` 兜底。 |
| P1-2 | 邮箱测试失败提示是开发者排障文本（原始协议错误、内部变量名） | **部分修复** | 现在默认只显示「连接测试失败 + 请检查邮箱地址、授权码（不是登录密码）与服务商 IMAP 设置」；原始错误收进「技术详情（给管理员看）」默认折叠。见 [14-email-test-failure.png](screenshots-round2/14-email-test-failure.png)。残留：可见提示仍有一句「如果是 .env 里的旧账号，请修改 .env 后重启后端」；技术详情里的原始错误仍可能出现 `.env` 变量名（P2）。 |
| P1-3 | 「新建发送」在 Mock 下不填 conversationId 报错 | **已修复** | 弹窗明确写「演示模式：留空即可，会生成一条本地模拟发送记录」；实测留空发送成功，toast 为「已模拟发送（不会真的发到平台）…可在『全链路回放』查看状态回流」。见 [31-compose-dialog.png](screenshots-round2/31-compose-dialog.png)、[32-compose-sent-no-conversation.png](screenshots-round2/32-compose-sent-no-conversation.png)。 |
| P1-4 | 平台账号页只有“去改 .env”，没有任何可点操作 | **已修复** | `/accounts` 顶部新增「平台应用配置」「打开『连接账号』向导」；钉钉卡有「连接本人账号」；飞书/企微卡明确指向「连接账号 → 平台应用配置」。见 [38-accounts-after.png](screenshots-round2/38-accounts-after.png)。 |
| P1-5 | 空收件箱里能产生消息的按钮在首屏之外 | **已修复** | 首屏横幅直接有「先体验演示」，「3 步上手」第 1 步也有「先体验演示（注入示例消息）」，不再需要向下滚。见 [inbox.png](screenshots-round2/inbox.png)。 |
| P1-6 | 首启横幅「稍后再说」点了没用，刷新后仍在 | **已修复** | 点击后横幅立即消失，`localStorage['linkhub.onboarded']='1'`；刷新、离开 `/connect` 再回 `/inbox` 都不再出现。见 [01-banner-after-dismiss.png](screenshots-round2/01-banner-after-dismiss.png)、[02-banner-after-reload.png](screenshots-round2/02-banner-after-reload.png)、[03-banner-after-reopen.png](screenshots-round2/03-banner-after-reopen.png)。 |
| P1-7 | “个人版只需连接你自己的账号”与三平台需管理员自相矛盾 | **部分修复** | 横幅已按实际状态改成「其中 2 个平台可能需要企业管理员开通配置」，连接页也区分「需管理员」；但首屏「3 步上手」的折叠摘要仍写「需要管理员配置（4 个平台）」，把可自助的邮箱/钉钉也算成管理员项（P1-C）。见 [inbox.png](screenshots-round2/inbox.png)。 |
| P1-8 | 零账号时页面仍显示“已连接”，容易被误解为账号已连 | **部分修复（主位置已改）** | 左下角改为「服务就绪」；顶栏是「实时连接」而非“已连接”。但设置 → 关于仍是「连接状态：已连接」，且 `/accounts` 的 `.env` 告警与“服务就绪”同时出现。见 [inbox.png](screenshots-round2/inbox.png)、[39-settings-about.png](screenshots-round2/39-settings-about.png)。 |

### 2.3 审计报告补充核对（不计入上面的 13 条）

- 审计 P0-2「钉钉 linked+mock 仍报 ready」：`onboarding.ts` 已新增 `linked && !real` 分支，注释与逻辑都明确“绝不 ready”；因未完成真实登录，本轮只做了代码/状态机核对，未实测登录成功分支。
- 审计 P0-3「邮箱运行态不随本地账号变化」：`mailAccounts.ts` 已新增 `recomputeRuntime()`，按 `verifiedAt` 重算 `config.runtime[MAIL]`，并在 `index.ts` 的 `onChange` 中启停/热加载轮询；未验证账号仍保持 mock（本轮实测一致），已验证账号的真实收信未实测。
- 审计 P1-3「飞书清单缺凭据写回+重启」：已修复，见 [09-feishu-admin-checklist.png](screenshots-round2/09-feishu-admin-checklist.png)。

---

## 三、逐项复验

### 3.1 首屏与首启

**通过项：**

- **客户语言 CTA**：首屏横幅是「首次使用：先连接你自己的账号」+「去连接账号 / 先体验演示 / 稍后再说」；「3 步上手」三步分别是「先体验演示」「去连接账号」「去『连接账号』查看状态」，没有再让客户敲命令。
- **开发者命令默认不可见**：可见文本中没有 `python scripts/smoke.py`、`pnpm run doctor`、改 `.env`、`docs/...`；只有点开「开发者：命令行方式（可选）」才出现。首屏这层阻断已解除。
- **「稍后再说」真的消失**：点击后当前页消失；刷新后不出现；离开再回来也不出现。`localStorage['linkhub.onboarded']='1'` 已现场读取。
- **空收件箱**：中间直接有「从上方『连接账号』开始连接，或点『先体验演示』注入一条示例消息」，不用滚动。
- **状态**：左下角为「服务就绪」，与零账号不冲突。

**仍存在的问题：**

- **同一首屏两个“管理员数量”**：横幅说「其中 2 个平台可能…」，3 步上手折叠摘要说「需要管理员配置（4 个平台）」，展开后还把邮箱、钉钉都写成“需企业管理员开通”。这会直接把客户从唯一可自助的邮箱/钉钉路径上吓走。证据：[inbox.png](screenshots-round2/inbox.png)（首屏原文）、[connect.png](screenshots-round2/connect.png)（连接页正确口径）。
- **「关于」仍写“已连接”**：零账号、0/4 时设置 → 关于仍是「连接状态：已连接」，没有说明这是“后端服务已连接”。这是上一轮 P1-8 的残留。证据：[39-settings-about.png](screenshots-round2/39-settings-about.png)。

「知道了」没有单独复测：注入第一条消息后「3 步上手」会自动隐藏，之后无法在同一条白号路径上再点「知道了」；这不是本轮重点，未计入结论。

### 3.2 `/connect` 连接账号页

**通过项：**

- **进度自洽**：`已就绪 0 / 4`、`还有 4 项待处理`、`已就绪 0 项 · 待处理 4 项`；保存未验证邮箱后仍是 0/4、4 项待处理。见 [connect.png](screenshots-round2/connect.png)、[17-email-unverified-detail.png](screenshots-round2/17-email-unverified-detail.png)。
- **四张卡都有可达动作**：
  - 邮箱：「添加邮箱账号」→ 表单出现；
  - 钉钉：「用钉钉本人账号登录（推荐，无需机器人应用）」→ 登录弹窗；「填写钉钉应用凭据（可选，用机器人时）」在初始状态可见；
  - 飞书：「填写飞书应用凭据（App ID / App Secret）」→ 定位到飞书分组的配置弹窗；「打开飞书开放平台（应用后台）」；
  - 企微：「填写企业微信凭据（Corp ID / Agent ID / Secret）」→ 定位到企微分组的配置弹窗；「打开企业微信管理后台」。
- **缺什么用人话显示**：卡片显示「还缺：飞书 App ID、飞书 App Secret、飞书 Verification Token」「还缺：钉钉 Client ID、…」等；配置弹窗再显示「还缺：…（填写并保存后补齐；应用凭据需要重启 LinkHub 生效）」。
- **应用凭据弹窗**：飞书 4 个字段、企微 5 个字段、钉钉 5 个字段齐全；当前全部为空；secret 为 password；没有保存任何值。见 [06](screenshots-round2/06-appconfig-feishu.png)、[07](screenshots-round2/07-appconfig-wecom.png)、[08](screenshots-round2/08-appconfig-dingtalk.png)、[43](screenshots-round2/43-feishu-card-credentials.png)、[44](screenshots-round2/44-wecom-card-credentials.png)。
- **管理员清单已补“凭据写回+重启”**：飞书第 6 步明确写“把凭据写回 LinkHub…或写入 .env 的 FEISHU_APP_ID/…，**重启后端**”；企微第 4 步同理。见 [09](screenshots-round2/09-feishu-admin-checklist.png)、[10](screenshots-round2/10-wecom-admin-checklist.png)。这解决了上一轮“清单只讲平台后台、不讲凭据怎么进来”的断点。

**仍存在的问题：**

- **卡片里仍混入内部变量名**：飞书/企微卡在人类可读的「还缺」下面，仍有一行 `还缺：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFY_TOKEN（填到 LinkHub 配置或 .env 后重启）`；页面底部也仍写「改完 .env 需要重启后端」。这是 P2 技术噪音，不是主阻断。
- **飞书“缺 Verification Token”口径不一致**：连接页卡说缺 Verification Token，配置弹窗的“还缺”只列 App ID/App Secret（Verify Token 标为可选）。客户会疑惑到底要不要填。见 [connect.txt](screenshots-round2/connect.txt) 与 [06](screenshots-round2/06-appconfig-feishu.png)。
- **清单里的 Markdown 没渲染**：飞书/企微清单原文出现字面量 `**重启后端**`（截图 [09](screenshots-round2/09-feishu-admin-checklist.png) 可见）。这是给管理员看的清单，属于专业度问题。
- **飞书清单第 7 步的按钮名**仍写「连接飞书本人账号」；该按钮按凭据条件出现，未填凭据时页面上看不到，容易再次出现“让我点一个不存在的按钮”的观感。因为未保存凭据，这一条未能走到实地验证。

### 3.3 邮箱：能填、能测、能保存为“未验证”，但真实成功未验证

**实测步骤与结果：**

1. `/connect` → 邮箱卡 →「添加邮箱账号」：表单出现，QQ 邮箱预设、邮箱地址、授权码、高级设置、测试连接、保存账号、取消齐全（[12-email-form.png](screenshots-round2/12-email-form.png)）。
2. 填 obviously-fake 数据：`white.r2.fake@example.invalid` / `fake-auth-code-1234`（[13-email-filled.png](screenshots-round2/13-email-filled.png)）。
3. 点「测试连接」：显示「连接测试失败」+「请检查邮箱地址、授权码（不是登录密码）与服务商 IMAP 设置」；toast「邮箱连接测试失败，请检查授权码与服务器地址」；原始错误收进「技术详情（给管理员看）」默认折叠（[14-email-test-failure.png](screenshots-round2/14-email-test-failure.png)）。**可理解性明显好于上一轮**，但还留有一句 `.env` 旧账号提示。
4. 点「保存账号」：弹出「还没有通过连接测试 → 保存后账号会标记为『未验证』…仍要保存吗？」（[15-email-save-unverified-confirm.png](screenshots-round2/15-email-save-unverified-confirm.png)）。确认「仍然保存」后：
   - 卡片摘要变成「已保存 1 个邮箱账号，但还没有验证通过：请点『测试连接』验证。」
   - 明确写「未验证的账号不会真实收信，也不算『已就绪』」「还有 1 个账号未验证」
   - 账号行有黄色「未验证」标签和「测试验证」按钮
   - 顶部仍是 `0/4 · 4 项待处理`
   （[17-email-unverified-detail.png](screenshots-round2/17-email-unverified-detail.png)）
5. 点「删除」→ 确认「删除这个邮箱账号？只删除 LinkHub 本地保存的账号；.env 里的配置不受影响。」→ toast「已删除本地邮箱账号」，邮箱卡回到“还没有邮箱账号”，进度仍是 0/4 · 4 项（[19](screenshots-round2/19-email-delete-confirm.png)、[20](screenshots-round2/20-email-deleted.png)）。删除后可恢复，符合预期。

**结论**：未验证账号**没有**被误显示为“已就绪”，计数也正确；这是本轮最扎实的修复之一。

**残留 P2**：保存成功的 toast 仍写「邮箱账号已保存并生效…建议点『测试连接』验证授权码，通过后才会标记『已验证』」——前半句“已保存并生效”与“未验证、不会真实收信”同时出现，客户会短暂误以为已经生效。建议改成「已保存为未验证账号」。

**未验证项**：没有真实邮箱授权码，所以“测试连接通过 → 保存为已验证 → 真实 IMAP 收信/SMTP 发信”没有端到端实测；只能确认到“失败提示/未验证保存/删除”这三段界面行为，以及后端在 `verifiedAt` 后重算运行画像的代码路径。

### 3.4 钉钉：登录入口有了，但“取消/关闭”会破坏状态

**通过项：**

- 点「用钉钉本人账号登录（推荐，无需机器人应用）」后，出现「连接钉钉本人账号」弹窗；自动发起浏览器登录，显示「已尝试在本机打开浏览器…」、可点击的真实 `https://login.dingtalk.com/oauth2/auth?...` 授权链接、「打开授权页」「我已登录，刷新状态」「改用设备码登录」「重新发起」；没有要求客户先填机器人应用凭据，也没有“去改 `.env`”作为唯一出路（[22-dingtalk-login-modal.png](screenshots-round2/22-dingtalk-login-modal.png)）。
- 未完成任何授权；按约束结束后调用 `POST /api/dingtalk/personal/logout`，返回 `authenticated:false`、`loginInProgress:false`，登录态已清理。

**仍存在的问题（新 P1-A）：点登录会先切 `identity=user`，取消后不回收**

复现：

1. 零账号 `/connect`，点「用钉钉本人账号登录（推荐，无需机器人应用）」；
2. 弹窗出现后**不完成授权，直接关闭**；
3. 回到 `/connect`：出现 `已保存，需要重启 LinkHub 生效` + `pnpm --filter @unimsg/server start` 命令（[23-connect-after-dingtalk-cancel.png](screenshots-round2/23-connect-after-dingtalk-cancel.png)）；
4. 钉钉卡变成：`DINGTALK_IDENTITY=user 但钉钉本人身份未登录：发送会显式失败；请到「平台账号」页点「连接本人账号」…也可终端执行 dws auth login`；同时原来的「填写钉钉应用凭据（可选，用机器人时）」按钮**消失**（[45-dingtalk-card-no-configure.png](screenshots-round2/45-dingtalk-card-no-configure.png)）；
5. 此时打开一条钉钉消息回复：界面底部仍标「本次回复 模拟发送 / 演示模式：模拟发送，不会真的发到平台」，但实际按 `user` 身份发送，最终消息变成「发送失败」并进入死信队列，原因写「钉钉本人身份发送缺少目标会话…」（[37-dingtalk-send-failed-detail.png](screenshots-round2/37-dingtalk-send-failed-detail.png)）。

API 侧证据：点击前 `settingsFile.present=false`；点击后 `GET /api/app-config` 返回 `identity.dingtalk.source=local / value=user / restartRequired:true`；`/api/accounts` 的钉钉 `policy` 变成 `user`，`effectiveSend=user`、`effectiveReceive=bot`，但未登录；`POST /api/dingtalk/personal/logout` 只清登录态，不会把 `identity` 回滚为 `auto`。

**客户视角**：我只是点开看看登录，没授权、关掉了；页面先告诉我“无需重启”，紧接着让我“重启后生效”，还让我用 `DINGTALK_IDENTITY` 和 `conversationId` 这种词；再回复消息时界面说“模拟发送”，结果发失败。这是典型的“越修越像开发者工具”。

### 3.5 飞书 / 企业微信：凭据录入可用，但仍是“企业管理员 + 重启”路径

- 飞书/企微卡都能打开「平台应用配置」并自动定位到对应分组；字段齐全、值为空（[06](screenshots-round2/06-appconfig-feishu.png)、[07](screenshots-round2/07-appconfig-wecom.png)）。
- 弹窗明确写「应用凭据需要重启 LinkHub 生效」；未保存任何值，避免污染环境。
- 管理员清单已包含“凭据写回 LinkHub 或 `.env` + 重启后端”；企微还包含可信 IP、公网回调。见 [09](screenshots-round2/09-feishu-admin-checklist.png)、[10](screenshots-round2/10-wecom-admin-checklist.png)。
- 但两家仍要求企业管理员创建自建应用/开通权限/公网回调；对没有企业的普通个人，这不是界面能解决的“连接账号”，是产品能力边界。结论里单独说明。

### 3.6 产品功能：Mock 演示闭环可用

**通过项：**

- 注入飞书示例：toast「已注入一条飞书消息」，列表出现「zhangsan · 飞书 · 未读 · 明天 10:00 前把周报发我…」（[25-inbox-after-inject.png](screenshots-round2/25-inbox-after-inject.png)）。
- 打开详情：AI 建议明确标「规则兜底」「可编辑后发送」；本次回复区标「模拟发送 / 演示模式：模拟发送，不会真的发到平台」（[26-inbox-message-detail.png](screenshots-round2/26-inbox-message-detail.png)）。
- 采用草稿 → 发送：toast 已改为「已模拟发送（不会真的发到平台）…状态会在消息里实时更新」；消息气泡有「模拟发送」；状态流转全部点亮；投递方式为「模拟发送（未调用真实平台）」（[27](screenshots-round2/27-reply-draft-adopted.png)、[28](screenshots-round2/28-reply-sent-mock.png)）。
- 标记完成 → 待办「全部完成 / 已完成 1 项」（[29-mark-complete.png](screenshots-round2/29-mark-complete.png)）。
- 回放：7 条事件，发送事件明确「模拟发送（本地 Mock，未调用真实平台接口）」，状态回流也标「模拟状态回流（本地 Mock）」（[30-trace-replay.png](screenshots-round2/30-trace-replay.png)）。
- 新建发送：Mock 下留空 conversationId 直接成功，toast 明确「已模拟发送」；不再复现上一轮 `缺少目标会话` 错误（[31](screenshots-round2/31-compose-dialog.png)、[32](screenshots-round2/32-compose-sent-no-conversation.png)）。
- 失败提示：钉钉失败详情把原因、重试、查看闭环日志放在一起，至少客户能看懂“发了但没成功”；但这是在 P1-A 的坏状态下出现的，见下。

**小问题**：回放事件里仍有 `待办(0.92) via rules` 的中英混排（P2）；新建发送产生的模拟消息在收件箱里以「未读 / LinkHub 统一入口」出现，容易被误认为收到一条新消息（P2）。

### 3.7 空态与导航

- `/todos`：零待办时有「去收件箱」「连接账号」两个 CTA（[todos.png](screenshots-round2/todos.png)）。
- `/trace`：没有消息时提示「先从收件箱选一条消息…也可以先去连接账号让真实消息进来」，并有「去收件箱选一条」「连接账号」入口（[trace.png](screenshots-round2/trace.png)）。
- 左侧导航已经有常驻文字标签：收件箱 / 待办 / 全链路回放 / 连接账号 / 平台账号 / 设置；不再只有图标和 hover tooltip（所有截图可见）。
- 底部「服务就绪」与实际 0/4 不冲突；顶栏「实时连接」仍是一个偏技术的表述，但没有直接写“账号已连接”。

---

## 四、仍存在的阻碍

### P0（完全阻断）

**本轮未发现新的 P0。** 上一轮 5 条 P0 的硬阻断路径均已解除或转为“部分修复/未实测”，没有出现“所有客户都完全无法开始”的问题。

### P1

#### P1-A　钉钉登录会在授权前预切换身份；取消/关闭后发送失败、配置入口消失

- **复现**：零账号 `/connect` → 点「用钉钉本人账号登录（推荐，无需机器人应用）」→ 不完成授权，关闭弹窗 → 打开一条钉钉消息 → 输入回复 → 发送。
- **实际**：
  - 点击登录后，本地配置已被写成 `identity.dingtalk=user`（API `GET /api/app-config` 返回 `source=local/value=user`），即使没有登录成功；
  - 关闭弹窗后，卡片提示 `DINGTALK_IDENTITY=user 但钉钉本人身份未登录：发送会显式失败`；
  - 原来的「填写钉钉应用凭据（可选，用机器人时）」按钮消失；
  - 再发送钉钉回复时，界面仍写「模拟发送」，实际按 user 身份发送并失败，消息进入死信队列；
  - `POST /api/dingtalk/personal/logout` 只清登录态，不把 `identity` 回滚为 `auto`。
- **期望**：授权成功后再切 `user`；取消/关闭时保持 `auto` 并回退 Mock/机器人；卡片始终保留“改用机器人凭据”的退路；发送前若身份未就绪，应阻止发送并明确说明，而不是先展示“模拟发送”再失败。
- **证据**：[22-dingtalk-login-modal.png](screenshots-round2/22-dingtalk-login-modal.png)、[23-connect-after-dingtalk-cancel.png](screenshots-round2/23-connect-after-dingtalk-cancel.png)、[45-dingtalk-card-no-configure.png](screenshots-round2/45-dingtalk-card-no-configure.png)、[37-dingtalk-send-failed-detail.png](screenshots-round2/37-dingtalk-send-failed-detail.png)。
- **建议**：把 identity 切换做成“登录成功回调里提交”或“取消时回滚”；`logout` 同时恢复策略；失败态下不要显示 `模拟发送` 标签；卡片保留「填写应用凭据」动作。

#### P1-B　热应用的钉钉身份仍被误判为“需要重启”，并触发错误的 `.env` 告警

- **复现**：完成 P1-A 的“点登录 → 关闭”后，回到 `/connect`；点「我已重启，重新检测」；或打开 `/accounts`。
- **实际**：
  - `/connect` 出现「已保存，需要重启 LinkHub 生效 / 应用凭据在后端启动时读取 / 重启命令 `pnpm --filter @unimsg/server start`」；
  - 点「我已重启，重新检测」toast 仍是「仍检测到配置未生效：请确认 LinkHub 已重启」；
  - `/accounts` 出现「.env 已修改，需要重启后端才生效」，并显示 `.env 修改于 15:27:53，后端启动于 16:25:12`（实际上触发的是 16:30 写入的本地 `linkhub-config.json`，`.env` 根本没改）。
- **期望**：`identity.*` 是热应用，不应触发重启提示；如果只是本地配置文件变了，提示应该说“本地配置已保存”，不要冤枉 `.env`；点“重新检测”后应清除提示。
- **证据**：[23-connect-after-dingtalk-cancel.png](screenshots-round2/23-connect-after-dingtalk-cancel.png)、[33-restart-recheck-false.png](screenshots-round2/33-restart-recheck-false.png)、[38-accounts-after.png](screenshots-round2/38-accounts-after.png)。
- **建议**：区分 `hotAppliedKeys` 与 `staticKeys`，`restartRequired` 只由 static keys 决定；`/api/app-config` 的 GET 不要用 settings 文件 mtime 一刀切；前端按 `source` 显示 `.env` 或“本地配置”，并用对应的时间戳。

#### P1-C　首屏两个“管理员数量”互相矛盾：横幅 2 个，3 步上手 4 个

- **复现**：零账号打开 `/inbox`，对比横幅与「3 步上手」的折叠摘要。
- **实际**：横幅「其中 2 个平台可能需要企业管理员开通配置」；3 步上手「需要管理员配置（4 个平台）」，展开后把邮箱/钉钉也算成“需要企业管理员”，与连接页「邮箱可自助 / 钉钉可本人登录」矛盾。
- **期望**：只把 `needs_admin`（飞书/企微）算作管理员项；邮箱/钉钉应显示“可自助”，或改成中性的“还缺配置（4 个平台）”并分栏说明。
- **证据**：[inbox.png](screenshots-round2/inbox.png)（首屏）；[connect.png](screenshots-round2/connect.png)（正确口径）。
- **建议**：`adminPlatforms` 只统计 `needs_admin/needs_install`；不要把“缺环境变量”等同于“需管理员”。

### P2（体验/文案/次要）

| 编号 | 问题 | 复现/证据 | 建议 |
| --- | --- | --- | --- |
| P2-1 | 设置 → 关于仍显示「连接状态：已连接」，零账号 0/4 时容易误解为账号已连 | [39-settings-about.png](screenshots-round2/39-settings-about.png) | 改为「后端服务：已连接」/「账号：0/4 已连接」两行 |
| P2-2 | 连接页/账号页仍混入 `FEISHU_APP_ID`、`DINGTALK_IDENTITY`、`.env`、`conversationId` 等内部词 | [connect.txt](screenshots-round2/connect.txt)、[38-accounts-after.png](screenshots-round2/38-accounts-after.png)、[22-dingtalk-login-modal.png](screenshots-round2/22-dingtalk-login-modal.png) | 客户视图只保留人类可读名称；原始键名收进“技术详情” |
| P2-3 | 邮箱「未验证」保存成功的 toast 仍写「已保存并生效」，与“未验证、不会真实收信”冲突 | [16-email-saved-unverified.png](screenshots-round2/16-email-saved-unverified.png) | 改成「已保存为未验证账号，验证通过后才会真实收信」 |
| P2-4 | 钉钉取消登录后没有「填写钉钉应用凭据」入口；账号页又显示「策略 auto」但 `DINGTALK_IDENTITY=user`、「不可接收」与身份块「发送 本人」并存，前后不一致 | [45-dingtalk-card-no-configure.png](screenshots-round2/45-dingtalk-card-no-configure.png)、[38-accounts-after.png](screenshots-round2/38-accounts-after.png) | 保留“改用机器人凭据”动作；统一策略/身份文案；提供“切回自动”按钮 |
| P2-5 | 飞书/企微管理员清单里字面量 `**重启后端**` 没渲染；飞书第 7 步按钮名与页面实际按钮（`填写飞书应用凭据`）不同 | [09](screenshots-round2/09-feishu-admin-checklist.png)、[10](screenshots-round2/10-wecom-admin-checklist.png) | 清单用纯文本强调或富文本；按钮名与实际按钮保持一致 |
| P2-6 | 连接页说缺飞书 Verification Token，配置弹窗只说缺 App ID/Secret（Verify Token 标可选），客户不知道要不要填 | [connect.txt](screenshots-round2/connect.txt)、[06](screenshots-round2/06-appconfig-feishu.png) | 统一口径；把“Webhook 才需要”直接写在缺项旁 |
| P2-7 | 回放事件 `待办(0.92) via rules` 中英混排；收件箱会出现自己“新建发送”的模拟消息并被标未读 | [30-trace-replay.png](screenshots-round2/30-trace-replay.png)、[34-inbox-dingtalk-injected.png](screenshots-round2/34-inbox-dingtalk-injected.png) | 改成「规则识别」；自发送记录不要计入未读或加“我发出的”标识 |
| P2-8 | 顶栏「实时连接」仍是技术词，与左下「服务就绪」、关于页「已连接」三套叫法并存 | [inbox.png](screenshots-round2/inbox.png)、[39](screenshots-round2/39-settings-about.png) | 统一为「服务已连接」并注明“账号 0/4” |

---

## 五、客户原话（我会这么跟朋友说）

1. **“这次首屏终于不是让我敲 `python` 和 `pnpm` 了，『去连接账号 / 先体验演示』我看得懂；但同一屏上面说 2 个平台要管理员，下面说 4 个平台要管理员，我到底该信哪个？”**
2. **“钉钉我点『用本人账号登录』，授权弹窗和链接都出来了，这步比上轮强多了；可我没登录、关掉以后，页面立刻让我重启后端，还甩我一条 `pnpm` 命令——刚才不是写『无需重启』吗？”**
3. **“更难受的是，关掉钉钉登录后我回复一条钉钉消息，下面明明写着『模拟发送』，结果发失败，说我是什么『本人身份』、缺 `conversationId`。我到底是在演示，还是在真实发送？”**
4. **“邮箱填假授权码，失败提示我能看懂；保存后也明确写『未验证、不算已就绪』，这个改得好。就是保存成功的 toast 还说『已保存并生效』，让我白高兴一下。”**
5. **“飞书、企微能填 App 凭据了，但清单还是让我找企业管理员、改 `.env`、重启。我要是有管理员，还用得着这个个人版吗？”**

---

## 六、结论：现在一个普通人 30 分钟内能凭界面“连接账号并开始使用”吗？

**分场景回答：**

- **纯演示（不连接真实账号）**：**可以，约 3–5 分钟**。注入示例 → 打开消息 → 采用草稿 → 发送（明确标模拟）→ 标记完成 → 回放，闭环完整，Mock 标注清楚。首屏命令、进度计数、横幅、空态、导航这些上一轮的阻断都已修好。
- **真实邮箱**：**界面路径基本完整，但真实成功未验证**。能添加账号、能测试失败、能保存为未验证、能删除；状态机也不再假装“已就绪”。如果客户手里有真实邮箱授权码，按当前界面有望在 30 分钟内完成“添加 → 测试通过 → 真实收信”；但本次受约束没有用真实授权码，不能替产品宣称已跑通。
- **真实钉钉**：**能走到官方授权入口，但“取消/关闭”会破坏身份状态**。登录弹窗和真实授权链接是通的；未完成授权（按约束）无法验证登录成功后的收发。当前不建议把这条路径当成“客户一定走得通”，先修 P1-A/P1-B。
- **飞书 / 企业微信**：**仍不是普通个人能独立完成的路径**。界面能填凭据、能给管理员清单，但需要企业管理员创建自建应用、开权限、配公网回调/可信 IP，最后还要重启。个人版如果没有企业管理员配合，这两家仍然只能停在“看清单”。

**总体判断**：上一轮“完全走不动”的状态已经明显改善；**纯演示可以放心给客户看**。但“连接真实账号并开始使用”仍取决于真实凭据与身份路径，且钉钉的取消路径会留下错误状态和误导性重启提示。**现在还不能说“一个普通人 30 分钟内一定能凭界面完成真实连接”**；邮箱最接近，钉钉需要先修 P1-A/P1-B，飞书/企微受企业管理员资质限制。

---

## 附录 A：关键截图索引

| 文件 | 内容 |
| --- | --- |
| [inbox.png](screenshots-round2/inbox.png) | 首屏：客户化横幅 + 3 步上手 + 空收件箱；可见「需要管理员配置（4 个平台）」 |
| [02-banner-after-reload.png](screenshots-round2/02-banner-after-reload.png) | 点「稍后再说」并刷新后，横幅不再出现 |
| [01](screenshots-round2/01-banner-after-dismiss.png) / [03](screenshots-round2/03-banner-after-reopen.png) | 点「稍后再说」后、离开再回来后 |
| [connect.png](screenshots-round2/connect.png) / [04-connect-top.png](screenshots-round2/04-connect-top.png) | `/connect` 零账号：0/4、4 项待处理、四张卡与动作 |
| [06](screenshots-round2/06-appconfig-feishu.png) / [07](screenshots-round2/07-appconfig-wecom.png) / [08](screenshots-round2/08-appconfig-dingtalk.png) | 应用凭据弹窗：字段齐全、值为空、需重启提示 |
| [09](screenshots-round2/09-feishu-admin-checklist.png) / [10](screenshots-round2/10-wecom-admin-checklist.png) | 管理员清单：凭据写回 + 重启（飞书还含字面量 `**重启后端**`） |
| [12](screenshots-round2/12-email-form.png) / [13](screenshots-round2/13-email-filled.png) | 邮箱表单、假数据填写 |
| [14-email-test-failure.png](screenshots-round2/14-email-test-failure.png) | 邮箱测试失败：可理解的结论 + 折叠的技术详情 |
| [15](screenshots-round2/15-email-save-unverified-confirm.png) / [17](screenshots-round2/17-email-unverified-detail.png) | 未验证保存确认、未验证卡片、0/4 计数 |
| [19](screenshots-round2/19-email-delete-confirm.png) / [20](screenshots-round2/20-email-deleted.png) | 删除确认、删除后恢复 |
| [22-dingtalk-login-modal.png](screenshots-round2/22-dingtalk-login-modal.png) | 钉钉本人账号登录弹窗与真实授权链接 |
| [23-connect-after-dingtalk-cancel.png](screenshots-round2/23-connect-after-dingtalk-cancel.png) | 取消登录后的假重启提示 |
| [33-restart-recheck-false.png](screenshots-round2/33-restart-recheck-false.png) | 点「我已重启」仍提示“配置未生效” |
| [45-dingtalk-card-no-configure.png](screenshots-round2/45-dingtalk-card-no-configure.png) | 取消后钉钉卡：`DINGTALK_IDENTITY=user`、凭据按钮消失 |
| [37-dingtalk-send-failed-detail.png](screenshots-round2/37-dingtalk-send-failed-detail.png) | 钉钉回复发送失败（死信）、界面仍标“模拟发送” |
| [25](screenshots-round2/25-inbox-after-inject.png) / [26](screenshots-round2/26-inbox-message-detail.png) | 注入示例、消息详情与 AI 规则兜底 |
| [27](screenshots-round2/27-reply-draft-adopted.png) / [28](screenshots-round2/28-reply-sent-mock.png) | 采用草稿、模拟回复成功、状态流转 |
| [29](screenshots-round2/29-mark-complete.png) / [30](screenshots-round2/30-trace-replay.png) | 标记完成、回放 7 条事件 |
| [31](screenshots-round2/31-compose-dialog.png) / [32](screenshots-round2/32-compose-sent-no-conversation.png) | 新建发送留空 conversationId、Mock 发送成功 |
| [38-accounts-after.png](screenshots-round2/38-accounts-after.png) | 平台账号页：可点入口 + 错误的 `.env` 重启告警 |
| [39-settings-about.png](screenshots-round2/39-settings-about.png) | 关于页仍写「连接状态：已连接」 |
| [43](screenshots-round2/43-feishu-card-credentials.png) / [44](screenshots-round2/44-wecom-card-credentials.png) | 从飞书/企微卡片打开凭据弹窗（分组正确） |
| [todos.png](screenshots-round2/todos.png) / [trace.png](screenshots-round2/trace.png) | 待办/回放空态的下一步入口 |

## 附录 B：未覆盖与清理

- **未使用真实邮箱授权码**，未验证“测试通过 → 真实 IMAP 收信/SMTP 发信”。
- **未完成飞书 OAuth、未完成钉钉扫码/授权**；飞书“连接飞书本人账号”按钮只在填完凭据后出现，本次未能实地看到。
- **未保存任何飞书/企微/钉钉应用凭据**；因此“保存后重启 → 真实收发”的上半段只验证了字段与提示，没有验证保存落盘。
- **测试数据**：邮箱假账号已删除；钉钉登录态已 `logout`；收件箱保留 3 条测试消息（飞书已完成的示例、飞书模拟新建发送、钉钉发送失败），无 UI 删除入口。
- **环境副作用**：点击钉钉登录 CTA 时产品自动写入了本地 `linkhub-config.json`（`identity.dingtalk=user`），这是 P1-A 的证据；未手动改回，以免再次修改配置。该数据目录是临时目录，重启/更换目录即可回到零配置。
- **未测**：移动端、暗色模式、附件大小上限、搜索/命令面板、企微/飞书真实回调。