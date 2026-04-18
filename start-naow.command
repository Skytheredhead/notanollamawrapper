#!/bin/zsh
set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR" || exit 1

BACKEND_PORT="${PORT:-5050}"
FRONTEND_PORT="${NAOW_FRONTEND_PORT:-5173}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"
LOG_DIR="${TMPDIR:-/tmp}/naow-launcher"
BACKEND_LOG="${LOG_DIR}/backend.log"
FRONTEND_LOG="${LOG_DIR}/frontend.log"
typeset -a CHILD_PIDS

mkdir -p "$LOG_DIR"
: > "$BACKEND_LOG"
: > "$FRONTEND_LOG"

say() {
  printf "\033[1;36m[naow]\033[0m %s\n" "$*"
}

warn() {
  printf "\033[1;33m[naow]\033[0m %s\n" "$*"
}

fail() {
  printf "\033[1;31m[naow]\033[0m %s\n" "$*"
  printf "\nPress any key to close this window..."
  read -k 1
  exit 1
}

cleanup() {
  if (( ${#CHILD_PIDS[@]} )); then
    say "Stopping processes started by this launcher..."
    for pid in "${CHILD_PIDS[@]}"; do
      kill "$pid" >/dev/null 2>&1 || true
    done
  fi
}

trap cleanup INT TERM EXIT

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

url_ok() {
  curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local pid="${3:-}"
  local log_file="${4:-}"

  for _ in {1..80}; do
    if url_ok "$url"; then
      say "${label} is ready at ${url}"
      return 0
    fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" >/dev/null 2>&1; then
      warn "${label} exited before it was ready."
      [[ -n "$log_file" ]] && tail -40 "$log_file"
      return 1
    fi
    sleep 0.25
  done

  warn "${label} did not become ready in time."
  [[ -n "$log_file" ]] && tail -40 "$log_file"
  return 1
}

say "Launching from ${ROOT_DIR}"

command_exists node || fail "Node.js is missing. Install Node.js 22+ first."
command_exists npm || fail "npm is missing. Install Node.js 22+ first."
command_exists curl || fail "curl is missing."

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 22 )); then
  fail "Node.js 22+ is required. Found $(node -v 2>/dev/null || echo unknown)."
fi

if [[ ! -d node_modules ]]; then
  say "Installing backend dependencies..."
  npm install || fail "Backend npm install failed."
fi

if [[ ! -d frontend/node_modules ]]; then
  say "Installing frontend dependencies..."
  npm --prefix frontend install || fail "Frontend npm install failed."
fi

if [[ ! -x .naow/mlx-venv/bin/python ]]; then
  warn "MLX runtime is not set up yet. The backend will still start, but local MLX models may be unavailable."
  warn "Run npm run setup:mlx later if you need MLX model support."
fi

BACKEND_STARTED=0
FRONTEND_STARTED=0

if url_ok "${BACKEND_URL}/health"; then
  say "Backend is already running at ${BACKEND_URL}"
elif port_in_use "$BACKEND_PORT"; then
  fail "Port ${BACKEND_PORT} is already in use, but ${BACKEND_URL}/health is not responding."
else
  say "Starting backend on ${BACKEND_URL}"
  npm run dev > "$BACKEND_LOG" 2>&1 &
  BACKEND_PID=$!
  CHILD_PIDS+=("$BACKEND_PID")
  BACKEND_STARTED=1
  wait_for_url "Backend" "${BACKEND_URL}/health" "$BACKEND_PID" "$BACKEND_LOG" || fail "Backend failed to start."
fi

if url_ok "$FRONTEND_URL"; then
  say "Frontend is already running at ${FRONTEND_URL}"
elif port_in_use "$FRONTEND_PORT"; then
  fail "Port ${FRONTEND_PORT} is already in use, but ${FRONTEND_URL} is not responding."
else
  say "Starting frontend on ${FRONTEND_URL}"
  npm --prefix frontend run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" > "$FRONTEND_LOG" 2>&1 &
  FRONTEND_PID=$!
  CHILD_PIDS+=("$FRONTEND_PID")
  FRONTEND_STARTED=1
  wait_for_url "Frontend" "$FRONTEND_URL" "$FRONTEND_PID" "$FRONTEND_LOG" || fail "Frontend failed to start."
fi

say "Opening ${FRONTEND_URL}"
open "$FRONTEND_URL" >/dev/null 2>&1 || true

cat <<EOF

naow is up.

Frontend: ${FRONTEND_URL}
Backend:  ${BACKEND_URL}

Keep this window open while you use the app.
Press Ctrl+C to stop anything this launcher started.

Logs:
  ${BACKEND_LOG}
  ${FRONTEND_LOG}

EOF

if (( BACKEND_STARTED || FRONTEND_STARTED )); then
  tail -n +1 -f "$BACKEND_LOG" "$FRONTEND_LOG" &
  TAIL_PID=$!
  wait "$TAIL_PID"
else
  say "Everything was already running. Press Ctrl+C when you are done with this launcher."
  while true; do sleep 3600; done
fi
