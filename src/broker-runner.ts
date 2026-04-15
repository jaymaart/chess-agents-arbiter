import fs from "fs/promises";
import http from "http";
import path from "path";
import os from "os";
import { hashData, signData, verifyData, publicKeyFromPrivate, decryptFromServer, normalizePem } from "./crypto";
import { runMatch } from "./matchmaking/runner";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ARBITER_VERSION: string = require("../package.json").version;

const API_URL = (process.env.API_URL || "https://chess-agents-api-production.up.railway.app").replace(/\/$/, "");
const WORKER_PRIVATE_KEY = normalizePem(process.env.WORKER_PRIVATE_KEY || "");
let WORKER_PUBLIC_KEY = "";

const POLL_INTERVAL_MS = Math.max(120_000, parseInt(process.env.POLL_INTERVAL_MS || "120000", 10));
const POLL_COUNT = Math.max(1, Math.min(50, parseInt(process.env.POLL_COUNT || "10", 10)));

// Auto-update: disabled by default. Set AUTO_UPDATE=true to enable.
// Requires /var/run/docker.sock mounted (-v /var/run/docker.sock:/var/run/docker.sock).
const AUTO_UPDATE = process.env.AUTO_UPDATE === "true";
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || "ghcr.io/jaymaart/chess-agents-arbiter:latest";

// Optional: limit to specific match types, e.g. MATCH_TYPES=training or MATCH_TYPES=training,rating
const MATCH_TYPES: string[] | null = process.env.MATCH_TYPES
  ? process.env.MATCH_TYPES.split(",").map(s => s.trim()).filter(Boolean)
  : null;

// Soft rate limit: RATE_LIMIT="100/10s" means at most 100 requests per 10-second window.
// If exceeded, the poll is skipped (not errored) until the window clears.
let rateLimitMax = Infinity;
let rateLimitWindowMs = 10_000;
const pollTimestamps: number[] = [];

if (process.env.RATE_LIMIT) {
  const match = process.env.RATE_LIMIT.match(/^(\d+)\/(\d+)(s|m)?$/);
  if (!match) throw new Error(`Invalid RATE_LIMIT format — expected "N/Xs" or "N/Xm" (e.g. "100/10s")`);
  rateLimitMax = parseInt(match[1], 10);
  const unit = match[3] ?? "s";
  rateLimitWindowMs = parseInt(match[2], 10) * (unit === "m" ? 60_000 : 1_000);
}

function withinRateLimit(): boolean {
  const now = Date.now();
  const cutoff = now - rateLimitWindowMs;
  // Evict timestamps outside the window
  while (pollTimestamps.length && pollTimestamps[0] < cutoff) pollTimestamps.shift();
  if (pollTimestamps.length >= rateLimitMax) return false;
  pollTimestamps.push(now);
  return true;
}

let serverPublicKey = "";

async function fetchServerPublicKey(): Promise<void> {
  const res = await fetch(`${API_URL}/api/public-key`);
  if (!res.ok) throw new Error("Failed to fetch server public key");
  const data = await res.json() as { publicKey: string };
  serverPublicKey = data.publicKey;
  console.log("[Arbiter] Server public key loaded.");
}

function isNewerVersion(current: string, candidate: string): boolean {
  const [cMaj, cMin, cPatch] = current.split(".").map(Number);
  const [nMaj, nMin, nPatch] = candidate.split(".").map(Number);
  if (nMaj !== cMaj) return nMaj > cMaj;
  if (nMin !== cMin) return nMin > cMin;
  return nPatch > cPatch;
}

// Pulls the latest Docker image via the Docker socket, then exits so Docker's
// restart policy restarts the container on the new image.
async function pullAndRestart(): Promise<void> {
  const lastColon = DOCKER_IMAGE.lastIndexOf(":");
  const image = lastColon > DOCKER_IMAGE.lastIndexOf("/") ? DOCKER_IMAGE.slice(0, lastColon) : DOCKER_IMAGE;
  const tag = lastColon > DOCKER_IMAGE.lastIndexOf("/") ? DOCKER_IMAGE.slice(lastColon + 1) : "latest";

  console.log(`[Arbiter] Pulling ${DOCKER_IMAGE}...`);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: "/var/run/docker.sock",
          path: `/v1.41/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
          method: "POST",
          headers: { "Content-Length": "0" },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            if (res.statusCode && res.statusCode < 400) resolve();
            else reject(new Error(`Docker API returned ${res.statusCode}`));
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
    console.log("[Arbiter] Pull complete. Restarting on new image...");
    process.exit(0);
  } catch (err: any) {
    console.warn(`[Arbiter] Auto-update pull failed: ${err.message}`);
    console.warn(`[Arbiter] Is /var/run/docker.sock mounted? Add: -v /var/run/docker.sock:/var/run/docker.sock`);
    console.warn(`[Arbiter] Manual update: docker pull ${DOCKER_IMAGE} && docker restart <container>`);
  }
}

// Checks GitHub releases for a newer version. If AUTO_UPDATE is enabled and a
// newer release is found, pulls the new image and restarts.
async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/jaymaart/chess-agents-arbiter/releases/latest",
      { headers: { "User-Agent": `chess-agents-arbiter/${ARBITER_VERSION}` } }
    );
    if (!res.ok) return;
    const release = await res.json() as { tag_name: string };
    const latest = release.tag_name.replace(/^v/, "");
    if (!isNewerVersion(ARBITER_VERSION, latest)) return;

    if (AUTO_UPDATE) {
      console.log(`[Arbiter] Update available: v${latest} (current: v${ARBITER_VERSION}). Auto-updating...`);
      await pullAndRestart();
    } else {
      console.log(`[Arbiter] Update available: v${latest} (current: v${ARBITER_VERSION}). Set AUTO_UPDATE=true to update automatically.`);
    }
  } catch {
    // Network or parse error — silently skip, don't crash the arbiter
  }
}

function buildSigningString(endpoint: "next-jobs" | "submit" | "report-crash", fields: Record<string, any>): string {
  if (endpoint === "next-jobs") return `next-jobs:${fields.count}`;
  if (endpoint === "submit") return `submit:${fields.jobId}:${fields.matchId}`;
  if (endpoint === "report-crash") return `report-crash:${fields.jobId}:${fields.matchId}`;
  return "";
}

async function signedPost(endpoint: string, body: object): Promise<Response> {
  const endpointKey = endpoint.includes("next-jobs") ? "next-jobs"
    : endpoint.includes("report-crash") ? "report-crash"
    : "submit";
  const signingString = buildSigningString(endpointKey as any, body);
  const signature = signData(signingString, WORKER_PRIVATE_KEY);

  return fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-public-key": WORKER_PUBLIC_KEY,
      "x-worker-signature": signature,
      "x-arbiter-version": ARBITER_VERSION,
    },
    body: JSON.stringify(body),
  });
}

async function verifyJobIntegrity(job: any): Promise<boolean> {
  // Engine code is obfuscated in transit — we verify the server's Ed25519 signature
  // which covers (matchId + challengerHash + defenderHash) using the original source hashes.
  // This proves the payload was built by the server and the hashes haven't been swapped.
  const signingString = job.matchId + job.challengerHash + job.defenderHash;
  if (!verifyData(signingString, job.serverSignature, serverPublicKey)) {
    console.error(`[Arbiter] Server signature invalid for match ${job.matchId} — rejecting.`);
    return false;
  }

  return true;
}

// Detect whether JS code uses ES module syntax so we can assign the right
// extension. .mjs forces ESM, .cjs forces CommonJS — Node respects both
// regardless of any parent package.json "type" field.
function jsExt(code: string): ".mjs" | ".cjs" {
  return /\bimport\s*[\(\{"'`]|\bexport\s+(default\b|\{|const\b|function\b|class\b|async\b)/.test(code)
    ? ".mjs"
    : ".cjs";
}

async function processJob(job: any): Promise<void> {
  console.log(`[Arbiter] Running match ${job.matchId}...`);

  const valid = await verifyJobIntegrity(job);
  if (!valid) {
    console.error(`[Arbiter] Skipping match ${job.matchId} — integrity check failed.`);
    return;
  }

  // Decrypt engine code if the server used per-arbiter RSA encryption
  let challengerCode = job.challenger.code as string;
  let defenderCode = job.defender.code as string;
  if (job.encrypted) {
    challengerCode = decryptFromServer(challengerCode, WORKER_PRIVATE_KEY);
    defenderCode = decryptFromServer(defenderCode, WORKER_PRIVATE_KEY);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arbiter-match-"));
  const challengerExt = job.challenger.language === "py" ? ".py" : jsExt(challengerCode);
  const defenderExt = job.defender.language === "py" ? ".py" : jsExt(defenderCode);
  const pathA = path.join(tempDir, `agent_a${challengerExt}`);
  const pathB = path.join(tempDir, `agent_b${defenderExt}`);

  try {
    await fs.writeFile(pathA, challengerCode);
    await fs.writeFile(pathB, defenderCode);

    const result = await runMatch(
      { path: pathA, language: job.challenger.language, name: job.challenger.name },
      { path: pathB, language: job.defender.language, name: job.defender.name },
      { games: job.gamesPlanned }
    );

    // Reject matches where any game ended due to a real crash — do not submit for rating.
    // Denylist known-good terminations; crash strings are inconsistent across engines.
    const CLEAN_TERMS = ["checkmate", "stalemate", "threefold", "insufficient", "50-move", "max plies", "draw", "normal", "adjudication", "timeout", "illegal move"];
    const crashedGame = result.games.find(g => {
      const termination = g.termination?.toLowerCase();
      return !termination || !CLEAN_TERMS.some(t => termination.includes(t));
    });
    if (crashedGame) {
      const crashReason = `Crash-terminated game (round ${crashedGame.round}): "${crashedGame.termination}"`;
      console.warn(`[Arbiter] Match ${job.matchId} has crashed game (round ${crashedGame.round}: "${crashedGame.termination}"). Reporting — no ratings applied.`);
      const crashRes = await signedPost("/api/broker/report-crash", {
        jobId: job.jobId,
        matchId: job.matchId,
        reason: crashReason,
        pgn: result.pgn,
      });
      if (!crashRes.ok) {
        const err = await crashRes.json().catch(() => ({})) as any;
        console.error(`[Arbiter] Failed to report crash for ${job.matchId}: ${err.error || crashRes.status}`);
      }
      return;
    }

    let challengerWins = 0, defenderWins = 0, draws = 0;
    for (const g of result.games) {
      const isChallengerWhite = g.round % 2 !== 0;
      if (g.result === "1-0") { isChallengerWhite ? challengerWins++ : defenderWins++; }
      else if (g.result === "0-1") { isChallengerWhite ? defenderWins++ : challengerWins++; }
      else if (g.result === "1/2-1/2") { draws++; }
    }

    const challengerScore = challengerWins + draws * 0.5;
    const defenderScore = defenderWins + draws * 0.5;

    const submitRes = await signedPost("/api/broker/submit", {
      jobId: job.jobId,
      matchId: job.matchId,
      pgn: result.pgn,
      result: challengerScore > defenderScore ? "challenger" : defenderScore > challengerScore ? "defender" : "draw",
      challengerScore,
      defenderScore,
    });

    if (!submitRes.ok) {
      const err = await submitRes.json().catch(() => ({})) as any;
      const detail = err.details ? ` — ${err.details}` : "";
      console.error(`[Arbiter] Submit failed for ${job.matchId}: ${err.error || submitRes.status}${detail}`);
    } else {
      console.log(`[Arbiter] Match ${job.matchId} complete. Score: ${challengerScore}-${defenderScore}`);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// Build the ordered list of matchTypes requests for one poll cycle.
// When training is included it gets its own request first; only if that
// returns nothing do we fall back to the remaining types.
function pollRequests(): Array<Record<string, unknown>> {
  if (!MATCH_TYPES) return [{ count: POLL_COUNT }];

  if (MATCH_TYPES.includes("training")) {
    const others = MATCH_TYPES.filter(t => t !== "training");
    const reqs: Array<Record<string, unknown>> = [
      { count: POLL_COUNT, matchTypes: ["training"] },
    ];
    if (others.length > 0) reqs.push({ count: POLL_COUNT, matchTypes: others });
    return reqs;
  }

  return [{ count: POLL_COUNT, matchTypes: MATCH_TYPES }];
}

let polling = false;

async function poll(): Promise<void> {
  if (polling) {
    // Previous batch still running — skip this tick and try again next interval
    setTimeout(poll, POLL_INTERVAL_MS);
    return;
  }

  polling = true;
  try {
    if (!withinRateLimit()) {
      console.warn(`[Arbiter] Rate limit reached (${rateLimitMax} reqs/${rateLimitWindowMs / 1000}s) — skipping poll.`);
    } else {
      for (const body of pollRequests()) {
        const res = await signedPost("/api/broker/next-jobs", body);
        if (res.status === 426) {
          const err = await res.json().catch(() => ({})) as any;
          console.error(`\n[Arbiter] !! OUTDATED VERSION !! ${err.error}`);
          console.error(`[Arbiter] Update at: ${err.updateUrl}`);
          if (AUTO_UPDATE) {
            await pullAndRestart();
          } else {
            console.error(`[Arbiter] Set AUTO_UPDATE=true to update automatically.\n`);
          }
          break;
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as any;
          console.error(`[Arbiter] Failed to fetch jobs: ${err.error || res.status}`);
          break;
        }
        const jobs = await res.json() as any[];
        for (const job of jobs) {
          await processJob(job);
        }
        if (jobs.length > 0) break; // got work — don't fall through to next type
      }
    }
  } catch (err) {
    console.error("[Arbiter] Poll error:", err);
  } finally {
    polling = false;
  }

  setTimeout(poll, POLL_INTERVAL_MS);
}

export async function startBrokerRunner(): Promise<void> {
  if (!WORKER_PRIVATE_KEY) {
    throw new Error(
      "Missing required env var: WORKER_PRIVATE_KEY\n" +
      "Get your Arbiter key at https://chessagents.ai/arbiter"
    );
  }

  try {
    WORKER_PUBLIC_KEY = publicKeyFromPrivate(WORKER_PRIVATE_KEY);
  } catch {
    throw new Error("WORKER_PRIVATE_KEY is invalid — check that you pasted the full PEM including headers");
  }

  console.log("[Arbiter] Starting...");
  console.log(`[Arbiter] API: ${API_URL}`);
  console.log(`[Arbiter] Identity: ${WORKER_PUBLIC_KEY.slice(27, 60)}...`);
  console.log(`[Arbiter] Poll interval: ${POLL_INTERVAL_MS}ms | Jobs per poll: ${POLL_COUNT}` +
    (rateLimitMax < Infinity ? ` | Rate limit: ${rateLimitMax}/${rateLimitWindowMs / 1000}s` : "") +
    (MATCH_TYPES ? ` | Match types: ${MATCH_TYPES.join(", ")}` : "") +
    (AUTO_UPDATE ? ` | Auto-update: enabled` : ""));

  await fetchServerPublicKey();
  await checkForUpdate();
  console.log("[Arbiter] Ready. Polling for matches.");
  poll();
}
