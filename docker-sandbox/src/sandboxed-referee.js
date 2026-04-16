// =============================================================================
// Sandboxed Referee — runs a single match using Docker-isolated agents
//
// Chess engine runs on HOST (trusted, via chess.js). Agent code runs in Docker
// (untrusted). Each agent gets its own container with --network none,
// --read-only, etc. Each move is a `docker exec` call; on crash, restarts
// the container and retries once before forfeiting.
// =============================================================================

import { spawn, execFileSync } from 'node:child_process';
import { Chess } from 'chess.js';
import { randomUUID } from 'node:crypto';
import config from './config.js';

const UCI_MOVE_REGEX = /[a-h][1-8][a-h][1-8][qrbn]?/;
const MAX_PLIES = 500;
const MAX_AGENT_STDOUT_BYTES = 64 * 1024;

function detectExt(code, language) {
    if (language === 'py') return '.py';
    return (code.includes('require(') && !code.includes('import ')) ? '.js' : '.mjs';
}

function startContainer(containerName, code, language) {
    const ext = detectExt(code, language);
    execFileSync('docker', [
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
    ], { stdio: 'pipe', timeout: 10000 });

    execFileSync('docker', [
        'exec', '-i', containerName,
        'sh', '-c', `cat > /tmp/agent${ext}`,
    ], { input: code, stdio: 'pipe', timeout: 5000 });

    return ext;
}

function stopContainer(containerName) {
    try {
        execFileSync('docker', ['rm', '-f', containerName], { stdio: 'pipe', timeout: 10000 });
    } catch {}
}

function getAgentMove(containerName, fen, language, ext) {
    const runtime = language === 'py' ? 'python3' : 'node';
    return new Promise(resolve => {
        let stdout = '';
        let stdoutBytes = 0;
        let completed = false;

        const child = spawn('docker', [
            'exec', '-i', containerName,
            runtime, `/tmp/agent${ext}`,
        ], { stdio: 'pipe' });

        const timer = setTimeout(() => {
            if (!completed) { completed = true; child.kill('SIGKILL'); resolve('__TIMEOUT__'); }
        }, config.agentMoveTimeoutMs);

        child.stdout?.on('data', d => {
            stdoutBytes += d.length;
            if (!completed && stdoutBytes > MAX_AGENT_STDOUT_BYTES) {
                completed = true;
                clearTimeout(timer);
                child.kill('SIGKILL');
                resolve('__CRASH__');
                return;
            }
            stdout += d.toString();
            if (!completed && stdout.includes('\n')) {
                const m = stdout.match(UCI_MOVE_REGEX);
                if (m) { completed = true; clearTimeout(timer); child.kill(); resolve(m[0]); }
            }
        });

        child.on('exit', code => {
            if (!completed) {
                completed = true;
                clearTimeout(timer);
                const m = stdout.match(UCI_MOVE_REGEX);
                if (m) { resolve(m[0]); return; }
                resolve(code === 137 ? '__OOM__' : '__CRASH__');
            }
        });

        child.on('error', () => {
            if (!completed) { completed = true; clearTimeout(timer); resolve('__CRASH__'); }
        });

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

    const wName = `match-${matchId}-white`;
    const bName = `match-${matchId}-black`;
    let wExt, bExt;

    try {
        wExt = startContainer(wName, whiteCode, whiteLang);
        bExt = startContainer(bName, blackCode, blackLang);
    } catch (err) {
        stopContainer(wName);
        stopContainer(bName);
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
                stopContainer(containerName);
                const newExt = startContainer(containerName, code, lang);
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
        stopContainer(wName);
        stopContainer(bName);
    }
}

function buildResult(chess, whiteName, blackName, pgnResult, reason) {
    const result = pgnResult === '1-0' ? 'white' : pgnResult === '0-1' ? 'black' : 'draw';
    chess.header('White', whiteName, 'Black', blackName, 'Result', pgnResult, 'Termination', reason);
    return { result, reason, plies: chess.history().length, pgn: chess.pgn(), pgnResult };
}

export default { playGame };
