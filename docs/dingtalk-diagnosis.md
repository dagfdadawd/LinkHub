# 钉钉通道问题梳理（诊断阶段 · 未改代码）

> 诊断时间：2026-11-19 12:40–12:55
> 环境：`D:\LinkHub-push\unimsg-connector`，后端 3001，前端 5173
> 方法：读真实数据 `data/linkhub-state.json` + 直接执行 `tools/dws.exe` + 读连接器源码

---

## 一、先说结论

钉钉这块有 **4 个独立问题**，其中 2 个是"看不到"的（静默失败/设计缺口）：

| 编号 | 问题 | 严重度 | 用户能感知吗 |
|---|---|---|---|
| P0 | dws 未登录 → 钉钉一切写操作（发送/回复/会话列表）全失败 | 阻断 | 能：发送失败 |
| P1 | 左侧会话列表不是真实会话列表，只是"收到过消息的去重结果" | 高 | 能：与手机不一致 |
| P2 | 群会话永远没有名字，一律显示「群聊」 | 中 | 能：认不出是哪个群 |
| P3 | 群消息只有被 @ 才收（默认订阅 all-direct + at-me） | 高 | 能：手机有、这里没有 |
| P4 | 回复用的是 `chat message reply`（引用回复），p2p 会被 dws 拒绝 | 中 | 半能：登录后仍可能发不出 |

---

## 二、P0：dws 未登录（发送不出去的直接原因）

### 证据（我实际执行）

```console
$ tools\dws.exe auth status -f json
{
  "success": true,
  "authenticated": false,
  "message": "未登录"
}
```

```console
$ tools\dws.exe chat +chat-list -f json
{
  "error": {
    "code": 5,
    "message": "resolve access token: load access token: acquiring file lock:
                opening lock file: open C:\\Users\\33527\\.dws\\.data.lock: Access is denied."
  }
}
```

数据库里的失败记录（2026-11-18 23:03/23:04）：

```
钉钉本人身份未登录：请先在终端执行 `dws auth login` 完成授权
（或到 LinkHub「平台账号」页点「连接本人账号」）。
```

### 为什么

1. `~/.dws/token.json` 最后更新是 **11-13 13:41**，`auth status` 明确返回 `authenticated: false` —— 登录态已失效/从未完成。
2. dws 把真正的凭据放在 Windows 凭据库，所有需要凭据的命令都要先拿 `~/.dws/.data.lock` 文件锁。
3. 这个锁文件 **在我这边创建不了**（`Access is denied`）；`~/.dws` 目录 ACL 本身是正常的（SYSTEM/Administrators/33527 全 FullControl），所以是**进程上下文**问题，不是文件权限问题。
4. 因此：`auth status`（不碰锁）能跑；`chat +chat-list`、`message send`（要凭据）全挂。

### 怎么改（方案，未执行）

1. 先用 `dws auth login --device`（设备码模式，不需要浏览器）把登录态建起来：
   ```cmd
   cd /d D:\LinkHub-push\unimsg-connector
   tools\dws.exe auth login --device
   ```
   终端会给出 `user_code` + 短链接，你本人在钉钉里确认一次。
2. 若报 `Access is denied`（还是锁文件）：用管理员 CMD 执行
   ```cmd
   takeown /F "%USERPROFILE%\.dws" /R /D Y
   icacls "%USERPROFILE%\.dws" /reset /T /C
   del /f /q "%USERPROFILE%\.dws\.data.lock"
   ```
   或绕开：`setx DWS_CONFIG_DIR "D:\LinkHub-push\unimsg-connector\.dws-data"` 后重启后端。
3. 应用侧改进（代码）：把 `not-logged-in` 明确渲染成**可点击的登录入口**（现在只是文字提示），并在「平台账号」页显示 `auth status` 实时结果，而不是让用户靠猜。

---

## 三、P1：左侧列表不是"真实会话列表"

### 证据

真实数据里钉钉只有 **4 个会话、25 条消息**，全部 `title = null`：

```
cidvtwlUu0ZWAYibiQCSj7PO7p…  p2p    15 条（14 收 / 1 发）
cidtnU87VwpUmOPEKhMrr2Iyw=   group   3 条
cids1oy/hE8wrkIwXRx0e6EJPH…  p2p     5 条
cidawPDdxpnUttEivql3hu3sfH…  p2p     2 条
```

代码证据：

```ts
// connectors/dingtalkPersonal.ts
// 会话标题：event schema 未提供（group_updated 事件才有），不臆造
```

```ts
// config/runtime.ts
export const DEFAULT_DINGTALK_EVENT_KINDS: string[] = ['all-direct', 'at-me'];
```

全仓库搜索 `chat-list`：**只有一个飞书文件里出现，钉钉没有任何会话同步调用**。

### 为什么

1. 左栏的"会话"是从**收到的消息**里 `group by conversationId` 出来的，没收到消息的会话根本不存在。
2. 钉钉事件里不带会话名，所以群名永远是空 → 前端退化显示「群聊」；单聊退化显示发送者昵称。
3. 没有调用 `dws chat +chat-list`（该命令能列出你加入的全部群/单聊），所以"手机上有 20 个群，这里只有 2 个"是必然的。

### 怎么改（方案，未执行）

1. **新增会话同步任务**：登录可用时调 `dws chat +chat-list`（含单聊），把 `conversationId / type / title / owner / lastActiveAt` 落成一个会话表；
2. 左栏渲染改为"会话表 ∪ 消息聚合"，**以会话表为准**，消息只是补充未读数/预览；
3. 同步失败时（未登录）在列表顶部显示"钉钉未登录，当前只显示已收到消息的会话"，而不是静默地少几个群。

---

## 四、P2：群会话没有名字

见上：`conversation.title` 从创建起就是 `undefined`，前端 fallback 成「群聊」。
`+chat-list` 或 `+conversation-info` 都能补上这个名字，补上后 P2 与 P1 一起解决。

---

## 五、P3：群消息只收 @我的

`DEFAULT_DINGTALK_EVENT_KINDS = ['all-direct', 'at-me']`

- `all-direct`：全部单聊 ✅
- `at-me`：群里 @我 的消息 ✅
- `all-group`：全部群消息 ❌（默认没开）

所以群里别人聊天、群里有人 @ 别人，你在 LinkHub 都看不到 —— 与"手机上有、这里没有"完全吻合。

**怎么改**：`DINGTALK_EVENT_KINDS=all-direct,at-me,all-group`（配置项已支持，只需改配置）。代价是消息量会明显上涨，需要配合列表分页/去重策略。

---

## 六、P4：p2p 回复可能被 dws 拒绝

2026-11-13 12:44 真实失败：

```
dws 命令执行失败（chat message reply，exit=1）：
读取被引用消息失败，无法确认其是否属于话题圈，已阻止发送。
会话类型：p2p
```

说明"引用回复"这条路对单聊不稳。`dws` 同时提供 `chat message send`（直接发，不引用），
现在 LinkHub 回复走的是 `reply`。**建议**：会话类型为 p2p 时改用 `send` + `--open-dingtalk-id`，
群聊保留 `reply`（引用上下文有意义）。

---

## 七、我无法验证的部分（需要你一步操作）

| 想验证 | 卡在哪 |
|---|---|
| 登录后能否真正发出去 | `dws auth login` 需要**你本人**在钉钉确认，我这边无法代签 |
| 会话列表能否拉到全部群 | 同上（`chat-list` 要凭据） |
| 当前后端的事件监听是否还活着 | 只能看数据（最后一条入站 08:49），看不到后端日志 |

**请先做一步**（做完我立刻继续验证）：

```cmd
cd /d D:\LinkHub-push\unimsg-connector
tools\dws.exe auth login --device
```

把终端输出（`user_code` 那段）发我，或者你自己确认完告诉我 `authenticated: true`，
我再跑：`chat +chat-list` 拉全部会话 → 对比手机 → 再实测发一条单聊 + 一条群聊。

---

## 八、优先级建议

1. **P0 登录**（不做这个，其余都验证不了）
2. **P1 + P2 会话同步**（左侧列表真实性，用户最直观）
3. **P4 回复通道切换**（登录后仍发不出的话，就是这里）
4. **P3 订阅范围**（配置一行，但会带来消息量）