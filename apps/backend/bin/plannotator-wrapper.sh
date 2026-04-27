#!/bin/sh
# Elevenex Plannotator Browser Wrapper
# Called by PLANNOTATOR_BROWSER env var when plannotator wants to open a URL
# Routes the URL to the Elevenex backend instead of opening a browser

URL="$1"
[ -z "$URL" ] && exit 0

SESSION_ID="${ELEVENEX_SESSION_ID:-}"
ELEVENEX_PORT="${ELEVENEX_PORT:-}"

# Logging setup
LOG_DIR="${HOME}/.plannotator"
LOG_FILE="${LOG_DIR}/wrapper.log"
mkdir -p "$LOG_DIR" 2>/dev/null
# Rotate: truncate if > 1MB
[ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null)" -gt 1048576 ] && : > "$LOG_FILE"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE" 2>/dev/null; }

log "invoked: URL=$URL ELEVENEX_PORT=$ELEVENEX_PORT SESSION_ID=$SESSION_ID"

# If we have the backend port and session id, send the URL directly to Elevenex.
if [ -n "$ELEVENEX_PORT" ] && [ -n "$SESSION_ID" ]; then
  ESCAPED_URL=$(printf '%s' "$URL" | sed 's/\\/\\\\/g; s/"/\\"/g')
  OPENED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  JSON_BODY=$(printf '{"sessionId":%s,"url":"%s","openedAt":"%s"}' "$SESSION_ID" "$ESCAPED_URL" "$OPENED_AT")

  log "sending to backend at 127.0.0.1:$ELEVENEX_PORT"
  RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" -w "\n%{http_code}" "http://127.0.0.1:${ELEVENEX_PORT}/api/plannotator/register-open" \
    -d "$JSON_BODY" 2>&1)
  CURL_EXIT=$?
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  HTTP_BODY=$(echo "$RESPONSE" | sed '$d')
  log "curl result: exit=$CURL_EXIT http=$HTTP_CODE body=$HTTP_BODY"
  exit 0
fi

log "missing SESSION_ID or ELEVENEX_PORT, exiting without fallback"
exit 0
