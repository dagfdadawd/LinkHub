# 独立部署指南（赛题 A · 决赛交付）

本指南面向**比赛指定的纯净服务器**：只要装 Docker Engine 和 Docker Compose 插件，
宿主机上不需要 Node.js、pnpm、PostgreSQL、Redis 或 nginx。一个容器、一个端口（3001），
从收消息到回写、状态回流都能走完。

---

## 1. 目录与产物

| 文件 | 作用 |
|---|---|
| `unimsg-connector/Dockerfile` | 两阶段构建：Vite 产出前端静态资源 → Node 单进程同时托管 `/api`、`/ws`、前端页面 |
| `unimsg-connector/docker-compose.yml` | 一键编排：构建、端口映射、健康检查、数据卷、环境变量注入 |
| `unimsg-connector/.dockerignore` | 排除 `node_modules`、`.env`、日志等，凭据不进镜像 |
| `linkhub-data` 卷 | 消息 / 闭环日志 / 死信队列快照，重启后回放不丢 |

服务内部由 `WEB_DIST` 指向前端 `dist`，`express.static` + SPA 回退提供页面；
前端构建期注入 `VITE_API_BASE=/`，因此所有 `/api/*` 与 `/ws` 都走同源，无需反向代理。

---

## 2. 从零到一（精确步骤）

```bash
# 0) 前置：Docker Engine 24+ / Docker Compose v2.24+
docker --version
docker compose version

# 1) 拿到源码
git clone https://github.com/lebin2025/LinkHub.git
cd LinkHub/unimsg-connector

# 2) 可选：复制环境变量模板（不复制也能启动，默认全平台 Mock）
cp .env.example .env

# 3) 构建并后台启动
docker compose up -d --build

# 4) 等健康检查变 healthy（首次构建约 2–5 分钟）
docker compose ps
docker compose logs -f app

# 5) 打开统一入口
#    http://<服务器IP>:3001
```

冒烟自检（把 `<IP>` 换成服务器地址；本机用 `127.0.0.1`）：

```bash
# 健康检查（公共接口）
curl http://127.0.0.1:3001/api/health

# 带令牌读取消息列表（默认令牌见下）
curl -H "Authorization: Bearer linkhub-local-demo-2026-change-me" \
     http://127.0.0.1:3001/api/messages

# 发送能力（含文件上限）
curl -H "Authorization: Bearer linkhub-local-demo-2026-change-me" \
     http://127.0.0.1:3001/api/capabilities
```

浏览器里验证闭环：顶栏 **新建发送** → 选平台 + 填目标会话（邮箱平台可选发件账号）+ 文本/附件 → 发送，
消息立刻进入收件箱，状态经 WebSocket 从 `replied` 推进到 `sent` / `synced`，
在「全链路回放」里可逐条查看 `composed → processing → replied → sent → synced`。

**账号自检（只读，判断"填对了没有 / 平台连不连得通"）**——账号页的「已配置 / 真实接口」只代表变量填齐，**以 doctor 的 PASS/FAIL 为准**：

```bash
# 容器内执行（使用容器里注入的环境变量；只读，不发业务消息）
docker compose exec app pnpm --filter @unimsg/server run doctor
# 只查某平台：
docker compose exec app pnpm --filter @unimsg/server run doctor --platform=feishu,dingtalk
```

> ⚠️ 不要写 `pnpm doctor`（pnpm 9 内置同名命令会抢占，没有任何输出、退出码 0）。容器里改完 `.env` 后要 `docker compose up -d` 重建容器让它生效；宿主机 `.env` 的修改不影响已运行容器。

---

## 3. 入密码牌（必读）

生产模式下项目自带安全闸门会**拒绝使用默认 `dev-token` 启动**。
因此 compose 单独使用 `LINKHUB_DEPLOY_TOKEN`（默认 `linkhub-local-demo-2026-change-me`）：

```bash
# 生成强随机令牌（Linux/macOS）
openssl rand -hex 24

# 在 unimsg-connector/.env 里写入，然后必须重新构建
LINKHUB_DEPLOY_TOKEN=<上一步结果>
docker compose up -d --build
```

> ⚠️ 该令牌在**前端构建期**被注入 bundle，同时是**后端运行期**的 Bearer 令牌，
> 两者必须一致。修改后一定要 `--build`，否则前端会持续 401。
> 这是演示级方案；正式系统应改为登录后签发的短期凭证（见 [reference.md](reference.md)「已知限制」）。

`.env` 中的 `API_TOKEN=dev-token` 会被 compose 的 `environment` 覆盖，不会导致启动失败。
其余 `FEISHU_*` / `DINGTALK_*` / `WECHAT_*` / `MAIL_*` / `LLM_*` 变量通过 `env_file` 注入容器，
换账号只改 `.env` 后 `docker compose up -d`（无需重新构建）。
本人身份变量（`FEISHU_IDENTITY` / `FEISHU_USER_RECEIVE` / `DINGTALK_IDENTITY` / `DWS_*` 等）同样走 `env_file`；
改 `FEISHU_REDIRECT_URI` 后重启容器即可生效（无需重建镜像）。容器内本人身份的额外步骤与限制见第 5 节。

---

## 4. 数据与回放持久化

`DATA_DIR=/app/data` 时，仓储把消息、闭环日志、幂等表、DLQ 原子写入
`/app/data/linkhub-state.json`（先写 `.tmp` 再 rename，容器被强杀也不会写坏）。
该文件挂在 `linkhub-data` 卷上：

```bash
# 查看数据卷
docker volume inspect linkhub_linkhub-data

# 备份
docker compose exec app cat /app/data/linkhub-state.json > linkhub-backup.json

# 彻底重置演示数据（会清空收件箱与回放）
docker compose down
docker volume rm linkhub_linkhub-data
docker compose up -d
```

这保证赛题 3.2「闭环每一步可追踪、可回放、状态可同步」在**重启之后**依然成立；
本地开发默认持久化到 `unimsg-connector/.linkhub-data/`（重启不丢消息，评审 P1-8）；要纯内存零副作用，设 `DATA_FILE=none`。

---

## 5. 本人身份（可选）：容器内的额外步骤与限制

> 容器部署默认保证「机器人通道 + Mock」开箱即用；**本人身份（飞书 / 钉钉）需要额外的平台配置与真人授权**，不配置时按 `auto` 回退机器人，不影响闭环演示。
> 完整的平台前提见 [personal-identity.md](personal-identity.md)。

### 5.1 飞书本人身份（容器内）

1. **回调地址要与浏览器实际访问的地址一致**：OAuth 授权在浏览器里完成，飞书会跳回 `FEISHU_REDIRECT_URI`。
   - 浏览器在宿主机、容器端口映射为 `HOST_PORT`（默认 3001）：设 `FEISHU_REDIRECT_URI=http://localhost:<HOST_PORT>/api/feishu/oauth/callback`；
   - 直接访问服务器 IP：用 `http://<服务器IP>:<端口>/api/feishu/oauth/callback`（或反向代理域名），并保证该地址从浏览器可达；
   - **先把同一个值填进飞书后台「安全设置 → 重定向 URL」，再重启容器**（协议 / 域名 / 端口 / 路径 / 斜杠逐字符一致）。
2. **令牌持久化**：飞书令牌文件默认落在 `DATA_DIR`（容器为 `/app/data/feishu-user-token.json`），已挂 `linkhub-data` 卷——容器重建后授权不丢，除非删除数据卷。
3. **接收水位**：建议显式把水位文件放到数据卷，例如 `FEISHU_USER_STATE_FILE=/app/data/.feishu-user-receive.json`（默认路径以 `.env.example` 注释为准），避免容器重建后重新立基线。
4. **网络**：授权完成后浏览器需要能访问回调地址；反向代理场景把 `/api` 整体转发到容器 3001 即可。

### 5.2 钉钉本人身份（dws，容器内限制更多）

- dws 必须安装在**LinkHub 进程所在的容器内部**（后端以子进程调用本机 `dws`），宿主机装的不行；**默认镜像不包含 dws**——它是外部 CLI 且首次登录需要真人 OAuth 授权，容器默认没有浏览器与系统凭据，本项目不把"容器开箱即用本人身份"写进承诺。
- **推荐**：个人 / 小团队的钉钉本人身份用**本机部署**（`pnpm --filter @unimsg/server start`，见 [personal-identity.md §5](personal-identity.md#5-钉钉本人身份配置dws-cli)）；容器部署主打机器人通道 + Mock，二者不冲突。
- 确需容器内本人身份时，**自建镜像**（或进入容器安装）：
  1. 基础镜像换成 glibc 发行版（如 `node:22-bookworm-slim`）——官方 dws 的 Linux 产物依赖 glibc，**当前基于 Alpine（musl）的默认镜像不能直接运行**；
  2. 在镜像里安装 dws（官方 `install.sh`，或从官方 Releases 页面下载对应平台的 dws 二进制放到 `PATH`）；
  3. 把 dws 的配置与凭据目录挂到数据卷做持久化（Linux 下通常为 `~/.dws` 与 `~/.local/share/dws-cli`；以 dws 官方文档为准），否则容器重建需要重新登录；
  4. 容器内没有可用的本机浏览器，登录用**设备码（device flow）**：

     ```bash
     docker compose exec app sh
     dws auth login --device     # 在另一台有浏览器的设备上打开提示的 URL / 输入设备码完成授权
     ```

     设备码有**有效期**（终端/账号页弹窗会显示倒计时），必须在有效期内输入；过期后重新执行命令，或在账号页弹窗点「重新获取授权码」。容器里不要用浏览器 loopback 方式——`127.0.0.1` 回调指向容器内部，宿主机浏览器访问不到。

- **离线演示**：`scripts/` 会复制进镜像，容器内可用本地桩做本人身份闭环演示（不连接真实钉钉）：

  ```dotenv
  DWS_BIN=node /app/scripts/fake-dws.mjs
  ```

  演示时必须说明这是本地桩、不是真实钉钉登录（见 [demo-script.md](demo-script.md)）。
- 不装 dws 时：`auto` 回退机器人、`user` 显式报错；离线演示与真实收发都不会假成功。
- **如实标注**：容器内的钉钉本人身份同样依赖 `dws` 登录与授权（见 [personal-identity.md](personal-identity.md)），容器里需把 dws 凭据目录挂进去。

---

## 6. 离线 / 无外网服务器

若指定服务器不能联网，可在有网机器上先构建镜像再搬运：

```bash
# 有网机器
cd unimsg-connector
docker compose build
docker save linkhub:latest -o linkhub-image.tar

# 拷贝 linkhub-image.tar 到目标服务器后
docker load -i linkhub-image.tar
docker compose up -d          # 不要加 --build
```

运行期不访问 npm registry；未配置平台凭据时全部走本地 Mock，**零外网也能完整演示闭环**。

---

## 7. 常用运维命令

| 目的 | 命令 |
|---|---|
| 换端口 | `.env` 里设 `HOST_PORT=8080`，`docker compose up -d` |
| 看日志 | `docker compose logs -f app` |
| 重启 | `docker compose restart app` |
| 停止并保留数据 | `docker compose down` |
| 重新构建 | `docker compose up -d --build` |
| 调整附件上限 | `MAX_UPLOAD_MB`（请求体，默认 32）；单文件/总数上限在 `packages/shared/src/message.ts` 的 `FILE_LIMITS` |

---

## 8. 与赛题提交项的对应

| 决赛提交项 | 本方案 |
|---|---|
| 独立部署包（Docker 镜像或部署脚本，纯净服务器零依赖启动） | `Dockerfile` + `docker-compose.yml` + 本指南；`docker save/load` 支持离线 |
| 完整源代码与提交历史 | GitHub 仓库 `lebin2025/LinkHub` |
| 演示视频中的完整闭环 | 新建发送 / 回复 → 收件箱 → 状态回流 → 全链路回放，单端口可复现 |
| 部署指南（从零到一的精确步骤） | 本文第 2 节 |

---

## 9. 如实说明的边界

- **未使用 PostgreSQL / Redis**：当前为单实例 + 文件快照，多实例水平扩展时限流、token 缓存、消息不共享（`001_init.sql` 与仓储接口已预留切换点）。
- **高可用未实现**：没有负载均衡 / 容灾，附加分项不申领。
- **真实平台文件通道未端到端验证**：飞书 / 邮箱的媒体上传与 MIME 附件已按官方接口实现并有单测，但受租户策略限制，现场演示默认走 Mock 通道（界面会明确标注「模拟发送」）。
- **本人身份不是容器开箱能力**：飞书需管理员开用户身份权限 + 重定向 URL 与容器访问地址一致；钉钉 dws 需自建 glibc 镜像安装并在容器内 device-flow 登录，**默认镜像不包含 dws**——不配置时自动回退机器人，不会假成功（详见第 5 节）。
- 前端令牌进 bundle 是演示级取舍，见 [reference.md](reference.md)「已知限制」。
