#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIST="$ROOT/apps/frontend/dist/frontend/browser"

DEV_BACKEND_PORT=11111
DEV_FRONTEND_PORT=4201

echo "==> Killing any leftover dev processes..."
for port in $DEV_BACKEND_PORT $DEV_FRONTEND_PORT; do
  pid=$(lsof -ti tcp:$port 2>/dev/null || true)
  if [ -n "$pid" ]; then
    exe=$(lsof -p "$pid" -Fn 2>/dev/null | grep "^n$ROOT" | head -1 || true)
    if [ -n "$exe" ]; then
      kill -9 $pid 2>/dev/null && echo "  killed pid $pid on :$port" || true
    else
      echo "  port $port in use by unrelated process ($pid), skipping"
    fi
  fi
done
pkill -f "$ROOT/apps/backend.*nest" 2>/dev/null || true
pkill -f "$ROOT/apps/backend/dist/src/main" 2>/dev/null || true
sleep 1

echo "==> Building frontend..."
(cd "$ROOT" && pnpm frontend:build) || { echo "Frontend build failed"; exit 1; }

echo "==> Starting backend on :$DEV_BACKEND_PORT ..."
(cd "$ROOT/apps/backend" && ELEVENEX_PROXY_PORT=$DEV_BACKEND_PORT FRONTEND_PORT=$DEV_BACKEND_PORT DB_PATH="$ROOT/apps/backend/dev.db" node_modules/.bin/nest start) &
PID_BE=$!

echo "==> Serving frontend on http://localhost:$DEV_FRONTEND_PORT ..."
npx --yes serve "$FRONTEND_DIST" --listen $DEV_FRONTEND_PORT --single &
PID_FE=$!

echo "==> Waiting for backend to be ready on :$DEV_BACKEND_PORT ..."
for i in $(seq 1 30); do
  (echo > /dev/tcp/127.0.0.1/$DEV_BACKEND_PORT) 2>/dev/null && break
  sleep 1
done

echo "==> Starting Electron..."
(cd "$ROOT" && env -u ELECTRON_RUN_AS_NODE ELECTRON_FRONTEND_URL=http://127.0.0.1:$DEV_FRONTEND_PORT ELECTRON_BACKEND_URL=http://127.0.0.1:$DEV_BACKEND_PORT pnpm electron:start) &
PID_EL=$!

echo ""
echo "  Backend : http://localhost:$DEV_BACKEND_PORT"
echo "  Frontend: http://localhost:$DEV_FRONTEND_PORT"
echo "  Electron: started"
echo ""
echo "Press Ctrl+C to stop all."

cleanup() {
  echo ""
  echo "Stopping..."
  kill $PID_BE $PID_FE $PID_EL 2>/dev/null || true
  pkill -f "$ROOT/apps/backend.*nest" 2>/dev/null || true
  pkill -f "$ROOT/apps/backend/dist/src/main" 2>/dev/null || true
  lsof -ti tcp:$DEV_BACKEND_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  lsof -ti tcp:$DEV_FRONTEND_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

wait
