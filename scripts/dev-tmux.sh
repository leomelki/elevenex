#!/bin/sh

set -eu

SESSION_NAME="${ELEVENEX_TMUX_SESSION:-elevenex-dev}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  exec tmux attach-session -t "$SESSION_NAME"
fi

tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:0.0" "pnpm backend:dev" C-m

tmux split-window -h -t "$SESSION_NAME:0" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:0.1" "pnpm frontend:dev" C-m

tmux select-pane -t "$SESSION_NAME:0.0"
tmux split-window -v -t "$SESSION_NAME:0.0" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:0.2" "pnpm electron:dev"

tmux select-layout -t "$SESSION_NAME:0" tiled
tmux select-pane -t "$SESSION_NAME:0.2"
exec tmux attach-session -t "$SESSION_NAME"
