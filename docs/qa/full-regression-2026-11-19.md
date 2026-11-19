# LinkHub 全项目回归测试报告

- 日期：2026-11-19
- 范围：`unimsg-connector`（server / web / desktop / scripts）+ 交付与部署链路
- 结论：**全部通过**（本轮新发现 3 个工具链问题，已修复并复测）

## 一、结果总览

| 测试面 | 用例 / 检查数 | 结果 | 备注 |
|---|---:|---|---|
| TypeScript 类型检查（shared / server / web） | 3 包 | ✅ 0 error | `pnpm -r typecheck` |
| 服务端单测（node:test） | 548 | ✅ 548 pass | 2 个 suite，0 fail |
| 前端单测（vitest） | 385 | ✅ 385 pass | 39 个文件全绿（含此前偶发的 MailAccountForm） |
| 项目自带 e2e 冒烟 | 20 项断言 | ✅ SMOKE OK | 独立 mock 实例 + 隔离数据目录 |
| `pnpm run doctor` 自检 | 8 PASS / 0 FAIL / 3 SKIP | ✅ 退出码 0 | 飞书/钉钉真实连通；企微/邮箱未配置按预期 SKIP |
| 全量 API 矩阵 | 80 | ✅ 80 pass | 所有 REST 路由 + 鉴权 + 隔离 + WS |
| 部署 / CORS / 并发 / 附件 | 15 | ✅ 15 pass | 单端口托管、白名单、50 并发、大小校验 |
| 全页面 UI 走查 | 32 | ✅ 32 pass | 7 个页面 + 设置 + 发送弹窗 + 移动端 |
| 零账号首次使用 + 后端离线 | 11 | ✅ 11 pass | 引导、注入示例、错误态不白屏 |
| 桌面轻量版构建 | 1 | ✅ 产出 zip 64.5 MB | 修复后通过 |
| 打包后的 server 产物 | 1 | ✅ 起服务 + 收消息正常 | `desktop/dist/app/server/server.cjs` |
| 交付打包 `pnpm run deliver` | 1 | ✅ 22 MB zip | 修复默认输出后通过 |

## 二、测试环境

- Node v24.14.0 / pnpm 9.15.9 / Python 3.14.6 / Windows。
- 所有写操作测试都在**隔离实例**上跑：独立 `DATA_DIR`、`FEISHU/DINGTALK/WECOM/MAIL_MODE=mock`、`MAIL_ENABLED=false`，不碰真实账号库与真实平台。
- UI 测试用无头 Chrome（CDP）真实点击，截图见 `_testrun/*.png`。
- 真实平台侧只做**只读**探测（`doctor`），未发送任何真实业务消息。

## 三、覆盖明细

### 1. 静态检查与单测

- `pnpm -r typecheck`：shared / server / web 全部通过。
- 服务端 548 条：账号体系、连接器、消息状态机、仓储、doctor、邮箱/飞书/钉钉身份、Stream、e2e 链路等。
- 前端 385 条：登录页、账号页、发送弹窗、详情面板、store、httpApi 等。

### 2. 项目自带 e2e（`pnpm e2e`）

`health → 三平台 webhook → 幂等 → 401 鉴权 → accounts → 列表 → reply → synced → Mock 标注 → trace 五事件 → 健康计数`，全部 PASS。

### 3. Doctor 自检（真实凭据，只读）

- 飞书 tenant token / 本人身份 / 用户轮询：PASS
- 钉钉 accessToken / 机器人编码 / Stream / dws 本人登录：PASS
- 企微、邮箱：未配置 → 按约定 SKIP，不伪造成功
- 出口 IP：113.118.83.251
- 结论 `PASS 8 / FAIL 0 / SKIP 3`，退出码 0

### 4. 全量 API 矩阵（80 项）

| 分组 | 覆盖 |
|---|---|
| 健康检查 | 200、四平台模式、计数字段 |
| 鉴权 | 8 个受保护读接口无令牌 401、错误令牌 401、有账号后部署令牌失效 |
| 账号 | 注册、登录、me、logout、改口令、重置、限流、注册准入 |
| Webhook | 飞书 / 钉钉 / 企微、重复幂等、未知平台 404、空事件安全忽略 |
| 消息 | 列表、详情、过滤、404、回复 202→synced、空回复 400、非法 identity 400、越权 404 |
| 状态机 | done / todo / read / unread / read-all / reanalyze / claim |
| 发送 | 主人 202、成员 403、缺参 400、非法平台 400 |
| 回放 | 事件齐全、模拟发送标注、不存在 trace 不 500 |
| 其它 | accounts / capabilities / contacts / onboarding / app-config / mail / 钉钉身份 / 飞书授权 |
| 协议 | 未知路由 404、非法 JSON 400、错误方法 404、CORS、query token |
| 实时 | WS 无效令牌 1008、会话令牌 connected、新消息推送 |

额外验证：**WS 跨账号隔离**——同一时刻连接主人与成员，注入消息后只有主人收到 `message.received`，成员收不到。

### 5. 部署 / 并发 / 附件（15 项）

- `WEB_DIST` 单端口部署：`/`、`/inbox` SPA 回退、静态资源、API 同端口、未知 API 404。
- `CORS_ORIGINS` 白名单：白名单 Origin 通过，`evil.example` 403。
- 50 个并发 webhook 全部 200 且全部入库，无 5xx。
- 重复 `msgId` 幂等。
- 附件发送：元数据入库、状态 synced；伪造 `size` 被 400 拒绝。
- 超长文本不产生 5xx。

### 6. 全页面 UI 走查

登录 → 收件箱（4 会话 / 5 消息）→ 搜索过滤（钉钉 1 条、无结果清空）→ 打开详情（URL 带 traceId）→ 输入并发送回复 → 标记完成/待办按钮 → 待办页 → 回放页 → 账号页（4 张卡）→ 连接页 → 群消息原型页 → 设置（个人资料/账号分区/改口令）→ 新建发送弹窗 → 移动端 390×844（无横向溢出、底部导航）→ 刷新保持登录。所有页面无控制台异常。

设置内改口令：提交后回到登录页 → 新口令可登录，符合"全端会话作废"的约定。

### 7. 零账号与异常态

- 全新实例（无账号）直接进 `/inbox`，显示「3 步上手」引导；点「先体验演示（注入示例消息）」后消息入库、引导消失。
- 后端不可达：页面不白屏，显示可读错误提示，无未捕获异常。

### 8. 桌面 / 交付

- `pnpm app:build:lite`：web 构建 → server 单文件打包（7.5 MB）→ 组装 node.exe 运行时 → 产出 `LinkHub-Lite-1.0.0-win-x64.zip`（64.5 MB，SHA256 已打印）。
- 直接运行打包出的 `server.cjs`：health 正常、webhook 入库、消息可读。
- `node scripts/deliver.mjs --allow-dirty`：22 MB 交付包，自动排除 `.env`/日志/水位/`node_modules`。

## 四、本轮发现并修复的问题

### 1. 桌面版打包在部分机器上必然失败（P1）

- **现象**：`pnpm app:build:lite` 最后一步 `tar -a -cf ...zip` 报 `exit 128`，前面构建全部成功、产物已生成，只有压缩失败。
- **原因**：脚本直接调用 PATH 里的 `tar` 并假设它是 bsdtar（支持 zip）。在 Git Bash / MSYS / 本机沙箱环境里 PATH 前面是 **GNU tar 1.35**，它不支持 zip 格式，`-a` 按后缀猜格式后失败；Windows `System32\tar.exe`（bsdtar）反而排在后面。
- **修复**：`desktop/scripts/build.mjs` 新增 `createZip()`：优先用 Windows 自带 `System32\tar.exe`，其次 PATH 里的 bsdtar，再其次 Unix `zip`，最后 PowerShell `Compress-Archive`；找不到工具时给出可操作报错，而不是隐晦的退出码。`zipApp` / `zipLite` 都改用它。
- **复测**：构建通过，zip 为合法 ZIP（`PK\x03\x04`），可正常列出内容。

### 2. 交付脚本默认输出目录不可写时直接崩（P2）

- **现象**：仓库在 `D:\LinkHub-push`，默认输出到上一级 `D:\`，`git archive` 报 `Permission denied` 并抛栈。
- **修复**：`scripts/deliver.mjs` 先探测可写性，按 `仓库上一级 → 仓库内 dist/（已 gitignore） → 用户主目录` 回退，并在回退时打印原因与 `--out` 用法；全部不可写时给出明确指引。
- **复测**：默认命令即可产出 22 MB 交付包。

### 3. Doctor 把合法变量误报成"拼错"（P2）

- **现象**：`pnpm run doctor` 把 `DWS_CONFIG_DIR` 报成"未在文档中定义，可能拼错"；同时新增的 `AUTH_REQUIRE_LOGIN / AUTH_REGISTRATION / AUTH_SIGNUP_CODE` 未进白名单，导致单测「`.env.example` 里每个键都必须被认作合法」失败。
- **修复**：`packages/server/src/doctor/env-check.ts` 的 `KNOWN_ENV_KEYS` 补齐这 4 个变量。
- **复测**：doctor 不再出现误报；`env-check.test.ts` 9/9 通过；服务端 548 全绿。

## 五、未覆盖 / 有意跳过

| 项 | 原因 |
|---|---|
| 真实平台**发送**消息 | 会真的打扰飞书/钉钉联系人，回归不发送真实业务消息；发送链路用 mock 全链路覆盖 |
| 真实邮箱收发 | 本机未配置 IMAP 账号（doctor SKIP）；邮箱逻辑由单测 + mock 覆盖 |
| 企业微信真实通道 | 未配置企微凭据（doctor SKIP） |
| Electron 完整版构建 | 需从镜像下载 ~100 MB Electron；本轮用 `--lite`（不依赖 Electron）验证了同一套 web/服务打包链路 |
| Docker 部署 | 本机未安装/未启用 Docker；单端口 `WEB_DIST` 部署已覆盖等价路径 |
| 桌面 App 的实际窗口/启动器 | 需要交互式桌面会话；打包产物与内置 server 已单独验证 |

## 六、复现命令

```bash
# 静态 + 单测
cd unimsg-connector
pnpm -r typecheck
pnpm --filter @unimsg/server test
pnpm --filter @unimsg/web test

# 项目 e2e（自带隔离 mock 实例）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Port 3110

# 真实凭据只读自检
pnpm run doctor

# 桌面轻量包
pnpm app:build:lite

# 交付包（工作区干净时省略 --allow-dirty）
node scripts/deliver.mjs --allow-dirty --out ./dist/LinkHub.zip
```

API / UI 矩阵脚本为本轮临时脚本（已清理）；结果与截图保留在仓库根 `_testrun/`（可随时删除）。

## 七、遗留风险（未在本轮修复）

来自上一轮登录注册审计、仍需排期的项：

1. `scryptSync` 同步阻塞事件循环，并发登录/注册会卡住整个服务。
2. CORS 未配置时默认 `*`（本报告已实测；生产建议显式 `CORS_ORIGINS`）。
3. 部署令牌仍可作为 `?token=` 查询参数传给 REST（WS 必须如此，REST 可收紧）。
4. 会话无数量上限、无滑动续期；登录失败计数表只在超限时清理。
5. 口令策略仍是最小 6 位（已禁止纯空白、自动 trim），无复杂度/弱口令校验。
6. `deliver.mjs` 打包的是 git HEAD：本轮改动尚未提交，交付前必须 `git commit`，否则包内不含这些修复。

## 八、截图索引（`_testrun/`）

- `full-01-inbox.png` 收件箱 / `walk-02-detail.png` 详情 / `walk-03-after-reply.png` 回复后
- `walk-04-todos.png` 待办 / `walk-05-trace.png` 回放 / `walk-06-accounts.png` 账号 / `walk-07-connect.png` 连接
- `walk-09-settings.png` 设置 / `walk-10-compose.png` 新建发送 / `walk-11-mobile.png` 移动端
- `fresh-01-first-run.png` 零账号引导 / `fresh-03-offline.png` 后端离线
- 登录注册专项：`ui2-01-wrong-password.png`、`v6-*` 系列