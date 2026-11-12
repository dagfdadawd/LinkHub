# LinkHub 白号首次使用链路审计报告

> 审计对象：LinkHub（`C:\Users\zx\Desktop\LinkHub`，monorepo `unimsg-connector/`）
> 审计模式：**白号**（全新安装、零账号、零凭据）
> 审计时间：2026-11-12 15:28–15:45（UTC+8）
> 审计员：独立审计（只读；未改代码 / 配置 / `.env` / README，未 commit）
> 结论一句话：**白号客户无法仅凭界面完成「配置 → 授权 → 收发」；邮箱只能完成到「添加账号」（且本地账号不会真实收信），配置与生效环节必须手改 `.env` 并重启，钉钉/飞书授权入口在 Mock 态不可达，且有多处会误导客户的「已就绪 / 可刷新即通」承诺。**

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 白号能否仅凭界面完成「配置 → 授权 → 收发」？ | **不能**。4 个平台里只有邮箱的「添加账号」是界面闭环；配置（App 凭据 / 模式 / LLM Key）没有任何界面入口，只能改 `unimsg-connector/.env` 并重启后端。而且**界面添加的本地邮箱不会让运行态变成 real**（见 P0-3），即使重启也不会，除非显式 `MAIL_MODE=real`。 |
| `/api/onboarding` 是否诚实？ | **状态标签基本诚实，但有一处硬伤**：钉钉卡片说「连接本人账号后可真实收发」，而在当前 Mock 运行态即使登录了 dws，收发仍是 Mock（`identityChannelsReal=false`）。另外 `needsAction` 计数与「已就绪 0/4」自相矛盾。 |
| actions 是否都能执行？ | **不**。`form`/`link` 可用；`copy` 的飞书清单缺凭据落地步骤；`command` 缺工作目录（本机 `pnpm` 不在 PATH，实测失败）；`api` 里飞书「刷新连接状态」的 `path` 指向不存在的接口（404）。 |
| 钉钉「连接本人账号」在 Mock 下可达吗？ | **不可达**（onboarding 无该动作、账号页按钮被 Mock 抑制、弹窗自身也拒绝 Mock 登录）。后端 `/api/dingtalk/personal/login` 其实**没有** Mock 门禁，是前端自己挡住的。 |
| 邮箱表单测试失败给中文原因吗？ | **给**，且可理解（IMAP/SMTP 分别给原因 + 修复建议）。保存后 onboarding 也会联动，但「保存即算配置好」会让待处理数归零，制造虚假完成感。 |
| 文档与界面一致吗？ | **不一致**：`docs/quickstart.md` 路径 E、`README.md` 个人版段落、`docs/personal-identity.md` §3.4/§5.5 多处指向当前界面不存在的按钮 / 状态（详见 §5）。 |
| 安全与隔离 | **通过**：`/api/onboarding` 无任何 token/授权码；Mock 消息通道代码层面不真外呼；除 `/api/health` 外均要求 Bearer。 |

---

## 1. 审计范围 / 环境 / 方法

### 1.1 环境（Lead 准备，审计开始时实测）

| 项 | 值 | 证据 |
|---|---|---|
| 前端 | `http://127.0.0.1:5173`（Vite dev，接真实后端） | `GET /` 200；页面渲染真实 `missing` 变量（非 demoMode） |
| 后端 | `http://127.0.0.1:3001`，Bearer `dev-token` | `GET /api/health` 200 |
| `.env` | `unimsg-connector/.env`，仅 4 行：注释、`SERVER_PORT=3001`、`API_TOKEN=dev-token`、`DATA_DIR=C:/Users/zx/AppData/Local/Temp/linkhub-white-data` | 读取文件。**没有任何 `*_MODE` / 平台凭据 / LLM Key** |
| 平台模式 | 四平台 `mode=mock`、`identity=send:mock / receive:mock` | `/api/health`、`/api/onboarding` |
| 消息 | 0 条；health `received=0 / sent=0 / sentMock=0` | `/api/health`、`/api/messages` → `{"ok":true,"data":[]}` |
| 邮箱账号 | **审计开始时 0 个** | `/api/mail/accounts` → `accounts: []` |
| 钉钉 dws | 已内置：`tools/dws.exe`，`v1.0.68-beta.1`，`source=tools`，**未登录** | `/api/dingtalk/personal/status` → `authenticated:false` |
| LLM | 无 Key，规则兜底 | 启动日志代码 `index.ts:98-102`；`config.llm.mode` |
| 数据目录 | `C:\Users\zx\AppData\Local\Temp\linkhub-white-data` | `/api/mail/accounts.filePath` |

### 1.2 方法

1. **API 采集（只读）**：`/api/health`、`/api/onboarding`、`/api/accounts`、`/api/mail/accounts`、`/api/dingtalk/personal/status`、`/api/messages`、`/api/feishu/oauth/status`。
2. **失败分支测试（不落盘）**：`POST /api/mail/accounts/test` 用 obviously-fake 数据；UI 上用 `127.0.0.1:1` 作为 IMAP/SMTP，避免任何外部网络，只测失败提示。**未保存任何账号**。
3. **代码契约审查**：onboarding 组装、身份通道判定、发送 Mock 门禁、邮箱测试/保存、前端动作分发、空态组件。
4. **界面验证**：Chrome headless + CDP（`--remote-debugging-port=9236`），逐页截图并抽取可见文本与全部按钮；复用 `docs/qa/verification/tools/ui-probe.mjs`。
5. **文档对照**：`docs/quickstart.md` 路径 E、`README.md` 个人版段落、`docs/personal-identity.md` §3.4/§5.5、`docs/swap-accounts.md` §0.1。

### 1.3 约束与未执行项

- **未做**：登录真实飞书/钉钉/企微、输入真实凭据、向外部发消息、改 `.env`/代码/配置、删除并发审计写入的数据。
- 因此「钉钉登录后 onboarding 谎报 ready」一项是**代码路径复现**（含单测覆盖缺口），未执行真实登录；报告中标明「静态复现」。
- `.env` 缺失 / 为空的验证只做代码审查，未做破坏性重命名（遵守只读约束）。
- 审计期间检测到**另一个审计进程**（`C:\Users\zx\AppData\Local\Temp\flow-email-save.mjs`）在 15:31:16 写入了一条 obviously-fake 邮箱账号 `whitetestnotexist / w******@example.invalid`，随后进程退出但账号仍在。本报告把它作为「保存后状态联动」的观察样本，并明确：**该账号非本次审计写入，本次审计未保存任何数据**。收尾时该账号仍在（见 §7.3），建议由 Lead 统一清理。

---

## 2. 白号基线快照（15:29，0 账号）

### 2.1 `/api/health`

```json
{"ok":true,"received":0,"deduped":0,"sent":0,"sentMock":0,"failed":0,"dlq":0,
 "modes":{"feishu":"mock","dingtalk":"mock","wecom":"mock","mail":"mock"},
 "identities":{"feishu":{"send":"mock","receive":"mock"},"dingtalk":{"send":"mock","receive":"mock"},
               "wecom":{"send":"mock","receive":"mock"},"mail":{"send":"mock","receive":"mock"}},
 "envFile":{"path":"C:\\Users\\zx\\Desktop\\LinkHub\\unimsg-connector\\.env","mtime":"2026-11-12T07:27:53.212Z"},
 "startedAt":"2026-11-12T07:28:01.98Z"}
```

### 2.2 `/api/onboarding`（关键片段）

```json
"firstRun": true,
"overall": {"ready":0,"total":4,"needsAction":1},
"steps": [
 {"id":"mail","state":"needs_user_auth",
  "summary":"还没有邮箱账号。个人版可直接在页面添加（需要邮箱授权码）。",
  "actions":[{"id":"mail-add-account","kind":"form","label":"添加邮箱账号"},
             {"id":"mail-provider-help","kind":"link","label":"去邮箱网页版开启 IMAP/SMTP（QQ 邮箱示例）","url":"https://mail.qq.com"}],
  "detail":{"accounts":[],"mode":"mock"}},
 {"id":"dingtalk","state":"mock",
  "summary":"钉钉当前为演示模式（Mock）：不会连真实钉钉；连接本人账号后可真实收发。",
  "actions":[{"id":"dingtalk-doctor","kind":"command","label":"自检钉钉配置","command":"pnpm run doctor --platform=dingtalk"}],
  "detail":{"identity":{"state":"not_linked","linked":false,...},
            "dws":{"available":true,"version":"v1.0.68-beta.1","source":"tools"},
            "missing":["DINGTALK_CLIENT_ID","DINGTALK_CLIENT_SECRET","DINGTALK_AES_TOKEN","DINGTALK_AES_KEY"]}},
 {"id":"feishu","state":"mock",
  "actions":[{"id":"feishu-admin","kind":"link","url":"https://open.feishu.cn/app"},
             {"id":"feishu-admin-checklist","kind":"copy","text":"…（清单 5 条，无 .env 键名）"}],
  "detail":{"identity":{"state":"unavailable","hint":"未配置 FEISHU_APP_ID / FEISHU_APP_SECRET…"},
            "missing":["FEISHU_APP_ID","FEISHU_APP_SECRET","FEISHU_VERIFY_TOKEN"]}},
 {"id":"wecom","state":"mock",
  "actions":[{"id":"wecom-admin","kind":"link","url":"https://work.weixin.qq.com/"},
             {"id":"wecom-admin-checklist","kind":"copy","text":"…（清单第 4 条：把 WECOM_* 填到 .env 后重启 LinkHub）"}],
  "detail":{"missing":["WECOM_CORP_ID","WECOM_SECRET","WECOM_AGENT_ID","WECOM_TOKEN","WECOM_AES_KEY"]}}
]
```

### 2.3 `/api/accounts`（钉钉身份，白号关键矛盾点）

```json
{"platform":"dingtalk","mode":"mock","configured":false,
 "identity":{"effectiveSend":"mock","effectiveReceive":"mock","policy":"auto",
   "user":{"state":"not_linked","linked":false,"canLink":true,"linkMethod":"cli",
           "loginCommand":"C:\\Users\\zx\\Desktop\\LinkHub\\unimsg-connector\\tools\\dws.exe auth login"}}}
```

> 即：**接口明确说 `canLink: true`（dws 已内置、可登录），但 onboarding 和账号页都不给登录入口**。

---

## 3. 检查项清单

> PASS = 期望与实际一致；FAIL = 不一致 / 不可用 / 误导。
> 证据中的 `文件:行` 均指 `C:\Users\zx\Desktop\LinkHub` 下路径。

### 3.1 首启 / 向导自洽性

| 编号 | 检查项 | 期望 | 实际（证据） | 结果 |
|---|---|---|---|---|
| A01 | 首启横幅出现 | 白号首开出现 | 收件箱顶部出现「首次使用：先连接你自己的账号」+「去连接账号 / 稍后再说」；`audit-screenshots/inbox.png`、`screenshots/01-first-open.png` | **PASS** |
| A02 | 首启横幅文案与当前状态一致 | 不提示不存在的状态 | 横幅写「带『需管理员』的项需要企业管理员开通」，但当前 4 张卡没有任何「需管理员」标签（`OnboardingBanner.tsx:27-30`；API 四步 state 均非 `needs_admin`） | **FAIL** |
| A03 | `firstRun` / `overall` 计数真实 | 0 就绪时「待处理」应等于未就绪数 | 基线 `ready:0,total:4,needsAction:1`；并发审计保存 1 个（假）邮箱后 `needsAction:0`，页面显示「已就绪 0 / 4」「已就绪 0 项 · 待处理 0 项」。计数只统计 `needs_user_auth/needs_install/needs_admin`，`mock` 不计（`onboarding.ts:481-482`） | **FAIL** |
| A04 | 四步 `state` 与 health/真实状态一致 | 状态标签与运行态一致 | `mail=needs_user_auth`（0 账号）、其余 `mock`；与 `/api/health` 的 `mode=mock` 一致 | **PASS** |
| A05 | Mock 明确标注、不假称已连接 | 卡片写「演示模式 / 不会真实收发 / 模拟发送」 | 三卡均标「演示模式」，hints 写「本地模拟接收」「模拟发送」。`screenshots/02-connect.png` | **PASS** |
| A06 | 卡片 summary 不含虚假能力承诺 | 不要承诺 Mock 下能做到的事 | 钉钉 summary：「连接本人账号后可真实收发」。但当前运行态 `identityChannelsReal=false`（`identity.ts:46-51`），`effectiveSend/Receive=mock`（`identity.ts:308-323`），发送走 `mockSend`（`connectors/dingtalk.ts:142-153`） | **FAIL** |
| A07 | `kind=form` 动作可执行 | 点击打开表单 | CDP 点击「添加邮箱账号」→ `mail-account-form` 出现，含服务商/地址/授权码/高级设置；`audit-screenshots/07-connect-email-form.png` | **PASS** |
| A08 | `kind=link` 动作可达 | 官方后台/设置页可打开 | `https://open.feishu.cn/app` GET 200；`https://work.weixin.qq.com/` 200；`https://mail.qq.com` 200（HEAD 对飞书 404，GET 正常） | **PASS** |
| A09 | `kind=copy` 文本完整、能指导管理员 | 含回调 URL / 权限 / **凭据怎么写回 LinkHub** | 飞书清单含 scope、重定向 URL、事件订阅、发布、登录入口（`onboarding.ts:101-111`），**但没有「把 App ID/Secret 填到 `.env` 的哪个键、改完重启」**；企微清单第 4 条有（`onboarding.ts:126-134`） | **FAIL** |
| A10 | `kind=command` 命令可执行 | 客户复制即可运行 | 命令无工作目录；本机 `pnpm` 不在 PATH，`corepack pnpm run doctor --help` 也因根脚本内层 `pnpm` 调用失败（exit 1）。脚本本身存在、`doctor` 支持 `--platform`（`doctor.ts:48-67`） | **FAIL**（环境相关） |
| A11 | `kind=api` 的 `path` 真实存在 | path 可调用 | `dingtalk-status` → `GET /api/dingtalk/personal/status` 200；`feishu-status` → `/api/feishu/oauth/status` **404**（后端只有 `/api/feishu/oauth/start`、`/api/feishu/oauth/callback`，`routes/feishuOAuth.ts:136,190`；`onboarding.ts:386`） | **FAIL** |
| A12 | 没有「点了没用」的按钮 | 每个动作都能推进 | 钉钉卡片唯一动作是复制 doctor 命令，不能推进连接；文档/引导中的「连接本人账号」按钮在界面上不存在（见 C05/B03） | **FAIL** |
| A13 | 全局「刷新状态」可重新检测 | 点后重新拉取状态 | 顶栏「刷新状态」→ `store.refreshOnboarding()`（`ConnectPage.tsx:452-458`），文本会更新；但不改变「没有凭据」的事实 | **PASS** |
| A14 | `.env` 改动后提示重启 | 检测 mtime > startedAt | `checkEnvRestart`（`envRestart.ts:24-36`）+ 页面 Alert（`ConnectPage.tsx:493-511`）；当前 mtime 早于 startedAt，未误报 | **PASS** |

### 3.2 零凭据客户能否推进

| 编号 | 检查项 | 期望 | 实际（证据） | 结果 |
|---|---|---|---|---|
| B01 | 客户能**在界面里**填平台凭据 | 有输入表单（飞书 AppID/Secret、钉钉、企微、LLM Key） | 全站搜索无任何凭据输入；设置页只有外观/提醒/资料/快捷键/数据（`SettingsModal.tsx`）；服务端也没有写 `.env` 的接口（凭据仅在 `config.ts` 读取） | **FAIL** |
| B02 | 若只能改文件，向导说明「哪个文件、哪些键、如何生效」 | 明确路径 + 键名 + 重启 | ConnectPage **不渲染** `step.detail`（只渲染 summary/hints/actions，`ConnectPage.tsx:302-352,398-425`），所以飞书/钉钉的 `missing` 键名在向导页看不到；只有「平台账号」页显示（`AccountsPage.tsx:376-380`）。重启说明只在页脚一句（`ConnectPage.tsx:617-620`） | **FAIL** |
| B03 | Mock 下钉钉「连接本人账号」入口可达 | 卡片/账号页能点开登录 | onboarding 无 login 动作（`onboarding.ts:231-243`）；账号页 `canStart = actionsEnabled && !mockMode && …`，按钮被抑制（`AccountsPage.tsx:159,166,177-178`）；按钮清单实测两页均无「连接本人账号」；即便打开弹窗，`mockMode` 分支也只显示「无法登录真实钉钉账号」（`PersonalIdentityModal.tsx:868-876`） | **FAIL** |
| B04 | 钉钉白号不是死胡同 | 至少给「去后台 / 管理员清单 / 填什么」 | 钉钉卡只有 `pnpm run doctor --platform=dingtalk` 一条命令；`dingtalkAdminChecklist`（含 CLI 访问、浏览器登录）只在 `needs_admin` 分支下发（`onboarding.ts:307-328`），而 Mock 分支先命中，**永远看不到** | **FAIL** |
| B05 | 飞书卡片给后台链接 | 可打开开放平台 | 链接 200；清单含 scope/回调/事件订阅 | **PASS** |
| B06 | 飞书卡片+清单足以打通 | 管理员按清单能完成；客户知道怎么把凭据给 LinkHub | 清单第 5 条让客户回 LinkHub 点「连接飞书本人账号」，但 LinkHub 侧没有 App ID/Secret，按钮不会出现；清单没有 `.env` 键名/重启步骤 | **FAIL** |
| B07 | 企微卡片+清单足以打通 | 同上 | 链接 200；清单第 4 条明确「把 WECOM_* 填到 `.env` 后重启」（向导页仍无表单，受 B01 限制，但清单本身完整） | **PASS** |
| B08 | 有「我已配好，重新检测」路径 | 每卡可重检 | 只有页面级「刷新状态」；没有 per-card 重检按钮（非 ready 态不渲染，`ConnectPage.tsx:379-394`）；且改凭据后必须重启，刷新本身不会让状态变化 | **FAIL**（部分能力存在） |
| B09 | 邮箱测试失败给中文可理解原因 | 中文原因 + 建议 | API：`{"ok":true,"data":{"ok":false,"imap":{"detail":"连接被拒绝：127.0.0.1:1（connect ECONNREFUSED…）","hint":"目标端口未开放…IMAP 993、SMTP 465/587…"}}}`；UI Alert「连接测试失败」+ 两条明细；`audit-screenshots/08-mail-test-failure.png` | **PASS** |
| B10 | 保存邮箱后 onboarding 状态随之变化 | 账号出现、状态联动 | 并发保存的 `whitetestnotexist` 出现后：mail 由 `needs_user_auth` → `mock`，summary 变「已配置 1 个邮箱账号…但当前为演示模式」，`needsAction` 1→0；保存接口返回 `hotReloaded:true`（`routes/mailAccounts.ts:84-101`） | **PASS** |
| B11 | 保存前要求测试通过 | 未通过不让保存 / 至少强提示 | 「保存账号」不看 `result.ok`（`MailAccountForm.tsx:116-138`）；后端 `POST /api/mail/accounts` 也不做连通性校验（`routes/mailAccounts.ts:84-97`）。可保存不可用账号，并让「待处理」归零 | **FAIL** |
| B12 | LLM Key 有配置入口 | 界面可填 / 向导提示 | 无任何 UI；onboarding 无 LLM 步骤；只有收到消息后详情页显示「规则兜底」badge（`AiSuggestion.tsx:30-36`）。无 Key 时 `config.llm.mode=mock`，启动日志说明（`index.ts:98-102`） | **FAIL** |
| B13 | 管理员开通后客户能继续 | 文档承诺「刷新即可」 | 管理员只在平台侧开通，LinkHub 侧仍无凭据；刷新后仍 `mock`（`onboarding.ts:363-372` 飞书 mock 分支优先）。必须手改 `.env` + 重启 | **FAIL** |
| B14 | 界面添加的邮箱能真实收信 | 保存后 mode 变 real / 下一轮 IMAP 生效 | 实测保存 1 个本地账号后 `/api/accounts` 仍 `mail.mode="mock"`、`configured=false`、`canReceive=false`；`health.modes.mail="mock"`。代码上 `config.runtime` 只在启动时按 `.env` 计算（`config/runtime.ts:713-727`），本地账号合并不重算（`services/mailAccounts.ts:297-309`），轮询器 `mode!=='real'` 直接跳过（`stream/mailPoller.ts:307-310`）；重启时 runtime 也在加载本地账号之前算好。**只有显式 `MAIL_MODE=real` 能真实收信**（`auto` 不够） | **FAIL** |

### 3.3 空态与冷启动

| 编号 | 检查项 | 期望 | 实际（证据） | 结果 |
|---|---|---|---|---|
| C01 | 收件箱空态有可执行引导 | 有事可做 | 横幅 +「3 步上手」+ 空态「注入飞书/钉钉/企微示例」按钮（`QuickStart.tsx:50-88`）；`audit-screenshots/inbox.png` | **PASS** |
| C02 | 待办空态有可执行引导 | 指路到收件箱/注入/连接 | 「暂无待办 / 当消息被识别为「待办」类型时，会出现在这里。」无任何按钮或链接（`TodosPage.tsx:87-88`） | **FAIL** |
| C03 | 追踪空态有可执行引导 | 指路 | 「选择一条消息 / 从上方下拉框中选择消息」，下拉为空，无入口（`TracePage.tsx:119-120`） | **FAIL** |
| C04 | 平台账号页 0 配置时说明清楚 | 显示未配置/缺变量 | 四卡均「Mock 模拟 / 未配置 / 不可接收 / 不可发送」+「缺少环境变量：…」；`audit-screenshots/accounts.png` | **PASS** |
| C05 | 平台账号页有连接入口 | 能点「连接本人账号 / 查看连接步骤」 | 卡片按钮区实际为空（`AccountsPage.tsx:241-268` 条件不满足）；CDP 实测按钮只有「打开「连接账号」向导」「运行指标…」 | **FAIL** |
| C06 | Mock 发送标注清楚 | 明确「模拟发送」 | `message.ts:431-446` 写「模拟发送（本地 Mock，未调用真实平台接口）」；UI `format.ts:114,137` 一律「模拟发送」；`IdentityTag` 也用「模拟」 | **PASS** |
| C07 | 首启引导不冗余/不互相打脸 | 一处主引导 | 横幅 + 3 步上手 + 空态注入 同时出现；其中 3 步上手第 2 步让去账号页点「连接本人账号」，该按钮不存在（`FirstRunGuide.tsx:217-226`） | **FAIL** |

### 3.4 文档一致性

> 详细行号对照见 §5，这里只给结论。

| 编号 | 检查项 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| D01 | `docs/quickstart.md` 路径 E 的状态标签 | 与界面一致 | 文档说钉钉/飞书/企微会标「需管理员」（L170）；实际三卡都是「演示模式」 | **FAIL** |
| D02 | 路径 E 钉钉步骤可照做 | 点「刷新状态」→「用浏览器登录」 | 白号卡是「演示模式」，刷新不会变「需本人授权」，也没有登录按钮（L188-192） | **FAIL** |
| D03 | 路径 E 飞书步骤可照做 | 管理员配好 → 卡片变「需本人授权」→ 授权 | 缺「App ID/Secret 填 `.env` + 重启」步骤，管理员配完仍「演示模式」（L193） | **FAIL** |
| D04 | 路径 E 企微步骤可照做 | 管理员配好 → 刷新 | 清单里有 `.env`+重启，但正文只说「刷新」，且向导页无凭据入口（L194） | **FAIL** |
| D05 | 路径 E 邮箱步骤可照做 | 添加 → 测试 → 保存 → 收信 | 表单/测试/保存/热加载均可用；但本地账号不会让运行态变 real（B14），L185「保存后立即生效、45s 出现新邮件」不成立；Mock 下是否收信取决于 `.env`（L181 只提示了模式，没提示必须显式 `real`） | **FAIL** |
| D06 | 路径 E「改完 .env 需重启」 | 页面有提示 | 有（`ConnectPage.tsx:493-511`），但仅在 mtime 变化后出现 | **PASS** |
| D07 | `README.md` 个人版段落 | 与实际一致 | L22/L198/L347 称「逐项连接」「真实状态与下一步动作」「需管理员」；L653 称「开通后刷新即可」——均与白号界面不符 | **FAIL** |
| D08 | `personal-identity.md` §3.4 管理员清单 | 与 actions 一致 | L92 称卡片标「需管理员」；L97 称钉钉有「打开钉钉开发者后台」「复制管理员开通清单」——实际钉钉卡只有 doctor 命令 | **FAIL** |
| D09 | `personal-identity.md` §5.5 连接入口 | 两处入口可点 | L308-309 说从「连接账号」点「用浏览器登录」、从账号页点「连接本人账号」——两处按钮均不存在 | **FAIL** |
| D10 | `swap-accounts.md` §0.1 | 图形向导能连本人账号 | L35 称授权中心「钉钉『用浏览器登录』/ 飞书『连接飞书本人账号』」；白号均不可达 | **FAIL** |
| D11 | 文档内部自洽 | 同一事实只有一种说法 | §5.4 L302 正确写明「钉钉只配本人身份需显式 `DINGTALK_IDENTITY=user`」，但路径 E 与 onboarding 都说「连接本人账号后可真实收发」 | **FAIL** |

### 3.5 错误与边界

| 编号 | 检查项 | 期望 | 实际（证据） | 结果 |
|---|---|---|---|---|
| E01 | 零凭据不崩、全 mock | 正常启动 | 四平台 `mock(auto)`，health 200，onboarding 200；启动日志按模式/告警打印（`index.ts:75-103`） | **PASS** |
| E02 | `.env` 缺失/为空不崩 | 降级 + 可诊断 | `dotenv` 加载不存在文件不抛错（`config.ts:15-16,42-45`）；`envFileSnapshot()` 返回 `null`（`config.ts:61-68`）；前端 `envFile:null` 不误报（`httpApi.ts:237-241`、`envRestart.ts:27`） | **PASS**（代码审查） |
| E03 | 空 `API_TOKEN` 行为 | 回退 + 告警，不关鉴权 | 显式空 → `dev-token` + `modeWarnings`（`config.ts:139-143`）；启动日志打印 `auth=Bearer dev-token(默认/空值回退)`（`index.ts:130`） | **PASS** |
| E04 | `/api/onboarding` 不泄漏 secret | 无 token/授权码/密钥 | 全文扫描：无 `dev-token`、无 `Bearer`、无 `authCode`、无 `"secret":"值"`；只有变量名（21 处 `SECRET/TOKEN/KEY` 均为名称与说明） | **PASS** |
| E05 | Mock 模式不真外呼平台 | 代码门禁 | 钉钉 `if (!personalReal) return mockSend(...)`（`connectors/dingtalk.ts:142-153`）；`mockSend` 只写内存 sentBox（`connectors/base.ts:27-38`）；邮箱轮询 `modeOf(MAIL)!=='real'` 直接跳过（`stream/mailPoller.ts:306-310`）；身份通道 Mock 不探测（`identityChannels.ts:69-73`） | **PASS** |
| E06 | Mock 下「测试连接」不应真连 | 或明确提示会真连 | `POST /api/mail/accounts/test` 不看模式，始终探测 IMAP/SMTP（`routes/mailAccounts.ts:63-82`、`services/mailAccountTest.ts:54-90`）；页面卡片却写「不会真实连 IMAP 收信」，未说明「测试连接会真连一次服务器」 | **FAIL**（文案） |
| E07 | 除 health 外都要鉴权 | 401 | 无 Bearer：`/api/onboarding`、`/api/accounts`、`/api/mail/accounts`、`/api/dingtalk/personal/status` 全 401；仅 `/api/health` 200 | **PASS** |
| E08 | 不暴露本机敏感路径 | 不暴露 | `/api/onboarding.envFile.path`、`mail.filePath` 返回绝对路径；`/api/health` 公开无鉴权也返回 `.env` 绝对路径与 mtime | **FAIL**（低危，本地应用） |

---

## 4. 阻断问题分级

### P0（阻断首次使用闭环 / 违反「不假称已连接」）

#### P0-1 零凭据客户没有任何「凭据配置」界面，文档承诺的「管理员开通后刷新即可」不成立

- **复现路径**
  1. 白号打开 `/connect`：飞书、钉钉、企业微信均为「演示模式」，页面只有「打开后台 / 复制清单 / doctor 命令」，没有任何输入框。
  2. 打开「平台账号」：能看到「缺少环境变量：FEISHU_APP_ID…」，但只有文字，无输入、无「连接」按钮。
  3. 打开「设置」：只有外观/提醒/资料/快捷键/数据，无凭据页。
  4. 按 `docs/quickstart.md` L193 让管理员配好飞书应用，回页面点「刷新状态」：仍是「演示模式」（LinkHub 进程里没有 `FEISHU_APP_ID/SECRET`）。
- **影响**：白号 4 个平台中，**没有一个能仅靠界面到达「授权」或「收发」**。邮箱只能「添加账号」，且 Mock 下不会真实收信。文档把责任推给「企业管理员」，但管理员无法替客户把凭据写进本机 `.env`。
- **证据**：`onboarding.ts:137-199,331-434`（无凭据输入动作）；`SettingsModal.tsx:126-333`（无凭据页）；`config.ts:42-45`（只在启动时读 `.env`）；`docs/quickstart.md:170,193`；`docs/personal-identity.md:92,101`；截图 `screenshots/02-connect.png`、`audit-screenshots/accounts.png`。
- **建议修复**
  - **[代码可修，MVP]** 在「连接账号」/「平台账号」加「配置凭据」抽屉：按 `missing` 渲染键名，写入 `unimsg-connector/.env`（保留注释、只改目标键），保存后提供「重启后端」按钮（桌面版可自动重启）或热加载；至少给「复制 `.env` 模板 + 打开文件所在目录 + 重启命令」。
  - **[文档可修，立即]** 在路径 E 每平台补「填哪些键、填到哪个文件、改完重启」；删除「开通后刷新即可」。
  - **[平台资质限制]** 飞书/企微/钉钉应用本身仍需企业管理员开通，这点无法绕过；但「管理员开通 → LinkHub 有凭据」这一步必须由产品承接。

#### P0-2 钉钉登录成功后 onboarding 会谎报「已就绪 / 以本人身份收发」，实际仍是 Mock

- **复现路径（静态复现，未执行真实登录）**
  1. 白号执行 `tools\dws.exe auth login`（`docs/personal-identity.md:308-319` 推荐路径）。
  2. 登录成功后 `resolveIdentity(DINGTALK).user.linked=true`。
  3. 打开 `/connect`：`dingtalkStep` 先命中 `view.user.linked` 分支（`onboarding.ts:245-250`），返回 `state:'ready'`，summary「已连接钉钉本人账号…消息以本人身份收发」。
  4. 但 `runtime.mode` 仍是 `mock`（没有改 `.env`），`identityChannelsReal=false`（`identity.ts:46-51`），`effectiveSend/Receive` 仍是 `mock`（`identity.ts:308-323`），发送实际走 `mockSend`（`dingtalk.ts:148-152`）。
- **影响**：客户按文档完成「登录」后，向导与进度会告诉他已经就绪、以本人身份收发；实际消息只进本地 sentBox，**外部没有任何人收到**。这是本项目最敏感的「不假称已连接」红线。
- **证据**：上列代码；单测 `onboarding.test.ts:156-164` 的 ready 用例只覆盖 `runtime.mode='real'`（`runtime()` 默认 `mode:'real'`，`onboarding.test.ts:35-48`），**没有 linked+mock 用例**；`docs/personal-identity.md:302` 才是正确事实（必须显式 `DINGTALK_IDENTITY=user`）。
- **建议修复**
  - **[代码可修]** `dingtalkStep` 的 `ready` 判定加 `effectiveSend !== 'mock'`（或 `identityChannelsReal(Platform.DINGTALK)`）；`linked && mock` 时单独给状态「已登录，但通道仍为模拟，需切换本人身份模式」。
  - **[代码可修]** 登录成功后自动把 `DINGTALK_IDENTITY` 切到 `user`（或提示一键切换并重启），让「登录即可用」成立。
  - **[测试]** 增加 `linked + runtime.mode='mock'` 用例，锁死不得为 `ready`。

#### P0-3 界面添加的邮箱账号不会真实收信：运行态 `mode` 不随本地账号变化，提示的 `MAIL_MODE=auto` 也不够

- **复现路径**
  1. 白号（`.env` 无 `MAIL_MODE`）在「连接账号 → 邮箱」添加一个真实邮箱账号（本地账号）。
  2. 保存响应 `hotReloaded:true`；页面与文档说「保存后立即生效、无需重启」「下一轮轮询出现新邮件」（`quickstart.md:185`），onboarding 提示「改 `MAIL_MODE=auto/real` 才会真实收信」（`onboarding.ts:165`）。
  3. 实测：`GET /api/accounts` 里邮箱仍是 `mode:"mock"`、`configured:false`、`canReceive:false`；`GET /api/health` 仍 `modes.mail:"mock"`（并发审计写入 1 个本地账号后实测）。
  4. 重启后端（仍不写 `MAIL_MODE`）——**代码推导，未实际重启**（避免打断共享环境）：`config.runtime` 在**加载本地账号文件之前**就按 `.env` 算好（`config.ts:86-91`、`config/runtime.ts:713-727`），仍是 `mock`，轮询器仍跳过。
  5. 只有 `.env` 显式 `MAIL_MODE=real` 才会真正连 IMAP（`auto` + 无 `.env` 账号仍是 mock）；把账号写进 `.env`（`MAIL_QQ_ADDRESS/AUTH_CODE`）也能 real。
- **影响**：邮箱是文档宣称「个人版自己能完成」的唯一平台；真实客户按界面添加后**永远收不到邮件**，而提示的 `auto` 选项同样无效。这是「配置 → 收发」在邮箱路径上的实质断点，且被「热加载」文案掩盖。
- **证据**：`config.ts:86-91`（`mailParsed`/`mailEnabled` 只取 `.env`）；`config/runtime.ts:719-727`（`auto` 且 `!mailEnabled` → mock；`cap` 也来自启动时 `.env`）；`services/mailAccounts.ts:297-309`（`applyMerged` 只改 `config.mail.accounts`/`enabled`，不重算 `config.runtime`）；`stream/mailPoller.ts:292-310`（`modeOf(MAIL)!=='real'` 直接 return）；`index.ts:57-66`（变更后仅在 `mode==='real'` 时启动轮询）；全仓无运行期重算 runtime（`grep` 仅测试里改 `config.runtime`）。
- **建议修复**
  - **[代码可修，MVP]** 本地账号变更后重算邮箱运行画像（`mode/configured/canReceive/canSend`），或在「保存账号」后显式要求 `MAIL_MODE=real` 并给出写入/重启按钮。
  - **[代码可修]** `applyMerged` 至少把 `config.runtime[MAIL]` 的 `configured/canSend/canReceive` 与 `enabled` 对齐，避免「有账号但仍显示未配置」。
  - **[文档可修]** 把 `quickstart.md:185` 与 onboarding hint 改为「本地账号要真实收信，需在 `.env` 设 `MAIL_MODE=real` 并重启（`auto` 不够）」；或先修代码再改文案。

### P1（严重缺口 / 会卡住客户或误导）

#### P1-1 钉钉 Mock 态是死胡同：onboarding 只给 doctor，账号页无按钮，弹窗拒绝登录

- **复现**：白号 `/connect` 钉钉卡只有「命令 pnpm run doctor --platform=dingtalk」；`/accounts` 钉钉卡身份块无按钮；API 却返回 `canLink:true`、`loginCommand=...tools\dws.exe auth login`。即使通过其他方式打开弹窗，`mockMode` 也会显示「当前平台通道是 Mock 模拟，无法登录真实钉钉账号」（`PersonalIdentityModal.tsx:868-876`）。
- **影响**：dws 已内置、后端 `/api/dingtalk/personal/login` 也**没有** Mock 门禁（`routes/dingtalkPersonal.ts:102-126`），这是白号最容易走通的一条真实身份路径，却被前端完全挡住。客户只能自己开终端执行 `dws auth login`（普通用户不会）。
- **建议修复**：**[代码可修]** `dingtalkStep` 在 `canLink` 时无论 mode 都下发 `dingtalk-login`；`AccountsPage` 允许 `mockMode && canLink` 打开弹窗；`PersonalIdentityModal` 允许登录并提示「登录后还需切到本人身份模式」；`ConnectPage.runApiAction` 去掉 `state==='mock'` 的一刀切拦截（`ConnectPage.tsx:212-218`）。
- **证据**：`onboarding.ts:231-243`、`AccountsPage.tsx:159-178`、`PersonalIdentityModal.tsx:868-876`、`/api/accounts` 响应、CDP 按钮清单。

#### P1-2 进度计数误导：0/4 就绪却「待处理 0 项」，保存一个不可用邮箱即可归零

- **复现**：基线 `已有 0/4 就绪 · 待处理 1 项`；并发写入一条 obviously-fake 邮箱账号后变成 `0/4 就绪 · 待处理 0 项`（`audit-screenshots/connect.png` 可见）。该账号是保留域名 `example.invalid`，不可能真实收信。
- **影响**：客户会认为「没有待办了」，实际 4 个平台都不可真实使用；与文档「演示模式 → 按卡片提示开启真实配置」（`quickstart.md:181`）直接矛盾。
- **建议修复**：**[代码可修]** `needsAction` 计入「因缺配置而降级为 mock」的平台（或至少把文案改成「4 项均未真实可用」）；`ready<total` 时不得显示「待处理 0 项」；邮箱步骤区分「已保存」与「已验证/已生效」。
- **证据**：`onboarding.ts:481-482`、`ConnectPage.tsx:583-601`、前后两次 API `needsAction` 1→0。

#### P1-3 飞书清单缺少「凭据写回 + 重启」，且向导页不显示缺失键名

- **复现**：点「复制管理员开通清单（含回调 URL / 权限）」→ 清单 5 条只讲开放平台侧；第 5 条让客户回 LinkHub 点「连接飞书本人账号」，但此时 LinkHub 没有 App ID/Secret，按钮不会出现。向导页不渲染 `detail.missing`，客户在 `/connect` 看不到 `FEISHU_APP_ID` 等键名（要去 `/accounts` 才看到）。
- **影响**：即使管理员完全照做，客户仍卡在「凭据怎么进来」。
- **建议修复**：**[文档可修+代码可修]** 清单增加第 6 条「把 App ID/Secret/Verify Token 填到 `unimsg-connector/.env` 的 `FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_VERIFY_TOKEN`，重启后端」；`ConnectPage` 渲染 `step.detail.missing` 并给「打开配置」入口。
- **证据**：`onboarding.ts:101-111`、`ConnectPage.tsx:302-352`、`accounts.png` 与 `connect.txt` 对比。

#### P1-4 文档在关键路径上指向不存在的按钮/状态（详见 §5）

- **影响**：客户按 `quickstart.md` 路径 E 第 4 步「刷新状态 → 用浏览器登录」操作时，页面没有该按钮；按 §5.5 去账号页点「连接本人账号」，也没有。第一次使用即失败，且会怀疑是自己操作错了。
- **建议修复**：**[文档可修]** 以白号实测为准重写路径 E 的状态表与分支（增加「未配置凭据」分支）；**[代码可修]** 或让界面真正提供文档承诺的按钮（推荐，见 P1-1/最小功能集）。

#### P1-5 首启「3 步上手」第 2 步引导到不存在的按钮，并被 quickstart 背书

- **复现**：首启收件箱 →「3 步上手」第 2 步：「到『平台账号』页点『连接本人账号』」；实际账号页无此按钮（CDP 按钮清单）。`quickstart.md:55` 还专门宣传这一步。
- **影响**：这是新客户最可能照做的第一条指引，直接走进死胡同。
- **建议修复**：**[代码可修]** 文案改为「到『连接账号』页配置凭据/登录」，或按钮真正可用；**[文档可修]** 同步 L55。

#### P1-6 `feishu-status` 动作的 path 指向不存在的接口（404）

- **复现**：带 Bearer `GET /api/feishu/oauth/status` → 404（路由根本不存在）。
- **影响**：当前前端对 `*-status` 特殊处理，未真正调用（`ConnectPage.tsx:208-211`），所以页面没炸；但这是公开契约里的坏 path，桌面端/脚本/后续复用会踩。
- **建议修复**：**[代码可修]** 改成 `/api/accounts`（或新增 status 路由）；补一条契约测试。

### P2（体验/文案/次要）

| 编号 | 问题 | 证据 | 建议 |
|---|---|---|---|
| P2-1 | 邮箱卡片写「当前邮箱通道为模拟模式（`MAIL_MODE=mock`）」，但 `.env` 根本没有 `MAIL_MODE`，实际是 `auto` 无凭据回退；且 `auto` 对本地账号也不足以启用真实收信（P0-3） | `onboarding.ts:165`；`.env` 4 行；`/api/accounts` `policy:"auto"` | **[代码可修]** 文案改为「未配置账号/凭据，auto 已回退模拟」；若要真实收信须显式 `MAIL_MODE=real` |
| P2-2 | 邮箱测试失败 hint 让「核对 `.env` 的 host/端口」，但页面表单保存的是 `mail-accounts.json`，不是 `.env` | `mailAccountTest.ts:72`；`audit-screenshots/08-mail-test-failure.txt` | **[代码可修]** 区分「页面添加」与「.env 来源」两种提示 |
| P2-3 | 保存账号不要求测试通过，可存一个完全不可用的账号 | `MailAccountForm.tsx:116-138`；`routes/mailAccounts.ts:84-97` | **[代码可修]** 未测试/测试失败时二次确认，或标记「未验证」 |
| P2-4 | 待办空态不可执行 | `TodosPage.tsx:87-88` | **[代码可修]** 加「去收件箱 / 注入示例 / 连接账号」按钮 |
| P2-5 | 追踪空态不可执行（下拉为空，无入口） | `TracePage.tsx:119-120` | **[代码可修]** 加「去收件箱选一条」链接 |
| P2-6 | LLM 无配置入口、无 onboarding 提示；白号只有收到消息后才看到「规则兜底」 | `SettingsModal.tsx`；`AiSuggestion.tsx:30-36`；`index.ts:98-102` | **[代码可修]** 设置页增加「AI 模型」页，或在向导中列「可选：LLM」 |
| P2-7 | `command` 动作缺工作目录；本机 `pnpm` 不在 PATH，实测 `corepack pnpm run doctor --help` 失败 | `onboarding.ts:240`；`FirstRunGuide.tsx:143,217`；实测 exit 1 | **[代码可修/文档可修]** 命令前带 `cd unimsg-connector`，并提供 `corepack pnpm` 回退 |
| P2-8 | 钉钉管理员清单（含 CLI 访问与登录指引）在 Mock 态永远不可达 | `onboarding.ts:307-328` vs `231-243` | **[代码可修]** 把清单作为 Mock 态的第二动作下发 |
| P2-9 | 首启横幅说「带『需管理员』的项」但当前无该标签；横幅+3步+注入三重引导叠加 | `OnboardingBanner.tsx:27-30`；`inbox.png` | **[代码可修]** 按实际 state 动态措辞；考虑合并引导 |
| P2-10 | `/api/health` 公开返回 `.env` 绝对路径与 mtime（本地应用，低危） | `GET /api/health`（无 Bearer 200） | **[代码可修]** 公开 health 只给 `envFile: {present:true}` 或路径 basename |
| P2-11 | 飞书「打开后台」HEAD 返回 404（GET 200），部分链接检查工具会误报 | 实测 | 无需修；记录 |
| P2-12 | Mock 下「测试连接」会真实连 IMAP/SMTP，但页面写「不会真实连 IMAP 收信」，未说明测试会连 | `mailAccountTest.ts`；`onboarding.ts:165` | **[代码可修]** 测试按钮旁加一句「测试会真实连接服务器一次」 |

---

## 5. 与文档不一致清单（文件:行号 → 承诺 → 实际）

| # | 文件:行 | 文档承诺 | 白号实际 | 建议 |
|---|---|---|---|---|
| 1 | `docs/quickstart.md:170` | 「钉钉/飞书/企微需要企业管理员先开通，页面会用『需管理员』如实标出」 | 三卡全部是「演示模式」，没有任何「需管理员」标签 | 文档按实测改；或代码在缺凭据时标「需配置/需管理员」 |
| 2 | `docs/quickstart.md:177-182` | 状态 Tag 表：需本人授权→点登录；需管理员→发清单后刷新；演示模式→按卡片提示开启真实配置 | 白号三卡是演示模式，但钉钉卡没有任何「开启真实配置」提示；飞书卡不显示缺哪些键；无一张卡有登录按钮 | 增加「未配置凭据」状态与动作；mock 卡显示 missing + 配置入口 |
| 3 | `docs/quickstart.md:178` | 「需本人授权 … 点卡片上的按钮（钉钉『用浏览器登录（推荐）』/ 飞书『连接飞书本人账号』）」 | 白号无这两个按钮（两页 CDP 按钮清单均无） | 同 P1-1 |
| 4 | `docs/quickstart.md:180` | 「需管理员 … 开通后回本页点『刷新状态』」 | 白号不出现需管理员；且刷新不会让缺凭据的平台变可用 | 删除「刷新即可」，补凭据写入+重启 |
| 5 | `docs/quickstart.md:188-190` | 钉钉：点「刷新状态」→ 变成「需本人授权」→ 点「用浏览器登录（推荐）」 | 白号钉钉卡 `state=mock`；刷新后仍 mock；无登录动作 | 补「Mock/未配置」分支，或让按钮可用 |
| 6 | `docs/quickstart.md:192` | 「若卡片是『需管理员』：… 开通后回本页刷新再登录」 | 该分支在 Mock 态不可达（mock 分支先命中） | 同上 |
| 7 | `docs/quickstart.md:193` | 飞书：「管理员配好后卡片从『需管理员』变为『需本人授权』→ 点连接」 | 管理员配好 ≠ LinkHub 有 App ID/Secret；卡片仍「演示模式」，无连接按钮 | 补 `.env` 键名 + 重启 + 再授权三步 |
| 8 | `docs/quickstart.md:194` | 企微：「管理员配好后再刷新」 | 还需把 `WECOM_*` 填 `.env` 并重启（清单第 4 条有，正文没写） | 正文补一句 |
| 9 | `docs/quickstart.md:55` | 「3 步上手…第 2 步直接引导『连接本人账号』」 | 第 2 步指向的按钮在账号页不存在 | 改文案或让按钮可用 |
| 10 | `README.md:22` | 「双击 App →『连接账号』→ 按 邮箱→钉钉→飞书→企微 逐项连接」 | 只有邮箱可添加；其余三项无连接入口 | 标注「需先配置 `.env` 凭据」 |
| 11 | `README.md:198` | 「状态…如实标注，管理员项给可复制清单与官方后台深链」 | 钉钉卡既无后台链接也无清单（只有 doctor） | 同 P2-8 |
| 12 | `README.md:347` | 「显示真实状态…与下一步动作」 | 钉钉「下一步动作」= 复制一条终端命令，不能推进连接 | 补动作或改文案 |
| 13 | `README.md:653` | 「『连接账号』页会标『需管理员』…开通后刷新即可」 | 标签是「演示模式」；刷新不能补凭据 | 改为「需在 `.env` 填凭据并重启」 |
| 14 | `docs/personal-identity.md:92` | 「卡片标『需管理员』，并提供打开后台 + 复制清单」 | 白号三卡均「演示模式」；钉钉无后台链接/清单 | 同 #1 / P2-8 |
| 15 | `docs/personal-identity.md:97` | 钉钉动作：「打开钉钉开发者后台」「复制管理员开通清单」 | 钉钉卡实际动作只有 `pnpm run doctor --platform=dingtalk` | 让清单在 Mock 态也下发 |
| 16 | `docs/personal-identity.md:101` | 「管理员开通后…点『刷新状态』；只有变成『需本人授权/已就绪』才说明生效」 | 缺凭据时永远变不了；「已就绪」还可能是 P0-2 的假 ready | 文档补凭据步骤；代码修 ready 判定 |
| 17 | `docs/personal-identity.md:154` | 飞书：从「连接账号」→ 飞书卡片点「连接飞书本人账号」 | 白号飞书卡无此按钮 | 同 P1-1/3 |
| 18 | `docs/personal-identity.md:308-309` | 钉钉：从「连接账号」点「用浏览器登录（推荐）」；或账号页点「连接本人账号」 | 两处均无按钮 | 同 P1-1 |
| 19 | `docs/personal-identity.md:302` | 「只配本人身份…显式 `DINGTALK_IDENTITY=user` 才会以本人身份真实收发」 | **文档正确**；但路径 E / onboarding 与它矛盾（说登录即可真实收发） | 以 §5.4 为准，修正路径 E/onboarding |
| 20 | `docs/swap-accounts.md:35` | 授权中心图形向导可「钉钉『用浏览器登录』/ 飞书『连接飞书本人账号』」 | 白号不可达 | 同 P1-1 |
| 21 | `docs/swap-accounts.md:36` | 凭据类「必须改 `.env` 并重启」 | **文档正确**，但与路径 E 的「刷新即可」矛盾 | 以本条为准统一 |
| 22 | `docs/quickstart.md:185` | 「保存后立即生效、无需重启；收件箱在下一轮轮询（45s）出现新邮件」 | 本地账号不改变运行态 `mode`（仍 mock）；重启后 `auto` 仍 mock；**只有显式 `MAIL_MODE=real` 才能真实收信**（B14/P0-3） | 改文档或修代码（推荐修代码） |
| 23 | `docs/quickstart.md:186` | 本地账号文件路径/来源说明 | `/api/mail/accounts.filePath` = `C:\Users\zx\AppData\Local\Temp\linkhub-white-data\mail-accounts.json`，与文档「`DATA_DIR/mail-accounts.json`」一致；本地条目标记「本地」可删，`.env` 来源不可删（`routes/mailAccounts.ts:45-61,103-122`） | 无需改 |

---

## 6. 结论与最小功能集

### 6.1 白号客户能否仅凭界面完成「配置 → 授权 → 收发」？

**不能。** 现状拆解：

| 阶段 | 邮箱 | 钉钉 | 飞书 | 企业微信 |
|---|---|---|---|---|
| 配置（凭据/模式） | 可添加账号（表单）；但本地账号不会让 mode 变 real，需显式 `MAIL_MODE=real` | 无入口（只有 doctor 命令） | 无入口 | 无入口 |
| 授权 | 不需要（授权码随账号） | 有 dws 但入口不可达 | OAuth 入口不可达 | 不需要（应用级） |
| 收发 | Mock 不真实收信；本地账号即使重启也不会 real（需改 `.env`） | Mock；需改模式/身份+重启 | Mock；需凭据+重启 | Mock；需凭据+重启 |

**可用的部分**：邮箱表单 / 测试失败提示 / 保存热加载（仅账号存储层，不等于真实收信）、后台链接、复制清单、Mock 标注、空收件箱注入、密钥卫生、无外呼契约。
**断点**：配置凭据没有界面；Mock 态把「未配置」包装成「演示模式」并从待处理里剔除；钉钉/飞书的登录入口被 Mock 抑制；文档承诺的按钮/状态不存在。

### 6.2 最小功能集（MVP，按优先级）

1. **凭据配置向导（P0）**：一个「平台配置」抽屉/页面，按 `/api/onboarding` 的 `missing` 列出键名与用途，提供输入框写入 `unimsg-connector/.env`（或独立 secrets 文件），保存后「一键重启后端 / 热加载」；桌面版直接重启子进程。至少覆盖：
   - 飞书：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFY_TOKEN`（或长连接说明）
   - 钉钉：`DINGTALK_CLIENT_ID/SECRET` 或「仅本人身份」`DINGTALK_IDENTITY=user`
   - 企微：`WECOM_CORP_ID/SECRET/AGENT_ID/TOKEN/AES_KEY`
   - 邮箱：`MAIL_MODE=real`（**不是 auto**，见 P0-3）；LLM：`OPENAI_API_KEY` 等
   - 每项写「保存后需重启」并在重启后自动刷新状态。
2. **邮箱运行态修正（P0）**：本地账号变更后重算 `config.runtime[MAIL]`（`mode/configured/canReceive/canSend`），或保存后明确要求 `MAIL_MODE=real` 并给写入+重启入口；否则「界面添加即用」不成立。
3. **状态机与计数修正（P0）**：区分「未配置（Mock 回退）」与「主动演示」；`ready<total` 时不得显示「待处理 0 项」；把「缺配置的平台」计入待处理。
4. **钉钉本人身份入口（P1）**：Mock/未配置态也允许点「连接本人账号」（后端已支持），登录成功后自动切 `DINGTALK_IDENTITY=user` 或明确提示并给一键切换；修掉「登录即 ready」的假状态。
5. **飞书/企微清单补凭据落地步骤（P1）**：清单一键复制里加入 `.env` 键名 + 重启 + 回页面重新检测；每张非 ready 卡提供「我已配好，重新检测」。
6. **文档同步（P1）**：以白号实测重写 `quickstart.md` 路径 E、`README.md` L22/198/347/653、`personal-identity.md` §3.4/§5.5；删除所有不存在的按钮和「刷新即可」。
7. **次要（P2）**：待办/追踪空态入口、`feishu-status` path、`MAIL_MODE` 文案、测试连接提示、命令 cwd/pnpm 回退、LLM 入口。

### 6.3 建议排期

| 优先级 | 事项 | 类型 |
|---|---|---|
| 立即（阻断交付） | 凭据配置闭环 + 邮箱 runtime 修正 + 状态计数 + 钉钉假 ready | 代码 |
| 立即（文档） | 路径 E / README / §3.4 / §5.5 与实测对齐 | 文档 |
| 本迭代 | 钉钉登录入口 + 飞书清单补 `.env` | 代码/文案 |
| 下迭代 | 空态入口、LLM 配置、命令工作目录、health 路径收敛 | 代码 |
| 不可控 | 飞书/企微/钉钉应用需企业管理员开通、企微可信 IP、飞书租户策略 | 平台资质限制 |

---

## 7. 附录

### 7.1 证据文件

**本次审计截图（`docs/qa/white-account/audit-screenshots/`）**

| 文件 | 内容 | 采集时状态 |
|---|---|---|
| `connect.png` / `connect.txt` | 连接账号页（含进度、四卡、动作） | 邮箱 1 条（并发审计写入的假账号），其余 0 |
| `accounts.png` / `accounts.txt` | 平台账号页（四卡、缺变量、身份块） | 同上 |
| `inbox.png` / `inbox.txt` | 收件箱首启（横幅 + 3 步上手 + 空态注入） | 0 消息 |
| `todos.png` / `todos.txt` | 待办空态 | 0 条 |
| `trace.png` / `trace.txt` | 追踪空态 | 0 条 |
| `07-connect-email-form.png` / `.txt` | 点击「添加邮箱账号」后的表单 | 未提交 |
| `08-mail-test-failure.png` / `.txt` | 假数据 + `127.0.0.1:1` 的失败提示（中文） | 未保存 |

**工作区已有白号基线截图（`docs/qa/white-account/screenshots/`，本次复核文本后引用）**

| 文件 | 内容 | 与本次基线一致性 |
|---|---|---|
| `01-first-open.png/.txt` | 首启收件箱 | 0 消息、四平台 Mock、缺变量清单，与 15:29 基线一致 |
| `02-connect.png/.txt` | 连接账号页（**0 邮箱账号**） | `ready 0/4`、`needsAction 1`、mail `needs_user_auth`，与基线 API 完全一致 |
| `03-accounts.png/.txt` | 平台账号页（0 账号） | 四卡未配置、缺变量 |
| `04-todos.png/.txt`、`05-trace.png/.txt` | 两个空态 | 与本次一致 |
| `06-connect-email-form.png` | 邮箱表单 | 与本次表单一致 |

### 7.2 复现命令（PowerShell，只读）

```powershell
$h = @{ Authorization = 'Bearer dev-token' }
Invoke-RestMethod 'http://127.0.0.1:3001/api/onboarding' -Headers $h | ConvertTo-Json -Depth 8
Invoke-RestMethod 'http://127.0.0.1:3001/api/accounts' -Headers $h | ConvertTo-Json -Depth 8
Invoke-RestMethod 'http://127.0.0.1:3001/api/mail/accounts' -Headers $h | ConvertTo-Json -Depth 6
Invoke-RestMethod 'http://127.0.0.1:3001/api/dingtalk/personal/status' -Headers $h | ConvertTo-Json -Depth 6
# 失败分支（不落盘）
$b = '{"address":"audit-fake@example.invalid","authCode":"not-a-real-code","provider":"custom","imapHost":"127.0.0.1","imapPort":1,"smtpHost":"127.0.0.1","smtpPort":1}'
Invoke-WebRequest 'http://127.0.0.1:3001/api/mail/accounts/test' -Method Post -Headers ($h + @{'Content-Type'='application/json'}) -Body $b
# 飞书状态接口 404 证据（动作 path 写错）
Invoke-WebRequest 'http://127.0.0.1:3001/api/feishu/oauth/status' -Headers $h   # 404
```

### 7.3 审计期间的环境变更（非本次审计写入）

| 时间（UTC+8） | 事件 | 影响 |
|---|---|---|
| 15:29 | 基线：0 邮箱账号、0 消息、全 mock | 报告基线 |
| 15:31:16 | 另一进程 `%TEMP%\flow-email-save.mjs` 写入 `whitetestnotexist / w******@example.invalid` 到 `DATA_DIR/mail-accounts.json` | 报告用它观察「保存后 onboarding 联动」；非本次审计保存 |
| 15:31–15:39 | 该账号仍在；`needsAction` 由 1 变 0 | 见 P1-2 |
| 审计结束 | 本次审计未保存任何邮箱账号、未发消息、未改 `.env` | — |

> 建议：由 Lead 决定是否删除该 obviously-fake 账号并恢复「0 账号」白号状态；删除接口 `DELETE /api/mail/accounts/whitetestnotexist`（仅本地账号可删）。

### 7.4 未覆盖 / 局限

- 未执行真实钉钉登录（P0-2 为代码路径复现），未执行真实飞书 OAuth（无 App 凭据）。
- 未执行 `python scripts/smoke.py` / 注入示例（会改变共享消息状态）；空态注入只做代码审查。
- Mock「不真外呼」按代码契约认定，未做网络抓包。
- `.env` 缺失/为空只做代码审查（遵守不修改配置的约束）。
- 外部链接可达性受本机网络影响：GitHub releases HEAD 超时（非当前动作），飞书/企微/QQ 邮箱 GET 均 200。

---

*报告结束。本报告只记录审计发现，不包含任何真实凭据、token 或授权码。*