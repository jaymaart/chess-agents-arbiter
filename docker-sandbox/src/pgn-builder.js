// =============================================================================
// PGN Builder — converts match results to standard PGN format
// =============================================================================

import { parseFen, applyUciMove, boardToFen, isInCheck } from './chess-engine.js';

const FILES = 'abcdefgh';
const PIECE_NAMES = { p: '', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };

/**
 * Convert a UCI move to SAN (Standard Algebraic Notation).
 * Requires the position BEFORE the move is made.
 */
function uciToSan(pos, uci, legalMoves) {
    const from = (8 - Number(uci[1])) * 8 + FILES.indexOf(uci[0]);
    const to = (8 - Number(uci[3])) * 8 + FILES.indexOf(uci[2]);
    const promo = uci.length > 4 ? uci[4] : null;
    const piece = pos.board[from];
    const target = pos.board[to];
    const lower = piece.toLowerCase();

    // Castling
    if (lower === 'k' && Math.abs(to - from) === 2) {
        const san = to > from ? 'O-O' : 'O-O-O';
        const after = applyUciMove(pos, uci);
        if (isInCheck(after.board, after.side)) return san + '+';
        return san;
    }

    let san = '';

    if (lower === 'p') {
        // Pawn moves
        if (FILES.indexOf(uci[0]) !== FILES.indexOf(uci[2]) || target !== '.') {
            san += uci[0]; // file for captures
        }
        if (target !== '.' || uci.slice(2, 4) === pos.ep) {
            san += 'x';
        }
        san += uci.slice(2, 4);
        if (promo) {
            san += '=' + promo.toUpperCase();
        }
    } else {
        san += PIECE_NAMES[lower];

        // Disambiguation: check if other pieces of same type can go to same square
        const others = legalMoves.filter(m => {
            if (m === uci) return false;
            const mFrom = (8 - Number(m[1])) * 8 + FILES.indexOf(m[0]);
            const mTo = (8 - Number(m[3])) * 8 + FILES.indexOf(m[2]);
            return mTo === to && pos.board[mFrom].toLowerCase() === lower;
        });

        if (others.length > 0) {
            const sameFile = others.some(m => m[0] === uci[0]);
            const sameRank = others.some(m => m[1] === uci[1]);
            if (!sameFile) san += uci[0]; // file
            else if (!sameRank) san += uci[1]; // rank
            else san += uci.slice(0, 2); // both
        }

        if (target !== '.') san += 'x';
        san += uci.slice(2, 4);
    }

    // Check/checkmate detection
    const after = applyUciMove(pos, uci);
    if (isInCheck(after.board, after.side)) {
        san += '+'; // simplified: always + (# would need legal move check)
    }

    return san;
}

/**
 * Build a PGN string from match data.
 * @param {object} opts
 * @param {string} opts.whiteName - White player name
 * @param {string} opts.blackName - Black player name
 * @param {string[]} opts.moves - Array of UCI moves
 * @param {string} opts.result - "1-0", "0-1", or "1/2-1/2"
 * @param {string} opts.reason - termination reason
 * @param {string} opts.event - event name
 * @param {string} opts.date - date string
 * @param {Function} generateLegalMovesFn - legal move generator for SAN disambiguation
 * @returns {string} PGN string
 */
export function buildPgnSync({ whiteName, blackName, moves, result, reason, event, date }, generateLegalMovesFn) {
    const headers = [
        `[Event "${event || 'ChessAgents Arena'}"]`,
        `[Site "Docker Sandbox"]`,
        `[Date "${date || new Date().toISOString().slice(0, 10).replace(/-/g, '.')}"]`,
        `[White "${whiteName || 'White'}"]`,
        `[Black "${blackName || 'Black'}"]`,
        `[Result "${result}"]`,
    ];
    if (reason) headers.push(`[Termination "${reason}"]`);

    let pos = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const sanMoves = [];

    for (const uci of moves) {
        const legalMoves = generateLegalMovesFn(pos);
        const san = uciToSan(pos, uci, legalMoves);
        sanMoves.push(san);
        pos = applyUciMove(pos, uci);
    }

    let moveText = '';
    for (let i = 0; i < sanMoves.length; i++) {
        if (i % 2 === 0) moveText += `${Math.floor(i / 2) + 1}. `;
        moveText += sanMoves[i] + ' ';
    }
    moveText += result;

    // Standard PGN: headers, blank line, movetext+result, blank line
    // No extra newlines — the double-newline after result is the game terminator
    return headers.join('\n') + '\n\n' + moveText.trim() + '\n';
}
