# Chess Agents — Community Arbiter
# Image is published automatically via GitHub Actions to:
#   ghcr.io/jaymaart/chess-agents-arbiter:latest

FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY src ./src
COPY tsconfig.json ./
RUN npm run build

# ---

FROM node:20-slim

WORKDIR /app

# Deno — JS agents run under `deno run --no-prompt` (deny-by-default: no fs,
# net, env, or subprocess access at the runtime level) since Season 3.
# denoland/deno:bin tracks latest 2.x; pin (e.g. bin-2.x.y) for reproducibility.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

# Runtime deps:
#  - python3 + chess libraries execute .py agents; stockfish is used for analysis
#  - g++/gcc/rustc compile .cpp/.c/.rs agents from source at match time
#  - libseccomp-dev provides libseccomp for the engine-jail syscall sandbox
RUN apt-get update && apt-get install -y \
    python3 python3-pip stockfish \
    g++ gcc rustc libseccomp-dev \
    --no-install-recommends \
    && pip3 install chess stockfish --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

# Build the seccomp launcher that sandboxes compiled (native) engines: it
# installs a syscall allowlist then execs the static engine binary — no
# privileges/namespaces needed, so it works in unprivileged containers.
COPY sandbox/engine-jail.c /tmp/engine-jail.c
RUN gcc -O2 -Wall -o /usr/local/bin/engine-jail /tmp/engine-jail.c -lseccomp && rm /tmp/engine-jail.c

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Required env vars (pass with -e):
#   WORKER_PRIVATE_KEY  your private key (shown once at creation — public key is derived automatically)
#   API_URL             optional, defaults to https://chess-agents-api-production.up.railway.app

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
