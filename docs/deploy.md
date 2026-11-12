# 独立部署指南（赛题 A · 决赛交付）

本指南面向**比赛指定的纯净服务器**：只需安装 Docker Engine + Docker Compose 插件，
不需要宿主机 Node.js、pnpm、PostgreSQL、Redis 或 nginx。一个容器、一个端口（3001）
即可跑通「接收 → 统一展示 → 处理 → 发送反馈 → 状态回流」的完整闭环。

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

---

## 3. 入口令牌（必读）

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
> 这是演示级方案；正式系统应改为登录后签发的短期凭证（见 README「已知限制」）。

`.env` 中的 `API_TOKEN=dev-token` 会被 compose 的 `environment` 覆盖，不会导致启动失败。
其余 `FEISHU_*` / `DINGTALK_*` / `WECOM_*` / `MAIL_*` / `LLM_*` 变量通过 `env_file` 注入容器，
换账号只改 `.env` 后 `docker compose up -d`（无需重新构建）。

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
本地开发不设 `DATA_DIR` 时仍是纯内存，不产生任何文件副作用。

---

## 5. 离线 / 无外网服务器

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

## 6. 常用运维命令

| 目的 | 命令 |
|---|---|
| 换端口 | `.env` 里设 `HOST_PORT=8080`，`docker compose up -d` |
| 看日志 | `docker compose logs -f app` |
| 重启 | `docker compose restart app` |
| 停止并保留数据 | `docker compose down` |
| 重新构建 | `docker compose up -d --build` |
| 调整附件上限 | `MAX_UPLOAD_MB`（请求体，默认 32）；单文件/总数上限在 `packages/shared/src/message.ts` 的 `FILE_LIMITS` |

---

## 7. 与赛题提交项的对应

| 决赛提交项 | 本方案 |
|---|---|
| 独立部署包（Docker 镜像或部署脚本，纯净服务器零依赖启动） | `Dockerfile` + `docker-compose.yml` + 本指南；`docker save/load` 支持离线 |
| 完整源代码与提交历史 | GitHub 仓库 `lebin2025/LinkHub` |
| 演示视频中的完整闭环 | 新建发送 / 回复 → 收件箱 → 状态回流 → 全链路回放，单端口可复现 |
| 部署指南（从零到一的精确步骤） | 本文第 2 节 |

---

## 8. 如实说明的边界

- **未使用 PostgreSQL / Redis**：当前为单实例 + 文件快照，多实例水平扩展时限流、token 缓存、消息不共享（`001_init.sql` 与仓储接口已预留切换点）。
- **高可用未实现**：没有负载均衡 / 容灾，附加分项不申领。
- **真实平台文件通道未端到端验证**：飞书 / 企微 / 邮箱的媒体上传与 MIME 附件已按官方接口实现并有单测，但受租户策略、可信 IP 限制，现场演示默认走 Mock 通道（界面会明确标注「模拟发送」）。
- 前端令牌进 bundle 是演示级取舍，见 README「已知限制」。
