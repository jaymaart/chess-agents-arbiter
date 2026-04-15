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

# python3 + common chess libraries required to execute .py chess agents
RUN apt-get update && apt-get install -y python3 python3-pip stockfish --no-install-recommends \
    && pip3 install chess stockfish --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Required env vars (pass with -e):
#   WORKER_PRIVATE_KEY  your private key (shown once at creation — public key is derived automatically)
#   API_URL             optional, defaults to https://chess-agents-api-production.up.railway.app

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
