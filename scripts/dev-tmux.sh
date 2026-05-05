#!/bin/zsh

set -eu

SESSION_NAME="${ELEVENEX_TMUX_SESSION:-elevenex-dev}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  exec tmux attach-session -t "$SESSION_NAME"
fi

# Start the session with a login shell so each pane inherits the full user
# environment (PATH, Volta, nvm, etc.) from ~/.zshrc / ~/.zprofile.
tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR"
tmux set-option -t "$SESSION_NAME" default-shell "$SHELL"
tmux set-option -t "$SESSION_NAME" default-command "exec $SHELL -l"

tmux send-keys -t "$SESSION_NAME:0.0" "pnpm backend:dev" C-m

tmux split-window -h -t "$SESSION_NAME:0" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:0.1" "pnpm frontend:dev" C-m

tmux select-pane -t "$SESSION_NAME:0.0"
tmux split-window -v -t "$SESSION_NAME:0.0" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:0.2" "pnpm electron:dev"

tmux select-layout -t "$SESSION_NAME:0" tiled
tmux select-pane -t "$SESSION_NAME:0.2"
exec tmux attach-session -t "$SESSION_NAME"
