# Graceful Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement graceful shutdown so that SIGTERM (e.g. `docker stop`) drains in-progress matches before exiting rather than abandoning them.

**Architecture:** Add a `draining` flag and `drain()` helper to `broker-runner.ts`. Signal handlers set the flag, stop the poll loop, wait up to 90s for `activeJobs` to empty, then exit. The same drain path is used by `pullAndRestart()`. Docker's `stop_grace_period` is bumped to 120s to give the drain room before SIGKILL.

**Tech Stack:** TypeScript, Node.js (built-in signals), Docker Compose

---

## File Map

| File | Change |
|------|--------|
| `src/broker-runner.ts` | Add `draining` flag, `drain()` helper, signal handlers; guard `poll()` and `pullAndRestart()` |
| `docker-compose.local.yml` | Add `stop_grace_period: 120s` |
| `scripts/test-drain.sh` | Manual verification script |

---

### Task 1: Add `draining` flag and `drain()` helper

**Files:**
- Modify: `src/broker-runner.ts`

- [ ] **Step 1: Add the `draining` flag** next to `activeJobs` (line 509)

Open `src/broker-runner.ts`. Find:

```ts
const activeJobs = new Set<Promise<void>>();
let lastCleanup = 0;
```

Replace with:

```ts
const activeJobs = new Set<Promise<void>>();
let lastCleanup = 0;
let draining = false;
```

- [ ] **Step 2: Add the `drain()` helper** immediately after the `fireJob` function (after line 520)

Find:

```ts
async function poll(): Promise<void> {
```

Insert before it:

```ts
async function drain(): Promise<void> {
  const DRAIN_TIMEOUT_MS = 90_000;
  const start = Date.now();
  if (activeJobs.size === 0) {
    console.log("[Arbiter] Drain complete — no active jobs.");
    return;
  }
  console.log(`[Arbiter] Draining — waiting for ${activeJobs.size} active job(s) to finish (timeout: 90s)...`);
  while (activeJobs.size > 0 && Date.now() - start < DRAIN_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 1000));
    if (activeJobs.size > 0) {
      console.log(`[Arbiter] Draining — ${activeJobs.size} job(s) remaining (${Math.round((Date.now() - start) / 1000)}s elapsed)...`);
    }
  }
  if (activeJobs.size > 0) {
    console.warn(`[Arbiter] Drain timeout reached — ${activeJobs.size} job(s) still running. Forcing exit.`);
  } else {
    console.log("[Arbiter] Drain complete. All jobs finished.");
  }
}

```

- [ ] **Step 3: Build and verify no TypeScript errors**

```bash
cd /d/Github/chess-agents-arbiter && npm run build 2>&1
```

Expected: exits 0, `dist/` updated, no errors.

- [ ] **Step 4: Commit**

```bash
cd /d/Github/chess-agents-arbiter
git add src/broker-runner.ts
git commit -m "feat(shutdown): add draining flag and drain() helper"
```

---

### Task 2: Guard `poll()` with the draining flag

**Files:**
- Modify: `src/broker-runner.ts`

- [ ] **Step 1: Return early from `poll()` when draining**

Find the start of `async function poll()`:

```ts
async function poll(): Promise<void> {
  const maxNow = getMaxConcurrent();
  const slots = maxNow - activeJobs.size;
```

Replace with:

```ts
async function poll(): Promise<void> {
  if (draining) return;
  const maxNow = getMaxConcurrent();
  const slots = maxNow - activeJobs.size;
```

- [ ] **Step 2: Guard the rescheduling `setTimeout` at the bottom of `poll()`**

Find (near line 584):

```ts
  // Sleep shorter when all slots full (just waiting for a slot to open)
  const delay = activeJobs.size >= maxNow ? 2000 : POLL_INTERVAL_MS;
  setTimeout(poll, delay);
}
```

Replace with:

```ts
  // Sleep shorter when all slots full (just waiting for a slot to open)
  if (!draining) {
    const delay = activeJobs.size >= maxNow ? 2000 : POLL_INTERVAL_MS;
    setTimeout(poll, delay);
  }
}
```

- [ ] **Step 3: Build and verify no TypeScript errors**

```bash
cd /d/Github/chess-agents-arbiter && npm run build 2>&1
```

Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
cd /d/Github/chess-agents-arbiter
git add src/broker-runner.ts
git commit -m "feat(shutdown): stop poll loop when draining"
```

---

### Task 3: Drain in `pullAndRestart()` before exiting

**Files:**
- Modify: `src/broker-runner.ts`

- [ ] **Step 1: Add drain call to `pullAndRestart()`**

Find in `pullAndRestart()` (around line 130):

```ts
    console.log("[Arbiter] Pull complete. Restarting on new image...");
    process.exit(0);
```

Replace with:

```ts
    console.log("[Arbiter] Pull complete. Draining before restart...");
    draining = true;
    await drain();
    process.exit(0);
```

- [ ] **Step 2: Build and verify no TypeScript errors**

```bash
cd /d/Github/chess-agents-arbiter && npm run build 2>&1
```

Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
cd /d/Github/chess-agents-arbiter
git add src/broker-runner.ts
git commit -m "feat(shutdown): drain active jobs before auto-update restart"
```

---

### Task 4: Register SIGTERM and SIGINT signal handlers

**Files:**
- Modify: `src/broker-runner.ts`

- [ ] **Step 1: Add signal handlers in `startBrokerRunner()`**

Find (near line 624):

```ts
  startedAt = Date.now();
  console.log("[Arbiter] Ready. Polling for matches.");
  poll();
```

Insert the signal handlers before that block:

```ts
  const shutdown = async (signal: string) => {
    console.log(`[Arbiter] ${signal} received — entering drain mode.`);
    draining = true;
    await drain();
    process.exit(activeJobs.size > 0 ? 1 : 0);
  };
  process.once("SIGTERM", () => { shutdown("SIGTERM").catch(err => { console.error("[Arbiter] Shutdown error:", err); process.exit(1); }); });
  process.once("SIGINT",  () => { shutdown("SIGINT").catch(err => { console.error("[Arbiter] Shutdown error:", err); process.exit(1); }); });

  startedAt = Date.now();
  console.log("[Arbiter] Ready. Polling for matches.");
  poll();
```

- [ ] **Step 2: Build and verify no TypeScript errors**

```bash
cd /d/Github/chess-agents-arbiter && npm run build 2>&1
```

Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
cd /d/Github/chess-agents-arbiter
git add src/broker-runner.ts
git commit -m "feat(shutdown): register SIGTERM/SIGINT handlers with drain"
```

---

### Task 5: Update docker-compose `stop_grace_period`

**Files:**
- Modify: `docker-compose.local.yml`

- [ ] **Step 1: Add `stop_grace_period`**

Open `docker-compose.local.yml`. Find:

```yaml
services:
  arbiter:
    image: chess-agents-arbiter:local
    restart: always
```

Replace with:

```yaml
services:
  arbiter:
    image: chess-agents-arbiter:local
    restart: always
    stop_grace_period: 120s
```

- [ ] **Step 2: Commit**

```bash
cd /d/Github/chess-agents-arbiter
git add docker-compose.local.yml
git commit -m "chore(docker): set stop_grace_period 120s for graceful drain"
```

---

### Task 6: Manual verification

**Files:**
- Create: `scripts/test-drain.sh`

- [ ] **Step 1: Create a verification script**

```bash
mkdir -p /d/Github/chess-agents-arbiter/scripts
```

Create `scripts/test-drain.sh`:

```bash
#!/usr/bin/env bash
# Smoke test for graceful shutdown.
# Starts the arbiter (must have BROKER_SECRET + API_URL in env), sends SIGTERM
# after 3s, and verifies it logs drain messages and exits within 10s.
set -e

echo "[test] Building..."
cd "$(dirname "$0")/.."
npm run build

echo "[test] Starting arbiter..."
node dist/index.js &
PID=$!

sleep 3

echo "[test] Sending SIGTERM to PID $PID..."
kill -SIGTERM "$PID"

START=$(date +%s)
wait "$PID" || true
END=$(date +%s)
ELAPSED=$((END - START))

echo "[test] Process exited after ${ELAPSED}s post-SIGTERM."

if [ "$ELAPSED" -lt 10 ]; then
  echo "[test] PASS — exited quickly (no active jobs in test env)."
else
  echo "[test] WARN — took ${ELAPSED}s; check logs for drain activity."
fi
```

```bash
chmod +x /d/Github/chess-agents-arbiter/scripts/test-drain.sh
```

- [ ] **Step 2: Run the script and check output**

```bash
cd /d/Github/chess-agents-arbiter && bash scripts/test-drain.sh 2>&1
```

Expected output includes:
```
[Arbiter] SIGTERM received — entering drain mode.
[Arbiter] Drain complete — no active jobs.
[test] PASS — exited quickly (no active jobs in test env).
```

- [ ] **Step 3: Verify `docker stop` behaviour with a local build**

```bash
cd /d/Github/chess-agents-arbiter
docker build -t chess-agents-arbiter:local .
docker run --rm --name arbiter-test chess-agents-arbiter:local &
sleep 3
docker stop arbiter-test
```

Expected: docker logs show `SIGTERM received — entering drain mode.` and `Drain complete.` before the container exits.

- [ ] **Step 4: Commit the script**

```bash
cd /d/Github/chess-agents-arbiter
git add scripts/test-drain.sh
git commit -m "chore: add manual drain smoke test script"
```

---

## Self-Review Checklist

- [x] `draining` flag added alongside `activeJobs`
- [x] `drain()` logs progress every second, times out at 90s, exits 1 if jobs remain
- [x] `poll()` returns early and stops rescheduling when `draining`
- [x] `pullAndRestart()` sets `draining = true` and awaits `drain()` before `process.exit(0)`
- [x] Signal handlers use `process.once` (not `on`) — prevents double-firing
- [x] Signal handler `.catch()` ensures async errors don't go unhandled
- [x] Heartbeat interval left running during drain (no change needed — `setInterval` keeps firing naturally)
- [x] `docker-compose.local.yml` updated with 120s grace period
- [x] All code blocks are complete, no TBD/TODO
