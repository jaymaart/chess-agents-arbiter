import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { execSync, execFileSync } from "child_process";
import http from "http";
import path from "path";
import os from "os";
import { hashData, signData, verifyData, publicKeyFromPrivate, decryptFromServer, normalizePem } from "./crypto";
import { runMatch } from "./matchmaking/runner";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ARBITER_VERSION: string = require("../package.json").version;

const API_URL = (process.env.API_URL || "https://chess-agents-api-production.up.railway.app").replace(/\/$/, "");
const WORKER_PRIVATE_KEY = process.env.WORKER_PRIVATE_KEY ? normalizePem(process.env.WORKER_PRIVATE_KEY) : "";
const BROKER_SECRET = process.env.BROKER_SECRET || "";
let WORKER_PUBLIC_KEY = "";

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || "10000", 10);

// Stable arbiter identity — set ARBITER_ID in env or auto-generate per-process.
const ARBITER_ID = process.env.ARBITER_ID || `arbiter-${Math.random().toString(36).slice(2, 10)}`;

// Concurrency — how many jobs to run in parallel.
// Night scaling: bump the limit during off-peak hours (crosses midnight correctly).
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || "10", 10));
const NIGHT_MAX_CONCURRENT = Math.max(1, parseInt(process.env.NIGHT_MAX_CONCURRENT || "20", 10));
const NIGHT_START_HOUR = parseInt(process.env.NIGHT_START_HOUR || "22", 10);
const NIGHT_END_HOUR = parseInt(process.env.NIGHT_END_HOUR || "8", 10);

// Dynamic scaling — admin can push a scaleTarget via heartbeat response, or
// the arbiter auto-scales based on queue pressure within these bounds.
const MIN_CONCURRENT = Math.max(1, parseInt(process.env.MIN_CONCURRENT || "1", 10));
const MAX_SCALE_CAP = Math.max(1, parseInt(process.env.MAX_SCALE_CAP || String(MAX_CONCURRENT * 4), 10));
let dynamicMaxConcurrent = MAX_CONCURRENT; // mutable — adjusted by auto-scaler and admin commands

// Auto-scaling pressure tracking
let pressureScore = 0; // positive = busy, negative = idle

// Match throughput counters
let matchesCompleted = 0;
let matchesFailed = 0;
const completionTimestamps: number[] = []; // rolling 60s window for matches/min

// Docker sandbox mode — agents run in isolated containers instead of bare subprocesses.
const DOCKER_SANDBOX = process.env.DOCKER_SANDBOX === "true";

// Auto-update: disabled by default. Set AUTO_UPDATE=true to enable.
// Requires /var/run/docker.sock mounted (-v /var/run/docker.sock:/var/run/docker.sock).
const AUTO_UPDATE = process.env.AUTO_UPDATE === "true";
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || "ghcr.io/jaymaart/chess-agents-arbiter:latest";

// Optional: limit to specific match types, e.g. MATCH_TYPES=training or MATCH_TYPES=training,rating
const MATCH_TYPES: string[] | null = process.env.MATCH_TYPES
  ? process.env.MATCH_TYPES.split(",").map(s => s.trim()).filter(Boolean)
  : null;

// Priority queue — hot-reloadable, no restart needed.
// Format: player_name  OR  player_name|expires_epoch_ms
const PRIORITY_FILE = process.env.PRIORITY_FILE || path.join(process.cwd(), "priority.txt");

// Soft rate limit: RATE_LIMIT="100/10s" means at most 100 requests per 10-second window.
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
  if (BROKER_SECRET) {
    return fetch(`${API_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-broker-secret": BROKER_SECRET,
        "x-arbiter-version": ARBITER_VERSION,
      },
      body: JSON.stringify(body),
    });
  }

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
  const signingString = job.matchId + job.challengerHash + job.defenderHash;
  if (!verifyData(signingString, job.serverSignature, serverPublicKey)) {
    console.error(`[Arbiter] Server signature invalid for match ${job.matchId} — rejecting.`);
    return false;
  }
  return true;
}

function jsExt(code: string): ".mjs" | ".cjs" {
  return /\bimport\s*[\(\{"'`]|\bexport\s+(default\b|\{|const\b|function\b|class\b|async\b)/.test(code)
    ? ".mjs"
    : ".cjs";
}

// ---------------------------------------------------------------------------
// Priority queue — reads priority.txt on every poll tick (hot-reloadable).
// Returns the priority player name, or null if none/expired.
// ---------------------------------------------------------------------------

function getPriority(): string | null {
  try {
    if (!existsSync(PRIORITY_FILE)) return null;
    const raw = readFileSync(PRIORITY_FILE, "utf-8").trim();
    if (!raw || raw.startsWith("#")) return null;
    const [name, expiresStr] = raw.split("|");
    if (expiresStr && Date.now() > parseInt(expiresStr, 10)) return null;
    return name.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orphan container cleanup — only runs when DOCKER_SANDBOX=true.
// Kills match containers that have been running >= 10 minutes (stuck/orphaned).
// ---------------------------------------------------------------------------

function cleanupOrphanContainers(): void {
  if (!DOCKER_SANDBOX) return;
  try {
    const output = execSync(
      'docker ps -a --filter "name=match-" --format "{{.Names}} {{.Status}}"',
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (!output) return;

    for (const line of output.split("\n")) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx < 0) continue;
      const name = line.slice(0, spaceIdx);
      const status = line.slice(spaceIdx + 1);

      const minutesMatch = status.match(/Up (\d+) minutes?/);
      const isOrphaned = status.includes("hour") || status.includes("day") ||
        (minutesMatch !== null && parseInt(minutesMatch[1], 10) >= 10);

      if (isOrphaned) {
        console.log(`[Arbiter] Cleaning orphaned container: ${name}`);
        try { execFileSync("docker", ["rm", "-f", name], { stdio: "pipe", timeout: 5000 }); } catch {}
      } else if (status.includes("Exited")) {
        try { execFileSync("docker", ["rm", name], { stdio: "pipe", timeout: 5000 }); } catch {}
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Night scaling
// ---------------------------------------------------------------------------

function getMaxConcurrent(): number {
  const hour = new Date().getHours();
  const isNight = NIGHT_START_HOUR > NIGHT_END_HOUR
    ? (hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR)
    : (hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR);
  const nightBase = isNight ? NIGHT_MAX_CONCURRENT : MAX_CONCURRENT;
  // Dynamic override wins if it differs from the static base
  return Math.max(nightBase, dynamicMaxConcurrent);
}

// Emergency scale-down — runs every poll tick regardless of slot availability.
// autoScale() is only called when we have free slots and fetch from the broker,
// so when all slots are full it never fires. This runs unconditionally.
function checkEmergencyScaleDown(): void {
  const load1m = os.loadavg()[0];
  const cores = os.cpus().length;
  if (load1m >= cores * 1.5 && dynamicMaxConcurrent > MIN_CONCURRENT) {
    const next = Math.max(Math.floor(dynamicMaxConcurrent * 0.75), MIN_CONCURRENT);
    if (next !== dynamicMaxConcurrent) {
      console.log(`[Arbiter] Emergency scale-down: ${dynamicMaxConcurrent} → ${next} (load=${load1m.toFixed(1)}, cores=${cores})`);
      dynamicMaxConcurrent = next;
    }
    pressureScore = 0;
  }
}

// Auto-scaler: called after every successful broker fetch, adjusts dynamicMaxConcurrent based on pressure.
// pressure > 3 consecutive full polls → scale up 25%
// pressure < -5 consecutive empty polls → scale down 10%
function autoScale(jobsReturned: number, slotsRequested: number): void {
  if (jobsReturned >= slotsRequested && slotsRequested > 0) {
    pressureScore = Math.min(pressureScore + 1, 10);
  } else if (jobsReturned === 0) {
    pressureScore = Math.max(pressureScore - 1, -10);
  } else {
    pressureScore = Math.max(pressureScore - 0.5, -10);
  }

  const load1m = os.loadavg()[0];
  const cores = os.cpus().length;

  if (pressureScore >= 3) {
    // Suppress scale-up if local load is near saturation (> 85% of core count)
    if (load1m >= cores * 0.85) {
      console.log(`[Arbiter] Auto-scale suppressed: load ${load1m.toFixed(1)} >= ${(cores * 0.85).toFixed(1)} (${cores} cores)`);
      pressureScore = 0;
      return;
    }
    // Suppress scale-up if host siblings are already using >= 80% of total host capacity.
    // This prevents multi-replica deployments from collectively over-subscribing one machine.
    const hostUtil = lastHostCapacity > 0 ? lastHostActiveJobs / lastHostCapacity : 0;
    if (hostUtil >= 0.8) {
      console.log(`[Arbiter] Auto-scale suppressed: host utilization ${(hostUtil * 100).toFixed(0)}% (${lastHostActiveJobs}/${lastHostCapacity} across all replicas)`);
      pressureScore = 0;
      return;
    }
    const next = Math.min(Math.ceil(dynamicMaxConcurrent * 1.25), MAX_SCALE_CAP);
    if (next !== dynamicMaxConcurrent) {
      console.log(`[Arbiter] Auto-scaling up: ${dynamicMaxConcurrent} → ${next} (pressure=${pressureScore.toFixed(1)}, load=${load1m.toFixed(1)}, host=${(hostUtil * 100).toFixed(0)}%)`);
      dynamicMaxConcurrent = next;
    }
    pressureScore = 0;
  } else if (pressureScore <= -5) {
    const next = Math.max(Math.floor(dynamicMaxConcurrent * 0.9), MIN_CONCURRENT);
    if (next !== dynamicMaxConcurrent) {
      console.log(`[Arbiter] Auto-scaling down: ${dynamicMaxConcurrent} → ${next} (pressure=${pressureScore.toFixed(1)})`);
      dynamicMaxConcurrent = next;
    }
    pressureScore = 0;
  }
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async function processJob(job: any): Promise<void> {
  console.log(`[Arbiter] Running match ${job.matchId}...`);

  const valid = await verifyJobIntegrity(job);
  if (!valid) {
    console.error(`[Arbiter] Skipping match ${job.matchId} — integrity check failed.`);
    return;
  }

  let challengerCode = job.challenger.code as string;
  let defenderCode = job.defender.code as string;
  if (job.encrypted) {
    if (!WORKER_PRIVATE_KEY) {
      console.error(`[Arbiter] Match ${job.matchId} is encrypted but no WORKER_PRIVATE_KEY — skipping.`);
      return;
    }
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
      { games: job.gamesPlanned, matchId: job.matchId }
    );

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
      matchesFailed++;
      completionTimestamps.push(Date.now());
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
      matchesCompleted++;
      completionTimestamps.push(Date.now());
      console.log(`[Arbiter] Match ${job.matchId} complete. Score: ${challengerScore}-${defenderScore}`);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Poll loop — concurrent slot-filling
// ---------------------------------------------------------------------------

function pollRequests(count: number): Array<Record<string, unknown>> {
  if (!MATCH_TYPES) return [{ count }];

  if (MATCH_TYPES.includes("training")) {
    const others = MATCH_TYPES.filter(t => t !== "training");
    const reqs: Array<Record<string, unknown>> = [
      { count, matchTypes: ["training"] },
    ];
    if (others.length > 0) reqs.push({ count, matchTypes: others });
    return reqs;
  }

  return [{ count, matchTypes: MATCH_TYPES }];
}

let startedAt = Date.now();
// Host-level aggregate from last heartbeat response — prevents multi-replica over-scaling
let lastHostActiveJobs = 0;
let lastHostCapacity = 0;

async function sendHeartbeat(): Promise<void> {
  try {
    const now = Date.now();
    const cutoff = now - 60_000;
    while (completionTimestamps.length && completionTimestamps[0] < cutoff) completionTimestamps.shift();

    const body = {
      arbiterId: ARBITER_ID,
      hostname: os.hostname(),
      version: ARBITER_VERSION,
      activeJobs: activeJobs.size,
      maxConcurrent: getMaxConcurrent(),
      matchTypes: MATCH_TYPES,
      uptimeMs: now - startedAt,
      authMode: BROKER_SECRET ? "broker-secret" : "rsa",
      matchesCompleted,
      matchesFailed,
      matchesPerMinute: completionTimestamps.length,
      pressureScore,
      osLoad: os.loadavg()[0],
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };

    const res = BROKER_SECRET
      ? await fetch(`${API_URL}/api/broker/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-broker-secret": BROKER_SECRET, "x-arbiter-version": ARBITER_VERSION },
          body: JSON.stringify(body),
        })
      : await signedPost("/api/broker/heartbeat", body);

    if (res.ok) {
      const data = await res.json() as any;
      if (typeof data.scaleTarget === "number") {
        const clamped = Math.max(MIN_CONCURRENT, Math.min(data.scaleTarget, MAX_SCALE_CAP));
        console.log(`[Arbiter] Admin scale command: ${dynamicMaxConcurrent} → ${clamped}`);
        dynamicMaxConcurrent = clamped;
        pressureScore = 0;
      }
      // Store host-level utilization for the auto-scaler to use
      if (typeof data.hostActiveJobs === "number" && typeof data.hostCapacity === "number") {
        lastHostActiveJobs = data.hostActiveJobs;
        lastHostCapacity = data.hostCapacity;
      }
    }
  } catch {
    // Heartbeat failure is non-fatal
  }
}

const activeJobs = new Set<Promise<void>>();
let draining = false;
let lastCleanup = 0;
let pollBackoffMs = 0;
const MAX_POLL_BACKOFF_MS = 60_000;

function fireJob(job: any): void {
  let p: Promise<void>;
  p = processJob(job).catch(err => {
    console.error(`[Arbiter] Job error (${job.matchId}):`, err);
  }).finally(() => {
    activeJobs.delete(p);
  });
  activeJobs.add(p);
}

async function drain(): Promise<void> {
  const DRAIN_TIMEOUT_MS = 90_000;
  const start = Date.now();
  if (activeJobs.size === 0) {
    console.log("[Arbiter] Drain complete — no active jobs.");
    return;
  }
  console.log(`[Arbiter] Draining — waiting for ${activeJobs.size} active job(s) to finish (timeout: 90s)...`);
  while (activeJobs.size > 0 && Date.now() - start < DRAIN_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 1000));
    if (activeJobs.size > 0) {
      console.log(`[Arbiter] Draining — ${activeJobs.size} job(s) remaining (${Math.round((Date.now() - start) / 1000)}s elapsed)...`);
    }
  }
  if (activeJobs.size > 0) {
    console.warn(`[Arbiter] Drain timeout reached — ${activeJobs.size} job(s) still running. Forcing exit.`);
  } else {
    console.log("[Arbiter] Drain complete. All jobs finished.");
  }
}

async function poll(): Promise<void> {
  if (draining) return;
  checkEmergencyScaleDown();
  const maxNow = getMaxConcurrent();
  const slots = maxNow - activeJobs.size;

  if (slots > 0 && withinRateLimit()) {
    try {
      for (const body of pollRequests(slots)) {
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

        if (res.status === 429) {
          const err = await res.json().catch(() => ({})) as any;
          pollBackoffMs = Math.min(pollBackoffMs ? pollBackoffMs * 2 : 5_000, MAX_POLL_BACKOFF_MS);
          console.warn(`[Arbiter] Rate limited by server: ${err.error || res.status} — backing off ${pollBackoffMs / 1000}s`);
          break;
        }

        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as any;
          console.error(`[Arbiter] Failed to fetch jobs: ${err.error || res.status}`);
          break;
        }

        const jobs = await res.json() as any[];
        pollBackoffMs = 0; // successful fetch — reset backoff

        autoScale(jobs.length, slots);

        // Priority sort — read priority.txt on every tick (hot-reloadable)
        const priority = getPriority();
        if (priority && jobs.length > 1) {
          const p = priority.toLowerCase();
          jobs.sort((a, b) => {
            const aMatch = a.challenger?.name?.toLowerCase().includes(p) || a.defender?.name?.toLowerCase().includes(p) ? 0 : 1;
            const bMatch = b.challenger?.name?.toLowerCase().includes(p) || b.defender?.name?.toLowerCase().includes(p) ? 0 : 1;
            return aMatch - bMatch;
          });
        }

        for (const job of jobs) {
          fireJob(job);
        }

        if (jobs.length > 0) break; // got work — don't fall through to next type
      }
    } catch (err) {
      console.error("[Arbiter] Poll error:", err);
    }
  } else if (!withinRateLimit()) {
    console.warn(`[Arbiter] Rate limit reached (${rateLimitMax} reqs/${rateLimitWindowMs / 1000}s) — skipping poll.`);
  }

  // Periodic orphan container cleanup
  if (DOCKER_SANDBOX && Date.now() - lastCleanup > 300_000) {
    cleanupOrphanContainers();
    lastCleanup = Date.now();
  }

  // Sleep shorter when all slots full (just waiting for a slot to open).
  // Add backoff if server recently rate-limited us.
  if (!draining) {
    const delay = (activeJobs.size >= maxNow ? 2000 : POLL_INTERVAL_MS) + pollBackoffMs;
    setTimeout(poll, delay);
  }
}

export async function startBrokerRunner(): Promise<void> {
  if (!WORKER_PRIVATE_KEY && !BROKER_SECRET) {
    throw new Error(
      "Missing required env var: WORKER_PRIVATE_KEY or BROKER_SECRET\n" +
      "Get your Arbiter key at https://chessagents.ai/arbiter"
    );
  }

  if (WORKER_PRIVATE_KEY) {
    try {
      WORKER_PUBLIC_KEY = publicKeyFromPrivate(WORKER_PRIVATE_KEY);
    } catch {
      throw new Error("WORKER_PRIVATE_KEY is invalid — check that you pasted the full PEM including headers");
    }
  }

  console.log("[Arbiter] Starting...");
  console.log(`[Arbiter] API: ${API_URL}`);
  console.log(`[Arbiter] Auth: ${BROKER_SECRET ? "broker-secret" : `rsa:${WORKER_PUBLIC_KEY.slice(27, 60)}...`}`);
  console.log(
    `[Arbiter] Concurrency: ${MAX_CONCURRENT} (night: ${NIGHT_MAX_CONCURRENT}, ${NIGHT_START_HOUR}:00–${NIGHT_END_HOUR}:00)` +
    ` | Poll: ${POLL_INTERVAL_MS}ms` +
    (DOCKER_SANDBOX ? ` | Sandbox: Docker (${process.env.SANDBOX_IMAGE || "agentchess-sandbox:latest"})` : " | Sandbox: bare subprocess") +
    (rateLimitMax < Infinity ? ` | Rate limit: ${rateLimitMax}/${rateLimitWindowMs / 1000}s` : "") +
    (MATCH_TYPES ? ` | Match types: ${MATCH_TYPES.join(", ")}` : "") +
    (AUTO_UPDATE ? ` | Auto-update: enabled` : "")
  );

  await fetchServerPublicKey();
  await checkForUpdate();

  if (DOCKER_SANDBOX) {
    cleanupOrphanContainers();
    lastCleanup = Date.now();
  }

  const shutdown = async (signal: string) => {
    console.log(`[Arbiter] ${signal} received — entering drain mode.`);
    draining = true;
    await drain();
    process.exit(activeJobs.size > 0 ? 1 : 0);
  };
  process.once("SIGTERM", () => { shutdown("SIGTERM").catch(err => { console.error("[Arbiter] Shutdown error:", err); process.exit(1); }); });
  process.once("SIGINT",  () => { shutdown("SIGINT").catch(err => { console.error("[Arbiter] Shutdown error:", err); process.exit(1); }); });

  startedAt = Date.now();
  console.log("[Arbiter] Ready. Polling for matches.");
  poll();

  // Heartbeat loop — reports stats to API and picks up admin scale commands
  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}
