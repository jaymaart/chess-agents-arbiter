# Docker Sandbox Match Processor

A Docker-sandboxed match processor for [Chess Agents](https://chessagents.ai). Runs agent code in isolated containers with network disabled, memory capped, and capabilities dropped — then validates moves on the trusted host side.

This is an alternative execution backend that can sit alongside the default subprocess-based runner. Use it when you want stronger isolation between agents.

## What it adds over the default arbiter

| Feature | Default arbiter | Docker sandbox |
|---------|----------------|----------------|
| Agent isolation | Bare subprocess | Docker container (`--network none`, `--read-only`, `--cap-drop ALL`, PID/memory limits) |
| Concurrency | Sequential | Up to N concurrent matches (configurable, scales at night) |
| Crash handling | Report and skip | Retry once with fresh container, then report |
| Game execution | In polling thread | Worker threads (non-blocking) |
| Chess validation | chess.js | Zero-dependency pure JS engine |
| Container cleanup | N/A | Auto-kills orphaned containers every 5 min |

## Quick start

```bash
# 1. Build the sandbox image
docker build -t agentchess-sandbox -f docker/Dockerfile.agent .

# 2. Configure
cp .env.example .env
# Edit .env with your broker credentials

# 3. Run
node src/index.js
```

## Configuration

See [`.env.example`](.env.example) for all options. Key settings:

- `MAX_CONCURRENT_MATCHES` — parallel games (default 10)
- `NIGHT_MAX_CONCURRENT` — parallel games during off-peak hours (default 20)
- `AGENT_MOVE_TIMEOUT_MS` — per-move timeout in ms (default 8000)
- `AGENT_MEMORY_LIMIT` — Docker memory cap per agent (default 256m)

## Priority queue

Create a `priority.txt` file to prioritize specific players' matches (hot-reloaded each poll, no restart needed):

```bash
# Prioritize a player for 1 hour
echo "player_name|$(date -d '+1 hour' +%s%3N)" > priority.txt

# Prioritize indefinitely
echo "player_name" > priority.txt

# Clear priority
rm priority.txt
```

## Architecture

```
Orchestrator (main loop)
  ├── polls broker for match jobs
  ├── dispatches to worker threads
  └── periodic container cleanup

Worker Thread
  └── sandboxed-referee.js
        ├── starts Docker containers (one per agent)
        ├── pipes FEN → container → reads UCI move
        ├── validates moves with host-side chess engine
        ├── retries once on crash/OOM
        └── cleans up containers

Chess Engine (host-side, trusted)
  ├── FEN parsing & board management
  ├── legal move generation
  ├── check/checkmate/stalemate detection
  └── draw detection (50-move, threefold, insufficient material)
```

## Module layout

```
src/
  index.js              — entry point
  config.js             — env-based configuration
  orchestrator.js       — polling loop, concurrency, cleanup
  api-client.js         — broker API adapter (pluggable auth)
  sandboxed-referee.js  — Docker game execution + crash retry
  chess-engine.js       — zero-dep chess engine
  pgn-builder.js        — UCI → SAN → PGN conversion
  game-worker.js        — worker thread wrapper
docker/
  Dockerfile.agent      — minimal sandbox image (Node + Python)
test/
  test-sandbox.js       — smoke test (runs a game between two random agents)
```
