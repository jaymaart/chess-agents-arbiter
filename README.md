# Chess Agents — Community Arbiter

This is the open-source arbiter node for [Chess Agents](https://chessagents.ai). It fetches signed match jobs from the arena API, verifies their integrity, executes the match locally, and submits the result.

The Docker image is built automatically from this repo on every push and published to GitHub Container Registry. Nothing hidden — you can trace any image back to the exact commit that built it.

---

## How it works

```
[Your machine]  ──── POST /api/broker/next-jobs ──────▶  [Arena API]
                ◀─── Job + serverSignature ──────────
                     (engine code is obfuscated in transit)

[Your machine]  ──── verifyServerSignature(job) ─────▶  ✓ or ✗

[Your machine]  ──── run(challenger vs defender) ────▶  [local subprocess]
                ◀─── PGN + scores ────────────────────

[Your machine]  ──── POST /api/broker/submit ────────▶  [Arena API]
```

Every job is **Ed25519-signed** by the server — the signature covers the match ID and SHA-256 hashes of the original engine source. Engine code is **obfuscated before dispatch** and then **encrypted with your RSA-4096 public key** (AES-256-GCM + RSA-OAEP hybrid), so only your private key can decrypt it. Tampered payloads are silently rejected.

---

## Quickstart

```bash
docker run \
  -e WORKER_PRIVATE_KEY="<your-private-key>" \
  ghcr.io/jaymaart/chess-agents-arbiter:latest
```

Docker is the only supported way to run the arbiter. It includes the correct Node.js and Python 3 runtimes, so agent execution works reliably without any local setup.

---

## Getting an Arbiter Key

1. Sign up at [chessagents.ai](https://chessagents.ai)
2. Go to your [dashboard](https://chessagents.ai/dashboard?tab=arbiter) and submit a key request
3. An admin reviews the request and generates your keypair — your **private key is shown once and never stored**. Copy it before closing.
4. Once an admin marks your key as **Trusted**, your arbiter starts receiving jobs automatically.

Full guide: https://chessagents.ai/arbiter

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WORKER_PRIVATE_KEY` | Yes | — | Your arbiter private key (public key is derived automatically) |
| `API_URL` | No | `https://chess-agents-api-production.up.railway.app` | Arena API endpoint |
| `POLL_INTERVAL_MS` | No | `30000` | Milliseconds between polls. Minimum `500`. |
| `POLL_COUNT` | No | `10` | Jobs fetched per poll (1–50). Raise if you have spare cores; each job runs in a subprocess. |
| `RATE_LIMIT` | No | — | Cap polls per window. Format `N/Xs` or `N/Xm` (e.g. `100/10s`, `500/1m`). Exceeded polls are skipped, not errored. |
| `MATCH_TYPES` | No | — | Comma-separated list of match types to run. Omit to run all authorized types. Example: `training` or `training,rating`. |

**Tuning tips:**
- Single-core VPS: `POLL_COUNT=2`, `POLL_INTERVAL_MS=30000`
- 4–8 core machine: `POLL_COUNT=10`, `POLL_INTERVAL_MS=30000` (default)
- High-core workstation (16+): `POLL_COUNT=20`, `POLL_INTERVAL_MS=15000`
- Self-imposed throttling: `RATE_LIMIT=60/1m` to stay under 60 polls/min regardless of interval

---

## What runs on your machine

- **`src/broker-runner.ts`** — polling loop, signature verification, RSA decrypt, job dispatch
- **`src/crypto.ts`** — Ed25519 verify (server sig) + RSA-OAEP decrypt (engine payload) + auto-detecting sign
- **`src/matchmaking/runner.ts`** — spawns engine subprocesses, plays games, returns PGN

Chess agents run as sandboxed subprocesses with no network access and a strict move timeout.

---

## Security

- Engine code is obfuscated by the server before dispatch, then encrypted with **your RSA-4096 public key** using hybrid AES-256-GCM + RSA-OAEP. The payload is mathematically unreadable without your private key.
- Your private key never leaves your machine — it is used only for request signing and decrypting engine payloads locally.
- Results are attributed to your public key and permanently recorded.
