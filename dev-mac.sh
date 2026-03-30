#!/bin/zsh
set -euo pipefail
unsetopt bg_nice 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")" && pwd)"
SELF="$ROOT/dev-mac.sh"
PROJECT="$ROOT/server/DiffSingerApi/DiffSingerApi.csproj"
BACKEND_RUNTIME_DLL="$ROOT/server/DiffSingerApi.dll"
BACKEND_RUNTIME_CONFIG="$ROOT/server/DiffSingerApi.runtimeconfig.json"
OPENUTAU_CORE="$ROOT/OpenUtau/OpenUtau.Core/OpenUtau.Core.csproj"
SEEDVC_APP="$ROOT/scripts/seedvc_service/app.py"
SEEDVC_ROOT="$ROOT/external/seed-vc"
DEFAULT_VOICEBANKS_DIR="$ROOT/server/voicebanks"
VOICEBANKS_DIR="${MELODY_VOICEBANKS_DIR:-$DEFAULT_VOICEBANKS_DIR}"
DOTNET_BIN="${DOTNET_BIN:-}"
SEEDVC_PYTHON_BIN="${SEEDVC_PYTHON_BIN:-$SEEDVC_ROOT/.venv/bin/python}"
BACKEND_HEALTH_URL="http://127.0.0.1:5000/api/voicebanks"
SEEDVC_HEALTH_URL="http://127.0.0.1:5001/health"
DEFAULT_FRONTEND_PORT="${MELODY_FRONTEND_PORT:-3000}"
BACKEND_START_TIMEOUT="${MELODY_BACKEND_START_TIMEOUT:-180}"
SEEDVC_START_TIMEOUT="${MELODY_SEEDVC_START_TIMEOUT:-60}"
FRONTEND_START_TIMEOUT="${MELODY_FRONTEND_START_TIMEOUT:-90}"
TMP_BASE="${TMPDIR:-/tmp}"
LAST_PID=""
typeset -a PIDS

usage() {
  cat <<'EOF'
用法:
  ./dev-mac.sh                 启动 Backend + Frontend
  ./dev-mac.sh all             同上；若 SeedVC 环境就绪则一并启动
  ./dev-mac.sh full            强制启动 Backend + SeedVC + Frontend
  ./dev-mac.sh check           检查 macOS 开发环境依赖
  ./dev-mac.sh backend         单独启动 DiffSinger 后端，自动选择兼容模式
  ./dev-mac.sh backend-runtime 单独启动已发布运行时
  ./dev-mac.sh backend-source  单独启动源码工程
  ./dev-mac.sh seedvc          单独启动 SeedVC 服务
  ./dev-mac.sh frontend [port] 单独启动前端，默认 3000
  ./dev-mac.sh help            显示帮助

环境变量:
  DOTNET_BIN                     指定 dotnet 可执行文件路径
  SEEDVC_PYTHON_BIN              指定 SeedVC Python 解释器路径
  MELODY_VOICEBANKS_DIR          指定声库目录，默认 ./server/voicebanks
  MELODY_FRONTEND_PORT           一键启动时的默认前端端口
  MELODY_BACKEND_START_TIMEOUT   Backend 健康检查等待秒数，默认 180
  MELODY_SEEDVC_START_TIMEOUT    SeedVC 健康检查等待秒数，默认 60
  MELODY_FRONTEND_START_TIMEOUT  Frontend 健康检查等待秒数，默认 90
EOF
}

is_macos() {
  [[ "$(uname -s)" == "Darwin" ]]
}

host_runtime_rid() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os:$arch" in
    Darwin:arm64)
      echo "osx-arm64"
      ;;
    Darwin:x86_64)
      echo "osx-x64"
      ;;
    Linux:arm64|Linux:aarch64)
      echo "linux-arm64"
      ;;
    Linux:x86_64)
      echo "linux-x64"
      ;;
    MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64)
      echo "win-x64"
      ;;
    *)
      return 1
      ;;
  esac
}

runtime_onnx_native_relpath() {
  local rid="$1"
  case "$rid" in
    osx-*)
      echo "runtimes/$rid/native/libonnxruntime.dylib"
      ;;
    linux-*)
      echo "runtimes/$rid/native/libonnxruntime.so"
      ;;
    win-*)
      echo "runtimes/$rid/native/onnxruntime.dll"
      ;;
    *)
      return 1
      ;;
  esac
}

backend_runtime_supports_host_platform() {
  local rid native_rel native_path

  backend_runtime_is_available || return 1
  rid="$(host_runtime_rid)" || return 0
  native_rel="$(runtime_onnx_native_relpath "$rid")" || return 0
  native_path="$ROOT/server/$native_rel"

  [[ -f "$native_path" ]] || return 1
  [[ -f "$ROOT/server/DiffSingerApi.deps.json" ]] || return 1
  rg -Fq "\"$native_rel\"" "$ROOT/server/DiffSingerApi.deps.json"
}

print_backend_runtime_incompatible_hint() {
  local rid native_rel
  rid="$(host_runtime_rid 2>/dev/null || true)"
  native_rel="$(runtime_onnx_native_relpath "$rid" 2>/dev/null || true)"
  echo "[提示] 当前已发布运行时不包含当前平台所需的 ONNX Runtime 本地库。"
  if [[ -n "$rid" ]] && [[ -n "$native_rel" ]]; then
    echo "[提示] 缺少 $rid 对应条目: $native_rel"
  fi
  echo "[提示] macOS 请优先使用 ./dev-mac.sh backend-source，或重新在本机执行 dotnet publish 生成兼容运行时。"
}

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait >/dev/null 2>&1 || true
}

print_log_tail() {
  local name="$1"
  local log="$2"
  if [[ -f "$log" ]]; then
    echo
    echo "[$name] 最近日志:"
    tail -n 40 "$log" || true
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local log="$3"
  local attempts="${4:-60}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "[错误] $name 未能在预期时间内启动: $url"
  print_log_tail "$name" "$log"
  return 1
}

start_process() {
  local name="$1"
  local log="$2"
  shift 2
  echo "[启动] $name ..."
  (
    cd "$ROOT"
    "$@" >"$log" 2>&1
  ) &
  LAST_PID="$!"
  PIDS+=("$LAST_PID")
}

port_is_listening() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

http_is_ready() {
  local url="$1"
  curl -fsS "$url" >/dev/null 2>&1
}

pick_frontend_port() {
  local port="$1"
  while port_is_listening "$port"; do
    port=$((port + 1))
  done
  echo "$port"
}

seedvc_is_available() {
  [[ -d "$SEEDVC_ROOT" ]] && [[ -f "$SEEDVC_APP" ]] && [[ -x "$SEEDVC_PYTHON_BIN" ]]
}

backend_runtime_is_available() {
  [[ -f "$BACKEND_RUNTIME_DLL" ]] && [[ -f "$BACKEND_RUNTIME_CONFIG" ]]
}

pick_backend_mode() {
  if backend_runtime_is_available; then
    if is_macos && ! backend_runtime_supports_host_platform; then
      if [[ -f "$PROJECT" ]] && [[ -f "$OPENUTAU_CORE" ]]; then
        echo "source"
        return 0
      fi
    fi
    echo "runtime"
  else
    echo "source"
  fi
}

resolve_dotnet() {
  if [[ -n "$DOTNET_BIN" ]]; then
    if [[ ! -x "$DOTNET_BIN" ]]; then
      echo "[错误] DOTNET_BIN 不可执行: $DOTNET_BIN"
      exit 1
    fi
    return 0
  fi

  if command -v dotnet >/dev/null 2>&1; then
    DOTNET_BIN="$(command -v dotnet)"
  elif [[ -x /usr/local/share/dotnet/dotnet ]]; then
    DOTNET_BIN="/usr/local/share/dotnet/dotnet"
  elif [[ -x /opt/homebrew/share/dotnet/dotnet ]]; then
    DOTNET_BIN="/opt/homebrew/share/dotnet/dotnet"
  else
    echo "[错误] dotnet 未安装或未加入 PATH。请先安装 .NET 8 SDK。"
    exit 1
  fi
}

ensure_backend_source_prereqs() {
  resolve_dotnet

  if [[ ! -f "$PROJECT" ]]; then
    echo "[错误] 未找到源码工程: $PROJECT"
    exit 1
  fi

  if [[ ! -f "$OPENUTAU_CORE" ]]; then
    echo "[错误] 未找到 OpenUtau 源码: $OPENUTAU_CORE"
    echo "[提示] 请先将 OpenUtau 放到仓库根目录的 OpenUtau/。"
    exit 1
  fi
}

ensure_backend_runtime_prereqs() {
  resolve_dotnet

  if ! backend_runtime_is_available; then
    echo "[错误] 未找到已发布运行时: $BACKEND_RUNTIME_DLL"
    echo "[提示] 可使用 ./dev-mac.sh backend-source，或先执行 dotnet publish。"
    exit 1
  fi

  if is_macos && ! backend_runtime_supports_host_platform; then
    echo "[错误] 当前已发布运行时与 macOS 不兼容。"
    print_backend_runtime_incompatible_hint
    exit 1
  fi
}

ensure_seedvc_prereqs() {
  if [[ ! -d "$SEEDVC_ROOT" ]]; then
    echo "[错误] 未找到 SeedVC 源码目录: $SEEDVC_ROOT"
    exit 1
  fi

  if [[ ! -f "$SEEDVC_APP" ]]; then
    echo "[错误] 未找到 SeedVC 服务入口: $SEEDVC_APP"
    exit 1
  fi

  if [[ ! -x "$SEEDVC_PYTHON_BIN" ]]; then
    echo "[错误] 未找到 SeedVC Python 环境: $SEEDVC_PYTHON_BIN"
    echo "[提示] 请先安装 external/seed-vc/.venv 依赖。"
    exit 1
  fi
}

ensure_frontend_prereqs() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "[错误] 未找到 npm，请先安装 Node.js。"
    exit 1
  fi

  if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "[错误] 未找到 node_modules，请先执行 npm install。"
    exit 1
  fi
}

has_voicebanks() {
  local -a voicebank_dirs
  [[ -d "$VOICEBANKS_DIR" ]] || return 1
  voicebank_dirs=("$VOICEBANKS_DIR"/*(/N))
  (( ${#voicebank_dirs[@]} > 0 ))
}

warn_if_no_voicebanks() {
  if ! has_voicebanks; then
    echo "[警告] 未发现可用声库目录内容: $VOICEBANKS_DIR"
    echo "[提示] 后端启动后 /api/voicebanks 可能返回空数组。"
  fi
}

run_backend_source() {
  ensure_backend_source_prereqs
  warn_if_no_voicebanks
  cd "$ROOT"
  exec "$DOTNET_BIN" run --project "$PROJECT" -- --VoicebanksPath="$VOICEBANKS_DIR"
}

run_backend_runtime() {
  ensure_backend_runtime_prereqs
  warn_if_no_voicebanks
  cd "$ROOT/server"
  exec "$DOTNET_BIN" "$BACKEND_RUNTIME_DLL"
}

run_backend_auto() {
  if [[ "$(pick_backend_mode)" == "runtime" ]]; then
    run_backend_runtime
  else
    run_backend_source
  fi
}

run_seedvc() {
  ensure_seedvc_prereqs
  export MPLCONFIGDIR="${TMP_BASE}/melody-singer-mpl"
  export XDG_CACHE_HOME="${TMP_BASE}/melody-singer-cache"
  mkdir -p "$MPLCONFIGDIR" "$XDG_CACHE_HOME"
  cd "$ROOT"
  exec "$SEEDVC_PYTHON_BIN" "$SEEDVC_APP"
}

run_frontend() {
  local port="${1:-$DEFAULT_FRONTEND_PORT}"
  ensure_frontend_prereqs
  cd "$ROOT"
  exec npm run dev -- --host 127.0.0.1 --port "$port"
}

run_check() {
  ensure_backend_source_prereqs
  ensure_frontend_prereqs
  warn_if_no_voicebanks

  echo "[检查通过] macOS 开发环境依赖已就绪。"
  echo "dotnet:  $DOTNET_BIN"
  echo "frontend: npm + node_modules"
  echo "voicebanks: $VOICEBANKS_DIR"

  if backend_runtime_is_available; then
    if backend_runtime_supports_host_platform; then
      echo "backend runtime: $BACKEND_RUNTIME_DLL"
      echo "backend default mode: runtime"
    else
      echo "backend runtime: 已发现，但不兼容当前平台"
      print_backend_runtime_incompatible_hint
      if [[ -f "$PROJECT" ]] && [[ -f "$OPENUTAU_CORE" ]]; then
        echo "backend default mode: source"
      fi
    fi
  else
    echo "backend runtime: 未发现，默认回退到 source"
    echo "backend default mode: source"
  fi

  if seedvc_is_available; then
    echo "seedvc:  $SEEDVC_PYTHON_BIN (optional)"
  else
    echo "seedvc:  未就绪 (optional)"
  fi
}

run_all() {
  local backend_mode="${1:-auto}"
  local seedvc_mode="${2:-auto}"
  local frontend_port="$DEFAULT_FRONTEND_PORT"
  local log_dir
  local backend_log
  local seedvc_log
  local frontend_log
  local resolved_backend_mode
  local should_start_seedvc="0"

  case "$backend_mode" in
    runtime)
      ensure_backend_runtime_prereqs
      resolved_backend_mode="runtime"
      ;;
    source)
      ensure_backend_source_prereqs
      resolved_backend_mode="source"
      ;;
    auto)
      resolved_backend_mode="$(pick_backend_mode)"
      if [[ "$resolved_backend_mode" == "runtime" ]]; then
        ensure_backend_runtime_prereqs
      else
        ensure_backend_source_prereqs
      fi
      ;;
    *)
      echo "[错误] 未知 backend mode: $backend_mode"
      exit 1
      ;;
  esac

  ensure_frontend_prereqs
  warn_if_no_voicebanks

  case "$seedvc_mode" in
    always)
      ensure_seedvc_prereqs
      should_start_seedvc="1"
      ;;
    auto)
      if seedvc_is_available; then
        should_start_seedvc="1"
      fi
      ;;
    never)
      should_start_seedvc="0"
      ;;
    *)
      echo "[错误] 未知 seedvc mode: $seedvc_mode"
      exit 1
      ;;
  esac

  trap cleanup EXIT INT TERM

  if port_is_listening "$frontend_port"; then
    frontend_port="$(pick_frontend_port "$frontend_port")"
    echo "[提示] 前端默认端口 $DEFAULT_FRONTEND_PORT 已被占用，自动切换到 $frontend_port。"
  fi

  log_dir="$(mktemp -d "$TMP_BASE/melody-singer-dev.XXXXXX")"
  backend_log="$log_dir/backend.log"
  seedvc_log="$log_dir/seedvc.log"
  frontend_log="$log_dir/frontend.log"

  echo "[日志] $log_dir"

  if http_is_ready "$BACKEND_HEALTH_URL"; then
    echo "[复用] Backend 已在运行: http://127.0.0.1:5000"
  elif port_is_listening 5000; then
    echo "[错误] 端口 5000 已被占用，但当前进程不是可用的 DiffSinger 后端。"
    return 1
  else
    echo "[模式] Backend 使用 $resolved_backend_mode"
    if [[ "$resolved_backend_mode" == "runtime" ]]; then
      start_process "Backend" "$backend_log" "$SELF" backend-runtime
    else
      start_process "Backend" "$backend_log" "$SELF" backend-source
    fi
    wait_for_http "Backend" "$BACKEND_HEALTH_URL" "$backend_log" "$BACKEND_START_TIMEOUT"
  fi

  if [[ "$should_start_seedvc" == "1" ]]; then
    if http_is_ready "$SEEDVC_HEALTH_URL"; then
      echo "[复用] SeedVC 已在运行: http://127.0.0.1:5001"
    elif port_is_listening 5001; then
      echo "[错误] 端口 5001 已被占用，但当前进程不是可用的 SeedVC 服务。"
      return 1
    else
      start_process "SeedVC" "$seedvc_log" "$SELF" seedvc
      wait_for_http "SeedVC" "$SEEDVC_HEALTH_URL" "$seedvc_log" "$SEEDVC_START_TIMEOUT"
    fi
  else
    echo "[提示] SeedVC 未配置完成，已跳过。"
  fi

  start_process "Frontend" "$frontend_log" "$SELF" frontend "$frontend_port"
  wait_for_http "Frontend" "http://127.0.0.1:$frontend_port" "$frontend_log" "$FRONTEND_START_TIMEOUT"

  echo
  echo "所有服务已启动:"
  echo "Backend:  http://127.0.0.1:5000"
  echo "Frontend: http://127.0.0.1:$frontend_port"
  if [[ "$should_start_seedvc" == "1" ]]; then
    echo "SeedVC:   http://127.0.0.1:5001"
  fi
  echo
  echo "按 Ctrl+C 可停止本脚本启动的服务。"

  wait
}

if [[ $# -gt 0 ]]; then
  COMMAND="$1"
  shift
else
  COMMAND="all"
fi

case "$COMMAND" in
  all)
    if [[ $# -ne 0 ]]; then
      echo "[错误] all 不接受额外参数。"
      usage
      exit 1
    fi
    run_all "auto" "auto"
    ;;
  full)
    if [[ $# -ne 0 ]]; then
      echo "[错误] full 不接受额外参数。"
      usage
      exit 1
    fi
    run_all "auto" "always"
    ;;
  check)
    if [[ $# -ne 0 ]]; then
      echo "[错误] check 不接受额外参数。"
      usage
      exit 1
    fi
    run_check
    ;;
  backend)
    if [[ $# -ne 0 ]]; then
      echo "[错误] backend 不接受额外参数。"
      usage
      exit 1
    fi
    run_backend_auto
    ;;
  backend-runtime)
    if [[ $# -ne 0 ]]; then
      echo "[错误] backend-runtime 不接受额外参数。"
      usage
      exit 1
    fi
    run_backend_runtime
    ;;
  backend-source)
    if [[ $# -ne 0 ]]; then
      echo "[错误] backend-source 不接受额外参数。"
      usage
      exit 1
    fi
    run_backend_source
    ;;
  seedvc)
    if [[ $# -ne 0 ]]; then
      echo "[错误] seedvc 不接受额外参数。"
      usage
      exit 1
    fi
    run_seedvc
    ;;
  frontend)
    if [[ $# -gt 1 ]]; then
      echo "[错误] frontend 最多接受一个端口参数。"
      usage
      exit 1
    fi
    run_frontend "${1:-$DEFAULT_FRONTEND_PORT}"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "[错误] 不支持的命令: $COMMAND"
    usage
    exit 1
    ;;
esac
