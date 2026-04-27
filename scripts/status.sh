#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

STATUS_FILE=".runtime/agent-status.json"
LABEL="dev.woofy.agent"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

if launchctl print "$SERVICE" >/dev/null 2>&1; then
  PID="$(launchctl print "$SERVICE" 2>/dev/null | sed -n 's/.*pid = \([0-9][0-9]*\).*/\1/p' | head -n 1)"
  if [[ -n "$PID" ]]; then
    echo "Process: running (pid $PID)"
  else
    echo "Process: running"
  fi
else
  echo "Process: stopped"
fi

if [[ -f "$STATUS_FILE" ]]; then
  echo "Status snapshot:"
  cat "$STATUS_FILE"
else
  echo "Status snapshot: unavailable"
fi
