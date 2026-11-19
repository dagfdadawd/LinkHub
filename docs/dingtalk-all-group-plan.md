# 方案：钉钉接收群内「所有」消息（设计稿，未动代码）

> 目标：群里不是只收 @我，而是**全部消息都进来**，同时不把界面和数据打爆。
> 前提事实来自现有代码与真实数据，见每节"依据"。

---

## 0. 现状（要做到什么程度才算达标）

| 维度 | 现在 | 目标 |
|---|---|---|
| 订阅范围 | `DEFAULT_DINGTALK_EVENT_KINDS = ['all-direct','at-me']` | `all-direct, at-me, all-group` |
| 会话列表 | 从"收到的消息"反推 | 真实会话表（`chat +chat-list`） |
| 群名 | 永远 `null` → 显示「群聊」 | 同步写入 `conversation.title` |
| 存储 | 每条消息 `save()` → **全量快照** `JSON.stringify(全部消息+traces)` | 增量写 |
| 断线 | 断开期间的消息**永久丢失** | 重连后按会话回溯补齐 |

**依据**
- `config/runtime.ts`：`SUPPORTED_DINGTALK_EVENT_KINDS = ['at-me','all-direct','all-group']`，`all-group` 本来就支持，只是没开。
- `stream/dingtalkPersonalStream.ts`：**每个 kind 起一个 dws 子进程**（channel），所以开 3 个 kind = 3 个常驻进程。
- `services/message.ts`：`ingest` 按 `(platform, externalId)` 幂等 → `at-me` 与 `all-group` 同时命中同一条消息**不会重复入库**。
- `db/repository.ts`：`save()` 里 `persist()` 把**所有消息 + traces + dlq** 全量序列化写盘。

---

## 1. 订阅层：打开 all-group

```env
DINGTALK_USER_EVENT_KINDS=all-direct,at-me,all-group
```

- 变量名是 `DINGTALK_USER_EVENT_KINDS`（`config/runtime.ts:1204` 读取），不是 `DINGTALK_EVENT_KINDS`。
- `group` / `sender` 两种 kind 需要额外目标参数，配置了会被忽略并告警（现有逻辑），不用管。
- 重叠去重：`(platform, externalId)` 幂等已实现，`all-group` 与 `at-me` 重复投递只入库一次。

**代价**：多一个常驻 dws 进程；消息量按群活跃度线性上涨。

---

## 2. 会话表：左栏改成"真实会话"

### 现状问题
左栏 = 消息 `group by conversationId`；没消息的群不存在，群名永远空。

### 方案
新增 `ConversationStore`：

```ts
interface Conversation {
  platform: 'dingtalk';
  conversationId: string;        // cid...
  type: 'group' | 'p2p';
  title: string;                 // 群名（来自 chat-list）
  ownerId?: string;              // 归属账号
  lastMessageAt?: string;
  unreadCount: number;
  syncedAt: string;
}
```

- 数据源：`dws chat +chat-list`（支持 `--include-direct` 含单聊）。
- 触发时机：后端启动后、登录状态可用时同步一次；之后每 30 分钟增量刷新；收到新消息时若会话不存在则补建。
- 左栏渲染：**会话表为主**，消息只提供预览与未读数；没消息的群也显示（灰度可配）。
- 同步失败（未登录）：左栏顶部黄条提示"钉钉未登录，当前只显示已收到消息的会话"，而不是静默少几个群。

**顺带解决**：群名不再显示「群聊」。

---

## 3. 存储层：必须改，否则 all-group 一开就卡

### 现状
`repository.save()` 每条消息都全量写盘：

```ts
const snap = { messages: [...this.byId.values()], externals: [...], traces: [...], dlq };
writeFileSync(tmp, JSON.stringify(snap));
```

当前 44 条消息、traces 已占 100KB+。群消息每天几千条时，每条写入都是 O(N) 序列化 + 整文件替换 —— CPU 和磁盘都会被打满，还会拖慢 WS 推送。

### 方案（按推荐度）

**A. 追加日志 + 周期压缩（改动最小，无新依赖）**
- 运行期：`data/messages.jsonl` 追加写一行一条消息（O(1)）；
- 启动：读 jsonl 重建内存索引（同 externalId 取最后一条）；
- 压缩：每 N 条或每 10 分钟把 jsonl 重写为"每个 traceId 最后状态"；
- 现有 `linkhub-state.json` 保留为"兼容旧版/月度归档"。

**B. SQLite（`better-sqlite3`）**
- 表：`messages(traceId PK, platform, externalId UNIQUE, conversationId, createdAt, payload JSON)`；
- 好处：按会话/时间查询、分页、搜索都变成 SQL，天然支持"最近 N 条"和断线回溯；
- 代价：引入原生依赖（Windows 需预编译）。

**C. 按会话分片文件**：`data/conv/<hash>.json` —— 简单但跨会话搜索变麻烦。

> 建议：**先 A**（半天能落地、零依赖），等数据量上万再考虑 B。

---

## 4. 断线补偿：事件流只推增量

`dws event +listen-im` 断开重连只保证"之后"的消息；断线期间群消息会**永久缺失**（现在就有这个洞，只是 @我 消息少所以不明显）。

方案：
- 重连成功后，对"最近活跃的 N 个会话"（按 `lastMessageAt` 排序）调用
  `dws chat +chat-messages --chat-id <id> --limit 50` 回溯；
- 用 `(platform, externalId)` 幂等去重，重复拉取无副作用；
- 回溯频率节流（例如每个会话 10 分钟最多一次），避免 dws 限流。

---

## 5. 降噪（不强求，但要预留）

全部群消息的噪声远高于 @我。建议做成可配置：

| 开关 | 默认 | 说明 |
|---|---|---|
| `DINGTALK_GROUP_WHITELIST` | 空（全收） | 只收指定群，逗号分隔 conversationId 或群名 |
| 系统消息过滤 | 开 | 入群提示、撤回、红包等 event 不入主列表 |
| @我 高亮 | 开 | `at-me` 通道命中的消息标 `mentionsMe`，UI 置顶 |
| 自环过滤 | 开 | `sender == self` 丢弃（现有逻辑，需实测 all-group 是否也推自己发的） |

**待实测**：`all-group` 是否包含"自己发的消息"、是否包含机器人消息 —— 这决定自环过滤是否需要改造。

---

## 6. UI 侧要跟着改的点

1. 会话列表：真实会话 + 未读数 + 虚拟滚动（几千会话不能全渲染）。
2. 群消息视图：默认折叠？（不建议，用户要的是"像微信一样全都有"）
3. 搜索：本地索引（现在只有内存过滤，量大后要加倒排或 SQLite FTS）。
4. 「待处理」筛选：群消息大多不需要处理，默认不标待处理，避免误判。

---

## 7. 分阶段落地

| 阶段 | 内容 | 预估 | 风险 |
|---|---|---|---|
| P1 | 打开 all-group + 存储改追加日志 | 0.5 天 | 写放大（必须先做存储） |
| P2 | 会话表同步（chat-list）+ 左栏改造 | 1 天 | 需要登录可用 |
| P3 | 断线补偿（chat-messages 回溯） | 0.5 天 | dws 限流 |
| P4 | 白名单/降噪/搜索 | 1 天 | 需要产品取舍 |

---

## 8. 验收方法（可执行）

```cmd
:: 1) 打开订阅
set DINGTALK_USER_EVENT_KINDS=all-direct,at-me,all-group

:: 2) 重启后端，观察日志
::    应该出现 3 条监听通道启动日志（all-direct / at-me / all-group）

:: 3) 手机在群里发一条「不 @ 任何人」的消息
::    期望：LinkHub 收到，且会话名为真实群名（不是「群聊」）

:: 4) 同一条消息被 at-me 和 all-group 同时推
::    期望：列表里只出现一次（幂等）
```

---

## 9. 与"登录卡点"的关系

上面所有验证都依赖 dws 登录。目前卡在 `~/.dws/.data.lock` 无法创建（整个用户目录写入被系统拦截，ACL 却是 FullControl）。

**已验证可行的绕行**：

```
DWS_CONFIG_DIR=D:\LinkHub-push\dws-data
```

设了之后 `dws auth login --device` 能正常出授权码（实测已拿到）。
需要同时给**后端进程**设置这个变量，否则后端读不到这份登录态。