# LinkHub 个人版「白号」首次使用障碍报告

- **测试时间**：2026-11-12 15:29–15:55（UTC+8）
- **测试身份**：第一次拿到 LinkHub 个人版的普通客户（非开发者，不知道 `.env`、OAuth、CLI、平台后台）
- **环境**：前端 `http://127.0.0.1:5173`（Vite dev），后端 `http://127.0.0.1:3001`（Bearer `dev-token`）；四平台全部 Mock 演示模式；无邮箱账号、钉钉 `dws` 未登录、飞书未授权、无 LLM key（AI 规则回退）；后端数据目录为全新临时目录
- **浏览器**：Chrome Headless 156 + CDP，视口 1440×900，全新临时 profile
- **证据目录**：[screenshots/](screenshots/)（36 张 PNG；`ui-probe` 抓取的页面另附同名 `.txt` 原文）
- **约束遵守**：未修改任何代码/配置/`.env`/README，未 commit；未登录任何真实平台、未扫码、未使用真实邮箱授权码；演示发送均确认界面标注「模拟发送」；未访问备份目录。
- **测试数据**：邮箱表单使用明显假数据 `white.test.not-exist@example.invalid` / `fake-auth-code-1234`，测试后已通过页面「删除」清理；另注入 1 条飞书示例消息并做了 1 次模拟回复、1 次标记完成（仅存在本机临时数据目录）。

> **环境中断说明（重要）**：15:47 左右，仓库前端源码被并发修改，`packages/web/src/services/mock/mockApi.ts:91` 出现语法错误，Vite 报 `Unexpected "}"`，5173 整页被错误覆盖层占据（见 [screenshots/32-vite-error-overlay.png](screenshots/32-vite-error-overlay.png)）。15:50 恢复。本报告以 **15:29–15:46 的界面快照**为准；恢复后复核 `/connect` 与收件箱，文案与按钮未变化（[34-connect-after-recovery.png](screenshots/34-connect-after-recovery.png)）。该中断不是产品缺陷，也不是本次调查改动造成的；调查期间 `git status` 可见多处并发修改（含新增 `appConfig`、`localConfig`），与本报告无关。

---

## 1. 第一次打开：我看到了什么

### 1.1 打开根地址

访问 `http://127.0.0.1:5173` 后自动跳到 `/inbox`，首屏见 [01-first-open.png](screenshots/01-first-open.png)。

首屏从上到下依次是：

1. **左侧图标栏**：5 个纯图标（收件箱、待办、回放、连接账号、平台账号），没有文字标签；鼠标悬停才出现 tooltip（见 [26-nav-hover-tooltip.png](screenshots/26-nav-hover-tooltip.png)）。
2. **顶部横幅**（原文）：
   > 首次使用：先连接你自己的账号
   > 邮箱、钉钉、飞书、企业微信逐项连接；不用把机器人拉进群。带「需管理员」的项需要企业管理员开通。
   > 去连接账号　稍后再说
3. **「3 步上手」大卡片**（原文，节选）：
   > 后端已连上，但还没有消息　收到第一条后，「接收 → 回复 → 回写 → 回流」的完整闭环会出现在这里。　实时连接正常
   > 当前通道　飞书 · Mock 模拟　缺 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_VERIFY_TOKEN　钉钉 · Mock 模拟　缺 DINGTALK_CLIENT_ID、DINGTALK_CLIENT_SECRET、DINGTALK_AES_TOKEN、DINGTALK_AES_KEY　企业微信 · Mock 模拟　缺 WECOM_CORP_ID、WECOM_SECRET、WECOM_AGENT_ID、WECOM_TOKEN、WECOM_AES_KEY　邮箱 · Mock 模拟　缺 MAIL_ACCOUNTS（或 MAIL_<KEY>_ADDRESS / MAIL_<KEY>_AUTH_CODE）
   >
   > **1　想立刻看到效果**　`python scripts/smoke.py http://127.0.0.1:3001`
   > 在 unimsg-connector/ 下执行：灌入三平台示例消息，跑通「接收 → 回复 → 回写 → 回流」。
   >
   > **2　想接真实平台**　`pnpm run doctor`
   > 在 unimsg-connector/ 下自检各平台模式 / 凭据 / 连通性；按 docs/swap-accounts.md 填好 .env 后重启后端。
   > 连接本人账号（推荐，免拉机器人进群）：到「平台账号」页点「连接本人账号」—— 飞书走官方授权，钉钉用本机 dws 登录；连上后收发都以你本人身份进行，机器人身份保留兜底。
   >
   > **3　想核对每个平台走了哪条通道**　查看平台账号
   > 账号页展示真实接口 / Mock 模拟、缺失变量与告警，以及每个平台「谁在收、谁在发」的身份标注，方便一眼定位接入问题。
   >
   > 启动后端 `pnpm --filter @unimsg/server start`　启动前端 `pnpm --filter @unimsg/web dev`
   > 收到第一条消息后，这条引导会自动隐藏。　知道了
4. **空收件箱**：图标 + “还没有收到消息”，以及一行“点下面的平台按钮，注入一条示例消息试试（走真实入站链路，不会真的发到平台）”。**三个注入按钮在 1440×900 首屏之外（y≈933），需要向下滚动才能看到**；首屏可见区域几乎全被开发者命令占据。

**第一印象**：我不知道 `.env` 是什么、`pnpm` 是什么、`unimsg-connector/` 在哪；页面没有告诉我“先用邮箱连一下”这种可执行的动作，反而先要求我在终端跑命令。首屏没有出现任何“下一步只需点这里”的客户级引导。

### 1.2 点「去连接账号」

横幅的「去连接账号」可以点击并跳到 `/connect`（验证通过）。这是首屏唯一一个能把我带到“配置账号”的入口。`/connect` 页面见 [02-connect.png](screenshots/02-connect.png)。

---

## 2. 逐页巡检（零账号状态）

| 页面 | 零账号下的内容 | 是否有可执行引导 | 截图 |
| --- | --- | --- | --- |
| `/inbox` 收件箱 | 横幅 + 「3 步上手」+ 空列表；注入示例按钮在首屏下方 | 有一个「去连接账号」；其余是终端命令 | [01](screenshots/01-first-open.png) |
| `/todos` 待办 | `待办 0`、`暂无待办`、`当消息被识别为「待办」类型时，会出现在这里。` | 无，没有“去连接/去注入示例”的入口 | [04](screenshots/04-todos.png) |
| `/trace` 全链路回放 | `选择一条消息` 下拉为空、`从上方下拉框中选择消息，即可查看它的全链路日志。` | 无，没有回到收件箱或连接账号的链接 | [05](screenshots/05-trace.png) |
| `/connect` 连接账号 | 进度 `已就绪 0 / 4`；邮箱卡片有「添加邮箱账号」；钉钉/飞书/企微只有演示模式说明和命令/后台链接 | 只有邮箱可操作，其余三个没有连接入口 | [02](screenshots/02-connect.png) |
| `/accounts` 平台账号 | 四张卡全部 `Mock 模拟`、`未配置`、`不可接收`、`不可发送`；说明全部指向 `.env` | 无任何连接按钮（只有「打开『连接账号』向导」） | [03](screenshots/03-accounts.png) |

导航本身：图标没有文字标签，只有 `aria-label`/hover tooltip。作为第一次使用的客户，我需要把 5 个图标逐个悬停一遍才知道哪个是“连接账号”。（P2）

---

## 3. 四个平台连接尝试（逐个按钮实测）

### 3.1 邮箱：表单能填、能保存，但保存完仍不是“已连接”

**我点了什么**：`/connect` → 邮箱卡片 →「添加邮箱账号」（[06-connect-email-form.png](screenshots/06-connect-email-form.png)）。

**表单显示**：服务商（下拉：QQ 邮箱、网易 163、网易 126、网易 yeah、Gmail、Outlook / Microsoft 365、iCloud、自定义 / 企业邮箱）、邮箱地址、授权码、高级设置（IMAP/SMTP 服务器）、测试连接、保存账号、取消。上方提示：

> 先到邮箱网页版「设置 → POP3/SMTP/IMAP」开启服务并生成授权码（16 位左右，不是网页登录密码）。
> 当前邮箱通道为模拟模式（MAIL_MODE=mock）：添加账号后改 MAIL_MODE=auto/real 才会真实收信。
> 保存后会热加载（无需重启），首轮只建立 UID 基线、不导入历史邮件。

**① 空表单点「保存账号」**：字段级报错清楚——`请填写邮箱地址`、`请填写邮箱授权码（不是登录密码）`（[07](screenshots/07-email-save-empty.png)）。这是正面体验。

**② 填假数据点「测试连接」**：界面先显示“连接测试失败”红色面板，正文是原始协议错误 + 内部变量名，例如：

> IMAP 登录失败（w******@example.invalid @ imap.qq.com:993）：IMAP 登录失败：NO [AUTHENTICATIONFAILED] Login fail. ... More
> （99% 是授权码问题：① 检查 .env 的 MAIL_WHITETESTNOTEXIST_AUTH_CODE 是否为邮箱网页端生成的授权码……④ 刚改过密码/授权码时以最新授权码为准。）
> SMTP：SMTP 535 认证失败（...）：SMTP 535：535 Login fail. ... More information at https:（535 基本就是授权码错误或服务商未开启 SMTP：……）

底部 toast：`邮箱连接测试失败，请检查授权码与服务器地址`（[08](screenshots/08-email-test-connection-fail.png)）。

**③ 仍然点「保存账号」**：**保存成功了**，页面变成：

> 已配置 1 个邮箱账号（.env 0 / 本地导入 1），但当前为演示模式：不会真实连 IMAP 收信。
> 邮箱通道当前为 Mock（MAIL_MODE=mock）：去掉 MAIL_MODE 或设为 auto/real 后重启即可真实收发。
> w******@example.invalid　QQ 邮箱　本地　删除
> 命令 `pnpm run doctor --platform=mail`

但顶部进度仍是 `已就绪 0 / 4`，摘要变成 `已就绪 0 项 · 待处理 0 项`（[09](screenshots/09-email-save-with-fake.png)）。

**客户视角**：我“保存成功”了，但页面同时告诉我“不会真实收信”“已就绪 0/4”“待处理 0 项”。我不知道自己到底连上没有；页面让我去改 `MAIL_MODE=auto/real`，但界面上没有这个开关，我也不知道 `.env` 在哪里。

**删除**：点「删除」会出现确认气泡：

> 删除这个邮箱账号？只删除 LinkHub 本地保存的账号；.env 里的配置不受影响。

确认后 toast `已删除本地邮箱账号`，邮箱卡片回到“还没有邮箱账号”，进度回到 `待处理 1 项`（[35](screenshots/35-email-delete-confirm.png)、[36](screenshots/36-connect-after-email-delete.png)）。删除流程本身清楚、可恢复。

---

### 3.2 钉钉：整张卡片没有任何“连接”按钮

**界面原文**（[02-connect.png](screenshots/02-connect.png)）：

> 钉钉　演示模式
> 钉钉当前为演示模式（Mock）：不会连真实钉钉；连接本人账号后可真实收发。
> 本地模拟接收（不连真实平台）
> 模拟发送（本地 Mock，界面标注「模拟发送」，不调用真实平台）
> 命令　`pnpm run doctor --platform=dingtalk`（旁边只有“复制命令”图标）

**我逐个点**：卡片里只有一个可点元素——复制命令图标。没有“连接本人账号”、没有“登录钉钉”、没有“打开登录页”。复制后只是图标 tooltip 变成“已复制”（无 toast）。

**与文案的矛盾**：
- 首页引导说：“钉钉用本机 dws 登录”；
- 连接页说：“钉钉运行环境：内置 tools 目录（无需手动安装）”；
- 但页面上没有任何地方能发起 `dws auth login`，也没有说明“dws 未登录时我该在哪里点”。

**结论**：钉钉是纯粹的死胡同。客户既无法在界面上登录 dws，也拿不到任何可执行的“下一步”（除了复制一条开发者命令）。卡在“我不知道 dws 还需要登录”这一步。

---

### 3.3 飞书：只有“去开放平台”和“复制清单”，没有 App ID/Secret 输入框

**界面原文**（[02](screenshots/02-connect.png)）：

> 飞书　演示模式
> 飞书当前为演示模式（Mock）：不会连真实飞书；企业管理员配好应用后可连接本人账号。
> 本地模拟接收（不连真实平台）
> 模拟发送（本地 Mock，界面标注「模拟发送」，不调用真实平台）
> [打开飞书开放平台（应用后台）] [复制管理员开通清单（含回调 URL / 权限）]
> 查看要复制的内容

**我点了「打开飞书开放平台（应用后台）」**：新标签打开 `https://accounts.feishu.cn/accounts/page/login?...`，页面是“扫码登录 / 请使用 豆包/飞书移动端 扫码”（[11-feishu-console-login-page.png](screenshots/11-feishu-console-login-page.png)）。我没有飞书账号，也没有企业，到这里就停了。

**我点了「复制管理员开通清单」**：toast `已复制管理员清单`，展开“查看要复制的内容”后是一份 5 步清单（[12-feishu-admin-checklist-expanded.png](screenshots/12-feishu-admin-checklist-expanded.png)）：

> 飞书管理员开通清单（LinkHub 个人版需要企业管理员配合）：
> 1. 打开飞书开放平台 https://open.feishu.cn/app ，创建/选择一个「企业自建应用」；
> 2. 权限管理：……（缺权限时 OAuth 后仍读不到消息）
> 3. 安全设置 → 重定向 URL：添加 http://localhost:3001/api/feishu/oauth/callback（照抄，含 /api/feishu/oauth/callback）；
> 4. 事件订阅：配置 Encrypt Key / Verification Token（或使用长连接），否则机器人收不到消息；
> 5. 发布应用后，回到 LinkHub「连接账号」页点「连接飞书本人账号」，用本人账号完成授权。

**关键死路**：第 5 步让我点「连接飞书本人账号」，但 `/connect` 和 `/accounts` 上都没有这个按钮（我全页搜过，只有说明文字）。清单也没告诉我 App ID / App Secret 要填到哪里——界面上根本没有输入框。

---

### 3.4 企业微信：明确要求企业管理员，且必须改 `.env`

**界面原文**（[02](screenshots/02-connect.png)）：

> 企业微信　演示模式
> 企业微信当前为演示模式（Mock）：需要企业管理员配好自建应用与可信 IP 才能真实收发。
> 缺少变量：WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID / WECOM_TOKEN / WECOM_AES_KEY
> 个人版无法自行开通企业微信，需要企业管理员配合。
> [打开企业微信管理后台] [复制管理员开通清单（含可信 IP）]
> 查看要复制的内容

**我点了「打开企业微信管理后台」**：新标签打开 `https://work.weixin.qq.com/`（需要管理员登录）。展开清单后第 4 步直接写：

> 4. 把 WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET / WECOM_TOKEN / WECOM_AES_KEY 填到 .env 后重启 LinkHub。

清单还要求“回调 URL 指向 /api/wecom/callback（需公网可达）”“企业可信 IP 添加运行 LinkHub 的机器的公网出口 IP”（[13-wecom-admin-checklist-expanded.png](screenshots/13-wecom-admin-checklist-expanded.png)）。复制清单有 toast `已复制管理员清单`（[14](screenshots/14-wecom-copy-toast.png)）。

**结论**：对个人客户来说，这是页面自己承认的“无法自行开通”。而且就算找到管理员，最后仍要改 `.env` + 重启，界面没有入口。

---

### 3.5 四平台尝试汇总

| 平台 | 页面上的可点动作 | 实际结果 | 客户能否在界面完成 | 卡点 |
| --- | --- | --- | --- | --- |
| 邮箱 | 添加邮箱账号 → 测试/保存 | 假数据也能保存；仍为 Mock，要求改 `MAIL_MODE` | **否** | 无 `MAIL_MODE` 开关；`.env` 不可达 |
| 钉钉 | 仅“复制命令” | 复制 `pnpm run doctor --platform=dingtalk` | **否** | 无连接/登录按钮；dws 登录无入口 |
| 飞书 | 打开开放平台、复制清单 | 跳到扫码登录页；清单第 5 步引用不存在的按钮 | **否** | 无 App ID/Secret 输入；需企业管理员 |
| 企业微信 | 打开管理后台、复制清单 | 跳到 work.weixin.qq.com；清单要求改 `.env`、公网回调、可信 IP | **否** | 明确“个人版无法自行开通” |

**连接页其余按钮实测**：

- 「刷新状态」→ toast `已刷新各平台连接状态`，四平台状态与 0/4 不变（[29](screenshots/29-refresh-state.png)）。
- 「平台账号页」→ 正常跳到 `/accounts`。
- 邮箱表单「取消」→ 关闭表单、不保存；「测试连接」「保存账号」见 §3.1。

---

## 4. 产品功能试用（Mock 演示）

### 4.1 收件箱与注入示例

空态“注入飞书示例”在首屏下方，滚动后点击。toast `已注入一条飞书消息`，列表出现：

> zhangsan · 飞书　未读　刚刚　明天 10:00 前把周报发我，重点写本周联调进展和下周计划。　已接收　待办

（[17-inbox-after-inject.png](screenshots/17-inbox-after-inject.png)）

**正面**：注入是本地链路、不真的发到平台；列表状态（未读/已接收/待办）清楚。

### 4.2 打开消息、AI 建议、回复

打开消息后（[18-inbox-message-detail.png](screenshots/18-inbox-message-detail.png)）：

> AI 建议　意图 待办　规则兜底　可编辑后发送
> 收到，我会在截止前完成。
> [采用草稿] [重新生成]
> 本次回复　模拟发送　Mock 模拟，不会真的发到平台

点「采用草稿」→「发送回复」：

- toast：`已提交，正在发送…状态会在消息里实时更新`
- 消息气泡出现 `已回复内容 收到，我会在截止前完成。` + 黄色 `模拟发送` 标签
- 状态流转全部点亮：已接收 → 处理中 → 已回复 → 已发送 → 已同步
- 消息信息里“投递方式”变成 `模拟发送（未调用真实平台）`

（[19-reply-draft-adopted.png](screenshots/19-reply-draft-adopted.png)、[20-reply-sent-mock.png](screenshots/20-reply-sent-mock.png)）

**Mock 标注评价：清楚**。回复框上方和结果里都写了“模拟发送/不会真的发到平台”，没有伪装成真实发送。

### 4.3 标记完成 / 待办

点「标记完成」→ toast `已标记完成`；`/todos` 显示 `全部完成`、`已完成 1 项`（[23](screenshots/23-mark-complete.png)、[24](screenshots/24-todos-after-mark.png)）。功能闭环正常。

### 4.4 新建发送：填完内容仍然发不出去

点「新建发送」→ 弹窗（[21](screenshots/21-compose-dialog.png)）：

> 新建发送 · 向指定平台发送消息或文件
> 目标平台　飞书
> 发送身份　模拟发送
> 当前平台通道为 Mock 模拟，不会真的发到平台，因此不能选择本人 / 机器人身份。
> 目标会话 ID（留空则复用该平台最近会话）　`飞书 chat_id（oc_…）或单聊 open_id`
> 当前 飞书 通道：本地模拟（不会真的调用平台）

填一段文本后点「发送」，报错：

> 向 feishu 发送缺少目标会话：请填写 conversationId，或先让该平台收到一条消息

（[22-compose-sent-mock.png](screenshots/22-compose-sent-mock.png)）

**问题**：我已经通过“注入飞书示例”收到过一条飞书消息，且页面承诺“留空则复用该平台最近会话”，但实际仍要求填 `conversationId`。客户没有地方能拿到 `oc_…`/`open_id`，所以“新建发送”在零账号下等于不可用。

### 4.5 全链路回放

从消息详情点「回放」→ `/trace` 自动选中该消息，展示 7 条事件（接收 / 意图识别 / 处理中 / 已回复 / 已发送 / 已同步 / 标记完成），其中发送事件明确写“模拟发送（本地 Mock，未调用真实平台接口）”（[25](screenshots/25-trace-select-open.png)）。这是本次体验中最完整、最可信的页面。

### 4.6 个人设置

`我` → 设置：个人资料 / 外观 / 消息 / 关于。关于页显示版本 `v1.0.0`、接口地址 `http://127.0.0.1:3001`、连接状态 `已连接`、清除本地数据/恢复默认设置（[15](screenshots/15-profile-dialog.png)、[16](screenshots/16-profile-about-tab.png)）。没有平台凭据或 AI key 的配置入口——这本身不是问题，但进一步说明“连接账号”是唯一入口，而它走不通。

---

## 5. 阻断清单

> 分级：**P0** = 客户完全无法完成某事 / 被明确误导；**P1** = 严重绕路、看不懂或前后矛盾；**P2** = 体验瑕疵。本次共 19 条：P0 × 5、P1 × 8、P2 × 6。

### P0-1　首屏把“开发者部署命令”当成新客户上手引导

- **复现**：打开 `http://127.0.0.1:5173` → 看首屏「3 步上手」。
- **期望**：第一屏告诉我“点哪里、用哪个账号、几分钟能收到第一条消息”，例如“添加邮箱 → 填地址和授权码 → 完成”。
- **实际**：第一步就是 `python scripts/smoke.py http://127.0.0.1:3001`，第二步 `pnpm run doctor` + “按 docs/swap-accounts.md 填好 .env 后重启后端”，底部还有 `pnpm --filter @unimsg/server start` / `pnpm --filter @unimsg/web dev`。普通客户不知道这些是什么，也没有终端。
- **证据**：[01-first-open.png](screenshots/01-first-open.png)；原文见 §1.1。
- **建议**：首屏只保留 1 条客户路径（连接账号/看演示）；所有命令、`.env`、doctor 移入“我是开发者/高级排查”折叠区或独立文档，默认不展示。

### P0-2　首页和飞书清单指向不存在的「连接本人账号 / 连接飞书本人账号」按钮

- **复现 A**：首屏「3 步上手」第 2 条 → 读“到「平台账号」页点「连接本人账号」” → 打开 `/accounts` 和 `/connect` 找该按钮。
- **复现 B**：`/connect` → 飞书卡片 →「查看要复制的内容」→ 第 5 步“回到 LinkHub「连接账号」页点「连接飞书本人账号」”。
- **期望**：文案指向的按钮真实存在且可点。
- **实际**：两个页面都没有这个按钮；`/accounts` 四张卡片也没有任何连接按钮（[03](screenshots/03-accounts.png)）。客户按引导去找，只会怀疑自己看漏了。
- **证据**：[01](screenshots/01-first-open.png)、[03](screenshots/03-accounts.png)、[12](screenshots/12-feishu-admin-checklist-expanded.png)。
- **建议**：要么实现按钮，要么在不可用时把文案改成“当前为演示模式，暂不支持连接本人账号”，并给出可执行的替代动作；清单第 5 步必须与实际按钮同名/同条件渲染。

### P0-3　钉钉：整张卡片没有任何连接/登录入口

- **复现**：`/connect` → 钉钉卡片 → 找可点元素。
- **期望**：至少有一个“连接钉钉本人账号”按钮，点开后告诉我 dws 未登录、并给出“一键登录/打开终端命令”的可执行步骤。
- **实际**：卡片只有“复制命令 `pnpm run doctor --platform=dingtalk`”；页面文字说“连接本人账号后可真实收发”，但按钮不存在；`dws` 未登录这件事界面上没有任何提示或入口。
- **证据**：[02](screenshots/02-connect.png)。
- **建议**：补“连接本人账号”按钮（demo 模式可置灰并解释原因）；若必须用终端，给出“复制 `dws auth login`”并说明在哪里粘贴、登录后回来点什么。

### P0-4　飞书/企业微信没有 App 凭据输入界面，必须去后台 + 改 `.env`

- **复现**：`/connect` → 飞书/企微卡片 → 找 App ID/Secret/CorpID 输入框。
- **期望**：个人版如果宣称“只需连接你自己的账号”，应能在页面里填应用凭据，或明确告诉我“这一步需要企业管理员，个人版不可用”。
- **实际**：飞书只有“打开开放平台（扫码登录）+ 复制管理员清单”，没有任何输入框；企微直接写“个人版无法自行开通企业微信，需要企业管理员配合”，清单第 4 步要求把 5 个变量“填到 .env 后重启 LinkHub”。
- **证据**：[02](screenshots/02-connect.png)、[12](screenshots/12-feishu-admin-checklist-expanded.png)、[13](screenshots/13-wecom-admin-checklist-expanded.png)。
- **建议**：在页面内提供凭据表单（至少飞书 App ID/Secret、企微 CorpID/Secret/AgentId），保存后由后端热加载；无法提供的平台明确标注“个人版不支持”，不要用“个人版只需连接你自己的账号”概括。

### P0-5　邮箱保存成功也仍是 Mock，界面没有切换真实模式的入口

- **复现**：`/connect` → 邮箱 → 添加邮箱账号 →（可用假数据）→ 保存账号。
- **期望**：保存后要么真实连上并显示“已就绪”，要么明确告诉我“当前是演示模式，真实收信需要 X，点这里开启”。
- **实际**：保存成功并显示“已配置 1 个邮箱账号”，但同卡片写“当前为演示模式：不会真实连 IMAP 收信”“去掉 MAIL_MODE 或设为 auto/real 后重启即可真实收发”；进度仍是 `已就绪 0 / 4` + `待处理 0 项`。客户无法在界面上改 `MAIL_MODE`，也没有 `.env` 的概念。
- **证据**：[09](screenshots/09-email-save-with-fake.png)。
- **建议**：加“启用真实收信”开关（写后端配置或明确引导），并在保存成功后给出唯一的下一步；不要在“已配置”和“0/4 未就绪”之间让客户猜。

### P1-1　进度计数自相矛盾，客户无法判断还剩什么

- **复现**：打开 `/connect`（零账号）→ 读顶部；再添加一个邮箱账号后读顶部。
- **期望**：0/4 就应显示“4 项待处理”，或说明“仅邮箱需要你处理，其余需管理员”。
- **实际**：
  - 零账号：`已就绪 0 / 4`、`按 邮箱 → 钉钉 → 飞书 → 企业微信 的顺序连接，还有 1 项待处理`、`已就绪 0 项 · 待处理 1 项`。
  - 添加邮箱后：`已就绪 0 / 4`、摘要变成 `已就绪 0 项 · 待处理 0 项`（但 0 个平台就绪）。
- **证据**：[02](screenshots/02-connect.png)、[09](screenshots/09-email-save-with-fake.png)。
- **建议**：把“待处理”定义为“需要客户本人操作的项”，并在旁注明“其余 3 项需管理员/演示模式”；或统一显示“0/4 就绪，其中 3 项需管理员”。

### P1-2　邮箱测试失败提示是开发者排障文本

- **复现**：邮箱表单填假授权码 → 测试连接。
- **期望**：一句客户能懂的结论 + 下一步（“授权码不对，请到 QQ 邮箱设置里重新生成一个 16 位授权码”）。
- **实际**：整段 IMAP/SMTP 原始错误 + 内部变量名 `MAIL_WHITETESTNOTEXIST_AUTH_CODE` + 被截断的 `https:`；还让我“重跑 doctor”。
- **证据**：[08](screenshots/08-email-test-connection-fail.png)。
- **建议**：默认只显示结论和步骤；原始错误折叠到“技术详情”，不要把 `.env` 变量名暴露给客户。

### P1-3　「新建发送」要求客户提供 `conversationId`，且提示与实际不符

- **复现**：收件箱 → 新建发送 → 选飞书 → 填文本 → 发送（不填会话 ID）。
- **期望**：按弹窗承诺“留空则复用该平台最近会话”直接发出（模拟）。
- **实际**：报错 `向 feishu 发送缺少目标会话：请填写 conversationId，或先让该平台收到一条消息`；即使已经注入过飞书消息也无法发送，且界面没有地方能查 `oc_…`/`open_id`。
- **证据**：[21](screenshots/21-compose-dialog.png)、[22](screenshots/22-compose-sent-mock.png)。
- **建议**：实现“最近会话”下拉，或提供“发给示例联系人”的演示路径；错误文案不要给一个客户无法执行的建议。

### P1-4　平台账号页只有“去改 .env”，没有任何可点操作

- **复现**：打开 `/accounts`。
- **期望**：未连接时告诉我“点哪里连接”，至少能跳到对应连接动作。
- **实际**：四张卡全部 `未配置`、`不可接收`、`不可发送`；身份区块写“请先在 .env 配置该平台凭据并重启后端，再回来连接”；页面主体只有“打开『连接账号』向导”一个按钮，另有一个「运行指标」折叠抽屉，均不能发起连接。
- **证据**：[03](screenshots/03-accounts.png)。
- **建议**：卡片上加“连接/配置”按钮，或在卡片内直接说明“当前仅演示，点这里看演示”，不要只指向 `.env`。

### P1-5　空收件箱里能产生消息的按钮在首屏之外

- **复现**：1440×900 打开 `/inbox`（零消息）。
- **期望**：空态正中间就能看到“注入示例/连接账号”。
- **实际**：首屏只看到“还没有收到消息”，三个“注入示例”按钮在 y≈933，需要滚动；首屏上方被开发者引导占满。
- **证据**：[01](screenshots/01-first-open.png)。
- **建议**：空态 CTA 上移到“还没有收到消息”旁边；开发者引导默认折叠。

### P1-6　「稍后再说」点了没用，刷新后横幅仍在

- **复现**：`/inbox` → 点横幅右侧「稍后再说」→ 观察当前页 → 刷新。
- **期望**：横幅立即消失，且不再出现。
- **实际**：点击后横幅仍显示；`localStorage` 写入了 `linkhub.onboarded=1`，刷新后横幅依旧（后端 `firstRun=true` 覆盖了本地标记）。客户会觉得按钮坏了。
- **证据**：[30a-after-dismiss.png](screenshots/30a-after-dismiss.png)（点击后仍可见）；`localStorage` 值已现场读取确认。
- **建议**：本地标记应优先于 `firstRun`，或把“稍后再说”改成“本次隐藏”（明确会再来）。

### P1-7　“个人版只需连接你自己的账号”与三个平台需管理员自相矛盾

- **复现**：读 `/connect` 顶部说明，再读三张卡片。
- **期望**：个人版能力边界一句话说清（哪些能自助、哪些必须企业管理员）。
- **实际**：顶部写“个人版只需连接你自己的账号”；下面飞书“企业管理员配好应用后可连接”、企微“个人版无法自行开通企业微信”、钉钉要本机 dws 登录。客户会以为自己买的产品能直接连四个平台。
- **证据**：[02](screenshots/02-connect.png)。
- **建议**：明确分栏“个人可自助（邮箱）/ 需企业管理员（飞书、企微）/ 需本机 CLI（钉钉）”，并在购买/首屏就说清。

### P1-8　零账号时页面仍显示“已连接”，容易被误解为账号已连

- **复现**：零账号打开任意页面，看左下角与右上角。
- **期望**：区分“后端已连接”和“账号已连接”。
- **实际**：左下角绿点 `已连接`、右上角 `实时连接` 均为绿色，同时 `/connect` 显示 `已就绪 0 / 4`。客户第一眼会以为“已经连上了”。
- **证据**：[01](screenshots/01-first-open.png)、[02](screenshots/02-connect.png)。
- **建议**：改成“服务已连接”/“后端在线”，或把账号连接状态放在同一处。

### P2-1　左侧导航只有图标，没有文字标签

- **复现**：任意页面看左侧栏。
- **实际**：5 个纯图标，只能靠 hover tooltip 辨认；客户需要逐个试。
- **证据**：[26-nav-hover-tooltip.png](screenshots/26-nav-hover-tooltip.png)。
- **建议**：常驻文字标签，或至少在图标下加短标签。

### P2-2　待办/回放空态没有下一步

- **复现**：零数据打开 `/todos`、`/trace`。
- **实际**：只有解释性一句话，没有“去收件箱注入示例/去连接账号”的链接。
- **证据**：[04](screenshots/04-todos.png)、[05](screenshots/05-trace.png)。
- **建议**：空态加一个明确 CTA。

### P2-3　同一状态有三套叫法：`Mock 模拟` / `演示模式` / `未配置`

- **复现**：`/connect` 与 `/accounts` 对比。
- **实际**：连接页叫“演示模式”，账号页叫“Mock 模拟”+“未配置”，横幅叫“Mock 模拟”；客户不知道这三个词是不是同一件事。
- **证据**：[02](screenshots/02-connect.png)、[03](screenshots/03-accounts.png)。
- **建议**：统一为一个词（如“演示模式”），并在首次出现处解释“不会真实收发”。

### P2-4　缺变量列表直接暴露内部变量名，信息过载

- **复现**：首屏与账号卡。
- **实际**：`缺 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_VERIFY_TOKEN` 等直接铺在客户首屏；普通客户既不知道这是什么，也不知道去哪填。
- **证据**：[01](screenshots/01-first-open.png)、[03](screenshots/03-accounts.png)。
- **建议**：默认折叠为“技术详情”，客户视图只显示“未配置/需管理员/演示模式”。

### P2-5　邮箱保存后账号卡头部仍写“未配置”，与下方账号列表矛盾

- **复现**：保存一个邮箱账号后打开 `/accounts`。
- **实际**：邮箱卡片头部 `Mock 模拟` + `未配置`，下方却列出 `QQ 邮箱 whitetestnotexist`、`IMAP imap.qq.com`、`SMTP smtp.qq.com`。
- **证据**：[27-accounts-card-click.png](screenshots/27-accounts-card-click.png)。
- **建议**：头部状态改为“已添加账号（演示模式）”，或区分“凭据未配置”和“已添加本地账号”。

### P2-6　“已提交，正在发送…”toast 未带“模拟”字样

- **复现**：发送回复。
- **实际**：toast 是 `已提交，正在发送…状态会在消息里实时更新`；虽然旁边与时间线都标注了“模拟发送”，但瞬时提示容易被当成真实发送。
- **证据**：[20](screenshots/20-reply-sent-mock.png)。
- **建议**：toast 改成“已模拟发送（不会真的发到平台）”。

---

## 6. 客户原话（我会这么跟朋友说）

1. **“我打开产品，第一步就让我敲 `python` 和 `pnpm`。我是来用消息中心的，不是来部署项目的。”**
2. **“首页说去『平台账号』点『连接本人账号』，我把两个页面从头翻到尾，根本没有这个按钮——是我瞎了吗？”**
3. **“钉钉那张卡只有一行 `pnpm run doctor`。我想连我自己的钉钉，连个登录按钮都没有。”**
4. **“飞书点开是扫码登录开放平台；回来还是让我改 `.env`。App ID 到底填哪儿？没人告诉我。”**
5. **“邮箱我填完保存，它说『已配置 1 个邮箱账号』，可上面还是 0/4，又说演示模式不会收信。到底连上没有？”**
6. **“我就想发条消息，它让我填 `conversationId`；我连这串东西去哪抄都不知道。”**

---

## 7. 结论：30 分钟内能凭界面“连接账号并开始使用”吗？

**不能。**

- **纯演示（不连接账号）**：可以。注入示例 → 回复 → 标记完成 → 看回放，约 3–5 分钟能跑通，且 Mock 标注清楚。
- **真正“连接账号”**：四个平台全部走不通：
  - 邮箱：表单能保存，但保存后仍是 Mock，必须改 `MAIL_MODE` 并重启；界面没有开关/输入框。
  - 钉钉：没有连接按钮，`dws` 登录无入口。
  - 飞书：只给开放平台链接和清单，无 App ID/Secret 输入；清单第 5 步指向不存在的按钮。
  - 企业微信：页面自己写“个人版无法自行开通”，清单要求改 `.env`、公网回调、可信 IP。
- **我实际花的时间**：前 5 分钟在读命令并怀疑自己是不是打开错了产品；接着约 10 分钟在 `/connect` 与 `/accounts` 之间来回找“连接本人账号”；再约 8 分钟尝试邮箱表单、飞书开放平台、企微后台；最后确认没有任何界面路径能完成真实连接。**30 分钟内无法完成目标。**

**最短阻断路径（复现用）**：

1. 打开 `http://127.0.0.1:5173` → 首屏被 `python scripts/smoke.py` / `pnpm run doctor` / `.env` 占据。
2. 点「去连接账号」→ `/connect`，看到 `已就绪 0 / 4`。
3. 点「添加邮箱账号」→ 填任意地址/授权码 → 保存 → 显示“已配置 1 个邮箱账号”但“不会真实连 IMAP 收信”，要求改 `MAIL_MODE=auto/real`。
4. 回到 `/connect` 看钉钉/飞书/企微：没有连接按钮，只有后台链接/命令/清单；企微直接写“个人版无法自行开通”。
5. 去 `/accounts`：四张卡全是“不可接收/不可发送”，只让我去 `.env` 配置；首页说的“连接本人账号”按钮不存在。
6. 结束：没有任何一步能在界面上完成“连接账号”。

**如果只能先修一处**：把首屏从“开发者命令”换成一条真实可走通的客户路径——要么提供可用的“连接本人账号/凭据录入”界面，要么诚实地给一个“当前是演示版，点这里 3 分钟看效果”的入口，并把所有 `.env`/`doctor`/`conversationId` 文案收进开发者模式。

---

## 附录 A：截图索引

| 文件 | 内容 |
| --- | --- |
| [01-first-open.png](screenshots/01-first-open.png) | 首次打开 `/inbox`：横幅 + 3 步上手 + 空收件箱（注入按钮在首屏下方） |
| [02-connect.png](screenshots/02-connect.png) | `/connect` 零账号：0/4、四平台卡片 |
| [03-accounts.png](screenshots/03-accounts.png) | `/accounts` 零账号：四卡未配置、不可收发 |
| [04-todos.png](screenshots/04-todos.png) / [05-trace.png](screenshots/05-trace.png) | 待办/回放空态，无 CTA |
| [06-connect-email-form.png](screenshots/06-connect-email-form.png) | 邮箱添加表单 |
| [07-email-save-empty.png](screenshots/07-email-save-empty.png) | 空表单校验文案 |
| [08-email-test-connection-fail.png](screenshots/08-email-test-connection-fail.png) | 假授权码测试失败的开发者式报错 |
| [09-email-save-with-fake.png](screenshots/09-email-save-with-fake.png) | 假数据保存成功，但仍 Mock、0/4、待处理 0 |
| [10-feishu-open-console-click.png](screenshots/10-feishu-open-console-click.png) | 程序化点击飞书后台按钮未打开新标签（真实鼠标点击见 11） |
| [11-feishu-console-login-page.png](screenshots/11-feishu-console-login-page.png) | 真实点击后打开的飞书扫码登录页 |
| [12-feishu-admin-checklist-expanded.png](screenshots/12-feishu-admin-checklist-expanded.png) | 飞书清单第 5 步指向不存在的按钮 |
| [13-wecom-admin-checklist-expanded.png](screenshots/13-wecom-admin-checklist-expanded.png) / [14](screenshots/14-wecom-copy-toast.png) | 企微清单要求改 .env；复制 toast |
| [15-profile-dialog.png](screenshots/15-profile-dialog.png) / [16](screenshots/16-profile-about-tab.png) | 个人设置与关于（无凭据入口） |
| [17-inbox-after-inject.png](screenshots/17-inbox-after-inject.png) | 注入飞书示例后的列表 |
| [18-inbox-message-detail.png](screenshots/18-inbox-message-detail.png) | 消息详情、AI 规则兜底、模拟发送标注 |
| [19-reply-draft-adopted.png](screenshots/19-reply-draft-adopted.png) / [20](screenshots/20-reply-sent-mock.png) | 采用草稿、模拟回复成功 |
| [21-compose-dialog.png](screenshots/21-compose-dialog.png) / [22](screenshots/22-compose-sent-mock.png) | 新建发送弹窗与缺少 conversationId 报错 |
| [23-mark-complete.png](screenshots/23-mark-complete.png) / [24](screenshots/24-todos-after-mark.png) | 标记完成与待办页 |
| [25-trace-select-open.png](screenshots/25-trace-select-open.png) | 全链路回放（7 条事件，含模拟标注） |
| [26-nav-hover-tooltip.png](screenshots/26-nav-hover-tooltip.png) | 导航只有 hover tooltip |
| [27-accounts-card-click.png](screenshots/27-accounts-card-click.png) | 添加邮箱后的账号卡：头部“未配置”但列出账号 |
| [28-email-provider-options.png](screenshots/28-email-provider-options.png) | 邮箱服务商下拉选项 |
| [29-refresh-state.png](screenshots/29-refresh-state.png) | 刷新状态 toast，状态无变化 |
| [30a-after-dismiss.png](screenshots/30a-after-dismiss.png) | 点「稍后再说」后横幅仍在 |
| [32-vite-error-overlay.png](screenshots/32-vite-error-overlay.png) | 15:47 并发改动导致的 Vite 编译错误（环境事件，非产品结论） |
| [33-inbox-after-recovery.png](screenshots/33-inbox-after-recovery.png) / [34-connect-after-recovery.png](screenshots/34-connect-after-recovery.png) | 前端恢复后复核，无变化 |
| [35-email-delete-confirm.png](screenshots/35-email-delete-confirm.png) / [36](screenshots/36-connect-after-email-delete.png) | 删除假邮箱确认与清理后状态 |
| [37-dingtalk-copy-command.png](screenshots/37-dingtalk-copy-command.png) | 钉钉卡片唯一动作：复制 doctor 命令 |

## 附录 B：未覆盖 / 无法覆盖

- 未使用真实邮箱授权码、未扫码登录飞书/钉钉/企微，因此“真实授权成功后是否可用”无法验证；本报告只覆盖“白号客户能否走到授权”。
- 未测试移动端、暗色模式、附件上传上限、搜索/命令面板等次要功能。
- 未读取 `C:\Users\zx\.linkhub-white-backup-*`。
- 测试期间仓库被并发修改（`git status` 有多处 `M` 及新增 `appConfig`/`localConfig`），前端一度编译失败；报告基于 15:29–15:46 快照，恢复后复核关键页面无变化。
- 清理情况：假邮箱账号已通过页面「删除」移除；注入的 1 条飞书示例消息、1 次模拟回复与“标记完成”仍留在本机临时数据目录（无 UI 删除消息入口）；浏览器 profile 为 `%TEMP%\white-user-chrome3`。