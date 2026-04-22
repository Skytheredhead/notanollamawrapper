#!/bin/zsh
# Stops processes typically started by start-naow.command (backend, frontend, MLX runner).
# Double-click in Finder or run: ./stop-naow.command

set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR" || exit 1

BACKEND_PORT="${PORT:-5050}"
FRONTEND_PORT="${NAOW_FRONTEND_PORT:-5173}"
MLX_PORT="${NAOW_MLX_PORT:-5055}"

say() {
  printf "\033[1;36m[naow]\033[0m %s\n" "$*"
}

warn() {
  printf "\033[1;33m[naow]\033[0m %s\n" "$*"
}

kill_listeners_on_port() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ -z "$pids" ]]; then
    say "Nothing listening on port ${port} (${label})."
    return 0
  fi
  say "Stopping ${label} on port ${port} (PID(s): ${pids})..."
  kill $=pids 2>/dev/null || true
  sleep 0.4
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ -n "$pids" ]]; then
    warn "Port ${port} still in use; sending SIGKILL..."
    kill -9 $=pids 2>/dev/null || true
  fi
  say "Port ${port} cleared."
}

say "Stopping naow (from ${ROOT_DIR})"

kill_listeners_on_port "$BACKEND_PORT" "backend"
kill_listeners_on_port "$FRONTEND_PORT" "frontend"
kill_listeners_on_port "$MLX_PORT" "MLX runner"

say "Done. You can start again with start-naow.command."

printf "\nPress any key to close..."
read -k 1
echo ""
