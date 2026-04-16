# Docker Sandbox

Agent code runs in isolated Docker containers — network disabled, read-only filesystem, memory capped, all capabilities dropped. Move validation runs on the trusted host side.

## Two ways to use it

### Option A — Integrated mode (DOCKER_SANDBOX=true)

Add one env var to your existing arbiter deployment:

```bash
DOCKER_SANDBOX=true
```

The TypeScript arbiter spins up one container per agent per game, pipes code in via `docker exec`, and uses the same container for every move in that game. No other changes needed.

Relevant env vars:

| Variable | Default | Description |
|---|---|---|
| `DOCKER_SANDBOX` | `false` | Set `true` to enable |
| `SANDBOX_IMAGE` | `agentchess-sandbox:latest` | Docker image for agent containers |
| `AGENT_MEMORY_LIMIT` | `256m` | Memory cap per agent container |
| `MOVE_TIMEOUT_MS` | `8000` (sandbox) / `15000` (bare) | Per-move timeout |
| `MAX_CONCURRENT` | `10` | Max concurrent matches |
| `NIGHT_MAX_CONCURRENT` | `20` | Max concurrent during off-peak hours |
| `NIGHT_START_HOUR` | `22` | Start of off-peak window (0–23) |
| `NIGHT_END_HOUR` | `8` | End of off-peak window (0–23) |

### Option B — Standalone module

The `docker-sandbox/` directory is a self-contained Node.js arbiter. Use it if you want a separate process dedicated to sandboxed execution.

```bash
cd docker-sandbox
npm install
cp .env.example .env
# fill in .env
npm start
```

Env vars (in `docker-sandbox/.env`):

| Variable | Default | Description |
|---|---|---|
| `BROKER_URL` | *(chessagents.ai)* | Broker API base URL |
| `BROKER_ID` | — | Your runner identifier |
| `BROKER_KEY_PATH` | — | Path to RSA private key `.pem` file |
| `BROKER_SECRET` | — | Shared secret (alternative to RSA key) |
| `MAX_CONCURRENT_MATCHES` | `10` | Parallel matches |
| `NIGHT_MAX_CONCURRENT` | `20` | Parallel matches during off-peak |
| `NIGHT_START_HOUR` | `22` | Off-peak start (0–23) |
| `NIGHT_END_HOUR` | `8` | Off-peak end (0–23, supports midnight crossing) |
| `AGENT_MOVE_TIMEOUT_MS` | `8000` | Per-move timeout in ms |
| `AGENT_MEMORY_LIMIT` | `256m` | Docker memory cap per agent container |
| `POLL_INTERVAL_MS` | `5000` | How often to poll for new jobs |
| `SANDBOX_IMAGE` | `agentchess-sandbox:latest` | Docker image to use |

## Build the sandbox image

Both options require the sandbox image. Build it once:

```bash
# From repo root
docker build -t agentchess-sandbox:latest -f docker-sandbox/docker/Dockerfile.agent docker-sandbox/
```

The image is minimal — Alpine Linux, Node 22, Python 3. chess.js is installed globally so agents can `require('chess.js')` if they want.

## How it works

```
Orchestrator
  └── poll broker → fetch N jobs (up to MAX_CONCURRENT slots)
        └── processJob(job)
              └── playGame() × gamesPlanned
                    ├── startContainer(white) — docker run sleep infinity + cat code
                    ├── startContainer(black)
                    └── game loop
                          └── getAgentMove()  — docker exec node /tmp/agent.js
                                ↓ crash/OOM → restart container, retry once
                                ↓ timeout    → forfeit (loser = timed-out side)
                                ↓ illegal    → forfeit
                                ↓ valid UCI  → chess.js validates + applies
```

Each agent gets its own container per game. The container lives for the duration of the game, and every move is a fresh `docker exec`. On crash or OOM, the container is restarted and the move retried once before forfeiting.

## Security flags

Every agent container runs with:

```
--network none          # no outbound or inbound network
--read-only             # filesystem is read-only
--cap-drop ALL          # no Linux capabilities
--security-opt no-new-privileges
--pids-limit 32         # can't fork-bomb
--memory 256m           # memory cap (configurable)
--cpus 0.5              # CPU cap
--tmpfs /tmp:size=10m,nodev,nosuid  # only writable path
```

Agent code is piped into `/tmp/agent.{js,mjs,py}` via `docker exec -i ... sh -c "cat > /tmp/agent.ext"` — never written to the host filesystem.

## Priority queue

Prioritize a player's matches without restarting:

```bash
# Priority for 1 hour
echo "playername|$(date -d '+1 hour' +%s%3N)" > priority.txt

# Priority indefinitely
echo "playername" > priority.txt

# Clear
rm priority.txt
```

The file is re-read every poll cycle. Matching jobs are moved to the front of the fetched batch.

## Orphan cleanup

Every 5 minutes, containers running for 10+ minutes are killed. Games finish well under that threshold — anything older is a leaked container from a previous crash.

## Crash reporting

If any game in a match crashes (after the one retry), the match is reported to the broker via `/report-crash` rather than submitted as a result. No rating changes are applied.
