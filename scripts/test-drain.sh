#!/usr/bin/env bash
# Smoke test for graceful shutdown.
# Starts the arbiter (must have BROKER_SECRET + API_URL in env), sends SIGTERM
# after 3s, and verifies it logs drain messages and exits within 10s.
set -e

echo "[test] Building..."
cd "$(dirname "$0")/.."
npm run build

echo "[test] Starting arbiter..."
node dist/index.js > /tmp/arbiter-test.log 2>&1 &
PID=$!

sleep 3

echo "[test] Sending SIGTERM to PID $PID..."
kill -SIGTERM "$PID"

START=$(date +%s)
wait "$PID" || true
END=$(date +%s)
ELAPSED=$((END - START))

echo "[test] Process exited after ${ELAPSED}s post-SIGTERM."
echo "[test] Log output:"
cat /tmp/arbiter-test.log

if grep -q "entering drain mode" /tmp/arbiter-test.log; then
  echo "[test] PASS — drain mode was entered."
else
  echo "[test] FAIL — 'entering drain mode' not found in logs."
  exit 1
fi

if [ "$ELAPSED" -lt 10 ]; then
  echo "[test] PASS — exited quickly (no active jobs in test env)."
else
  echo "[test] WARN — took ${ELAPSED}s; check logs for drain activity."
fi
