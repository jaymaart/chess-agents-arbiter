import fs from "fs/promises";
import path from "path";
import os from "os";
import { hashData, signData, verifyData, publicKeyFromPrivate, decryptFromServer } from "./crypto";
import { runMatch } from "./matchmaking/runner";

const API_URL = (process.env.API_URL || "https://chess-agents-api-production.up.railway.app").replace(/\/$/, "");
const WORKER_PRIVATE_KEY = process.env.WORKER_PRIVATE_KEY || "";
let WORKER_PUBLIC_KEY = "";
const POLL_INTERVAL_MS = 2000;

let serverPublicKey = "";

async function fetchServerPublicKey(): Promise<void> {
  const res = await fetch(`${API_URL}/api/public-key`);
  if (!res.ok) throw new Error("Failed to fetch server public key");
  const data = await res.json() as { publicKey: string };
  serverPublicKey = data.publicKey;
  console.log("[Arbiter] Server public key loaded.");
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
  const challengerExt = job.challenger.language === "py" ? ".py" : ".mjs";
  const defenderExt = job.defender.language === "py" ? ".py" : ".mjs";
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
    const CLEAN_TERMS = ["checkmate", "stalemate", "threefold", "insufficient", "50-move", "max plies", "draw", "normal", "adjudication", "timeout"];
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

async function poll(): Promise<void> {
  try {
    const res = await signedPost("/api/broker/next-jobs", { count: 1 });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any;
      console.error(`[Arbiter] Failed to fetch jobs: ${err.error || res.status}`);
    } else {
      const jobs = await res.json() as any[];
      for (const job of jobs) {
        await processJob(job);
      }
    }
  } catch (err) {
    console.error("[Arbiter] Poll error:", err);
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

  await fetchServerPublicKey();
  console.log("[Arbiter] Ready. Polling for matches.");
  poll();
}
