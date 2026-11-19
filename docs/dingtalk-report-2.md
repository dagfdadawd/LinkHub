# 钉钉问题汇报 · 第二轮（诊断完成，未改动代码）

> 时间：2026-11-19 13:45–14:00
> 依据：真实数据 + 直接调 dws + 读源码
> 这一轮新增了「发送语义」问题，同时把上一轮清单按最新事实订正

---

## 一、先说清楚：上一轮结论的订正

| 上一轮我说 | 现在的事实 | 结论 |
|---|---|---|
| dws 未登录 | ✅ 已确认并解决（你完成了设备授权） | 已关闭 |
| `~/.dws` 写不进去 | ✅ 根因是**进程运行在 Low 完整性级别**，不是文件权限 | 已定位，绕行有效 |
| 会话列表只有 4 个，是"没同步" | 现在用 `chat +chat-list` 实际拉到了 4 个，**和 LinkHub 里的 4 个对不上** | 有新发现，见 P1 |

**登录问题的准确结论**：

```
whoami /groups → Low Mandatory Level (S-1-16-4096)
```

低完整性级别 → 写注册表被拒 → `save to keychain: registry create/open failed`。
用 `DWS_CONFIG_DIR` 换目录 + 在正常权限窗口登录后，现在：

```
$ dws auth status
"authenticated": true        ✅
```

---

## 二、问题清单（当前全部）

| 编号 | 问题 | 严重度 | 状态 |
|---|---|---|---|
| P0 | dws 登录态 | — | ✅ 已解决（需后端配 `DWS_CONFIG_DIR` 并重启） |
| **P1** | 发送永远是"引用回复"，语义错误 | **高（本次重点）** | 待设计确认 |
| P2 | 会话列表与手机不一致（缺群 / 类型判断有误） | 高 | 待改 |
| P3 | 群会话没有名字，显示「群聊」 | 中 | 待改 |
| P4 | 群消息只收 @我（你要改成全收） | 高 | 方案已出 |
| P5 | 单聊回复可能被 dws 拒绝（`chat message reply` 对 p2p 不稳） | 中 | 与 P1 一起改 |

---

## 三、P1（本次重点）：为什么发出去"总是带引用"

### 事实

你在手机截图里看到的引用条（灰底引用 + 你的回复），是 `dws chat message reply` 的效果。
LinkHub 的判定逻辑在 `connectors/dingtalk.ts:286-345`：

```ts
const refMessageId = /^dingtalk:(.+)$/.exec(msg.externalId)?.[1];
const canReply = msg.receivedAs === 'user' && Boolean(refMessageId);

const useReply = inlineImages.length === 0
  && canReply
  && Boolean(refMessageId)
  && Boolean(msg.conversation?.id);

const outcome = useReply
  ? await client.reply({ conversationId, refMessageId, refSenderOpenDingtalkId: msg.sender.id, text })
  : await client.sendText({ target, text });
```

**只要目标是一条"收到的钉钉消息"、且这次没有带图，就一定走 `reply`（引用）**。

而 LinkHub 的回复框永远绑定"最后一条收到的消息"（`replyTarget = 最后一条非 out 消息`），
所以你每次点发送，都等于"引用那条消息再回复"。

### 为什么这是错的

| 你的期望（微信模型） | 现在的行为 |
|---|---|
| 直接发送 → 消息就是一条普通消息 | 每条都挂引用条，手机上看像"在回某一句话" |
| 想引用 → 手动选某条消息再回复 | 没有"选择引用对象"的操作 |
| 引用是可选信息 | 引用是强制的 |

### 怎么改（方案）

**后端**

1. 请求契约加显式引用目标（不传 = 普通发送）：
   ```ts
   interface ReplyRequest {
     text: string;
     /** 引用回复的目标消息 traceId；不传 = 普通消息，不带引用 */
     quoteTraceId?: string;
   }
   ```
2. `dingtalk.ts` 的判定改成"**只有显式给了 quoteTraceId 才走 reply**"：
   ```ts
   const useReply = Boolean(quoteTarget) && canReply && inlineImages.length === 0;
   ```
3. 引用目标要从 `quoteTraceId` 反查：`externalId`（openMessageId）+ `sender.id`（senderOpenDingtalkId）。
4. 把引用信息记进回复历史，前端才能画出引用条：
   ```ts
   replies: [{ text, at, quote?: { text: string; senderName: string } }]
   ```
5. P5 顺带解决：普通发送走 `chat message send --conversation-id`，单聊/群聊都稳，不再受 `reply` 对 p2p 的限制。

**前端**

1. **默认发送 = 普通消息**（输入框直接发，不带引用）。
2. 新增「回复某条消息」操作：
   - 收到的消息：右键 / 长按 / 气泡右侧「⋯」→ **回复**；
   - 选中后输入框上方出现引用条（灰底 + 被引用文本 + × 取消），像微信；
   - 此时发送 = 带引用的回复。
3. 发送后的气泡里渲染引用块：
   ```
   ┌──────────────────
   │ 郑乐斌
   │ @郑友佳 请问你想约什么时间、什么地点呢？
   ├──────────────────
   │ 收到，我确认后回复你。
   └──────────────────
   ```
4. 「本次回复」区域的语义要跟着变：不再默认指向最后一条入站消息。
5. 移动端/窄屏：长按触发同一菜单。

**兼容性**

- 老数据（`replies` 里没有 `quote`）：按普通消息渲染，不显示引用块。
- 其他平台（飞书）：飞书本身支持引用回复，可按同样契约接入，但**默认也应该是普通发送**。

**风险**

- 引用对象需要在"历史消息"里可取：只允许引用 `receivedAs=user` 的钉钉消息，其他平台/自己发的消息不显示"回复"入口。
- `chat message reply` 对单聊不一定支持（P5），所以引用功能上线时要对 p2p 做降级：**引用条只在本机渲染，实际发送走 `send`**，避免又被 dws 拒绝。

---

## 四、P2：会话列表和手机对不上（新证据）

### 实测对比

`dws chat +chat-list --types group,p2p --page-all` 返回 **4 个**：

| 类型 | 名字 | conversationId |
|---|---|---|
| direct | 郑友佳 | `cidawPDdxpnUttEivql3hu3sfHlc2RNJIHJPqbVwknMVS8=` |
| group | 消息管理 | `cidtnU87VwpUmOPEKhMrr2Iyw==` |
| direct | 郑乐斌 | `cids1oy/hE8wrkIwXRx0e6EJPHlc2RNJIHJPqbVwknMVS8=` |
| group | 工作通知:消息管理 | `cidPekYat+DwMXquizt6ZcUJQ==` |

LinkHub 数据里也是 **4 个**，但内容不同：

| LinkHub | 对得上吗 |
|---|---|
| `cidtnU87…` group 3 条 | ✅ 消息管理 |
| `cids1oy…` p2p 5 条 | ✅ 郑乐斌 |
| `cidawPDd…` p2p 2 条 | ✅ 郑友佳 |
| `cidvtwlUu0ZWAYibiQCSj7PO7pH/c+…` p2p 15 条 | ❌ **chat-list 里没有** |
| （缺） | ❌ **少了「工作通知:消息管理」这个群** |

### 三个结论

1. **没同步会话表**：LinkHub 的会话来自消息聚合，所以 `工作通知:消息管理` 没消息 → 不显示。
2. **多出来的那个 `cidvtwl…`**：15 条消息、被标成 `p2p`，但它不在 chat-list 里 —— 很可能是**群消息被 `inferConversationType` 判成了单聊**（`mapPersonalEventToMessage` 里按 `event_type` 猜类型）。
3. **群名全空**：事件 schema 不带名字，只有 chat-list 有。

### 怎么改

1. 新增会话同步（`chat +chat-list --types group,p2p --page-all`），落 `conversations` 表：`id / type / name / memberCount / lastMsgAt`；
2. 左栏以会话表为准，消息只补未读和预览；
3. 消息入库时若能匹配到会话表，用会话表的 `type` 覆盖 `inferConversationType` 的猜测；
4. 会话表里没有的 conversationId（比如那个 `cidvtwl…`）标记为「未归属会话」，单独提示，方便排查。

---

## 五、P4：群消息全收（沿用上一轮方案）

```env
DINGTALK_USER_EVENT_KINDS=all-direct,at-me,all-group
```

配套必须先做存储改造（当前每条消息全量写快照）与断线回溯，详见 [dingtalk-all-group-plan.md](dingtalk-all-group-plan.md)。

---

## 六、建议的施工顺序

| 顺序 | 内容 | 理由 |
|---|---|---|
| 1 | **P1 发送语义**（默认普通发送 + 右键引用） | 你每天都在用，体验最痛 |
| 2 | P2 会话同步 + P3 群名 | 一次改造同时解决两个问题 |
| 3 | P4 群消息全收（含存储改造） | 需要前置存储改造 |
| 4 | P5 p2p 引用降级 | 跟 P1 一起做 |

---

## 七、需要你确认的两个产品决策

1. **引用入口放哪**：
   - A. 右键菜单（桌面）/ 长按（移动）→ 回复
   - B. 气泡右侧常驻「⋯」→ 回复
   - 建议：A+B 都支持，桌面右键、移动长按。

2. **群消息全收后，默认视图怎么处理**：
   - A. 全部平铺（像微信）
   - B. 默认只看 @我 / 单聊，群消息折叠为"群消息 N 条"
   - 你之前说要"像微信一样全都有"，我默认按 A 设计，但会保留按群静音的能力。