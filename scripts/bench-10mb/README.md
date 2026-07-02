# 10MB engine timing bench

Proves the payoff of persistent engine processes: a large (e.g. 10MB net) engine
loads its weights **once per game**, instead of **once per move** like the old
one-shot model.

## Run (on the arbiter host, for real hardware numbers)

```bash
node make-engine.js 9.8    # generate engine-10mb.js (~9.8MB, base64-embedded net)
node bench.js 30           # compare persistent vs one-shot over 30 moves
```

## What it shows (example)

```
PERSISTENT (arbiter now): first=97ms  steady[min/avg/max]=0/0/1ms
ONE-SHOT   (old model):   first=98ms  steady[min/avg/max]=95/102/116ms
Steady-state speedup: 511.8x
```

- **Persistent**: pays the ~100ms net load once (first move), then near-zero
  per-move overhead — the full move budget goes to actual search.
- **One-shot**: pays the full net load on *every* move.

## Sizing the season's move budget

Run this with a target size near the season's Open cap, then set
`MOVE_TIMEOUT_MS` / `FIRST_MOVE_TIMEOUT_MS` (and `AGENT_MEMORY_LIMIT` for Docker
mode) with headroom above the numbers you see. `AGENT_MEMORY_LIMIT` defaults to
256m — too small for a real 10MB net; bump it.

## Notes

- `engine-10mb.js` is a **timing fixture**, not a legal player. Don't submit it.
- The embedded net is a base64 **string** (parse-cheap). Engines that embed a
  giant array literal instead will be slow to validate and load.
