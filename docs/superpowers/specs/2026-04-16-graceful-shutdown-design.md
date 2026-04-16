# Graceful Shutdown Design

**Date:** 2026-04-16  
**Repo:** chess-agents-arbiter  
**Status:** Approved

## Problem

When the arbiter process receives SIGTERM (container restart, update, scale-down), it exits immediately. Any in-progress matches are orphaned in `processing` state. The arena's stale job reaper only runs every 5 minutes and only reaps jobs older than 30 minutes, so those matches hang as `running` in the UI for up to 30 minutes before being auto-canceled.

This affects every container update — including the new arbiter version announcements the Discord bot now posts.

## Approach

Drain flag + wait. On SIGTERM/SIGINT:

1. Set `draining = true` — stops the poll loop from fetching new jobs or rescheduling itself.
2. Wait for `activeJobs` Set to empty, polling every second, up to a 90-second timeout.
3. Log progress each second so operators can observe the wind-down.
4. Exit 0 on clean drain, exit 1 on timeout (so Docker can distinguish).
5. The heartbeat interval keeps running during drain so the API sees the arbiter as alive with shrinking `activeJobs` rather than treating it as crashed.

The `pullAndRestart()` auto-update path also goes through drain before calling `process.exit(0)`.

Docker's `stop_grace_period` is bumped to 120s to give the 90s drain room before SIGKILL.

## Changes

### `src/broker-runner.ts`

**New module-level state:**
```ts
let draining = false;
```

**New `drain()` helper** (called by signal handlers and `pullAndRestart`):
```ts
async function drain(): Promise<void> {
  const DRAIN_TIMEOUT_MS = 90_000;
  const start = Date.now();
  console.log(`[Arbiter] Draining — waiting for ${activeJobs.size} active job(s) to finish...`);
  while (activeJobs.size > 0 && Date.now() - start < DRAIN_TIMEOUT_MS) {
    console.log(`[Arbiter] Draining — ${activeJobs.size} job(s) remaining...`);
    await new Promise(r => setTimeout(r, 1000));
  }
  if (activeJobs.size > 0) {
    console.warn(`[Arbiter] Drain timeout — ${activeJobs.size} job(s) still running. Forcing exit.`);
  } else {
    console.log("[Arbiter] Drain complete. Exiting cleanly.");
  }
}
```

**Signal handlers** (registered in `startBrokerRunner()` before `poll()` is called):
```ts
const shutdown = async (signal: string) => {
  console.log(`[Arbiter] ${signal} received — entering drain mode.`);
  draining = true;
  await drain();
  process.exit(activeJobs.size > 0 ? 1 : 0);
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT",  () => shutdown("SIGINT"));
```

**`poll()` — stop scheduling when draining:**
- At the top of `poll()`, return immediately if `draining`.
- At the bottom, guard the `setTimeout` call: only reschedule if `!draining`.

**`pullAndRestart()` — drain before exit:**
```ts
await drain();
process.exit(0);
```

### `docker-compose.local.yml` (and any production compose file)

```yaml
services:
  arbiter:
    stop_grace_period: 120s
```

## Behaviour Summary

| Event | Before | After |
|-------|--------|-------|
| `docker stop` / SIGTERM | Instant kill, matches orphaned 30 min | Waits up to 90s for matches to finish, then clean exit |
| Auto-update (`pullAndRestart`) | Instant exit, matches orphaned | Drains first, then exits |
| Scale-down (concurrency only) | Unchanged — already safe | Unchanged |
| SIGKILL / hard crash | Unchanged — unavoidable | Unchanged |

## Out of Scope

- Per-job cancellation via AbortController (adds complexity without meaningful benefit given 90s drain covers almost all matches)
- Crash-reporting orphaned jobs on timeout (falsely penalizes engine ratings)
- Changes to the arena's stale job reaper (complementary, separate concern)
