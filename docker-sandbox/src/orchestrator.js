// =============================================================================
// Orchestrator — Main service loop
//
// Polls chessagents.ai broker for match jobs, runs them via Docker-sandboxed
// referee, and submits PGN results back. Designed for multi-day continuous
// operation with crash recovery and container leak prevention.
// =============================================================================

import { execSync, execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { fetchJobs, submitResult, reportCrash, verifyJobIntegrity, initServerPublicKey } from './api-client.js';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'game-worker.js');

let running = true;
let activeGames = 0;

// Stats tracking
const stats = {
    started: Date.now(),
    jobsCompleted: 0,
    gamesPlayed: 0,
    errors: 0,
    results: { white: 0, black: 0, draw: 0 },
    reasons: {},
};

function log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] ${msg}`);
}

function logError(msg, err) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`[${ts}] ERROR: ${msg}`, err?.message || '');
}

/**
 * Run a single game in a worker thread with a hard timeout.
 * Prevents blocking the main event loop.
 */
function runGameInWorker(opts) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_PATH, { workerData: opts });
        worker.on('message', (msg) => {
            if (msg.ok) resolve(msg.result);
            else reject(new Error(msg.error));
        });
        worker.on('error', (err) => {
            reject(err);
        });
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
    });
}

/**
 * Read priority filter from priority.txt (hot-reloadable).
 * File format: player_name or player_name|expires_epoch_ms
 * Returns null if no priority, expired, or file missing.
 *
 * To set priority:   echo "trinity|$(date -d '+1 hour' +%s%3N)" > priority.txt
 * To clear priority: rm priority.txt
 */
function getPriority() {
    try {
        if (!existsSync(config.priorityFile)) return null;
        const raw = readFileSync(config.priorityFile, 'utf-8').trim();
        if (!raw) return null;
        const [name, expiresStr] = raw.split('|');
        if (expiresStr) {
            const expires = parseInt(expiresStr);
            if (Date.now() > expires) return null; // expired
        }
        return name.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Clean up any orphaned match containers.
 */
function cleanupContainers() {
    try {
        const output = execSync(
            'docker ps -a -f "name=match-" --format "{{.Names}} {{.Status}}"',
            { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        if (!output) return;

        for (const line of output.split('\n')) {
            const [name, ...statusParts] = line.split(' ');
            if (!name) continue;
            const status = statusParts.join(' ');
            // Kill containers running >= 10 minutes (orphaned — healthy games finish well under that)
            const minutesMatch = status.match(/Up (\d+) minutes?/);
            const isOld = status.includes('hour') || status.includes('day') ||
                (minutesMatch !== null && parseInt(minutesMatch[1], 10) >= 10);
            if (isOld) {
                log(`Cleaning orphaned container: ${name}`);
                try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe', timeout: 5000 }); } catch {}
            }
            // Remove exited containers
            if (status.includes('Exited')) {
                try { execFileSync('docker', ['rm', name], { stdio: 'pipe', timeout: 5000 }); } catch {}
            }
        }
    } catch {}
}

/**
 * Process a single match job from the broker.
 */
async function processJob(job) {
    const { jobId, matchId, challenger, defender, gamesPlanned = 1 } = job;
    log(`Job ${jobId.slice(0, 8)}: ${challenger.name} vs ${defender.name} (${gamesPlanned} game(s))`);

    if (!await verifyJobIntegrity(job)) {
        log(`  Skipping job ${jobId.slice(0, 8)} — server signature invalid.`);
        return;
    }

    let challengerTotal = 0;
    let defenderTotal = 0;
    const pgns = [];
    let crashReason = null;

    for (let g = 0; g < gamesPlanned; g++) {
        const swap = g % 2 === 1;
        const whiteCode = swap ? defender.code : challenger.code;
        const whiteLang = swap ? defender.language : challenger.language;
        const whiteName = swap ? defender.name : challenger.name;
        const blackCode = swap ? challenger.code : defender.code;
        const blackLang = swap ? challenger.language : defender.language;
        const blackName = swap ? challenger.name : defender.name;

        try {
            const result = await runGameInWorker({
                matchId: `${matchId.slice(0, 8)}-g${g}`,
                whiteCode,
                whiteLang,
                whiteName,
                blackCode,
                blackLang,
                blackName,
            });

            log(`  G${g + 1}: ${result.pgnResult} (${result.reason}, ${result.plies} plies)`);
            pgns.push(result.pgn);
            stats.gamesPlayed++;
            stats.reasons[result.reason] = (stats.reasons[result.reason] || 0) + 1;

            if (result.result === 'draw') {
                challengerTotal += 0.5;
                defenderTotal += 0.5;
                stats.results.draw++;
            } else if (result.result === 'white') {
                if (swap) { defenderTotal += 1; stats.results.white++; }
                else { challengerTotal += 1; stats.results.white++; }
            } else if (result.result === 'black') {
                if (swap) { challengerTotal += 1; stats.results.black++; }
                else { defenderTotal += 1; stats.results.black++; }
            }
        } catch (err) {
            logError(`Game ${g + 1} crashed for job ${jobId.slice(0, 8)}`, err);
            stats.errors++;
            crashReason = `Game ${g + 1} crashed: ${err.message?.slice(0, 100) || 'unknown'}`;
            pgns.push(
                `[Event "ChessAgents Arena"]\n[Site "Docker Sandbox"]\n` +
                `[Date "${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}"]\n` +
                `[White "${whiteName}"]\n[Black "${blackName}"]\n` +
                `[Result "*"]\n[Termination "crash"]\n\n*\n`
            );
        }
    }

    const fullPgn = pgns.join('\n');

    if (crashReason) {
        try {
            await reportCrash({ jobId, matchId, reason: crashReason, pgn: fullPgn });
            log(`  Crash reported for job ${jobId.slice(0, 8)} — no ratings applied.`);
        } catch (err) {
            logError(`Failed to report crash for job ${jobId.slice(0, 8)}`, err);
        }
        return;
    }

    const overallResult = challengerTotal > defenderTotal ? 'challenger'
        : defenderTotal > challengerTotal ? 'defender'
        : 'draw';

    try {
        await submitResult({
            jobId,
            matchId,
            pgn: fullPgn,
            result: overallResult,
            challengerScore: challengerTotal,
            defenderScore: defenderTotal,
        });
        stats.jobsCompleted++;
        log(`  Submitted: ${challenger.name} ${challengerTotal}-${defenderTotal} ${defender.name}`);
    } catch (err) {
        logError(`Failed to submit job ${jobId.slice(0, 8)}`, err);
        stats.errors++;
    }
}

function printStats() {
    const uptime = ((Date.now() - stats.started) / 60000).toFixed(1);
    const gps = stats.gamesPlayed > 0 ? (stats.gamesPlayed / (Date.now() - stats.started) * 3600000).toFixed(1) : '0';
    log(`--- Stats: ${stats.jobsCompleted} jobs, ${stats.gamesPlayed} games (${gps}/hr), ${stats.errors} errors, uptime ${uptime}m ---`);
    if (Object.keys(stats.reasons).length > 0) {
        log(`    Reasons: ${Object.entries(stats.reasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
}

/**
 * Main polling loop.
 */
export async function runLoop() {
    log('=== Match Processor Starting ===');
    log(`Broker: ${config.brokerUrl}`);
    log(`Runner ID: ${config.brokerId}`);
    log(`Move timeout: ${config.agentMoveTimeoutMs}ms`);

    await initServerPublicKey();

    // Clean up any orphaned containers from previous runs
    cleanupContainers();

    let pollFailures = 0;
    let lastCleanup = Date.now();
    let lastStats = Date.now();

    function getMaxConcurrent() {
        const hour = new Date().getHours();
        if (hour >= config.nightStartHour && hour < config.nightEndHour) {
            return config.nightMaxConcurrent;
        }
        return config.maxConcurrentMatches;
    }

    // Continuously keep MAX_CONCURRENT jobs running
    // When a job finishes, immediately backfill the slot
    function runJob(job) {
        activeGames++;
        return processJob(job).catch(err => {
            logError(`Job failed`, err);
            stats.errors++;
        }).finally(() => {
            activeGames--;
        });
    }

    while (running) {
        // Fill up to current max (scales up at night)
        const maxNow = getMaxConcurrent();
        const slotsAvailable = maxNow - activeGames;
        if (slotsAvailable > 0) {
            try {
                const jobs = await fetchJobs(slotsAvailable);
                pollFailures = 0;

                if (jobs.length > 0) {
                    // Priority: check priority.txt (hot-reloadable, no restart needed)
                    // Format: player_name or player_name|expires_epoch_ms
                    const priority = getPriority();
                    if (priority) {
                        const pLower = priority.toLowerCase();
                        jobs.sort((a, b) => {
                            const aMatch = (a.challenger?.name?.toLowerCase().includes(pLower) || a.defender?.name?.toLowerCase().includes(pLower)) ? 0 : 1;
                            const bMatch = (b.challenger?.name?.toLowerCase().includes(pLower) || b.defender?.name?.toLowerCase().includes(pLower)) ? 0 : 1;
                            return aMatch - bMatch;
                        });
                    }
                    const priorityCount = priority ? jobs.filter(j => j.challenger?.name?.toLowerCase().includes(priority.toLowerCase()) || j.defender?.name?.toLowerCase().includes(priority.toLowerCase())).length : 0;
                    log(`Fetched ${jobs.length} job(s), ${activeGames} active, ${slotsAvailable} slots${priorityCount ? ` (${priorityCount} ${priority})` : ''}`);
                    for (const job of jobs) {
                        runJob(job);
                    }
                }
            } catch (err) {
                pollFailures++;
                const backoff = Math.min(config.pollIntervalMs * Math.pow(2, pollFailures), 30000);
                if (pollFailures <= 3 || pollFailures % 20 === 0) {
                    logError(`Poll failed (attempt ${pollFailures}), retrying in ${backoff}ms`, err);
                }
                await sleep(backoff);
                continue;
            }
        }

        // Short sleep before checking for open slots again
        await sleep(activeGames >= maxNow ? 2000 : config.pollIntervalMs);

        // Periodic container cleanup (every 5 minutes)
        if (Date.now() - lastCleanup > 300000) {
            cleanupContainers();
            lastCleanup = Date.now();
        }

        // Periodic stats (every 5 minutes)
        if (Date.now() - lastStats > 300000) {
            printStats();
            lastStats = Date.now();
        }
    }

    log('=== Match Processor Stopped ===');
    printStats();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function shutdown() {
    log('Shutdown requested...');
    running = false;
}

export default { runLoop, shutdown };
