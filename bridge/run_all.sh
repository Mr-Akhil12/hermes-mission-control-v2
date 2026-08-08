#!/bin/bash
# Hermes OS v2 — run both the Turso bridge loop AND the state server.
# Used by the hermes-os-bridge systemd service so both survive reboots.
set -e

export TURSO_URL="https://akhils-budget-mr-akhil12.aws-ap-northeast-1.turso.io"
export TURSO_TOKEN="$(grep '^TURSO_AUTH_TOKEN=' /home/akhil/.hermes/secrets.md | cut -d= -f2-)"
export API_SERVER_KEY="$(grep '^API_SERVER_KEY=' /home/akhil/.hermes/.env | cut -d= -f2- | tr -d '"' | tr -d "'")"
export NATIVE_URL="http://127.0.0.1:9119"

cd /home/akhil/hermes-mission-control-v2

# Use the Hermes venv python — it has pywebpush (Web Push) + all deps.
PY=/home/akhil/.hermes/hermes-agent/venv/bin/python3
[ -x "$PY" ] || PY=python3

# Clean shutdown: kill children on SIGTERM so systemd restarts don't leave
# duplicate bridge loops behind (KillMode=control-group + this trap).
STATE_PID=""
BRIDGE_PID=""
cleanup() {
  [ -n "$STATE_PID" ] && kill "$STATE_PID" 2>/dev/null
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null
  exit 0
}
trap cleanup TERM INT

# Start the state server in the background
$PY bridge/state_server.py &
STATE_PID=$!

# Run the bridge loop in the background too (systemd tracks the wrapper)
$PY bridge/bridge.py loop &
BRIDGE_PID=$!

# If either dies, restart both
while true; do
  if ! kill -0 $STATE_PID 2>/dev/null; then
    echo "[wrapper] state server died, restarting"
    $PY bridge/state_server.py &
    STATE_PID=$!
  fi
  if ! kill -0 $BRIDGE_PID 2>/dev/null; then
    echo "[wrapper] bridge died, restarting"
    $PY bridge/bridge.py loop &
    BRIDGE_PID=$!
  fi
  sleep 10
done
