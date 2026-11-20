#!/usr/bin/env bash
# 一键端到端（macOS / Linux / Git Bash）：启动后端 → 等就绪 → 跑 smoke.py → 关服务
# 用法：pnpm e2e:sh   或   bash scripts/e2e.sh [port]
set -euo pipefail

PORT="${1:-3001}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="http://127.0.0.1:$PORT"
LOG="$ROOT/scripts/e2e-server.log"

# Windows 上 python3 可能指向微软商店占位符，回退到 python
PY="python3"
if ! command -v "$PY" >/dev/null 2>&1 || ! "$PY" --version >/dev/null 2>&1; then
  PY="python"
fi
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "[e2e] 未找到 Python，请安装 Python 3 后重试"
  exit 1
fi

cd "$ROOT"
echo "[e2e] 工作目录: $ROOT"

# 端口已被占用时必须拒绝：否则下面的健康检查会命中别人的服务，
# 冒烟结果不可信，甚至可能往真实实例灌消息（与 e2e.ps1 的预检保持一致）。
if "$PY" - "$PORT" <<'PY'
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
then
  echo "[e2e] 端口 $PORT 已被占用：换一个端口（pnpm e2e:sh 3102），或先关闭占用该端口的程序。"
  exit 1
fi

echo "[e2e] 启动后端服务 (port=$PORT, 强制 mock 模式，与本地 .env 里的真实凭据隔离) ..."
# 关键：e2e 必须完全离线可复现，不受 .env 中真实凭据影响；入密码牌也固定（避免用户改过 API_TOKEN 后 smoke 401）
# smoke.py 从 LINKHUB_API_TOKEN 读取令牌，故单独 export 给同脚本后续的 python 进程
export LINKHUB_API_TOKEN=dev-token
: > "$LOG"
# DATA_DIR/DATA_FILE 也清空：用户 .env 若设了快照目录，后端会恢复历史消息，
# smoke.py 固定 externalId 全被判 duplicate → received=0 假失败。e2e 必须纯内存。
SERVER_PORT="$PORT" API_TOKEN=dev-token \
FEISHU_MODE=mock DINGTALK_MODE=mock WECHAT_MODE=mock MAIL_MODE=mock \
DINGTALK_STREAM=false MAIL_ENABLED=false \
DATA_DIR= DATA_FILE= \
pnpm --filter @unimsg/server start > "$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  echo "[e2e] 关闭服务..."
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      # Windows: $! 是 MSYS 的 PID，taskkill 不认；按端口取真正的 Windows PID，
      # 再 /T 带走 node 子进程。端口在启动前已确认空闲，这里不会误杀。
      win_pid="$(netstat -ano 2>/dev/null | awk -v port=":$PORT" '$2 ~ port"$" && $4 == "LISTENING" { print $5; exit }')"
      if [ -n "$win_pid" ]; then
        taskkill //F //T //PID "$win_pid" >/dev/null 2>&1 || true
      fi
      ;;
    *)
      kill "$SERVER_PID" 2>/dev/null || true
      pkill -P "$SERVER_PID" 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 40); do
  if curl -sf "$BASE/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "[e2e] 服务未在 20 秒内就绪，日志如下："
  tail -n 20 "$LOG" || true
  exit 1
fi

echo "[e2e] 服务就绪，开始冒烟..."
# 先收下 smoke.py 的输出用于统计断言条数，再原样打印；失败时保留它的退出码，且不打印 PASS
smoke_code=0
smoke_out="$("$PY" scripts/smoke.py "$BASE")" || smoke_code=$?
printf '%s\n' "$smoke_out"
if [ "$smoke_code" -ne 0 ]; then
  echo "[e2e] FAIL (exit $smoke_code)"
  exit "$smoke_code"
fi
# 与 e2e.ps1 的成功信号保持一致：[e2e] PASS（grep -c 无匹配时返回 1，故兜底 true 以免 set -e 提前退出）
passed="$(printf '%s\n' "$smoke_out" | grep -c '^PASS ' || true)"
echo "[e2e] PASS (断言 $passed 条全部通过)"
