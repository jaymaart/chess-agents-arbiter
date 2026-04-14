# Chess Agents — Community Arbiter

This is the open-source arbiter node for [Chess Agents](https://chessagents.ai). It fetches signed match jobs from the arena API, verifies their integrity, executes the match locally, and submits the result.

This is the exact code that runs inside the `jaymaart/chess-worker` Docker image. Nothing hidden.

---

## How it works

```
[Your machine]  ──── POST /api/broker/next-jobs ────▶  [Arena API]
                ◀─── Job + serverSignature ───────────

[Your machine]  ──── verifySignature(job) ──────────▶  ✓ or ✗
                ──── verifyCodeHashes(job) ──────────▶  ✓ or ✗

[Your machine]  ──── run(challenger vs defender) ────▶  [local subprocess]
                ◀─── PGN + scores ───────────────────

[Your machine]  ──── POST /api/broker/submit ────────▶  [Arena API]
```

Every job is **Ed25519-signed** by the server. Your arbiter verifies the signature and **SHA-256 re-hashes** both engine files before executing anything. Tampered payloads are silently rejected.

---

## Quickstart

### Docker (recommended)

```bash
docker run \
  -e WORKER_PUBLIC_KEY="<your-public-key>" \
  -e WORKER_PRIVATE_KEY="<your-private-key>" \
  jaymaart/chess-worker
```

### Node.js

Requires Node.js 18+ and Python 3.

```bash
git clone https://github.com/jaymaart/chess-arbiter
cd chess-arbiter
npm install
npm run build

WORKER_PUBLIC_KEY="<your-public-key>" \
WORKER_PRIVATE_KEY="<your-private-key>" \
node dist/index.js
```

---

## Getting an Arbiter Key

1. Sign up at [chessagents.ai](https://chessagents.ai)
2. Request a key in the **#become-an-arbiter** Discord channel
3. An admin generates your keypair — your **private key is shown once and never stored**. Copy it before closing.
4. Once an admin marks your key as **Trusted**, your arbiter starts receiving jobs.

Full guide: https://chessagents.ai/arbiter

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WORKER_PUBLIC_KEY` | Yes | — | Your arbiter public key |
| `WORKER_PRIVATE_KEY` | Yes | — | Your arbiter private key |
| `API_URL` | No | `https://api.chessagents.dev` | Arena API endpoint |

---

## What runs on your machine

- **`src/broker-runner.ts`** — polling loop, signature verification, job dispatch
- **`src/crypto.ts`** — Ed25519 sign/verify and SHA-256 hashing (Node built-ins only, no third-party crypto)
- **`src/matchmaking/runner.ts`** — spawns engine subprocesses, plays games, returns PGN

Chess agents run as sandboxed subprocesses with no network access and a strict move timeout.

---

## Security

- Engine source code is received as part of the job payload and written to a temp directory to execute, then deleted. As an arbiter you temporarily have access to engine code — this is unavoidable.
- Your private key never leaves your machine.
- Results are attributed to your public key and permanently recorded.
