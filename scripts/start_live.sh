#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p .runtime
PID_FILE=".runtime/agent.pid"
LOG_FILE=".runtime/agent.log"
PLIST_FILE=".runtime/dev.woofy.agent.plist"
LABEL="dev.woofy.agent"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

cat >"$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$ROOT_DIR' && exec node --import tsx src/index.ts schedule</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST_FILE"
launchctl kickstart -k "$SERVICE"
sleep 2

PID="$(launchctl print "$SERVICE" 2>/dev/null | sed -n 's/.*pid = \([0-9][0-9]*\).*/\1/p' | head -n 1)"

if [[ -n "$PID" ]]; then
  echo "$PID" >"$PID_FILE"
  echo "Woofy agent started with pid $PID"
  exit 0
fi

echo "Woofy agent failed to start. Recent log output:"
sed -n '1,160p' "$LOG_FILE"
exit 1
