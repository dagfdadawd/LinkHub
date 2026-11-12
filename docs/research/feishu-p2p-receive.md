# 飞书「本人账号」接收单聊（p2p）调研

- 调研日期：2026-11-12
- 目标：确认 LinkHub「飞书本人身份接收」能否读到**别人发给我的单聊**，以及需要哪些端点/参数/scope
- 方法：官方文档（open.feishu.cn / open.larkoffice.com / open.larkenterprise.com 的 `.md` 纯文本版）+ 官方 CLI 源码与 PR（`larksuite/cli` v1.0.100，2026-11-10）+ 官方 Go SDK（`larksuite/oapi-sdk-go/v3` v3.12.2）
- 证据分级（下文每条结论均标注）：
  - **[官方文档]** = 飞书开放平台文档明确写出
  - **[官方 CLI 源码]** = `github.com/larksuite/cli`（Lark 官方，MIT，源码头部版权 "Lark Technologies Pte. Ltd."）的代码或 PR
  - **[官方 SDK]** = `larksuite/oapi-sdk-go` 生成代码
  - **[未公开]** = 上述官方渠道在用、但公开 API 文档未收录，存在变更风险

> 结论一句话：**能做，但必须用 `GET /open-apis/im/v1/chats?types=p2p,group`（官方 CLI 依赖的未公开参数）+ UAT**；读单聊历史本身没问题；缺的 scope 是 `im:chat:read`；官方至今没有个人消息推送事件。

---

## TL;DR（5 条硬结论）

1. **列会话必须加 `types` 参数，否则永远收不到单聊。** 官方 CLI（`larksuite/cli`）用 `GET /open-apis/im/v1/chats?types=p2p,group` + `user_access_token` 列出本人单聊；`types` 是 2026-05 新增的服务端查询参数，但**公开 API 文档没有收录**（2026-11-12 核对三个官方域名均为 4 个查询参数）。→ 方案 A，见 §1。[官方 CLI 源码 + PR #1077]
2. **读单聊历史没有额外障碍。** `GET /open-apis/im/v1/messages` 的 `container_id_type=chat` 官方明确「包含单聊（p2p）和群聊（group）」；UAT 需要基础权限（`im:message` 或 `im:message:readonly`）+ `im:message.p2p_msg:get_as_user`。LinkHub 目前已申请这两个 get_as_user，**读这一步本身已就绪**。[官方文档]
3. **列会话缺的精确 scope 是 `im:chat:read`（查看群信息）。** 官方 CLI 的 `+chat-list` 声明 `Scopes: ["im:chat:read"]`，其排障文档明确写：`--as user` 报 99991679 表示 UAT 未授权 `im:chat:read`。同一 scope 也被 CLI 用于 bot 身份 → 判定为**双身份权限**（应用身份 + 用户身份都有）。LinkHub 当前 `FEISHU_USER_RECEIVE_SCOPES` **没有它**，必须加。[官方 CLI 源码]
4. **没有个人消息推送事件，2026 年也没有。** `im.message.receive_v1`（接收消息 v2.0）只推给**机器人**，前提是应用开启机器人能力；官方「事件订阅概述」明确：大多数事件只能用应用身份订阅，**只有云文档/日历/邮箱三个业务**支持用户身份订阅，IM 不在其中。轮询仍是唯一路径。[官方文档]
5. **`types` 失效时有兜底方案。** 官方文档公开的 `POST /open-apis/im/v1/messages/search`（仅 user_access_token，scope `search:message`）支持 `filter.chat_type="p2p"` + 时间范围，可从搜索结果里拿到 `chat_id`/`is_p2p_chat`，用于发现单聊会话；若已知对方 `open_id`，官方 CLI 用 `POST /open-apis/im/v1/chat_p2p/batch_query` 直接换 `chat_id`（未公开文档）。见 §1 方案 B/C。[官方文档 + 官方 CLI 源码]

---

## §1 单聊（p2p）会话发现

### 1.0 官方边界（先确认「坑」是真的）

- `GET /open-apis/im/v1/chats`（获取用户或机器人所在的群列表）官方注意事项原文：
  > **获取到的群列表中，不包含单聊（群模式为 `p2p`）。**
  - 文档只列 4 个查询参数：`user_id_type`、`sort_type`、`page_token`、`page_size`，**没有** `chat_type` / `types`。
  - 证据：<https://open.feishu.cn/document/server-docs/group/chat/list>（纯文本版：<https://open.larkenterprise.com/document/server-docs/group/chat/list.md>）
- 「获取单聊 chat_id」官方文档给的办法是：用应用调**发送消息**接口给某个用户，从响应里拿 `chat_id`（此时 `chat_mode=p2p`）。
  - 证据：<https://open.larkenterprise.com/document/server-docs/group/chat/chat-id-description.md>（「获取单聊的 chat_id」一节）、群组常见问题 <https://open.larkenterprise.com/document/group/faq>
- 结论：**纯公开文档确实没有「枚举本人全部单聊」的端点**。下面 A/B/C 三条路都是官方生态实际使用/公开文档可用的补充。

### 方案 A（推荐）：`GET /im/v1/chats` + `types=p2p,group`（UAT）

**请求**

```http
GET https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id&page_size=100&sort_type=ByCreateTimeAsc&types=p2p%2Cgroup
Authorization: Bearer u-xxxxxxxx
```

- `types` 取值：`group`（默认，等价不传）、`p2p`、`p2p,group`（逗号分隔；CSV）
- **必须 user_access_token**：官方 CLI 对 `--as bot --types=p2p` 直接拒绝（"To protect user privacy, bot identity cannot list p2p chats"），`--types=p2p,group` 在 bot 身份下会被降级成 `types=group`。
- 响应中 p2p 行会额外带（据官方 CLI 文档）：`chat_mode="p2p"`、`p2p_target_type`（如 `user`）、`p2p_target_id`（对方 open_id，类型由 `user_id_type` 控制）；`name` 是对方显示名。

**证据**

- PR #1077 正文原文：*"Add `--types` CSV flag to `lark-cli im +chat-list`... **Backed by the new `types` query parameter on `GET /open-apis/im/v1/chats`**."* → <https://github.com/larksuite/cli/pull/1077>（2026-05-25 提交，2026-05-29 合并；v1.0.44 发布，见 <https://github.com/larksuite/cli/blob/main/CHANGELOG.md>）
- 源码：`shortcuts/im/im_chat_list.go` 的 `buildChatListParams()` 在 `types` 非空时 `params["types"] = effectiveTypes` → <https://github.com/larksuite/cli/blob/main/shortcuts/im/im_chat_list.go>
- 使用者文档（Lark 官方 skill）：`skills/lark-im/references/lark-im-chat-list.md` §"Including p2p single chats" / §"Bot identity and p2p" → <https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-list.md>
- 2026-11-10 的 v1.0.100 仍在用（本次调研直接下载 goproxy.cn 上的官方模块源码核对）。

**风险（必须知道）**

1. **公开文档未收录 `types`**：2026-11-12 核对 `open.feishu.cn` / `open.larkoffice.com` / `open.larksuite.com` 三站该接口 `.md` 文档均只有 4 个查询参数；官方 Go SDK v3.12.2 的 `ListChatReq` 也没有 `Types` 字段（[官方 SDK]）。因此这是「官方 CLI 依赖、但未写入公开 OpenAPI 契约」的参数，**未来可能被改/下线**。
2. PR #1077 的 Test Plan 中，"Manual sanity check on BOE/Online: ... returns at least one row with `chat_mode="p2p"`" 这一项**当时未勾选**（标注 spec risk #2）；2026-11-03 还有用户 issue #2885 在问官方文档依据（未获官方回复）。→ 建议 LinkHub 上线前用真实租户实测一次，并做兜底（见 §6）。
3. 响应字段 `chat_mode` / `p2p_target_type` / `p2p_target_id` 也不在公开 API 文档响应体里，只在官方 CLI 文档里。`name` 字段是否为空建议实测（CLI 文档说 p2p 行 `name` 是对方显示名；但同一 CLI 的 feed 文档又说 p2p 会话 `name` 返回空字符串 — 属不同接口，别混用）。

### 方案 B：`POST /im/v1/chat_p2p/batch_query`（已知对方 open_id 时最直接，未公开文档）

```http
POST https://open.feishu.cn/open-apis/im/v1/chat_p2p/batch_query?chatter_id_type=open_id
Authorization: Bearer u-xxxxxxxx
Content-Type: application/json

{ "chatter_ids": ["ou_xxx"] }
```

- 响应取 `data.p2p_chats[].chat_id`（另有 `chatter_id1`/`chatter_id2`）。
- **仅用户身份**：官方 CLI 在 bot 身份下直接拒绝 `--user-id`（PR #340）；PR #340 的 Test Plan 有真实租户手工验证：*"--as user --user-id ou_xxx → resolves p2p chat and returns DM messages"*。
- 局限：必须先知道对方 `open_id`，**不能枚举全部单聊**。
- 证据：<https://github.com/larksuite/cli/blob/main/shortcuts/im/helpers.go>（`resolveP2PChatID`）、<https://github.com/larksuite/cli/pull/340>

### 方案 C：`POST /im/v1/messages/search` 发现 p2p 会话（公开文档，仅 UAT）

**这是官方文档里唯一带 `chat_type=p2p` 过滤器的读取类接口**，2026 年的新接口（"搜消息能力的升级版"）。

```http
POST https://open.feishu.cn/open-apis/im/v1/messages/search?user_id_type=open_id&page_size=30
Authorization: Bearer u-xxxxxxxx
Content-Type: application/json

{
  "query": "",
  "filter": {
    "chat_type": "p2p",
    "time_range": { "start_time": "2026-11-12T00:00:00+08:00" }
  }
}
```

- 权限：`search:message`（获取消息搜索结果）；**请求头只接受 `user_access_token`**。
- 响应：`data.items[].meta_data.chat_id` + `is_p2p_chat`，可用它发现"最近有单聊往来"的会话，再走 `GET /im/v1/messages` 拉增量。
- 局限：搜索型接口（100 次/分钟、`page_size` 最大 30、可能有 `notice` 提示"搜索结果不全"），**不适合作为唯一增量通道**，只适合兜底发现 p2p chat_id。
- 证据：<https://open.larkenterprise.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/search.md>

### 方案 D：纯公开文档的取 chat_id 方式（无法枚举）

- 给用户发一条消息（`POST /im/v1/messages`，`receive_id_type=open_id`），响应里返回 `chat_id` —— 只适用于"愿意先发消息"的场景。
- 官方客户端 7.60+ 群设置页可直接看到单聊/群的群 ID（人工）。
- 证据：<https://open.larkenterprise.com/document/server-docs/group/chat/chat-id-description.md>

### 方案对比

| 方案 | 能否枚举全部单聊 | 需要 scope | 是否公开文档 | 建议用途 |
|---|---|---|---|---|
| A `chats?types=p2p,group` | ✅ 能 | `im:chat:read` | ❌（官方 CLI 在用） | **主方案** |
| B `chat_p2p/batch_query` | ❌（需 open_id 列表） | 用户身份（CLI 未单列 scope） | ❌ | 已知对方时兜底/建会话 |
| C `messages/search` + `chat_type=p2p` | ⚠️ 只能发现"近期有消息"的单聊 | `search:message` | ✅ | 兜底发现、补漏 |
| D 发消息拿 chat_id | ❌ | `im:message` + `im:message.send_as_user` | ✅ | 一对一场景 |

---

## §2 读消息所需 scope（精确字符串）

`GET /open-apis/im/v1/messages`（获取会话历史消息）官方原文：

- `container_id_type=chat`：**包含单聊（p2p）和群聊（group）**；p2p 的 `container_id` 就是 §1 拿到的 `oc_...`（单聊 ID 也是 `oc_` 开头）。
- **用户身份读消息**：所有群类型先满足 `im:message` 或 `im:message:readonly` 之一，再按类型加补充权限：
  - 单聊：**`im:message.p2p_msg:get_as_user`**（以用户身份获取单聊消息）
  - 群聊：**`im:message.group_msg:get_as_user`**（以用户身份获取群聊消息）
- 证据：<https://open.larkenterprise.com/document/server-docs/im-v1/message/list.md>

**LinkHub 现状**：`FEISHU_BASE_SCOPES` 已含 `im:message`，`FEISHU_USER_RECEIVE_SCOPES` 已含 `im:message.p2p_msg:get_as_user` + `im:message.group_msg:get_as_user` → **读消息权限齐了，不需要改。**

> 备注：`GET /open-apis/im/v1/messages/:message_id/resources/:file_key`（下载图片/文件）公开文档列的权限是 `im:message` / `im:message:readonly` / `im:message.history:readonly` 三选一（<https://open.feishu.cn/document/server-docs/im-v1/message/get-2.md>）；官方 CLI 在 user 身份下给该接口声明的是 `im:message:readonly`（<https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-message-enrichment.md>）。LinkHub 有 `im:message`，按公开文档应可用；若 UAT 下载附件报 99991679，再补 `im:message:readonly`。

---

## §3 列会话所需 scope（精确字符串）

`GET /open-apis/im/v1/chats` 公开文档「权限要求」四选一：

- `im:chat`（获取与更新群组信息）
- `im:chat:readonly`（获取群组信息）
- `im:chat:read`（查看群信息）
- `im:chat.group_info:readonly`（读取群信息（历史版本））

**但官方文档没有标注每个 scope 属于哪个身份页签。** 用官方 CLI 源码可以定死用户身份该用哪个：

- `+chat-list` 的声明是 `Scopes: ["im:chat:read"]`，`AuthTypes: ["user","bot"]`；CLI 里 `Scopes` 是「两个身份共同的兜底 scope」（`shortcuts/common/types.go`：*"unconditional pre-flight scopes (fallback when UserScopes/BotScopes are empty)"*）。
- 其 skill 排障表明确：
  - `Permission denied (99991679) with --as user` → **UAT 未授权 `im:chat:read`**，修复：`lark-cli auth login --scope "im:chat:read"`；
  - `Permission denied (99991672)`（bot）→ 应用未开通 `im:chat:read` TAT 权限。
- 证据：<https://github.com/larksuite/cli/blob/main/shortcuts/im/im_chat_list.go>、<https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-list.md>、<https://github.com/larksuite/cli/blob/main/shortcuts/common/types.go>

**判定**：

| scope | 身份判定 | 依据 |
|---|---|---|
| `im:chat:read` | **用户身份 + 应用身份（双身份）** | 官方 CLI 对 user 与 bot 都用它，并分别给出 99991679/99991672 的排障指引 |
| `im:chat` | 应用身份（未找到用户身份依据） | 官方 CLI 对 UAT 列会话不使用它；公开文档未标注身份 |
| `im:chat:readonly` | 应用身份（未找到用户身份依据） | 同上；第三方（华为云码道）文档明确把它列在「应用身份权限 tenant_access_token」页签的示例里 |
| `im:chat.group_info:readonly` | 应用身份（历史版本） | 名称即「历史版本」，官方 CLI 不用于 UAT |

→ **LinkHub 用户身份列会话只需申请 `im:chat:read`**，不必为 UAT 申请另外三个（多申请只会增加管理员审核成本）。

---

## §4 完整用户身份权限清单（LinkHub 后台开通 + OAuth 申请）

| scope | 中文名 | 应用身份 / 用户身份 | 用途（LinkHub） |
|---|---|---|---|
| `im:message` | 获取与发送单聊、群组消息 | 双身份（文档分别写了两种身份的用法） | UAT 发送的**基础必需**；读消息基础权限之一；下载附件的可选权限 |
| `im:message.send_as_user` | 以用户身份发送消息 | **用户身份** | UAT 发送**必需**（与 `im:message` 同时具备才能发） |
| `im:message:readonly` | 获取单聊、群组消息 | 双身份（消息类 API 文档两种身份都列它） | 读消息/下载附件的可选替代；官方 CLI user 身份下载资源声明的是它 → 建议顺带申请，作为下载兜底 |
| `im:message.p2p_msg:get_as_user` | 以用户身份获取单聊消息 | **用户身份** | UAT 读**单聊**历史消息必需（本次核心） |
| `im:message.group_msg:get_as_user` | 以用户身份获取群聊消息 | **用户身份** | UAT 读**群聊**历史消息必需 |
| `im:chat:read` | 查看群信息 | **双身份**（官方 CLI user+bot 都用） | **UAT 列会话（含 p2p）必需** ← 当前缺失 |
| `im:resource` | 获取与上传图片或文件资源 | 双身份（上传接口同时接受两种 token；官方 CLI 明确 user 身份 UAT 需 `im:resource`） | UAT 上传图片/文件（发送附件） |
| `search:message` | 获取消息搜索结果 | **用户身份**（接口只接受 UAT） | 可选：方案 C 兜底发现 p2p 会话 |
| `offline_access` | 官方字段权限名就是 `offline_access`（英文说明 Access authorized data offline；在后台「权限管理」里开通） | OAuth 字段权限 | 拿 `refresh_token`、自动续期 |
| （应用身份，仅供机器人通道）`im:message:send_as_bot` | 以应用的身份发消息 | 应用身份 | LinkHub `policy=bot` 时用 |

> 说明：
> - 上表「双身份」= 官方 CLI 源码把它同时用于 user 与 bot 的 preflight，且公开文档的接口同时接受 `tenant_access_token` / `user_access_token`。
> - `im:message:send`（发送消息 V2 / 历史版本）属应用身份历史版本，UAT 用不到，不必申请。
> - 上传接口文档（<https://open.larkenterprise.com/document/server-docs/im-v1/image/create.md>、<https://open.larkenterprise.com/document/server-docs/im-v1/file/create.md>）权限要求为 `im:resource` 或 `im:resource:upload`（上传文件 V2）。

**结论：LinkHub 的 `FEISHU_USER_RECEIVE_SCOPES` 应变成**（在现有基础上 +1）：

```
im:message.p2p_msg:get_as_user
im:message.group_msg:get_as_user
im:chat:read                         ← 新增（列 p2p 会话必需）
```

`FEISHU_BASE_SCOPES`（`im:message`, `im:message.send_as_user`, `im:resource`）保持不变；`offline_access` 保持不变。

---

## §5 有没有官方「个人消息推送 / 事件」能力？

**没有。2026 年也没有新增。**

证据（全部官方文档）：

1. **「接收消息」事件只推给机器人**：`im.message.receive_v1`
   > 「机器人接收到用户/机器人发送的消息后触发此事件」
   > 前提条件：应用需要开启**机器人能力**；需在事件订阅中订阅「接收消息 v2.0」。
   - 权限全是机器人侧权限（`im:message.p2p_msg:readonly` / `im:message.group_at_msg:readonly` / `im:message.group_msg` …），没有 `*_get_as_user` 之类用户身份读消息权限。
   - 证据：<https://open.larkenterprise.com/document/server-docs/im-v1/message/events/receive.md>
2. **「用户身份订阅事件」只覆盖三个业务，IM 不在内**（事件订阅概述原文）：
   > 「大多数事件均需要使用应用身份订阅，需要使用用户身份订阅的场景说明如下：
   > - **云文档**：支持应用身份或用户身份订阅
   > - **日历**：只支持用户身份订阅
   > - **邮箱**：只支持用户身份订阅（内测中）」
   - 证据：<https://open.larkenterprise.com/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM.md>（事件订阅概述 / 订阅身份介绍）
3. **官方 CLI 的事件消费仅支持机器人身份**：`lark-cli event consume im.message.receive_v1 --as bot`；其 IM 事件目录 12 项全部是机器人视角事件（`im.message.*`、`im.chat.*`、`card.action.trigger`）。证据：<https://github.com/larksuite/cli/blob/main/skills/lark-event/references/lark-event-im.md>
4. **官方 SDK 的长连接/回调只托管应用身份**：官方文档原文 *"SDK 仅支持托管应用身份的访问凭证（tenant_access_token），不支持托管用户身份的访问凭证（user_access_token），开发者需自行实现相关逻辑"*（<https://open.feishu.cn/document/tools-and-resources/server-sdk-download>）。即使用户身份订阅了事件（仅云文档/日历/邮箱），也没有现成的用户 token 长连接通道。

**未找到官方依据的能力（不要基于它们设计）**：
- 「用户消息事件订阅 / 个人消息推送事件」
- 「消息同步 API」「消息审计 API 供个人账号读本人消息」
- 「飞书个人版 API」

**结论**：轮询 `im/v1/chats`（带 `types`）→ `im/v1/messages` 仍是 2026-11 唯一可行路径；延迟 5–30s 的现状无法用官方推送消除。

> 补充：2026 年官方在「UAT 读外部会话」上有两次放宽（对 LinkHub 有利，不影响方案）：
> - 2026-06-08 起，UAT 读外部会话（含单聊与群组）不再受应用对外共享状态限制：<https://open.larkenterprise.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/breaking-change/support-uat-get-external-chat-msg.md>

---

## §6 对 LinkHub 实现的直接建议

> 本次为只读调研，**没有改任何仓库文件**。以下为改造清单，供 lead 排期。

### 6.1 必改（否则单聊永远收不到）

1. **`unimsg-connector/packages/server/src/connectors/feishuUserReceive.ts` → `fetchUserChats()`**
   - 现在查询串只有 `user_id_type` + `page_size`（约 L203-207）。
   - 改成：
     ```ts
     const query = new URLSearchParams({
       user_id_type: 'open_id',
       page_size: String(pageSize),
       types: 'p2p,group',   // ← 新增：否则服务端只返回群聊
     });
     ```
   - 同时把响应里的 p2p 字段显式收进 `FeishuChat`：`chat_mode`（已有）、`p2p_target_type`、`p2p_target_id`（建议新增，用于会话标题/去重）。
2. **`src/config/runtime.ts` → `FEISHU_USER_RECEIVE_SCOPES`**（L819）
   ```ts
   export const FEISHU_USER_RECEIVE_SCOPES = [
     'im:message.p2p_msg:get_as_user',
     'im:message.group_msg:get_as_user',
     'im:chat:read',                    // ← 新增：列会话（含 p2p）必需
   ] as const;
   ```
   - 只影响 `resolveFeishuScopes()` 的 OAuth scope；`policy=bot` / `receive=false` 时不会申请，符合最小权限。
3. **`docs/personal-identity.md` §4.1**：后台「用户身份权限」清单加 `im:chat:read`，并说明「本人接收依赖 `im/v1/chats?types=p2p,group`」；§4.1 里"单聊 + 群聊可读"的表述在这条修复前是不成立的，修完后才成立。

### 6.2 建议改（健壮性 / 可观测性）

4. **`src/stream/feishuUserPoller.ts`**
   - 无需改分页/水位逻辑；但要注意新增 p2p 会话后 `FEISHU_USER_CHAT_LIMIT`（默认 20）可能不够 → 轮转切片的排序已经按"最久没检查"，可接受；建议在身份视图显示"已发现 N 个会话（其中 p2p M 个）"。
   - 会话标题兜底：p2p 行若 `name` 为空，用 `p2p_target_id` 显示为「单聊 ou_xxx」或用通讯录接口补名字（不要为此新增高敏权限）。
5. **`src/doctor/probes.ts`**（约 L1127）
   - 探针现在打 `im/v1/chats?user_id_type=open_id&page_size=1`，**不带 `types`** → 必然通过但证明不了 p2p 能力。
   - 改成带 `types=p2p,group`，并在返回里检查是否至少出现一次 `chat_mode === 'p2p'`（没有则降级为 warn："可能未生效/无单聊"）。
6. **错误码兜底**（`describeFeishuError` 可扩展）
   - `232001` invalid request parameter：若由 `types` 引起 → 说明服务端移除了该参数，切方案 C（`im/v1/messages/search`，需 `search:message`）。
   - `99991679` / `99991672`：缺 `im:chat:read`（UAT/TAT 两种）。
   - p2p 行为异常（`types` 被忽略、只回群聊）时不要静默：日志明确 "types=p2p,group 未返回任何 p2p 会话"。
7. **测试**：`src/connectors/feishuUserReceive.test.ts` 补断言：`fetchUserChats()` 的 URL 必须含 `types=p2p%2Cgroup`；mock 一个 `chat_mode=p2p` 的 item，断言 `mapFeishuUserMessage` 的 `conversation.type === 'p2p'`（现有逻辑已按 `chat.chatMode === 'p2p'` 判断，p2p 行带回 `chat_mode` 后即生效）。
8. **可选权限**：若实测 UAT 下载附件报 `99991679`，再补 `im:message:readonly`；若要做"发现近期单聊"兜底，再加 `search:message`（会新增一个需管理员审核的用户身份权限，非必需）。

### 6.3 上线前验证清单

- [ ] 用真实租户跑一次：`GET /im/v1/chats?types=p2p,group` 是否返回 `chat_mode=p2p` 行、`name`/`p2p_target_id` 是否符合预期。
- [ ] 让对方发一条单聊 → 轮询能否入库（`conversation.type === 'p2p'`、`receivedAs === 'user'`）。
- [ ] 群聊回归：`types` 加入后群聊仍返回、增量水位不受影响。
- [ ] 如果 `types` 无效：确认是 232001 还是"静默忽略"，走方案 C 兜底。
- [ ] 权限变更后**重新发布版本 + 重新授权**（旧 UAT 不带新 scope）。

---

## 附：证据 URL 清单

**官方文档（均可在末尾加 `.md` 取纯文本）**
- 获取用户或机器人所在的群列表（不含 p2p；无 types 参数）：<https://open.feishu.cn/document/server-docs/group/chat/list>
- 群 ID 说明（单聊 chat_id 获取方式）：<https://open.larkenterprise.com/document/server-docs/group/chat/chat-id-description.md>
- 群组常见问题（单聊 ID）：<https://open.larkenterprise.com/document/group/faq>
- 获取会话历史消息（container_id_type=chat 含 p2p；UAT 读消息权限）：<https://open.larkenterprise.com/document/server-docs/im-v1/message/list.md>
- 发送消息（UAT = `im:message` + `im:message.send_as_user`）：<https://open.larkenterprise.com/document/server-docs/im-v1/message/create.md>
- 搜索消息（仅 UAT；`search:message`；`chat_type=p2p`）：<https://open.larkenterprise.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/search.md>
- 获取消息中的资源文件（im:message / readonly / history）：<https://open.feishu.cn/document/server-docs/im-v1/message/get-2.md>
- 上传图片（im:resource）：<https://open.larkenterprise.com/document/server-docs/im-v1/image/create.md>
- 上传文件（im:resource）：<https://open.larkenterprise.com/document/server-docs/im-v1/file/create.md>
- 接收消息事件（仅机器人）：<https://open.larkenterprise.com/document/server-docs/im-v1/message/events/receive.md>
- 事件订阅概述（用户身份订阅仅云文档/日历/邮箱）：<https://open.larkenterprise.com/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM.md>
- 申请 API 权限（区分应用/用户身份页签）：<https://open.larkenterprise.com/document/server-docs/application-scope/introduction.md>
- 刷新 user_access_token（开 offline_access、安全设置开关「刷新 user_access_token」）：<https://open.larkenterprise.com/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3.md>
- 获取 user_access_token / refresh_token 返回条件：<https://open.larkenterprise.com/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token.md>
- UAT 读外部会话变更（2026-06-08）：<https://open.larkenterprise.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/breaking-change/support-uat-get-external-chat-msg.md>

**官方 CLI（`github.com/larksuite/cli`，Lark 官方）**
- PR #1077（types 参数来源）：<https://github.com/larksuite/cli/pull/1077>
- PR #340（chat_p2p/batch_query 真实租户手测）：<https://github.com/larksuite/cli/pull/340>
- `+chat-list` 源码（types 参数、p2p 字段）：<https://github.com/larksuite/cli/blob/main/shortcuts/im/im_chat_list.go>
- `+chat-list` 用户文档（p2p 用法、身份限制、错误码）：<https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-list.md>
- `resolveP2PChatID`（chat_p2p/batch_query 请求体）：<https://github.com/larksuite/cli/blob/main/shortcuts/im/helpers.go>
- scope/身份语义（Scopes/UserScopes/BotScopes）：<https://github.com/larksuite/cli/blob/main/shortcuts/common/types.go>
- IM 事件目录（仅机器人事件）：<https://github.com/larksuite/cli/blob/main/skills/lark-event/references/lark-event-im.md>
- CHANGELOG（v1.0.44 收录 #1077）：<https://github.com/larksuite/cli/blob/main/CHANGELOG.md>
- v1.0.100 模块源码（本次核对，goproxy.cn 下载）：<https://goproxy.cn/github.com/larksuite/cli/@v/v1.0.100.zip>

**官方 SDK**
- `larksuite/oapi-sdk-go/v3` v3.12.2：`ListChatReq` 无 `Types` 字段（旁证：types 未进公开契约）；`im/v1/messages/search`、`chat_p2p` 相关模型存在 → <https://pkg.go.dev/github.com/larksuite/oapi-sdk-go/v3>

---

## 明确「未找到官方依据」的点

1. 公开 API 文档中**没有** `GET /im/v1/chats` 的 `types` 参数，也没有 p2p 响应字段（`chat_mode`/`p2p_target_*`）说明 —— 仅官方 CLI 在用。
2. 公开 API 文档中**没有** `POST /im/v1/chat_p2p/batch_query` 的页面（按常见路径 404）—— 仅官方 CLI 在用。
3. 公开文档**没有**个人消息推送事件、消息同步 API、面向个人账号的消息审计 API；「用户身份订阅事件」仅覆盖云文档/日历/邮箱。
4. `im:chat` / `im:chat:readonly` / `im:chat.group_info:readonly` 的**用户身份归属**没有官方文档直接标注；本文判为应用身份，依据是官方 CLI 对 UAT 只声明 `im:chat:read` + 第三方集成文档把 `im:chat:readonly` 列在应用身份页签。如果后台在「用户身份权限」页签能看到其中某个，可直接用；否则「任一权限即可」在 UAT 下是否成立需实测。