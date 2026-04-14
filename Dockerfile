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

# python3 is required at runtime to execute .py chess agents
RUN apt-get update && apt-get install -y python3 --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Required env vars (pass with -e):
#   WORKER_PUBLIC_KEY   your public key from chessagents.ai/arbiter
#   WORKER_PRIVATE_KEY  your private key (shown once at creation)
#   API_URL             defaults to https://api.chessagents.dev

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
