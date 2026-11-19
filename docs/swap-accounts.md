# LinkHub 换账号指南（swap-accounts）

> 目标：评审 / 同学拿到仓库后，**只改 `unimsg-connector/.env`，不改一行代码**，就能用自己的飞书、钉钉、微信、邮箱账号把真实收发跑起来。
>
> 本文所有凭据一律用占位符表示（`xxxxxxxx` / `you@example.com` 形式），请勿把真实密钥、授权码、邮箱地址提交进 git 或发到群里。

本文覆盖：

- 换账号的 3 步快速路径与模式判定（为什么填了凭据还是 Mock）
- 四个平台各自的 checklist：**后台点什么 → 填哪些 env → 验证命令 → 常见报错**
- **本人账号收发**（飞书 OAuth / 钉钉官方 CLI `dws`）的配置、验证、平台限制与回退（完整版见 [personal-identity.md](personal-identity.md)）
- errcode 排错总表（21001 / 10014 / 535 / 550 / Unsafe Login / ENOTFOUND / ETIMEDOUT …）
- 邮箱 provider 预设表、端口与加密方式表、多账号写法
- 飞书企业认证（21001）的现实说明
- 安全与回滚

---

## 0. 先读：五条约定

1. **只改 `.env`**：平台凭据、邮箱账号、运行模式全部走环境变量，代码不需要动。改完**重启后端**（`config.ts` 只在启动时读取 `.env`）。账号页会在 `.env` 修改时间晚于服务启动时间时提示「.env 已修改，需要重启后端才生效」。
2. **换完账号先跑 `doctor`**：`pnpm run doctor` 会检查 Node、`.env`、平台模式、逐平台探针、大模型连通性与出口公网 IP，并给出中文修复建议；有 FAIL 时退出码为 1。大模型探针（`llm:chat`）只在**未加** `--platform=` 时执行，所以下文各平台的示意输出不含它。
3. **账号页 ≠ 连通性证明**：账号页 / `/api/accounts` / 启动日志只说明 **env 变量是否填齐、解析成 `real` 还是 `mock`、缺哪些变量**；**填假的 App ID / Secret 也会显示「已配置（未验证）/ 真实接口」**。平台到底能不能连通，以 `pnpm run doctor` 的 PASS / FAIL 为准（FAIL 会带错误码与修复建议）。真实模式的账号卡片上直接给出可复制的 `pnpm run doctor --platform=<平台>`，提示语「变量齐了 ≠ 平台能连通」。
4. **Mock 是合法状态，但一定标注**：没配凭据或配得不全时，`auto` 会自动回退本地模拟；回写消息里会写 `delivery.mode=mock`，闭环日志与前端都显示「模拟发送」，**不会假装真实平台已收到**。
5. **命令写法**：在 `unimsg-connector/` 目录下用 `pnpm run doctor`；**不要写 `pnpm doctor`**——pnpm 9 会命中同名内置命令（实测无输出、退出码 0），看起来像成功但本项目自检根本没运行。在脚本 / CI 里推荐全路径：`pnpm --filter @unimsg/server run doctor`。

> 更多架构、API、测试说明见 [reference.md](reference.md)；项目总览见根目录 [README.md](../README.md)。

---

### 0.1 两种换账号方式：授权中心（推荐个人版）vs 直接改 `.env`

| 场景 | 推荐方式 | 怎么做 | 生效方式 |
|---|---|---|---|
| 个人版 / 白号：填平台应用凭据、切身份模式 | **图形化「平台应用配置」** | 「连接账号」→ 对应卡片 **「填写飞书应用凭据 / 填写钉钉应用凭据 / 填写微信凭据」**，或「平台账号」页右上 **「平台应用配置」**；钉钉「仅用本人身份」开关 | **应用凭据 / 模式：保存后必须重启 LinkHub**；**钉钉「仅用本人身份」：热应用、无需重启** |
| 个人版：添加 / 换邮箱 | **图形化授权中心** | 「连接账号」→ 邮箱卡片 **「添加邮箱账号」** → 测试连接 → 保存账号 | **热加载、无需重启**；已验证账号自动真实收信 |
| 个人版：连接钉钉 / 飞书本人身份 | **图形化授权中心** | 钉钉「用钉钉本人账号登录（推荐，无需机器人应用）」；飞书「连接飞书本人账号」 | **登录成功后热应用、无需重启**（钉钉：点按钮只打开登录弹窗，未授权/取消不改配置；成功后自动启用本人身份；注销时自动启用的自动回退） |
| 批量 / CI / 运维：换机器人凭据、微信应用 | **直接改 `.env`** | 按 §1 的 3 步复制模板 → 只填目标平台 → `pnpm run doctor` → 重启 | **必须重启后端**（后端只在启动时读 `.env`） |
| 已用 `.env` 配好，想改其中之一 | 二者皆可 | 页面不能覆盖 `.env` 显式写死的键（会提示「部分配置来自 .env，未被本次保存覆盖」）；要改就改 `.env` 并重启 | 改完重启 |

- **配置来源与优先级**：`.env`（显式，**优先级最高**）→ 页面保存的本地配置 `linkhub-config.json`（有 `DATA_DIR` 时 `DATA_DIR/linkhub-config.json`，否则 `unimsg-connector/.linkhub-config.json`；已 gitignore、非 Windows chmod 600、**secret 只回末 4 位、绝不下发明文**）。
- **白号口径**：2 项可自助（邮箱、钉钉）+ 1 项需管理员（飞书），不是四个平台都需要管理员。
- **同一邮箱 key 的优先级**：`.env` 与页面添加的本地账号同时存在时，**本地导入覆盖 `.env` 并 warn**（以最近一次页面操作为准）；授权中心列表会标来源「来自 .env」/「本地」。
- 「平台应用配置」弹窗按 **飞书 / 钉钉 / 微信 / AI 模型（可选）** 分 Tab，字段来源标「来自 .env（不可覆盖）/ 本地配置 / 已配置 / 未配置」；已有 secret 只显示「已配置」、不回显。授权中心 / 应用配置弹窗**不显示任何 token / 授权码明文**；管理员清单可整段复制发给管理员（见 [personal-identity.md §3.4](personal-identity.md#34-管理员事项汇总授权中心可一键复制)）。
## 1. 换账号 3 步

```bash
cd unimsg-connector

# 1) 复制模板
cp .env.example .env              # Windows PowerShell：Copy-Item .env.example .env

# 2) 只填“目标平台”那一段，其他平台留空即可（留空 = auto 回退 Mock）
#    飞书 / 钉钉 / 微信 / 邮箱的变量见下面各平台 checklist

# 3) 自检（只读，不发任何业务消息），通过后再启动
pnpm run doctor
pnpm --filter @unimsg/server start
```

按目标平台选择自检命令：

```bash
pnpm run doctor --platform=feishu      # 只查飞书
pnpm run doctor --platform=dingtalk    # 只查钉钉
pnpm run doctor --platform=wechat       # 只查微信
pnpm run doctor --platform=mail        # 只查邮箱
pnpm run doctor --platform=feishu,mail # 多个平台用逗号
```

机器可读 JSON（stdout 严格只有 JSON，便于 CI / 脚本消费）：

```bash
pnpm --filter @unimsg/server run --silent doctor --json
```

> `--json` 场景必须加 `--silent` 且用**全路径**：`pnpm run doctor --json` 会把 pnpm 启动横幅写进 stdout，破坏 JSON。

「换账号」可以只换一个平台，例如只把钉钉换成自己的应用：改 `DINGTALK_*` 四个变量 → `pnpm run doctor --platform=dingtalk` → 重启后端。飞书 / 微信 / 邮箱的配置不受影响。

---

## 2. 先搞懂模式，避免误判

| `*_MODE` | 行为 | 凭据不全时 |
|---|---|---|
| `auto`（默认） | 具备真实收或真实发能力 → 真实接口；否则本地 Mock | 自动回退 Mock，`/api/accounts` 的 `reason` 说明原因 |
| `real` | 强制真实接口 | 发送时显式报错并列出缺失变量，**绝不静默假成功** |
| `mock` | 强制本地模拟（填了凭据也不外呼） | 不适用，适合离线演示 |

- 变量名：`FEISHU_MODE` / `DINGTALK_MODE` / `WECHAT_MODE` / `MAIL_MODE`。
- 旧全局 `MOCK` 已废弃：只在没写 `*_MODE` 时作为默认策略（`true→mock`、`false→real`），启动日志和 doctor 都会警告；请删除它。
- `auto` 下邮箱有特例：`MAIL_ENABLED=false`（关轮询）时按 Mock 处理；需要「只发不收」请显式 `MAIL_MODE=real`。
- 每个平台解析出的 `policy / mode / configured / canSend / canReceive / missing / warnings / reason` 在三处一致：`/api/accounts`、启动日志、`doctor`。
- 想确认「现在到底走没走真实接口」：

```bash
curl http://127.0.0.1:3001/api/health
# 看 modes：{"feishu":"real","dingtalk":"mock","wechat":"mock","mail":"mock"}
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/accounts
# 看每个平台的 mode / policy / missing / reason；邮箱另有 accounts[] 明细（地址脱敏）
```

**为什么填了凭据还是 mock？** 按顺序排查：

1. 是不是显式写了 `*_MODE=mock`？
2. 该平台是否缺关键变量（看 `/api/accounts` 的 `missing`，例如飞书缺 `FEISHU_VERIFY_TOKEN` 只影响收，不影响 `mode=real`，但收不到消息）？
3. 邮箱是不是被 `MAIL_ENABLED=false` 关了轮询（`auto` 下按 Mock 处理）？
4. 改了 `.env` 但没重启后端（启动时读取）？

**为什么 doctor 里全是 SKIP？** SKIP 表示该平台当前未启用真实通道（`mode=mock` 且 `policy≠real`），doctor 按约定不发起真实探针；不是失败。填好凭据后 `auto` 会自动变 `real`，或临时加 `*_MODE=real` 强制自检。

---

## 3. 飞书 checklist

### 3.1 后台点什么

在 [飞书开放平台](https://open.feishu.cn/) 开发者后台：

1. **创建应用**：创建企业自建应用，填写名称与描述。
2. **凭证与基础信息**：复制 **App ID**、**App Secret**。注意 App Secret 别复制成 App ID。
3. **添加应用能力 → 机器人**（要收发机器人消息时需要）。
4. **权限管理**：开通
   - `im:message:send_as_bot`（以应用身份发送消息）——**发送必需**；
   - `im:message`（获取与发送单聊、群组消息）——接收 / 查询消息需要；未开通时可能收不到消息。
5. **事件与回调 → 事件配置**（两种订阅方式二选一）：
   - **方式 A · 长连接（推荐，免公网）**：订阅方式选「**使用长连接接收事件**」，保存时要求本地长连接已在线（**先启动后端，再回后台保存**）；添加事件 `im.message.receive_v1`。长连接下事件由官方 SDK 明文推送，无需 Verification Token / Encrypt Key，也不需要公网回调地址。
   - **方式 B · HTTP 回调**：订阅方式选「将事件发送至开发者服务器」，请求地址填 `https://<公网域名>/api/webhook/feishu`；添加事件 `im.message.receive_v1`。
6. 若走**方式 B（HTTP 回调）**：**事件与回调 → 加密策略**复制 **Verification Token**（必填）、**Encrypt Key**（建议配置；配了就必须同步到 `.env`，否则解密失败）。走**方式 A 长连接则无需此项**。
7. **版本管理与发布**：创建版本并发布（可用范围可先设「仅我可见」自测）。**不发布版本，事件订阅可能不生效。**
8. 配置回调 URL 时飞书会发 `url_verification` 挑战（仅 HTTP 回调方式），本服务会自动回 `challenge`；这一步**不用**手动处理。

> 飞书现已支持**长连接（WebSocket）收消息**（`FEISHU_STREAM=true`，实现见 `packages/server/src/stream/feishuStream.ts`）：与钉钉 Stream 同理，免公网回调、事件明文推送，本机 / 决赛服务器直接收。代价是仍依赖应用已发布且启用——否则 `tenant_access_token` 同样报 `21001`（**21001 本机租户 2026-11-12 已解除；其他租户仍可能**）。不想配公网时优先用长连接；纯本地演示仍可用 `FEISHU_MODE=mock`。

### 3.2 填哪些 env

```dotenv
FEISHU_MODE=auto
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# —— 长连接（推荐，免公网）——
FEISHU_STREAM=true
# —— 以下两项仅 HTTP 回调方式需要（FEISHU_STREAM=false 时）——
FEISHU_VERIFY_TOKEN=xxxxxxxxxxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxxxxxxxxxx          # 后台没开加密策略可留空；开了必须填
# FEISHU_BASE_URL=https://open.feishu.cn       # 国际版 Lark / 代理网关才需要改
```

### 3.3 验证命令

```bash
pnpm run doctor --platform=feishu
```

期望输出形态（示意）：

```
[PASS] 飞书 tenant_access_token（应用凭据校验）
       结果：tenant_access_token 获取成功（有效期 7200s；只换取 token，未发送任何消息）。
  ✔ 自检通过：PASS 1 / FAIL 0 / SKIP 0。
  退出码：0
```

然后启动后端，用真实飞书账号给应用机器人发一条消息，再确认入库：

```bash
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/messages
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/accounts
```

### 3.4 常见报错

| 现象 | 原因 | 处理 |
|---|---|---|
| `21001 Access denied due to platform policy` | 租户级策略 / 合规限制，常见于未完成企业认证的租户（**历史：本机租户 2026-11-12 已解除；换租户仍可能**） | 代码、Secret、IP 白名单、应用发布都救不了；见「现实说明」 |
| `10014` | App Secret 错误 | 回后台重新复制 App Secret（别复制成 App ID），更新后重跑 doctor |
| `10003` 或 `app_id not found` | App ID 不存在 / 应用被删除 | 核对 `FEISHU_APP_ID`，确认应用仍存在 |
| `99991663` | tenant_access_token 无效 | 重置 Secret 后旧 token 失效；重跑 doctor；核对 `FEISHU_BASE_URL` 与数据中心一致 |
| 配置回调 URL 时提示「请求地址不正确」 | 公网不可达，或域名/路径写错 | 确认 `https://<域名>/api/webhook/feishu` 可从公网访问；先 `curl -I` 验证 |
| 收到事件但返回 401 `verify failed` | `FEISHU_VERIFY_TOKEN` 与后台不一致 | 复制后台 Verification Token（不是 Encrypt Key） |
| 收到加密事件但报「未配置 FEISHU_ENCRYPT_KEY」 | 后台开了加密策略但 `.env` 没填 Encrypt Key | 填上 Encrypt Key 并重启 |
| 解密失败 / JSON 解析失败 | Encrypt Key 错误，或后台关闭加密但 `.env` 仍按加密处理 | 两处保持一致；改完重启 |
| 能发不能收 | 缺 `FEISHU_VERIFY_TOKEN`、事件未订阅、权限未开通或版本未发布 | 看 `/api/accounts` 的 `missing` / `warnings`，逐项补齐 |
| 长连接保存时提示「连接校验失败」 | 本地后端未启动，或 `FEISHU_STREAM=true` 未设，或应用未发布启用 | 先 `FEISHU_STREAM=true` 启动后端，确认日志出现 `[feishu-stream] 飞书长连接启动指令已下发` 且随后出现「已就绪」，再回后台保存订阅方式 |
| 长连接启动后日志无「已就绪」 | `FEISHU_STREAM` 未开，或 `FEISHU_MODE≠real`，或 21001（应用未发布/未启用；**本机租户已解除，其他租户仍可能**），或 appId 格式不对 | 看 `[feishu-stream]` 日志（SDK 异步建连，启动指令下发 ≠ 已连通）；21001 见「现实说明」 |
| 长连接能收但回复发失败 | 缺 `im:message:send_as_bot` 权限，或版本未发布 | 开通权限并重新发布版本 |

### 3.5 现实说明：飞书 21001 与企业认证

> **2026-11-12 现状**：本机租户已恢复正常（实测 `app_access_token` / `tenant_access_token` 均 `code:0`）；本段保留作为**换租户 / 换环境时的排错参考**——`21001` 仍是飞书平台策略，其他租户仍可能遇到。

飞书 `21001` 是**租户级平台策略**，不是配置错误。已实测排除的方向：错误 Secret（会报 `10014`）、IP 白名单（未开启）、应用未发布（已发布且启用）、测试企业通道（建测试企业并关联后仍 `21001`）。

常见解决路径：

1. 让应用挂在**已完成企业认证**的租户下（个人版 / 未认证租户常被拒）；
2. 开发者后台核对「安全设置 / 租户策略」是否禁止自建应用获取 token、「可用成员 / 部门范围」是否为空；
3. 换一个合规租户重新创建自建应用——**只需要改 `.env` 的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`**，代码与其余配置不动；
4. 仍不通时按 doctor 建议走飞书客服 / 工单确认租户策略。

> 所以：飞书适配器、验签、加解密、发送、事件订阅代码均已就绪，`21001` 属于「换租户 / 走认证」才能解决的外部约束（**本机租户已于 2026-11-12 解除**）。

### 3.6 以用户本人身份收发（user_access_token）

默认机器人身份收发时，群里看到的是「机器人」、收消息也只能收「单聊 + @机器人」。如果希望**以你本人身份收消息、以你本人身份发出**，需要额外做一次用户授权（只需一次，后续 access_token 自动续期）。完整版本（含平台边界与排错）见 [personal-identity.md](personal-identity.md)，本节是速查。

> **白号先填应用凭据**：没有 App ID / App Secret 时不会出现「连接飞书本人账号」。在「连接账号 → 飞书 → 填写飞书应用凭据（App ID / App Secret）」保存 → **重启 LinkHub**（或写 `.env` 的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 后重启），再回到授权中心点连接。

**后台一次性配置（缺一不可）**

1. **权限管理 → 用户身份权限** 开通：
   - `im:message`（获取与发送单聊、群组消息）
   - `im:message.send_as_user`（以用户身份发消息）
   - `im:resource`（上传图片/文件；只发文本也建议一起开）
   - **本人接收**另需：`im:message.p2p_msg:get_as_user`（以用户身份获取单聊消息）、`im:message.group_msg:get_as_user`（以用户身份获取群聊消息）、`im:chat:read`（查看群信息 / 列会话，缺它列不出任何会话、报 `99991679`）；缺权限时报 `99991672` 并给出权限清单。
   - **持续授权**：`offline_access`（后台显示「持续访问已授权的数据」）——refresh_token / 自动续期必需；缺它授权页会报 `20027`。
   - LinkHub 的 OAuth 会**自动申请**上述 scope（本人接收开启时额外附带 `im:message.p2p_msg:get_as_user`、`im:message.group_msg:get_as_user`、`im:chat:read`，FEISHU_USER_RECEIVE=false / FEISHU_IDENTITY=bot 时不申请）；**从旧版本升级后需重新授权一次**，旧 token 不含读消息 / 列会话权限（轮询会报 `99991672` / `99991679`）。
2. **安全设置 → 重定向 URL** 添加：`http://localhost:3001/api/feishu/oauth/callback`
   - 如果后端端口不是 3001，先设 `FEISHU_REDIRECT_URI`，再把**同一个值**原样填进后台；协议、域名、端口、路径、结尾斜杠都必须完全一致。
3. **持续授权（自动续期）由 `offline_access` 决定**：在「用户身份权限」开通它（后台显示「持续访问已授权的数据」）并重新授权后，OAuth 会返回 `refresh_token` + `refresh_token_expires_in`（2026-11-12 实测已验证）；旧版控制台曾有「刷新 user_access_token」开关，**新版控制台已无此项**。
4. **应用发布**：正式应用需发布版本并等待权限生效（**测试应用**改动免审即时生效）；完成授权的飞书账号必须在应用可用范围内（否则报 `20010`）。
5. **事件订阅**：默认用**长连接**（`FEISHU_STREAM=true`，可免公网回调，此时 Verify Token / Encrypt Key 都可不填）；只有改用 **HTTP 回调模式**才必须填 Verification Token。管理员清单（纯文本、无 Markdown 星号）第 7 步是「填写飞书应用凭据（App ID / App Secret）」、第 8 步是「连接飞书本人账号」。

**env 写法**

```dotenv
# 身份策略：auto（默认，已连接本人就用本人，否则机器人）/ bot（固定机器人）/ user（固定本人，未连接显式报错）
FEISHU_IDENTITY=auto
# 旧变量 FEISHU_SEND_AS 仍兼容（仅在未写 FEISHU_IDENTITY 时生效并提示废弃）；新配置只用 FEISHU_IDENTITY
# 本人身份接收（轮询）：auto（默认，身份=本人时自动开启）/ true / false
FEISHU_USER_RECEIVE=auto
FEISHU_USER_RECEIVE_SECONDS=20     # 轮询间隔秒（最小 5）
FEISHU_USER_CHAT_LIMIT=20          # 每轮最多检查的会话数
FEISHU_USER_BACKFILL_HOURS=0       # 首轮回溯小时数：0=只立基线不灌历史
# FEISHU_USER_STATE_FILE=          # 接收水位文件（默认 .feishu-user-receive.json，已 gitignore）
# FEISHU_REDIRECT_URI=http://localhost:3001/api/feishu/oauth/callback
# FEISHU_USER_TOKEN_FILE=.feishu-user-token.json
# FEISHU_ACCOUNTS_BASE_URL=https://accounts.feishu.cn   # 国际版 Lark 才需要改
```

**操作步骤**

1. 改完 `.env` 后**重启后端**；
2. 打开 LinkHub「平台账号」页 → 飞书卡片 → 点「连接本人账号」（已授权过则显示「重新授权」）；
3. 在飞书授权页点同意，成功后回到页面；
4. 飞书卡片「身份 · 谁在收、谁在发」块显示「接收 = 本人、发送 = 本人」，并展示「已连接：<展示名>」与 access / refresh 过期时间；
5. 在收件箱回复一条消息，或「新建发送」发一条，去飞书里确认发送者是**你本人**；
6. 让别人给你发一条单聊消息（或你在某个群里收到消息），**5–30 秒内**应出现在收件箱，并标注「本人账号接收」。

**令牌与失败行为**

- 令牌保存在 `unimsg-connector/.feishu-user-token.json`（已 gitignore；POSIX 下 0600），只存服务端，接口/日志/前端都拿不到。
- `access_token` 约 2 小时，过期前自动用 `refresh_token` 续期；refresh_token 单次有效，刷新后立即落盘。若落盘失败（磁盘满/权限被改），新令牌只在**当前进程内存**里继续用，重启后需重新授权；启动日志会打印警告。
- `FEISHU_IDENTITY=user`，或 `auto` 下已经连接过但令牌过期 / 文件损坏 / 无权限读取 / 属于其他飞书应用：发送会**显式失败**并进死信队列，错误提示「请重新授权」，**不会悄悄换回机器人**。重新点一次「重新授权」即可。
- 当前为**单账号授权**：谁完成连接，之后所有回写都以该用户身份发送；多人共用请各自部署实例。
- 用户身份只能发到**授权用户本人所在的会话**；如果手动填了用户不在的群 / 单聊 `conversationId`，飞书会拒绝，LinkHub 会如实置为 failed。
- **单实例约束**：不要让多个后端进程共享同一个令牌文件。`refresh_token` 单次有效，两个实例并发刷新会导致其中一个实例的令牌失效。
- 令牌文件默认在 `unimsg-connector/` 根目录；设置了 `DATA_DIR`（Docker Compose 固定为 `/app/data`，已持久化）时默认落在 `DATA_DIR/feishu-user-token.json`。如果默认目录被 OneDrive / 云盘同步，建议用 `FEISHU_USER_TOKEN_FILE` 指向非同步目录（令牌仍只在服务端）。
- 连接用户身份前建议先把 `API_TOKEN` 改成强随机值；默认 `dev-token` 虽然仍强制鉴权，但任何知道它的人都能发起授权并覆盖令牌（启动日志与 `doctor` 会提示默认令牌风险）。

**本人身份接收（轮询）的行为**

- 飞书官方没有「个人消息推送事件」，项目用用户 token **轮询**本人所在会话：默认 20s 一轮（`FEISHU_USER_RECEIVE_SECONDS`，最小 5），新消息通常 **5–30 秒**出现；**只读本人可见会话**，读不到你不在的群。
- 首轮默认只记录每个会话的水位基线（`FEISHU_USER_BACKFILL_HOURS=0`），只入库之后的新消息；需要回看最近 N 小时可设 `24`。
- 自己发出的消息会被过滤（自环保护）；水位文件损坏时安全回退重建基线；重启后从水位续传。
- 权限不足不会静默：账号页身份块 / 日志会给出所需权限与「重新授权」提示（权限变更后必须重新授权，旧 token 不带新权限）。
- 机器人长连接 / 回调**保留**：本人轮询与机器人通道可同时存在，入库按 `platform + externalId` 幂等去重，界面如实标注每条是「本人账号接收」还是「机器人接收」。
- **注意**：接收链路真实可用性受租户策略影响——**本机租户 2026-11-12 已解除 `21001`，飞书本人身份真实端到端已实测通过（收单聊 + 群聊、发本人）**；换租户 / 换环境仍可能遇到 `21001`（应用本身都换不到 token），状态见 [personal-identity.md](personal-identity.md) §11 与 [飞书验收记录](verification/feishu-personal-e2e-2026-11-12.md)。

**用户身份常见报错**

| 现象 | 原因 | 处理 |
|---|---|---|
| 授权页报 `20027` / 权限不足 | 用户身份权限未开通或版本未发布（**实测常因缺 `offline_access` / `im:resource`**） | 按上面第 1、4 步开通并发布 |
| 授权页报 `20010` | 当前飞书账号不在应用可用范围 | 让管理员把账号加入应用可用范围 |
| 授权页报 `20029` / redirect_uri 不合法 | 回调地址与后台登记不一致（**实测：后台该栏为空也会报 `20029`**） | 两处都改成 `FEISHU_REDIRECT_URI` 的同一个值（含端口与斜杠） |
| 账号页提示「用户身份未授权」 | 还没点连接，或令牌文件被删 | 点「连接本人账号」 |
| 发送失败「授权已过期 / 请重新授权」 | refresh_token 失效或被使用 | 点「重新授权」；确认后台已开通 `offline_access`（持续访问已授权的数据） |
| 文件发送失败但文本成功 | `im:resource` 未开通 | 开通用户身份的资源上传权限并发布 |

---

## 4. 钉钉 checklist

### 4.1 后台点什么

在 [钉钉开放平台](https://open-dev.dingtalk.com/) 开发者后台：

1. **创建应用**：企业内部应用。
2. **凭证与基础信息**：复制 **Client ID**、**Client Secret**（旧版后台叫 AppKey / AppSecret，本服务两种都兼容）。
3. **应用能力 → 机器人**：添加机器人，填名称 / 简介 / 消息预览图；**消息接收模式选「Stream 模式」**（推荐，本机免公网）或「HTTP 回调」。
4. 在机器人配置里获取 **RobotCode**（企业内部应用通常与 Client ID 相同，留空会自动回退 Client ID）。
5. **权限管理**：开通机器人发消息 / 消息相关权限。
6. **版本管理与发布**：发布版本，机器人配置才对外生效（可用范围可先「仅我可见」）。

### 4.2 填哪些 env（Stream 模式，推荐）

```dotenv
DINGTALK_MODE=auto
DINGTALK_CLIENT_ID=dingxxxxxxxxxxxxxxxx
DINGTALK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DINGTALK_ROBOT_CODE=dingxxxxxxxxxxxxxxxx      # 企业内部应用通常等于 Client ID
DINGTALK_STREAM=true                          # 本机长连接收消息，无需公网
```

HTTP 回调替代方案（有公网域名时）：

```dotenv
# DINGTALK_STREAM=false
DINGTALK_AES_TOKEN=xxxxxxxxxxxxxxxx           # 事件订阅的 Token
DINGTALK_AES_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # 加密密钥
```

后台「事件订阅 → 推送方式」选 HTTP 推送，地址填 `https://<公网域名>/api/webhook/dingtalk`。

### 4.3 验证命令

```bash
pnpm run doctor --platform=dingtalk
```

期望输出形态（Stream 模式）：三条 PASS——accessToken 校验、机器人编码、收消息通道；且 Stream 模式下不再把 AES Token/Key 误报为缺失。

```
[PASS] 钉钉 accessToken（应用凭据校验）
[PASS] 钉钉机器人编码（DINGTALK_ROBOT_CODE）
[PASS] 钉钉收消息通道（Stream 长连接 / HTTP 回调）
  ✔ 自检通过：PASS 3 / FAIL 0 / SKIP 0。
```

启动后端后，日志应出现 `[stream] 钉钉 Stream 已连接，机器人消息将实时入库`；在钉钉里给机器人发消息即入库，再调 `POST /api/messages/:traceId/reply` 会真实发回。

### 4.4 常见报错

| 现象 | 原因 | 处理 |
|---|---|---|
| `40089` / `InvalidAuthentication` | Client ID / Secret 错误 | 回后台复制，更新 `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET`（旧名 AppKey/AppSecret 也兼容） |
| `40001` / `40014` | accessToken 无效 / 环境不对 | 核对 `DINGTALK_BASE_URL`，确认应用已发布 |
| 提示无权限 / forbidden | 机器人 / 消息权限未开通，或未发布版本 | 权限管理开通后重新发布版本 |
| 启动后收不到消息 | 后台机器人消息接收模式不是 Stream，或应用版本未发布，或 `DINGTALK_STREAM` 未开 | 改后台模式 → 发版本 → `.env` 设 `DINGTALK_STREAM=true` → 重启后端 |
| HTTP 回调 401 | AES Token / Key 不一致，或时间戳超出容忍窗口 | 后台 Token / AES Key 与 `.env` 对齐；确认服务器时间正确 |
| 发送群消息报缺 `conversation.id` | 收到的消息没有会话信息 | 确认走的是机器人消息事件（Stream / 事件订阅），不是纯文本 webhook 自造数据 |

> 钉钉实测记录（2026-11-03）：Stream 模式在本机无公网条件下完成「手机发消息 → 入库 → 调接口回写 → 机器人消息回到钉钉会话」全流程；`accessToken` 用真实 Client ID/Secret 换取成功，未认证企业也可用。

### 4.5 以本人身份收发（钉钉官方 CLI dws）

> 钉钉本人身份不走应用机器人，而是走官方开源 CLI [`dws`](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)（LinkHub 以子进程方式调用）。完整版（安装、登录、事件范围、安全）见 [personal-identity.md §5](personal-identity.md#5-钉钉本人身份配置dws-cli)，本节只列操作顺序与排错。

**前置（缺一不可，且都需要企业侧配合）**

1. **安装 dws**（本机已有 `dws` 可跳过；`dws version` 验证）：

   ```powershell
   # Windows PowerShell（官方安装脚本，推荐）
   irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex
   # 或从官方 Releases 下载 dws.exe 放到 PATH：
   #   https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases
   ```

2. **企业管理员开启 CLI 访问**：钉钉**开发者平台 →「CLI 访问管理」→ 开启**；成员未开通时 `dws auth login` 会引导向管理员发起申请、审批后重登。
   替代方案 **Custom App（自有应用）模式**：开放平台创建应用 → 安全设置添加重定向 URL `http://127.0.0.1`、`https://login.dingtalk.com` → 发布 → `dws auth login --client-id <AppKey> --client-secret <AppSecret>`。
3. **首次真人授权**（LinkHub 不能代替，两种方式二选一）：
   - **浏览器登录（推荐，本机）**：LinkHub 弹窗点「用浏览器登录（推荐）」，或终端 `dws auth login`——`127.0.0.1` loopback 自动回调，浏览器扫码 / 账号登录并确认即可，不用手输码；浏览器必须和 LinkHub 同机，约 10 分钟操作窗口。
   - **设备码登录（远程 / 无浏览器 / 容器）**：弹窗点「使用设备码登录（远程/无浏览器）」，或终端 `dws auth login --device`——把授权链接发到另一台有浏览器的设备、输入授权码；约 15 分钟有效，过期点「重新获取授权码」，旧码会提示 `Invalid or expired user code`。
4. **验证登录态**（只读）：`dws auth status --readonly --format json` → `authenticated: true`、`message` 为空。

**env 写法**

```dotenv
# 身份策略：auto（默认，dws 已登录就用本人，否则机器人）/ bot（固定机器人）/ user（未登录显式报错）
DINGTALK_IDENTITY=auto
# 本人身份接收：auto（默认）/ true / false
DINGTALK_USER_RECEIVE=auto
# 个人事件订阅范围（逗号分隔）：all-direct=全部单聊（默认）、at-me=@我（默认）、all-group=全部群消息（量大按需）
# 注意：group / sender 暂不支持（需要 dws 目标参数），配了会被忽略并在启动日志告警，回退默认范围
DINGTALK_USER_EVENT_KINDS=all-direct,at-me
# dws 可执行文件（默认 dws，在 PATH 里）；可带参数，如 node scripts/fake-dws.mjs（离线演示/测试）
DWS_BIN=dws
# DWS_PROFILE=            # 多账号时指定登录档案，一般留空
# DWS_AUTH_TIMEOUT_MS=15000
# DWS_SEND_TIMEOUT_MS=30000
```

**操作步骤**

1. 改完 `.env` 后**重启后端**；
2. 打开 **「连接账号」** → 钉钉卡片：点 **「用钉钉本人账号登录（推荐，无需机器人应用）」**（**只打开登录弹窗，不会预先改配置**；未授权/取消不改变设置）→ 弹窗内用 **「用浏览器登录（推荐）」**（本机）或 **「使用设备码登录（远程/无浏览器）」**；也可终端执行 `tools\dws.exe auth login --recommend` 后回页面点「刷新状态」。**登录成功后**后端才自动启用本人身份（热应用、无需重启）并启动接收；注销时若该身份是自动启用的会自动回退 `auto`（显式配置不动）；
3. 卡片显示「已连接：<dws 档案展示名>」，「接收 / 发送」均为本人；已连接后提供「重新登录（换账号）」与「注销」；
4. 手机钉钉给本人 / 同事发一条单聊消息 → 收件箱出现并标「本人账号接收」；在 LinkHub 回复 → 对方收到**你本人**发的消息；
5. 启动日志应出现钉钉本人身份 / 个人事件子进程启动说明（具体文案以实际日志为准）。

**限制（如实，写进答辩话术）**

- dws 官方处于**共创阶段**：企业数据访问需管理员授权，不能承诺"零配置"；未开 CLI 访问时任何 `.env` 都救不了。
- 首次登录必须**真人授权**：本机推荐浏览器 loopback（浏览器须与 LinkHub 同机）；远程 / 容器用设备码（约 15 分钟有效、过期必须重新获取）。凭据加密绑定设备，**Windows 不能跨机复制**，换机器 / 重建容器需重新登录；容器部署需在容器内登录（见 [deploy.md](deploy.md)）。
- 默认只订阅「全部单聊 + @我」；普通群消息平台不推送，全量群消息（`all-group`）量大且受平台事件能力限制，默认不开。
- 以本人身份发出的消息会带钉钉平台的 **AI 发送角标**（dws 默认 `--ai-tag=true`，LinkHub 保留该默认、不隐藏）。
- **真实端到端待实测**：本机 dws v1.0.68-beta.1 已安装但未登录；离线演示可用 fake-dws（见 [personal-identity.md §7](personal-identity.md#7-离线演示用-fake-dws-模拟已登录不碰真实钉钉)）。

**验证命令**

```bash
# 在 unimsg-connector/ 下
pnpm run doctor --platform=dingtalk    # dws version / auth status / 事件目录（只读）
curl http://127.0.0.1:3001/api/health              # identities：收/发身份摘要
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/accounts
# 钉钉 identity.user.state=linked、effectiveSend/Receive=user 表示本人身份生效
```

**常见报错**

| 现象 | 原因 | 处理 |
|---|---|---|
| 账号页「未找到 dws」 | 未安装 / `DWS_BIN` 路径错 | 按上面安装；`DWS_BIN` 保持 `dws` 或写绝对路径 |
| `dws auth login` 提示组织未开启 CLI 访问 | 管理员未开「CLI 访问管理」 | 走申请审批，或让企业走 Custom App 模式 |
| 钉钉设备授权页提示 `Invalid or expired user code` | 设备码过期 / 已使用 / 登录流程已重启 | 改用「用浏览器登录（推荐）」；或点「重新获取授权码」拿新码并在有效期内输入，不要输旧码 |
| `auth status` 返回 `local_state_requires_repair` | 本机凭据状态需要修复 | 重新 `dws auth login`；按官方文档迁移 / 重建 |
| 换机器 / 重建容器后变回机器人 | 凭据与设备绑定、容器内未登录 | 新环境重新登录；不要复制 `~/.dws` |
| `DINGTALK_IDENTITY=user` 时发送报错 | 固定本人但本人不可用 | 正确行为（不悄悄回退）；连接 dws 或改 `auto` / `bot` |
| 收不到群消息 | 默认只订阅单聊 + @我 | 平台边界；按需配置事件范围，不承诺全量群消息 |

---

## 5. 微信 checklist（RPA 通道）

> 微信**个人版没有官方收发 API**。本项目按赛题 Supplemental 允许的 RPA 路径接入：本机跑一个独立 Python 桥（`scripts/wechat-rpa/rpa_bridge.py`），用键鼠模拟操作微信桌面端。「收」= 桥读窗口新消息 → POST 本机 webhook；「发」= 后端调桥 `/send` → 桥模拟粘贴回车。
>
> 因此微信**不需要任何平台凭据**（没有 corpId / Secret / Token / 可信 IP / 回调这些企业级概念），只有「桥地址」一个配置。

### 5.1 前提准备（需要你在本机做）

1. **Windows 上登录微信 PC 桌面端**并保持打开。

   > **版本决定「怎么收」**：
   > - **3.9.x**（`WeChat.exe`，窗口类 `WeChatMainWndForPC`）：暴露完整控件树，可以**自动轮询**接收，不需要你点任何按钮。
   > - **4.x**（`Weixin.exe`，Qt 5 自绘）：实测 4.2.0.53 的可访问性树只有 2 个空 `Pane`、渲染子窗口 `childCount=0`，UIA 与 MSAA 都拿不到控件（`Weixin.dll` 里连 `QWindowsAccessib` 都没有，编译期就裁掉了）。**自动轮询不可用，但可以「按需拉取」**：在收件箱选微信渠道 →「从微信拉取当前会话」，桥会把微信置前、拖选复制、解析原文入库。
   >
   > 桥启动时自动识别版本，`/health` 的 `client.kind` 会写明 `wechat3` / `weixin4` 与原因。
2. 安装依赖：`python -m pip install pyautogui pyperclip pywin32 uiautomation pillow`
   （`uiautomation` 只对 3.9.x 的**自动轮询**有用；`pillow` 用于截图。4.x 的按需拉取只要 `pyautogui` + `pyperclip` + `pywin32`。）
3. （仅真实收发需要）`.env` 里设 `WECHAT_MODE=real`。默认 `mock` 只演示、不碰真实微信。

> 环境检查：`python --version` 应 ≥ 3.9；`pip list | findstr uiautomation` 能看到包即装好。

### 5.2 填哪些 env

```dotenv
WECHAT_MODE=real                                  # 默认 mock；real 才操作真实微信
WECHAT_BRIDGE_URL=http://127.0.0.1:8787            # 桥地址，一般不用改（改了桥端口才同步）
```

> `WECHAT_MODE=real` 只代表「配置上允许真实操作」，**不等于桥已就绪**：后端会实际请求桥的
> `/health`（1.2s 超时、5s 缓存），确认它真的在 `rpa` 模式、并且接收能力可用。
> 桥在 mock、没启动、或读不到微信窗口时，「连接账号」页不会报 ready，发送也会被如实拒绝。

### 5.3 启动桥并验证

**第一步：启动 RPA 桥（另开一个终端）**

```bash
cd unimsg-connector/scripts/wechat-rpa
python rpa_bridge.py --mode mock        # 零依赖自测（不碰真实微信）
# 确认链路通：另开终端注入一条模拟消息，LinkHub 收件箱应出现
curl -X POST http://127.0.0.1:8787/mock/inject -H "Content-Type: application/json" \
  -d '{"from":"张三","text":"明天交周报","conversation":"项目群"}'
```

**第二步：切真实模式**

```bash
python rpa_bridge.py --mode rpa         # 真实操作微信桌面端（需先装依赖 + 登录微信）
# 不想被抢焦点：--no-switch（只读当前打开的会话，只能收这一个会话）
# 没有未读徽标的会话也要扫：--scan-all
# 4.x 建议固定自己的昵称，用来过滤「自己发的消息」：
python rpa_bridge.py --mode rpa --self-name 你的微信昵称
```

> **微信 4.x 用「按需拉取」接收**（自动轮询在 4.x 上注定读到 0 条，桥会直接关掉轮询）：
>
> 1. 先在微信里**打开要拉的会话**（4.x 没有控件树，外部无法替你切换会话）；
> 2. LinkHub 收件箱 → 渠道选「微信」→ 点 **「从微信拉取当前会话」**；
> 3. 填会话名（必须和微信里显示的一致）+ 你的昵称（可选，过滤自己发的话），点「开始拉取」。
>
> 桥会：置前微信 → 在消息区拖选（逐个试最可能有气泡的起点）→ `Ctrl+C` → 按「昵称/时间/正文」解析 → 去重 → 入库，
> 结束后还原你的剪贴板和焦点。文件消息会按名字到 `msg/file/<YYYY-MM>/` 找工作副本，找到就能在 LinkHub 里下载。
>
> 命令行等价写法：
>
> ```bash
> curl -X POST http://127.0.0.1:8787/pull -H "Content-Type: application/json" \
>   -d '{"conversation":"项目群","selfName":"我的昵称"}'
> ```
>
> 边界（会原样显示在界面的返回里）：只覆盖当前会话 + 可视区，执行期间会短暂抢前台。

**第三步：自检与回写验证**

```bash
pnpm run doctor --platform=wechat
```

期望：两条结论——`微信 RPA 桥（发送）` PASS（桥在 rpa 模式）；`微信 RPA 桥（接收）` PASS
（`/health` 报 `receive.supported=true`）。若桥没起 / 还在 mock，会直接 FAIL 并给出启动命令，
不会再出现「桥没动却报就绪」。退出码随 FAIL 变化。

拿到真实消息后验证回写：

```bash
curl -X POST -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"text":"收到"}' http://127.0.0.1:3001/api/messages/<traceId>/reply
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3001/api/messages/<traceId>
# 看 delivery.mode 是否为 real、platformReply 是否以 rpa: 开头、status 是否到 synced
```

### 5.4 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 发送报「微信 RPA 发送失败：请确认 RPA 桥已启动」 | 桥没启动 / 端口不对 | 先启动 `rpa_bridge.py`；核对 `WECHAT_BRIDGE_URL` 与桥的 `--port` 一致 |
| 发送报「RPA 桥当前是 mock 模式，本次没有真实操作微信」 | 桥是 `--mode mock` 起的 | 用 `--mode rpa` 重启桥；只想演示就把 `WECHAT_MODE` 设为 `mock`，界面会标「模拟发送」 |
| 发送成功但对方没收到 | 微信没登录 / 窗口被遮挡 / 联系人名对不上 | 确认微信桌面端已登录并前台可见；「会话」填的是**微信里的好友昵称或群名**（RPA 按名称定位） |
| 启动报「RPA 态缺少依赖」 | 没装 pyautogui 等 | `python -m pip install pyautogui pyperclip pywin32 uiautomation` |
| 收不到新消息（连接页显示「真实接收还没就绪」） | 微信是 4.x（自绘无控件树，自动轮询不可用）、没装 `uiautomation`、或微信没打开 | `curl http://127.0.0.1:8787/health` 看 `client.kind`：`weixin4` 就改用「按需拉取」（收件箱 → 微信 → 从微信拉取当前会话）；`wechat3` 则 `pip install uiautomation` 后 `--mode rpa` 重启 |
| 点「从微信拉取」报「拖选后剪贴板没有变化」 | 当前会话没消息 / 微信窗口被挡住 / 窗口布局异常 | 先在微信里确认这个会话有可见消息并让窗口露出来；桥会换 7 个起点重试，仍失败会如实报错而不是返回空结果 |
| 拉取报「无法把微信窗口切到前台」 | Windows 前台锁定，后台进程抢不到焦点 | 手动点一下微信窗口，再点一次拉取 |
| 只能收到当前会话 | 默认只切「有未读徽标」的会话；或启了 `--no-switch` | 去掉 `--no-switch`；必要时加 `--scan-all`（会更频繁切换会话） |
| 中文日志乱码 | Windows 控制台 GBK | 桥启动时已切 UTF-8；仍乱码则设 `PYTHONIOENCODING=utf-8` |
| 想紧急停止 | 键盘鼠标被自动操作 | 把鼠标猛甩到屏幕左上角（pyautogui FAILSAFE），或 Ctrl+C 停桥 |

### 5.5 现实说明：能不能收，先看微信版本

桥的 `read_new_messages()` 已用 UI Automation 实现（查会话列表未读徽标 → 切会话 → 读消息列表 → 按气泡左右区分收发 → 稳定指纹去重 → 转发 webhook），**不再是空钩子**。它能不能真读到东西，取决于微信客户端是否暴露控件树：

| 微信版本 | 窗口类名 | 自动轮询 | 按需拉取 |
|---|---|---|---|
| 3.9.x | `WeChatMainWndForPC` | ✅ 可读（会话列表/消息列表都是 `ListControl`） | ✅ |
| 4.x | `Qt51514QWindowIcon` | ❌ 自绘界面，UIA / MSAA 都是空壳 | ✅ 拖选复制（原文零误差） |

桥读不到时会在 `/health` 里如实上报 `receive.supported=false` + `receive.reason`，连接页据此显示「真实接收还没就绪」，**不会报 ready**。3.9 内部小版本若改了控件结构，只需调 `WechatUiaReader._lists()` / `_text_of()`，接口与后端链路不用动。

**4.x 的按需拉取**为什么可行：微信的「选中复制」走系统剪贴板这条正规路径，复制出来的是**原文**（没有 OCR 误差）。桥会自动处理三件容易翻车的事：

- 微信**只有按在消息气泡上**才进入选择模式，按在空白处拖选什么都不选 → 桥按「最可能有气泡」的顺序试几个起点；
- 拉取前要确认**真的置前成功**（Windows 有前台锁定，静默失败会在别的窗口上拖选）→ 用 `AttachThreadInput` 绕开并逐次校验；
- 消息区右侧有滚动条，贴着右边缘会拖成滚屏、剪贴板不动 → 右侧留足余量。

同时请务必遵守：

- 每条消息桥内已有 300–900ms 随机延迟，**严禁高频群发**；
- 个人号有**账号风控风险**，只作补充通道，不做 7×24 稳定运行；
- 微信改版 / 分辨率变化会导致控件定位失效，需要重新适配。

> 当前项目状态：微信连接器（`connectors/wechat.ts`）+ 单测 + 本地 RPA 桥（MOCK/RPA 两态、`/send`、`/pull`、`/mock/inject`、UIA 入站轮询转发）均已完成；3.9.x 可自动接收，4.x 用**按需拉取**（拖选复制原文），两条路都已实测跑通（含附件下载）。

---

## 6. 邮箱 checklist（任意数量 / 任意服务商）

邮箱是第 4 类数据源，**不需要公网地址**：IMAP 本机收、SMTP 本机发。账号数量与服务商都不限，只要该服务商开放 IMAP/SMTP 且允许授权码（或应用专用密码）登录。

> **个人版推荐：不用改 `.env`** —— 左侧「连接账号」→ 邮箱卡片 **「添加邮箱账号」**：选服务商（QQ / 网易 163 / 网易 126 / 网易 yeah / Gmail / Outlook / Microsoft 365 / iCloud / 自定义 / 企业邮箱）→ 填邮箱地址 + 授权码 → **「测试连接」**（会真实连一次 IMAP/SMTP 做登录自检；不保存、不发信）→ **「保存账号」**。
> - **验证与生效**：只有「测试连接」成功的本地账号才标 **已验证**（`verified:true`；保存时也可先测试再保存）；**未验证账号不算就绪、不会收信**。验证过的账号会让邮箱运行态从 Mock 自动变为**真实收信**（无需手写 `MAIL_MODE`），保存后热加载、无需重启；列表里未验证的本地账号可点 **「测试验证」**（等价 `POST /api/mail/accounts/:key/verify`）。若卡片仍提示「仍是模拟模式」，页面提供 **「启用真实邮箱（自动开关）」** 时可点它（热应用）；没有该按钮时以验证后自动真实收信为准。若 `.env` 显式写了 `MAIL_MODE=mock`，GUI 不能覆盖，需改 `.env` 并重启。
> - 账号文件：有 `DATA_DIR` 时 `DATA_DIR/mail-accounts.json`，否则 `unimsg-connector/.linkhub-mail-accounts.json`（已 gitignore；含授权码、仅本机、**永不打印/下发前端**）；来源「本地」可删，「来自 .env」需改 `.env`。
> 下面 `.env` 写法适合批量配置 / CI / 管理员。
### 6.1 先开通 IMAP/SMTP 并拿授权码

> 授权码 **不是**网页登录密码，且通常只显示一次，当场复制。

| 服务商 | 网页端操作 |
|---|---|
| QQ 邮箱 | 设置 → 账号与安全 → 安全设置 → `POP3/IMAP/SMTP… 服务` → 开启服务（需先通过密保，通常要短信验证）→ 生成授权码 |
| 163 / 126 / yeah | 设置 → POP3/SMTP/IMAP → 开启服务（短信验证）→ 新增授权密码（只显示一次） |
| Gmail | 先开启两步验证 → 生成「应用专用密码」；企业 / 学校 Workspace 可能被管理员关闭 IMAP 或基础认证，需管理员放行 |
| Outlook / Microsoft 365 | 可能需要应用专用密码；部分租户关闭 SMTP AUTH / 基础认证，只能用 OAuth（本服务暂未实现 OAuth） |
| iCloud | Apple ID → 安全 → App 专用密码；确认已开启 IMAP |
| 自建 / 企业邮局（custom） | 找管理员确认 IMAP/SMTP host、端口、加密方式，并确认允许「授权码 / 客户端密码」登录 |

### 6.2 两种写法

**写法 A：自动发现（推荐，账号增删无需改顺序）**——只要填 `MAIL_<KEY>_ADDRESS` / `MAIL_<KEY>_AUTH_CODE` 就会被识别：

```dotenv
MAIL_MODE=auto
MAIL_QQ_ADDRESS=you@qq.com
MAIL_QQ_AUTH_CODE=your-qq-auth-code
MAIL_163_ADDRESS=you@163.com
MAIL_163_AUTH_CODE=your-163-auth-code
```

**写法 B：`MAIL_ACCOUNTS` 显式声明要启用的账号**（只加载列出的 key，顺序按你写的来）：

```dotenv
MAIL_ACCOUNTS=qq,163,work
```

- `KEY` 可随意取（`qq` / `163` / `work` / `school2` …），会被大写后拼成环境变量名（`work` → `MAIL_WORK_*`）；`externalId` 里的账号前缀也用它。
- 写了 `MAIL_ACCOUNTS` 后，**只有列出的 key 会被加载**；未列出的即使填了 `MAIL_<KEY>_ADDRESS` 也不会启用（想用自动发现就别写 `MAIL_ACCOUNTS`）。
- 在 `MAIL_ACCOUNTS` 里列了但没有填地址 / 授权码的 key 会给出警告并跳过，不会静默生效。
- 同一服务商可以挂多个账号（`MAIL_QQ_ADDRESS` 与 `MAIL_QQ2_ADDRESS` 等，key 不重复即可）。
- **不建议**把同一个邮箱地址配成两个 key：会产生两条轮询会话，语义混乱。

### 6.3 provider 预设表

不写 `MAIL_<KEY>_PROVIDER` 时按邮箱域名自动推断；写错 / 未知服务商请用 `custom` 并显式填 host。

| provider | 服务商 | IMAP 默认 | SMTP 默认 | 说明 |
|---|---|---|---|---|
| `qq` | QQ 邮箱 | `imap.qq.com:993` 隐式 TLS | `smtp.qq.com:465` 隐式 TLS | 域名 `qq.com` |
| `foxmail` | Foxmail | `imap.qq.com:993` | `smtp.qq.com:465` | 域名 `foxmail.com`（推断为 qq） |
| `163` | 网易 163 | `imap.163.com:993` | `smtp.163.com:465` | 反垃圾可能进 Junk |
| `126` | 网易 126 | `imap.126.com:993` | `smtp.126.com:465` | — |
| `yeah` | 网易 Yeah | `imap.yeah.net:993` | `smtp.yeah.net:465` | — |
| `gmail` | Gmail | `imap.gmail.com:993` | `smtp.gmail.com:465` | 需应用专用密码 |
| `outlook` | Outlook / Microsoft 365 | `outlook.office365.com:993` | `smtp.office365.com:587` STARTTLS | 部分租户关闭 SMTP AUTH |
| `icloud` | iCloud | `imap.mail.me.com:993` | `smtp.mail.me.com:587` STARTTLS | 用 App 专用密码 |
| `custom` | 自定义邮箱 | 无默认，必须填 | 无默认，必须填 | 企业邮局 / 自建域名 |

按域名推断的别名：`qq.com` / `foxmail.com → qq`，`163.com → 163`，`126.com → 126`，`yeah.net → yeah`，`gmail.com` / `googlemail.com → gmail`，`outlook.com` / `hotmail.com` / `live.com` / `msn.com` / `office365.com → outlook`，`icloud.com` / `me.com` / `mac.com → icloud`；其他域名 → `custom`（必须显式填 host）。

### 6.4 端口与加密方式

| 用途 | 端口 | 加密方式 | 说明 |
|---|---|---|---|
| IMAP | `993` | 隐式 TLS（默认） | 连接即 TLS，最常用 |
| IMAP | `143` | STARTTLS | 先明文 greeting → `STARTTLS` 升级 → 再登录 |
| SMTP | `465` | 隐式 TLS（默认） | 连接即 TLS，最常用 |
| SMTP | `587` | STARTTLS | EHLO → `STARTTLS` → 重新 EHLO → 认证 |
| SMTP | `25` | STARTTLS | 很多云厂商封 25 端口，不建议 |
| 任意 | `*_IMAP_SECURE` / `*_SMTP_SECURE` | `true`=隐式 TLS，`false`=STARTTLS | 不写时按端口自动推断（993/465→true，143/587/25→false） |

安全约束：明文链路上如果服务端不声明 `STARTTLS`，客户端会**直接报错，绝不降级成明文认证**。

### 6.5 监听目录

- 默认只监听 `INBOX`；反垃圾 / 规则把回信扔进垃圾箱时用 `MAIL_<KEY>_FOLDERS=INBOX,Junk` 一起监听。
- 多个目录用逗号（或分号 / 空格）分隔；目录名区分大小写、不要加引号。
- `externalId` 形如 `<key>:<目录>:<UID>`（如 `qq:Junk:7`），多账号、多目录不会互相吞消息。
- 首轮轮询只记录每个账号每个目录的最大 UID 作为**基线**，不会把历史邮件灌进中枢；之后只导入水位之后的新信。

### 6.6 验证命令

```bash
pnpm run doctor --platform=mail
```

期望：每个账号两条 PASS（IMAP 登录基线 + SMTP 登录自检；2 个账号即 PASS 4），地址自动脱敏：

```
[PASS] 邮箱 IMAP 登录基线（1******@163.com）
       结果：登录 imap.163.com:993 成功并 SELECT INBOX，当前 UID 基线 …（只做 UID SEARCH，未读取正文、未标记已读）。
[PASS] 邮箱 SMTP 登录自检（1******@163.com）
       结果：登录 smtp.163.com:465 认证成功（PLAIN 机制，链路已加密）；只登录 + QUIT，未发送任何邮件。
  ✔ 自检通过：PASS 4 / FAIL 0 / SKIP 0。
```

2026-11-04 实测：两个真实邮箱账号（163 + QQ）`--platform=mail` → **PASS 4 / FAIL 0**。启动后端后日志应出现：

```
[mail] 轮询已启动，间隔 45s，账号：QQ邮箱[INBOX,Junk]@imap.qq.com / 网易163邮箱[INBOX]@imap.163.com
[mail] QQ邮箱/INBOX 已连接，基线 UID=…，历史邮件不入库
```

给该邮箱发一封新邮件，约一个轮询周期后应能在 `/api/messages` 看到 `platform=mail`；回复它会经 SMTP 真实发出。

### 6.7 多账号完整示例（含自定义服务商）

```dotenv
# ---- 邮箱：任意数量、任意服务商 ----
MAIL_MODE=auto
MAIL_POLL_SECONDS=45
MAIL_ACCOUNTS=qq,163,work

# 账号一：QQ（内置预设）
MAIL_QQ_ADDRESS=you@qq.com
MAIL_QQ_AUTH_CODE=your-qq-auth-code
MAIL_QQ_FOLDERS=INBOX,Junk

# 账号二：163（内置预设）
MAIL_163_ADDRESS=you@163.com
MAIL_163_AUTH_CODE=your-163-auth-code

# 账号三：公司邮箱（无内置预设，必须显式 host；587 自动 STARTTLS）
MAIL_WORK_ADDRESS=you@company.com
MAIL_WORK_AUTH_CODE=your-corp-auth-code
MAIL_WORK_PROVIDER=custom
MAIL_WORK_LABEL=公司邮箱
MAIL_WORK_IMAP_HOST=imap.company.com
MAIL_WORK_SMTP_HOST=smtp.company.com
MAIL_WORK_IMAP_PORT=993
MAIL_WORK_SMTP_PORT=587
MAIL_WORK_FOLDERS=INBOX,Junk
```

### 6.8 常见报错

| 现象 / 关键词 | 原因 | 处理 |
|---|---|---|
| `Unsafe Login` | 网易 / QQ 风控：不报客户端身份的连接被拒，或用了登录密码而非授权码 | 检查授权码；本项目 IMAP 客户端已自动发送 ID 命令，仍报错通常是服务商风控，换网络重试或联系服务商 |
| `IMAP 登录失败` / `authenticationfailed` | 授权码错误、未开启 IMAP、或用了网页密码 | 回网页端重新开启 IMAP/SMTP 并生成授权码（16 位左右，别带空格） |
| SMTP `535` / `534` / `530` | 认证失败：授权码错 / 未开 SMTP / 服务商关闭基础认证 | 重新生成授权码；Gmail 用应用专用密码；企业邮箱找管理员确认 |
| SMTP `550` / `553` | 发信被拒：发信地址与登录账号不一致，或收件人被限制 | 用账号本人地址发信（本项目已固定）；核对收件人；企业邮箱确认外发权限 |
| SMTP `421` / `450` / `451` / `452` | 临时限流 / 反垃圾 | 降低频率、稍后重试；自测频繁可换账号 |
| SMTP `554` | 被判垃圾邮件 / 未开通发信 | 先用网页端正常收发几封；确认已开通 SMTP；必要时联系服务商 |
| `STARTTLS` 不可用 / 未声明 STARTTLS | 端口与加密方式不匹配，或服务端不支持 STARTTLS | 优先改 `465` 隐式 TLS；`587` 才用 STARTTLS；检查 `*_SMTP_SECURE` 与端口 |
| `ENOTFOUND` / `EAI_AGAIN` | 域名解析失败，host 写错 / DNS 异常 | 核对 `MAIL_<KEY>_IMAP_HOST` / `_SMTP_HOST`（不要带端口、协议前缀、空格）；`nslookup imap.qq.com` 验证 |
| `ETIMEDOUT` / 连接超时 | 网络不通 / 端口被公司网络或防火墙拦截 | 换网络（手机热点）验证；公司网络常封 25/465/587；检查代理 / VPN |
| `ECONNREFUSED` | 端口未开放或中间设备拒绝 | 核对端口与加密方式；关闭代理后重试 |
| `SELECT <目录> 失败` | `MAIL_<KEY>_FOLDERS` 目录名不对 | 收件箱用 `INBOX`、垃圾箱用 `Junk`（区分大小写，不要引号） |

### 6.9 邮箱行为说明

- 邮箱**没有平台回调**：真实模式下 `POST /api/webhook/mail` 一律验签失败，邮件只能由本机 IMAP 轮询 ingest（防伪造的有意设计）；Mock 模式仍可用演示签名走通闭环。
- 轮询默认 45s 一轮（`MAIL_POLL_SECONDS`，最小 5），不是实时推送。
- IMAP 的 UID 水位存在内存里：重启会重新立基线，**重启间隙到达的邮件会被跳过**。
- 入库正文为「主题 + 正文」，合计截断到约 2000 字符（中枢与 LLM 只需要要点）。
- 回写走 SMTP：主题自动加 `Re:`、带 `In-Reply-To` 串联会话；发信地址固定为登录账号（否则 QQ / 网易会判冒用）。
- 取正文用 `BODY.PEEK[]`，不会改动你邮箱里的已读状态。

---

## 7. errcode / 报错总表

> 下表中的建议与 `pnpm run doctor` 输出的中文修复建议一致；换账号时优先照 doctor 的建议做。

| 平台 | 错误码 / 关键词 | 含义 | 处理 |
|---|---|---|---|
| 飞书 | `21001` | 租户策略 / 合规限制，无法换 tenant_access_token（**历史：本机租户 2026-11-12 已解除；换租户 / 换环境仍可能**） | 企业认证或换合规租户；改 Secret / IP / 代码无效 |
| 飞书 | `10014` | App Secret 错误 | 回后台重新复制 Secret |
| 飞书 | `10003` | App ID 不存在 / 应用被删除 | 核对 `FEISHU_APP_ID` |
| 飞书 | `99991663` | tenant_access_token 无效 | 重置 Secret 后旧 token 失效；重跑 doctor；核对 base URL |
| 飞书 | `401 verify failed` | Verification Token 不一致 | 对齐 `FEISHU_VERIFY_TOKEN` |
| 飞书 | `20027` / `99991672` / `99991679` / `230027`（用户身份） | 用户身份权限未开通（`20027` 实测常因缺 `offline_access` / `im:resource`；`99991679` 缺 `im:chat:read`）/ 版本未发布 / 旧 token 不带新权限 | 开通 §3.6 的用户身份权限（按需发布版本）→ **重新授权** |
| 飞书 | `20010`（授权页） | 当前账号不在应用可用范围 | 让管理员加入可用范围 |
| 飞书 | `20029` / redirect_uri 不合法 | 回调地址与后台登记不一致 | `FEISHU_REDIRECT_URI` 与后台逐字符一致 |
| 钉钉 | `40089` / `InvalidAuthentication` | Client ID / Secret 错误 | 重新复制 `DINGTALK_CLIENT_ID` / `_CLIENT_SECRET` |
| 钉钉 | `40001` / `40014` | accessToken 相关错误 | 核对 `DINGTALK_BASE_URL`；确认应用已发布 |
| 钉钉 | 机器人无权限 / 收不到消息 | 机器人能力未开、未发布、接收模式不是 Stream | 后台改接收模式 → 发布版本 → `DINGTALK_STREAM=true` → 重启 |
| 钉钉 | 账号页「未找到 dws」/ 本人身份不可用 | 未装 dws、未登录、组织未开 CLI 访问 | 装 dws + 管理员开 CLI 访问 + `dws auth login`；见 §4.5 |
| 微信 | 发送报「RPA 发送失败」 | 桥未启动 / 微信未登录 / 联系人名对不上 | 启动 `rpa_bridge.py`、登录微信桌面端、会话填微信里的昵称或群名；见 §5.4 |
| 微信 | 收不到消息 | 微信是 4.x（自绘，无控件树）/ 没装 uiautomation / 主窗口没打开 | `curl 127.0.0.1:8787/health` 看 `client.kind` 与 `receive.reason`；4.x 用「按需拉取」；见 §5.5 |
| 邮箱 | `Unsafe Login` | 服务商风控 | 用授权码；客户端已发 ID；仍失败换网络 / 联系服务商 |
| 邮箱 | IMAP 登录失败 / auth failed | 授权码 / IMAP 开关问题 | 重新生成授权码，确认已开启 IMAP |
| 邮箱 | SMTP `535` / `534` / `530` | 认证失败 | 授权码 / 应用专用密码 / 服务商基础认证限制 |
| 邮箱 | SMTP `550` / `553` | 发信被拒 | 发信地址=登录账号；核对收件人 / 外发权限 |
| 邮箱 | `421` / `450` / `451` / `452` / `554` | 限流 / 反垃圾 | 降频、稍后重试、换账号 / 联系服务商 |
| 邮箱 | `STARTTLS` 相关 | 端口与加密方式不匹配 | 465 隐式 TLS 优先；587/143 才用 STARTTLS |
| 邮箱 | `ENOTFOUND` / `EAI_AGAIN` | DNS / host 写错 | 核对 host（不带端口/协议前缀），`nslookup` 验证 |
| 邮箱 | `ETIMEDOUT` / `ECONNREFUSED` | 网络 / 端口被拦 | 换网络；检查代理 / VPN / 防火墙 |
| 通用 | `401`（业务接口） | API_TOKEN 不一致 | 前端 `VITE_API_TOKEN` 与后端 `API_TOKEN` 一致 |
| 通用 | `1008 unauthorized`（WS） | WS token 错误 | 同上，`/ws?token=<API_TOKEN>` |

---

> **本地应用配置文件**：页面「平台应用配置」保存的凭据 / 模式在 `DATA_DIR/linkhub-config.json`（无 `DATA_DIR` 时 `unimsg-connector/.linkhub-config.json`），已 gitignore、非 Windows 写盘后 chmod 600；其中含 App Secret，**API 只回末 4 位、日志不打印、不随交付包分发**。桌面版的 `DATA_DIR` 在 `%APPDATA%\LinkHub\data`，因此桌面版该文件在 `%APPDATA%\LinkHub\data\linkhub-config.json`。

> **本地邮箱账号文件**：授权中心添加的邮箱存 `DATA_DIR/mail-accounts.json`（无 `DATA_DIR` 时 `unimsg-connector/.linkhub-mail-accounts.json`），**已 gitignore**，非 Windows 上写盘后 chmod 600；它含授权码，只在本机、不会下发前端或写日志。交付包 / git 里不应出现该文件；换机时重新添加即可。

## 8. 安全与回滚

- **凭据只放 `.env`**：`unimsg-connector/.env` 已被 `.gitignore` 忽略；仓库只保留 `.env.example`（全占位符）。不要 `git add -f .env`，不要把授权码贴进 issue / 截图 / 聊天记录。
  **本人身份令牌不进仓库**：飞书令牌文件（`.feishu-user-token.json`）、接收水位（`.feishu-user-receive.json`）已 gitignore；钉钉 token 由 dws 存在本机（Windows 用系统凭据保护、与设备绑定），LinkHub 不读取、不落盘。**不要**提交 / 复制 `~/.dws`，也不要 `git add -f` 任何 token / 水位文件。
  **不同平台的身份互不影响**：飞书令牌按 App ID 校验（换应用需重新授权）；钉钉按 dws 登录档案（换组织 / 换账号重新 `dws auth login`，多账号用 `DWS_PROFILE`）。
- **`VITE_` 红线**：任何 `*SECRET` / `*KEY` / `*TOKEN` 都不能加 `VITE_` 前缀，否则会被打进前端构建产物。前端只拿业务入口 token（`VITE_API_TOKEN`）。
- **doctor 是只读的**：只做换取 token / IMAP SEARCH 立基线 / SMTP 登录 + QUIT，不发送任何业务消息；报告中的邮箱地址自动脱敏，但把报告贴出去前仍建议人工再看一眼。
- **换错账号 / 想回滚**：
  - 临时离线演示：把对应平台改成 `*_MODE=mock`（或四个都改），重启即可，不需要删凭据；
  - **回退到机器人身份**：`.env` 设 `FEISHU_IDENTITY=bot` / `DINGTALK_IDENTITY=bot` 重启（已连接的本人身份保留但不使用）；只想停掉本人接收可设 `*_USER_RECEIVE=false`；钉钉彻底退出登录用 `dws auth logout`；
  - 恢复旧配置：用你的 `.env` 备份覆盖后重启；
  - 凭据泄露：立刻在平台后台重置 Secret / 重新生成授权码，更新 `.env` 后重启；旧值会立即失效。
- **改完 `.env` 必须重启**：后端只在启动时读取；前端 Vite 也只在 dev server 启动时读取 `packages/web/.env`。

---

## 9. FAQ

**Q：我填了真实凭据，但 `/api/health` 的 `modes` 还是 mock？**
A：按顺序查：① 是否显式 `*_MODE=mock`；② `/api/accounts` 的 `missing` / `reason` 是否说明凭据不足；③ 邮箱是否 `MAIL_ENABLED=false`；④ 是否改完没重启后端。

**Q：真实模式发送失败了，原因在哪看？**
A：消息详情页「回写失败」区域会直接显示 `failureReason`（形如「原因：…」），并提供「重试发送」按钮；完整错误仍在「全链路回放」的闭环日志与死信队列里。收到失败 WebSocket 推送时也会弹失败 toast（带一句可读原因）。

**Q：账号页显示「真实接口 / 已配置」，为什么实际发不出去？**
A：账号页只说明**变量填齐了**，不代表平台能连通——假 App ID、权限未开、租户策略（飞书 `21001`；**本机租户 2026-11-12 已解除，换租户仍可能**）、微信 RPA 桥未就绪都会这样。以 `pnpm run doctor --platform=<平台>` 的 PASS / FAIL 为准；FAIL 会带错误码和修复建议。改完 `.env` 记得**重启后端**（账号页会提示需重启）。

**Q：doctor 显示 SKIP，是失败吗？**
A：不是。SKIP 表示该平台当前未启用真实通道（`mode=mock` 且不是强制 `real`），doctor 按约定不发起真实探针。退出码只看 FAIL 与 Node 版本：全 PASS / SKIP → 0，有 FAIL → 1。

**Q：Mock 模式下的「发送成功」是真的发出去了吗？**
A：不是真实平台发送。消息里 `delivery.mode=mock`、闭环日志写「模拟发送（本地 Mock，未调用真实平台接口）」、`/api/health.sentMock` 单独计数、前端标「模拟发送」。这正是「绝不假成功」的约定。

**Q：换账号后旧消息还在吗？**
A：不在。消息、闭环日志、DLQ 都在内存里，重启即清空；邮箱首轮也只立 UID 基线，不会把历史邮件灌进来。

**Q：邮箱换账号后要重新开 IMAP 吗？**
A：新的邮箱账号都要在网页端开启 IMAP/SMTP 并生成授权码；同一账号只换密码 / 重新生成授权码时，更新 `.env` 后重跑 doctor 即可。

**Q：为什么邮箱回信会进垃圾箱？**
A：反垃圾行为不可预测（同一发件人不同轮次可能进 `Junk` 或 `INBOX`）。把 `MAIL_<KEY>_FOLDERS` 设为 `INBOX,Junk` 一起监听，`externalId` 会带目录名，不会和收件箱的 UID 撞车。

**Q：微信为什么不需要 App ID / Secret / 可信 IP？**
A：因为微信个人版**没有官方收发 API**，本项目走的是 RPA 补充路径——本地桥用键鼠模拟操作微信桌面端，不调用任何腾讯接口，自然没有凭据、回调验签、出口 IP 白名单这些概念。代价是它依赖本机微信环境、稳定性受窗口影响，只作补充通道。

**Q：微信能 7×24 稳定跑吗？**
A：不建议。RPA 依赖微信窗口布局与分辨率，微信改版会失效；个人号频繁自动化还有**账号风控风险**。演示与轻量补充够用，生产级多平台聚合应优先官方 API 通道（飞书 / 钉钉）。

**Q：飞书 21001 能靠改配置解决吗？**
A：不能。21001 是租户级策略，已排除 Secret（10014）、IP 白名单、应用未发布、测试企业通道等因素；需要企业认证或换合规租户，换租户后只改 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 即可。**2026-11-12 本机租户已恢复正常（实测 `app_access_token` / `tenant_access_token` 均 `code:0`）**；其他租户仍可能遇到。

**Q：如何完全离线演示给评审？**
A：四个平台都设 `*_MODE=mock`（或什么都不填，`auto` 自动 Mock），启动后端 + 前端即可走通「收件箱 → 回复 → 回放」；或直接 `pnpm e2e`（强制四平台 mock，完全离线，20 项断言 + `SMOKE OK`）。

**Q：`pnpm doctor` 为什么输出的是 pnpm 自己的诊断？**
A：pnpm 9 自带同名内置命令，实测无输出、退出码 0。本项目命令必须写 `pnpm run doctor`（或全路径 `pnpm --filter @unimsg/server run doctor`）。

**Q：本人身份和机器人身份可以同时用吗？**
A：可以。机器人通道（飞书长连接 / 回调、钉钉 Stream）配置保留即可；本人身份连接后由 `*_IDENTITY` 决定发送身份，接收按 `*_USER_RECEIVE` 决定是否开启。两种通道同时收消息时按 `platform + externalId` 幂等去重，界面分别标注「本人账号接收」与「机器人接收」。

**Q：飞书本人身份为什么收消息慢、还收不全？**
A：慢是因为飞书官方没有个人消息推送事件，项目用用户 token **轮询**（默认 20s 一轮，通常 5–30s 延迟）；收不全是"本人身份"的平台语义——**只能读你本人可见的会话**，你不在的群读不到。两点都是边界，不是配置错误。

**Q：钉钉为什么必须管理员开 CLI 访问？能绕吗？**
A：不能绕。dws 涉及企业数据访问，官方设计就是管理员授权（共创阶段白名单 + 权限最小化）；未开通时 `dws auth login` 只能走申请审批。企业也可走 Custom App 模式自建应用授权，但仍需管理员操作。详见 §4.5。

**Q：为什么我以本人身份发出的消息带「AI」角标？**
A：dws 发送默认带钉钉平台的 AI 发送角标（`--ai-tag` 默认 `true`），LinkHub 保留这个默认、不隐藏不伪造——对方能看出是自动化工具以你本人身份发出的，属于透明标注。

**Q：本人身份真实端到端验证过吗？**
A：代码、单测与 fake-dws 离线桩已覆盖；**飞书已于 2026-11-12 真实端到端验证通过**（真实 OAuth → 单聊 + 群聊轮询入库 → 以本人身份发送，飞书侧核对 `sender_type=user`；本机租户 `21001` 已解除），见 [飞书验收记录](verification/feishu-personal-e2e-2026-11-12.md)。**钉钉真实端到端待实测**：需企业开启 CLI 访问并真人授权。
