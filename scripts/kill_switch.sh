#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PID_FILE=".runtime/agent.pid"
LABEL="dev.woofy.agent"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

STOPPED=false

if launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
  STOPPED=true
fi

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if [[ -n "$PID" ]] && [[ "$PID" != "0" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    STOPPED=true
  fi
fi

rm -f "$PID_FILE"

if [[ "$STOPPED" == "true" ]]; then
  echo "Woofy agent stopped."
else
  echo "Woofy agent is not running."
fi
