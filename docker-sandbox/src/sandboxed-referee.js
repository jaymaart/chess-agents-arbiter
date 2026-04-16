// =============================================================================
// Sandboxed Referee — runs a single match using Docker-isolated agents
//
// Chess engine runs on HOST (trusted). Agent code runs in Docker (untrusted).
// Each agent gets its own container with --network none, --read-only, etc.
// =============================================================================

import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    parseFen, boardToFen, applyUciMove, generateLegalMoves,
    isInCheck, getBoardKey, insufficientMaterial, STARTING_FEN
} from './chess-engine.js';
import { buildPgnSync } from './pgn-builder.js';
import config from './config.js';

const MOVE_REGEX = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Start a Docker container for an agent.
 * Returns the container name.
 */
function detectModuleType(code) {
    // ESM if it uses import/export syntax
    if (/^\s*import\s+/m.test(code) || /^\s*export\s+/m.test(code)) return 'esm';
    return 'cjs';
}

function startContainer(matchId, color, agentCode, language) {
    const containerName = `match-${matchId}-${color}`;
    let ext;
    if (language === 'py') {
        ext = '.py';
    } else {
        // Match Jaymart's arbiter: .mjs for JS agents (Node ESM mode)
        // Agents using require() get .js (CommonJS), everything else .mjs
        ext = agentCode.includes('require(') && !agentCode.includes('import ') ? '.js' : '.mjs';
    }
    const tmpFile = join(config.dataDir, `${containerName}${ext}`);

    // Write agent code to temp file
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(tmpFile, agentCode);

    try {
        // Start container with sleep infinity
        // Note: tmpfs does NOT have noexec so node/python can run agent code from /tmp
        execFileSync('docker', [
            'run', '-d',
            '--name', containerName,
            '--network', 'none',
            '--read-only',
            '--memory', config.agentMemoryLimit,
            '--cpus', '0.5',
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges',
            '--pids-limit', '32',
            '--tmpfs', '/tmp:size=10m,nodev,nosuid',
            config.sandboxImage,
            'sleep', 'infinity',
        ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });

        // Pipe agent code into container's writable tmpfs via docker exec
        execFileSync('docker', [
            'exec', '-i', containerName,
            'sh', '-c', `cat > /tmp/agent${ext}`
        ], {
            input: agentCode,
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } finally {
        // Remove temp file from host
        try { unlinkSync(tmpFile); } catch {}
    }

    return { containerName, ext };
}

/**
 * Get a move from a Docker-sandboxed agent.
 * @returns {string} UCI move or error sentinel
 */
function getAgentMove(containerName, fen, language, timeoutMs, ext) {
    const runtime = language === 'py' ? 'python3' : 'node';
    ext = ext || (language === 'py' ? '.py' : '.js');
    const timeoutSec = Math.ceil(timeoutMs / 1000);

    try {
        const raw = execFileSync('docker', [
            'exec', '-i', containerName,
            'timeout', String(timeoutSec),
            runtime, `/tmp/agent${ext}`
        ], {
            input: fen + '\n',
            encoding: 'utf-8',
            timeout: timeoutMs + 2000, // host-side grace period
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 1024 * 1024,
        });
        return String(raw).trim();
    } catch (e) {
        // exit 124 = `timeout` command killed it (agent too slow)
        // exit 137 = OOM killed
        // e.killed = Node's own timeout fired
        if (e.killed || e.signal === 'SIGTERM' || e.status === 124) return '__TIMEOUT__';
        if (e.status === 137) return '__OOM__';
        const stderr = e.stderr?.toString().slice(0, 300) || '';
        const stdout = e.stdout?.toString().slice(0, 100) || '';
        console.error(`[CRASH] ${containerName} exit=${e.status} sig=${e.signal} stderr=${stderr.replace(/\n/g, ' | ')} stdout=${stdout.replace(/\n/g, ' | ')}`);
        return '__CRASH__';
    }
}

/**
 * Stop and remove a Docker container.
 */
function stopContainer(containerName) {
    try {
        execFileSync('docker', ['rm', '-f', containerName], {
            stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
        });
    } catch {}
}

/**
 * Play a single game between two agents in Docker containers.
 * The chess engine runs on the host for trusted move validation.
 *
 * @param {object} opts
 * @param {string} opts.matchId - Unique match identifier
 * @param {string} opts.whiteCode - White agent source code
 * @param {string} opts.whiteLang - "js" or "py"
 * @param {string} opts.whiteName - White agent name
 * @param {string} opts.blackCode - Black agent source code
 * @param {string} opts.blackLang - "js" or "py"
 * @param {string} opts.blackName - Black agent name
 * @param {number} opts.maxPlies - Max plies before draw (default 500)
 * @param {number} opts.moveTimeoutMs - Per-move timeout (default from config)
 * @returns {object} { result, reason, plies, moves, pgn }
 */
export function playGame(opts) {
    const {
        matchId = randomUUID().slice(0, 8),
        whiteCode, whiteLang = 'js', whiteName = 'White',
        blackCode, blackLang = 'js', blackName = 'Black',
        maxPlies = 500,
        moveTimeoutMs = config.agentMoveTimeoutMs,
    } = opts;

    // Start containers
    const white = startContainer(matchId, 'white', whiteCode, whiteLang);
    const black = startContainer(matchId, 'black', blackCode, blackLang);

    try {
        let pos = parseFen(STARTING_FEN);
        const positionHistory = new Map();
        const moveLog = [];

        for (let ply = 0; ply < maxPlies; ply++) {
            const fen = boardToFen(pos);
            const isWhiteTurn = pos.side === 'w';
            const agent = isWhiteTurn ? white : black;
            const container = agent.containerName;
            const agentExt = agent.ext;
            const lang = isWhiteTurn ? whiteLang : blackLang;
            const sideName = isWhiteTurn ? 'White' : 'Black';

            // Draw checks
            if (pos.halfmove >= 100) {
                return buildResult({ result: 'draw', reason: '50-move', plies: ply, moves: moveLog,
                    whiteName, blackName });
            }
            if (insufficientMaterial(pos.board)) {
                return buildResult({ result: 'draw', reason: 'insufficient', plies: ply, moves: moveLog,
                    whiteName, blackName });
            }
            const boardKey = getBoardKey(pos);
            const count = (positionHistory.get(boardKey) || 0) + 1;
            positionHistory.set(boardKey, count);
            if (count >= 3) {
                return buildResult({ result: 'draw', reason: 'threefold', plies: ply, moves: moveLog,
                    whiteName, blackName });
            }

            // Legal moves check (checkmate / stalemate)
            const legalMoves = generateLegalMoves(pos);
            if (legalMoves.length === 0) {
                if (isInCheck(pos.board, pos.side)) {
                    const winner = isWhiteTurn ? 'black' : 'white';
                    return buildResult({ result: winner, reason: 'checkmate', plies: ply, moves: moveLog,
                        whiteName, blackName });
                }
                return buildResult({ result: 'draw', reason: 'stalemate', plies: ply, moves: moveLog,
                    whiteName, blackName });
            }

            // Get move from agent — retry once on crash with fresh container
            let uci = getAgentMove(container, fen, lang, moveTimeoutMs, agentExt);

            if (uci === '__CRASH__' || uci === '__OOM__') {
                // Retry: kill container, start fresh, try again
                const agentCode = isWhiteTurn ? whiteCode : blackCode;
                stopContainer(container);
                const fresh = startContainer(matchId + 'r', isWhiteTurn ? 'white' : 'black', agentCode, lang);
                if (isWhiteTurn) { Object.assign(white, fresh); } else { Object.assign(black, fresh); }
                uci = getAgentMove(fresh.containerName, fen, lang, moveTimeoutMs, fresh.ext);
            }

            if (uci === '__TIMEOUT__') {
                const winner = isWhiteTurn ? 'black' : 'white';
                return buildResult({ result: winner, reason: 'timeout', plies: ply, moves: moveLog,
                    whiteName, blackName });
            }
            if (uci === '__CRASH__' || uci === '__OOM__') {
                const winner = isWhiteTurn ? 'black' : 'white';
                return buildResult({ result: winner, reason: uci === '__OOM__' ? 'oom' : 'crash', plies: ply, moves: moveLog,
                    whiteName, blackName });
            }

            // Validate format
            if (!MOVE_REGEX.test(uci)) {
                const winner = isWhiteTurn ? 'black' : 'white';
                return buildResult({ result: winner, reason: 'invalid_format', plies: ply, moves: moveLog,
                    whiteName, blackName });
            }

            // Validate legality
            if (!legalMoves.includes(uci)) {
                const winner = isWhiteTurn ? 'black' : 'white';
                return buildResult({ result: winner, reason: 'illegal', plies: ply, moves: moveLog,
                    whiteName, blackName });
            }

            moveLog.push(uci);
            pos = applyUciMove(pos, uci);
        }

        return buildResult({ result: 'draw', reason: 'max_plies', plies: maxPlies, moves: moveLog,
            whiteName, blackName });

    } finally {
        // Always clean up containers
        stopContainer(white.containerName);
        stopContainer(black.containerName);
    }
}

/**
 * Build a result object with PGN.
 */
function buildResult({ result, reason, plies, moves, whiteName, blackName }) {
    let pgnResult;
    if (result === 'white') pgnResult = '1-0';
    else if (result === 'black') pgnResult = '0-1';
    else pgnResult = '1/2-1/2';

    const pgn = buildPgnSync({
        whiteName,
        blackName,
        moves,
        result: pgnResult,
        reason,
    }, generateLegalMoves);

    return { result, reason, plies, moves, pgn, pgnResult };
}

export default { playGame };
