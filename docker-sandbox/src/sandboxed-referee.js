// =============================================================================
// Sandboxed Referee — runs a single match using Docker-isolated agents
//
// Chess engine runs on HOST (trusted, via chess.js). Agent code runs in Docker
// (untrusted). Each agent gets its own container with --network none,
// --read-only, etc. Each move is a `docker exec` call; on crash, restarts
// the container and retries once before forfeiting.
// =============================================================================

import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';
import { randomUUID } from 'node:crypto';
import config from './config.js';

const UCI_MOVE_REGEX = /[a-h][1-8][a-h][1-8][qrbn]?/;
const MAX_PLIES = 500;
const MAX_AGENT_STDOUT_BYTES = 64 * 1024;
const EXEC_EXIT_GRACE_MS = 250;
const HOST_TIMEOUT_BUFFER_MS = 1500;
const FALLBACK_MATCH_ID_LENGTH = 16;

function detectExt(code, language) {
    if (language === 'py') return '.py';
    return (code.includes('require(') && !code.includes('import ')) ? '.js' : '.mjs';
}

function normalizeExt(ext) {
    return ext === '.py' || ext === '.js' || ext === '.mjs' ? ext : '.mjs';
}

function runtimeForLanguage(language) {
    return language === 'py' ? 'python3' : 'node';
}

function runDocker(args, { input, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, { stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout?.on('data', d => { stdout += d.toString(); });
        child.stderr?.on('data', d => { stderr += d.toString(); });
        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('exit', code => {
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            const err = new Error(`docker ${args[0]} failed with code ${code}`);
            err.code = code;
            err.stdout = stdout;
            err.stderr = stderr;
            err.timedOut = timedOut;
            reject(err);
        });

        if (typeof input === 'string') child.stdin?.write(input);
        child.stdin?.end();
    });
}

async function startContainer(containerName, code, language) {
    const ext = normalizeExt(detectExt(code, language));
    await runDocker([
        'run', '-d', '--name', containerName,
        '--network', 'none',
        '--read-only',
        '--memory', config.agentMemoryLimit,
        '--cpus', '0.5',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', '32',
        '--tmpfs', '/tmp:size=10m,nodev,nosuid',
        config.sandboxImage, 'sleep', 'infinity',
    ]);

    await runDocker([
        'exec', '-i', containerName,
        'sh', '-c', `cat > /tmp/agent${ext}`,
    ], { input: code, timeoutMs: 5000 });

    return ext;
}

async function stopContainer(containerName) {
    try {
        await runDocker(['rm', '-f', containerName]);
    } catch {}
}

function getAgentMove(containerName, fen, language, ext) {
    const runtime = runtimeForLanguage(language);
    return new Promise(resolve => {
        let stdout = '';
        let stdoutBytes = 0;
        let done = false;
        let pendingResult = null;
        let exitGraceTimer = null;

        const child = spawn('docker', [
            'exec', '-i', containerName,
            'sh', '-lc', `timeout -k 1s ${(config.agentMoveTimeoutMs / 1000).toFixed(3)}s ${runtime} /tmp/agent${normalizeExt(ext)}`,
        ], { stdio: 'pipe' });

        const finish = (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (exitGraceTimer) clearTimeout(exitGraceTimer);
            resolve(value);
        };

        const requestExitAndResolve = (value, signal = 'SIGKILL') => {
            if (done || pendingResult !== null) return;
            pendingResult = value;
            child.stdout?.removeAllListeners('data');
            child.kill(signal);
            exitGraceTimer = setTimeout(() => finish(value), EXEC_EXIT_GRACE_MS);
        };

        const timer = setTimeout(() => requestExitAndResolve('__TIMEOUT__', 'SIGKILL'), config.agentMoveTimeoutMs + HOST_TIMEOUT_BUFFER_MS);

        child.stdout?.on('data', d => {
            if (done || pendingResult !== null) return;
            const chunk = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
            const chunkBytes = chunk.length;
            if (stdoutBytes + chunkBytes > MAX_AGENT_STDOUT_BYTES) {
                requestExitAndResolve('__CRASH__', 'SIGKILL');
                return;
            }
            stdoutBytes += chunkBytes;
            stdout += chunk.toString();
            if (stdout.includes('\n')) {
                const m = stdout.match(UCI_MOVE_REGEX);
                if (m) requestExitAndResolve(m[0], 'SIGTERM');
            }
        });

        child.on('exit', code => {
            if (pendingResult !== null) { finish(pendingResult); return; }
            const m = stdout.match(UCI_MOVE_REGEX);
            if (m) { finish(m[0]); return; }
            if (code === 124) { finish('__TIMEOUT__'); return; }
            finish(code === 137 ? '__OOM__' : '__CRASH__');
        });

        child.on('error', () => finish('__CRASH__'));

        child.stdin?.write(fen + '\n');
        child.stdin?.end();
    });
}

/**
 * Play a single game between two agents in Docker containers.
 * Chess validation runs on the host (trusted). Agent code runs isolated.
 *
 * @param {object} opts
 * @param {string} opts.matchId        - Unique match identifier
 * @param {string} opts.whiteCode      - White agent source code
 * @param {string} opts.whiteLang      - "js" or "py"
 * @param {string} opts.whiteName      - White agent display name
 * @param {string} opts.blackCode      - Black agent source code
 * @param {string} opts.blackLang      - "js" or "py"
 * @param {string} opts.blackName      - Black agent display name
 * @returns {Promise<{result, reason, plies, pgn, pgnResult}>}
 */
export async function playGame(opts) {
    const {
        matchId = randomUUID().slice(0, 8),
        whiteCode, whiteLang = 'js', whiteName = 'White',
        blackCode, blackLang = 'js', blackName = 'Black',
    } = opts;

    const safeMatchId = String(matchId)
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 40) || randomUUID().replace(/-/g, '').slice(0, FALLBACK_MATCH_ID_LENGTH);
    const wName = `match-${safeMatchId}-white`;
    const bName = `match-${safeMatchId}-black`;
    let wExt, bExt;

    try {
        wExt = await startContainer(wName, whiteCode, whiteLang);
        bExt = await startContainer(bName, blackCode, blackLang);
    } catch (err) {
        await Promise.all([stopContainer(wName), stopContainer(bName)]);
        throw err;
    }

    const chess = new Chess();

    try {
        while (!chess.isGameOver() && chess.history().length < MAX_PLIES) {
            const isWhite = chess.turn() === 'w';
            const containerName = isWhite ? wName : bName;
            const lang = isWhite ? whiteLang : blackLang;
            const ext = isWhite ? wExt : bExt;
            const code = isWhite ? whiteCode : blackCode;

            let uci = await getAgentMove(containerName, chess.fen(), lang, ext);

            // Retry once on crash/OOM with fresh container
            if (uci === '__CRASH__' || uci === '__OOM__') {
                await stopContainer(containerName);
                const newExt = await startContainer(containerName, code, lang);
                if (isWhite) wExt = newExt; else bExt = newExt;
                uci = await getAgentMove(containerName, chess.fen(), lang, newExt);
            }

            if (uci === '__TIMEOUT__') {
                return buildResult(chess, whiteName, blackName, isWhite ? '0-1' : '1-0', 'timeout');
            }
            if (uci === '__CRASH__' || uci === '__OOM__') {
                return buildResult(chess, whiteName, blackName, isWhite ? '0-1' : '1-0', uci === '__OOM__' ? 'oom' : 'crash');
            }

            let moveResult;
            try {
                moveResult = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
            } catch { moveResult = null; }

            if (!moveResult) {
                return buildResult(chess, whiteName, blackName, isWhite ? '0-1' : '1-0', 'illegal');
            }
        }

        let pgnResult, reason;
        if (chess.isCheckmate()) {
            pgnResult = chess.turn() === 'w' ? '0-1' : '1-0'; reason = 'checkmate';
        } else if (chess.isStalemate()) {
            pgnResult = '1/2-1/2'; reason = 'stalemate';
        } else if (chess.isThreefoldRepetition()) {
            pgnResult = '1/2-1/2'; reason = 'threefold';
        } else if (chess.isInsufficientMaterial()) {
            pgnResult = '1/2-1/2'; reason = 'insufficient';
        } else if (chess.isDraw()) {
            pgnResult = '1/2-1/2'; reason = '50-move';
        } else {
            pgnResult = '1/2-1/2'; reason = 'max_plies';
        }

        return buildResult(chess, whiteName, blackName, pgnResult, reason);
    } finally {
        await Promise.all([stopContainer(wName), stopContainer(bName)]);
    }
}

function buildResult(chess, whiteName, blackName, pgnResult, reason) {
    const result = pgnResult === '1-0' ? 'white' : pgnResult === '0-1' ? 'black' : 'draw';
    chess.header('White', whiteName, 'Black', blackName, 'Result', pgnResult, 'Termination', reason);
    return { result, reason, plies: chess.history().length, pgn: chess.pgn(), pgnResult };
}

export default { playGame };
