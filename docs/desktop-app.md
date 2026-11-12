# LinkHub 桌面版（打包成 App）

> 目标：让 LinkHub 从「命令行 + 浏览器」变成**双击即用的桌面应用**：
> 主界面是独立窗口，本地服务自动启动/退出，配置与数据都在用户目录，不需要装 Node / pnpm，不需要浏览器地址栏。

---

## 0. 结论先说：本机有两种形态，推荐「轻量版」

| 形态 | 产物 | 适用环境 | 本机（Windows 11 + 智能应用控制） |
|---|---|---|---|
| **轻量版（推荐）** | `LinkHub-Lite-1.0.0-win-x64.zip`（约 34 MB，解压即用） | 所有 Windows 10/11 | ✅ 可直接运行 |
| **Electron 完整版** | `LinkHub-1.0.0-win-x64.zip`（约 111 MB，含独立 exe 与原生窗口） | 普通 Windows（**未开启**智能应用控制） | ⚠️ 系统会拦截：`应用程序控制策略已阻止此文件` |

**为什么本机推荐轻量版**：这台 Windows 11 开启了「智能应用控制（Smart App Control）」强制模式，
它只允许**有数字签名/有信誉**的可执行文件。Electron 官方运行时（electron.exe）**没有数字签名**，
所以无论是原版还是改名后的 `LinkHub.exe` 都会被系统直接拦截——这不是我们程序的问题，
Electron 生态在开启该功能的机器上普遍如此。

轻量版因此改用系统里**已签名**的程序来承载：
- 用**已签名的 node.exe**（OpenJS Foundation 签名）跑本地服务（打包进 `runtime/node.exe`，不依赖用户装 Node）；
- 用**已签名的 Edge**（Windows 11 自带，Chrome 亦可）以 `--app` 模式开一个**无地址栏/无标签页的独立窗口**，
  任务栏里是一扇独立窗口，效果接近普通桌面 App。

如果以后关闭了智能应用控制（设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制），
就可以直接用 Electron 完整版，体验更标准（自定义 exe 图标/名称/原生窗口）。该设置关闭后需重置系统才能重新开启，请自行权衡。

---

## 1. 使用方式（轻量版）

1. 解压 `LinkHub-Lite-1.0.0-win-x64.zip`（或直接使用桌面上的 `LinkHub-App` 文件夹）；
2. 双击 **`启动 LinkHub.vbs`**（桌面已建好 `LinkHub` 快捷方式，双击即可）；
3. 首次启动会自动创建配置，窗口打开后先看**首次使用引导**：收件箱顶部横幅「首次使用：先连接你自己的账号」→ 点 **「去连接账号」** 进入 **「连接账号」** 页（左侧导航也有），按 **邮箱 → 钉钉 → 飞书 → 企业微信** 逐项连接（详见 [quickstart.md 路径 E](quickstart.md#path-e)）；点「稍后再说」后不再打扰，需要时可从左侧「连接账号」或「平台账号」页右上「打开「连接账号」向导」再进：
   - 不填任何凭据 = 四平台自动 Mock，可完整走通「接收 → 处理 → 回写 → 回流 → 回放」演示；
   - 接真实平台：编辑 `%APPDATA%\LinkHub\.env`（见 §3），保存后关闭 App 重新打开；
4. **关闭应用窗口 = 退出 App**：本地服务会被一并停止（不会留后台进程/端口）。

行为细节：
- 单实例：重复双击不会开第二个窗口，会提示「已经在运行」；
- 服务只监听 `127.0.0.1`，不暴露到局域网；入口令牌在每次构建时随机生成并同时烤进前端；
- 端口优先 3901，被占用会自动顺延（3902、3903…），启动日志里会写明实际端口；
- 关闭窗口时若有异常退出，会弹出错误框并给出日志路径。

## 2. 目录与文件

| 内容 | 位置 |
|---|---|
| 程序目录（可整体移动/删除） | 解压出来的 `LinkHub-Lite\`（或 `C:\Users\<用户>\Desktop\LinkHub-App`） |
| 内置运行时 | `LinkHub-Lite\runtime\node.exe`（已签名，不依赖用户安装 Node） |
| 本地服务（单文件） | `LinkHub-Lite\server\server.cjs`（esbuild 打包，含 express/ws/钉钉/飞书 SDK） |
| 前端静态资源 | `LinkHub-Lite\web\`（Vite 产物，同源部署） |
| 启动器 | `LinkHub-Lite\启动 LinkHub.vbs` + `launcher\launcher.ps1` |
| 用户配置 | `%APPDATA%\LinkHub\.env`（首次自动创建，含中文注释模板） |
| 数据 | `%APPDATA%\LinkHub\data`（消息快照 / 飞书用户令牌 / 邮箱水位，重装不丢） |
| 日志 | `%APPDATA%\LinkHub\logs\`（`launcher.log` 启动器、`server.log` 服务） |
| 浏览器专属 profile | `%APPDATA%\LinkHub\browser-profile`（App 窗口的独立配置，删掉会自动重建） |
| 内置 dws（钉钉本人身份用） | 轻量版：`LinkHub-Lite\tools\`；Electron 版：`resources\app\tools\`（构建时若已执行 `pnpm run fetch:dws` 才会带上；dws 运行时是**一整个目录**——`dws.exe` + 同名 DLL + `skt.bin` 等配置，必须一起保留。桌面版优先用内置，其次 `%USERPROFILE%\.local\bin\dws.exe`，最后 PATH） |

升级：替换整个程序目录即可，`%APPDATA%\LinkHub` 里的配置与数据保留。
卸载：删除程序目录 + `%APPDATA%\LinkHub`（以及桌面快捷方式）。

## 3. 配置真实平台账号

配置文件：`%APPDATA%\LinkHub\.env`（从包内 `config\.env.example` 复制而来，字段含义与仓库 `.env.example` 完全一致）。

- 飞书 / 钉钉 / 企业微信 / 邮箱：按模板填写后**关闭 App 再打开**；
- 飞书本人身份：账号页点「连接本人账号」走 OAuth（回调默认 `http://localhost:<端口>/api/feishu/oauth/callback`，
  必要时在 `.env` 显式设置 `FEISHU_REDIRECT_URI`，端口见本次启动日志）；
- 邮箱：**不用改 `.env`**——「连接账号」页 → 邮箱卡片「添加邮箱账号」，填地址 + 授权码（测试连接 → 保存账号，热加载无需重启）；也仍支持在 `.env` 里按 `MAIL_<KEY>_*` 配置。
- 钉钉本人身份：桌面包**已内置官方 `dws`**（构建前置见 §4），用户不用自己装；在「连接账号」钉钉卡片点「用浏览器登录（推荐）」按弹窗完成真人授权即可。若这个包是**构建时没跑 `pnpm run fetch:dws`** 的版本，则回退为：本机安装 `dws` 到 `%USERPROFILE%\.local\bin\dws.exe`（或 PATH），或在源码里先 `pnpm run fetch:dws` 后重新构建；没有 dws 不影响邮箱/飞书/企微，钉钉卡片会显示「需安装」并给下载入口。
- 桌面版会强制使用自己的入口令牌与数据目录（`API_TOKEN` / `DATA_DIR` 由启动器注入），
  `.env` 里这两项对本 App 不生效——这是为了避免令牌不一致导致 401、以及数据写进程序目录。

> 提示：如果同时开着命令行开发版（`pnpm start` / `start.bat`），不要同时开桌面版；两个实例会用同一套平台凭据
> 建立长连接（钉钉 Stream / 飞书长连接），可能互相顶掉。演示时二选一即可。

## 4. 从源码重新构建

前置：Windows、Node ≥ 20、pnpm 9（本仓库已配置 `packageManager`）。

```bash
cd unimsg-connector
pnpm install                 # 会安装 desktop 工程依赖（esbuild/resedit，很小）
pnpm run fetch:dws           # 构建前置（重要）：下载官方 dws 运行时到 unimsg-connector/tools/，打包时整个目录进 App（约 24MB+；跳过则包内不含 dws）
pnpm app:build:lite          # 构建轻量版（推荐；不会下载 Electron）
# 或
pnpm app:build               # 构建 Electron 完整版（首次会从 npmmirror 下载约 110MB 运行时）
```

产物：
```
unimsg-connector/desktop/dist/
  LinkHub-Lite/                          # 轻量版程序目录（可直接双击）
  LinkHub-Lite-1.0.0-win-x64.zip         # 轻量版便携包
  LinkHub/                               # Electron 版程序目录
  LinkHub-1.0.0-win-x64.zip              # Electron 版便携包
```

构建脚本做的事（`desktop/scripts/build.mjs`）：
1. `vite build` 构建前端，注入 `VITE_API_BASE=/` 与本次随机的本机 token；
2. `esbuild` 把 `packages/server` 打成单文件 `server.cjs`（Node 20 目标，兼容 Electron 内置 Node）；
3. 若 `tools/dws.exe` 存在：**整个 `tools/` 目录**（dws.exe + 运行时 DLL/配置）复制进包——轻量版到 `LinkHub-Lite\tools\`（启动器优先设 `DWS_BIN` 为它），Electron 版到 `resources\app\tools\`（主进程优先用内置）；不存在则跳过并打印提示，应用照常可用（钉钉卡片显示「需安装」）；
   3. 轻量版：复制已签名 `node.exe` + 启动器 + 前端 + 服务 + 配置模板；
   Electron 版：从 npmmirror 下载运行时 → 组装 `resources/app` → `resedit` 写入图标与版本信息；
4. 打包 zip，打印 SHA256。

图标重建：`pnpm desktop:icon`（用 Pillow 生成 512px PNG + 多尺寸 ICO，已提交进仓库，一般不需要重跑）。

## 5. 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 双击 Electron 版报「应用程序控制策略已阻止此文件」 | 本机开启了智能应用控制，且 Electron 无数字签名 → 用轻量版；或自行关闭智能应用控制（不可逆） |
| 双击后没反应/过几秒消失 | 看 `%APPDATA%\LinkHub\logs\launcher.log` 与 `server.log`；常见是 3901–3930 全被占用、或杀毒软件拦截脚本 |
| 提示「LinkHub 已经在运行了」 | 单实例保护：已有窗口在后台，去任务栏找 LinkHub 窗口 |
| 窗口打开是空白/连不上 | 本地服务没起来：看日志；重开 App 会自动重试起服务 |
| 改了 `.env` 不生效 | 需要**关闭 App 重新打开**（启动器只在启动时读配置） |
| 关闭窗口后后台还有进程？ | 正常设计是窗口关闭即停服；若任务管理器残留，看日志是否 launcher 被杀（强杀 wscript/powershell 会跳过清理） |
| 想换端口 | 端口自动从 3901 顺延；如需固定，可在启动前设环境变量 `LINKHUB_DESKTOP_PORT`（Electron 版） |
| Edge 窗口想全屏/记住大小 | 窗口大小记忆由 `%APPDATA%\LinkHub\browser-profile` 负责；删掉可重置 |
| 首次打开不知道从哪开始 | 收件箱顶部横幅「首次使用…」→「去连接账号」；或左侧「连接账号」。四个平台逐项连接，带「需管理员」的项把卡片里的清单发给企业管理员 |
| 钉钉显示「需安装 dws」/ 登录报未找到 dws | 这个包构建时没包含 dws：在源码里 `pnpm run fetch:dws` 后重新构建，或本机安装 `dws` 到 `%USERPROFILE%\.local\bin\dws.exe`；不影响其它平台 |

## 6. 限制与安全说明

- **单机单实例**：一次只有一个用户/一个窗口；多人共享同一台机器请各自用不同 Windows 账户（userData 按用户隔离）。
- **只监听回环地址**：`127.0.0.1`，局域网/外网访问不到；入口令牌随构建随机生成。
- **不携带任何凭据**：交付 zip 里没有 `.env`/令牌/邮箱授权码；首次运行生成的是全 Mock 模板。
- **内置 dws 是官方二进制、不含登录凭据**：首次使用钉钉本人身份仍需你本人在浏览器完成一次授权；换机/重装后需重新登录。
- **轻量版的窗口是 Edge App 模式**：任务栏图标是 Edge 的；窗口标题与页面是 LinkHub。若企业策略禁用 Edge 可换 Chrome（脚本会自动找）。
- **Electron 版在未开智能应用控制的机器上**才是完整原生 App 体验（自定义图标/名称）。
- 真实平台（尤其钉钉 dws 个人身份、飞书 OAuth）需要真人授权步骤，App 内只负责引导与状态展示。