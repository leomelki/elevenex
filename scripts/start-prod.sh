#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIST="$ROOT/apps/frontend/dist/frontend/browser"
BACKEND_DIST="$ROOT/apps/backend/dist"

echo "==> Building backend and frontend in parallel..."
(cd "$ROOT" && pnpm backend:build) &
PID_BE_BUILD=$!
(cd "$ROOT" && pnpm frontend:build) &
PID_FE_BUILD=$!

wait $PID_BE_BUILD || { echo "Backend build failed"; exit 1; }
wait $PID_FE_BUILD || { echo "Frontend build failed"; exit 1; }

echo "==> Starting backend..."
node "$BACKEND_DIST/main.js" &
PID_BE=$!

echo "==> Serving frontend on http://localhost:4200 ..."
npx --yes serve "$FRONTEND_DIST" --listen 4200 --single &
PID_FE=$!

echo ""
echo "  Backend : http://localhost:11111"
echo "  Frontend: http://localhost:4200"
echo ""
echo "Press Ctrl+C to stop both."

cleanup() {
  echo ""
  echo "Stopping..."
  kill $PID_BE $PID_FE 2>/dev/null
}
trap cleanup INT TERM

wait $PID_BE $PID_FE
