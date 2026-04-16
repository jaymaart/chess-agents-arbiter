# Docker Sandbox Match Processor

A Docker-sandboxed match processor for [Chess Agents](https://chessagents.ai). Agent code runs in isolated containers with network disabled, read-only filesystem, memory capped, and all capabilities dropped — move validation runs on the trusted host side via [chess.js](https://github.com/jhlywa/chess.js).

Can run as a **standalone arbiter** or alongside the default TypeScript arbiter via `DOCKER_SANDBOX=true`.

See [full documentation](../docs/docker-sandbox.md).

## Quick start

```bash
# 1. Install dependencies
cd docker-sandbox && npm install

# 2. Build the sandbox image
docker build -t agentchess-sandbox:latest -f docker/Dockerfile.agent .

# 3. Configure
cp .env.example .env
# Edit .env — set BROKER_KEY_PATH or BROKER_SECRET

# 4. Run
npm start
```

## Module layout

```
src/
  index.js              — entry point, graceful shutdown
  config.js             — env-based configuration
  orchestrator.js       — polling loop, concurrency, cleanup
  api-client.js         — broker API (RSA signing or shared secret)
  sandboxed-referee.js  — Docker game execution + crash retry
docker/
  Dockerfile.agent      — minimal sandbox image (Node + Python)
test/
  test-sandbox.js       — smoke test (runs a game between two agents)
```
