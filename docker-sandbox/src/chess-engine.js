// =============================================================================
// Chess Engine — FEN management, legal move generation, game state tracking
// Extracted and modularized from vibe-code-cup-challenge1/referee.js
// =============================================================================

const FILES = 'abcdefgh';

export function parseFen(fen) {
    const [placement, side, castling, ep, halfmove, fullmove] = fen.trim().split(/\s+/);
    const board = [];
    for (const ch of placement) {
        if (ch === '/') continue;
        if (/\d/.test(ch)) board.push(...'.'.repeat(Number(ch)));
        else board.push(ch);
    }
    return {
        board, side: side || 'w', castling: castling || '-', ep: ep || '-',
        halfmove: Number(halfmove || 0), fullmove: Number(fullmove || 1)
    };
}

export function boardToFen(pos) {
    let fen = '';
    for (let r = 0; r < 8; r++) {
        let empty = 0;
        for (let c = 0; c < 8; c++) {
            const p = pos.board[r * 8 + c];
            if (p === '.') { empty++; }
            else { if (empty) { fen += empty; empty = 0; } fen += p; }
        }
        if (empty) fen += empty;
        if (r < 7) fen += '/';
    }
    return `${fen} ${pos.side} ${pos.castling} ${pos.ep} ${pos.halfmove} ${pos.fullmove}`;
}

function colorOf(p) {
    if (!p || p === '.') return null;
    return p === p.toUpperCase() ? 'w' : 'b';
}

function opposite(s) { return s === 'w' ? 'b' : 'w'; }
function sqToIdx(sq) { return (8 - Number(sq[1])) * 8 + FILES.indexOf(sq[0]); }
function idxToSq(i) { return FILES[i % 8] + (8 - (i >> 3)); }
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

function isSquareAttacked(board, sq, by) {
    const tr = sq >> 3, tc = sq & 7;
    const pawnRow = by === 'w' ? tr + 1 : tr - 1;
    for (const dc of [-1, 1]) {
        if (inBounds(pawnRow, tc + dc)) {
            const p = board[pawnRow * 8 + tc + dc];
            if (p !== '.' && colorOf(p) === by && p.toLowerCase() === 'p') return true;
        }
    }
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const nr = tr + dr, nc = tc + dc;
        if (inBounds(nr, nc)) {
            const p = board[nr * 8 + nc];
            if (p !== '.' && colorOf(p) === by && p.toLowerCase() === 'n') return true;
        }
    }
    for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
        let r = tr + dr, c = tc + dc;
        while (inBounds(r, c)) {
            const p = board[r * 8 + c];
            if (p !== '.') { if (colorOf(p) === by && (p.toLowerCase() === 'b' || p.toLowerCase() === 'q')) return true; break; }
            r += dr; c += dc;
        }
    }
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        let r = tr + dr, c = tc + dc;
        while (inBounds(r, c)) {
            const p = board[r * 8 + c];
            if (p !== '.') { if (colorOf(p) === by && (p.toLowerCase() === 'r' || p.toLowerCase() === 'q')) return true; break; }
            r += dr; c += dc;
        }
    }
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = tr + dr, nc = tc + dc;
        if (inBounds(nr, nc)) {
            const p = board[nr * 8 + nc];
            if (p !== '.' && colorOf(p) === by && p.toLowerCase() === 'k') return true;
        }
    }
    return false;
}

function findKing(board, side) {
    const k = side === 'w' ? 'K' : 'k';
    return board.indexOf(k);
}

export function isInCheck(board, side) {
    const kSq = findKing(board, side);
    if (kSq < 0) return true;
    return isSquareAttacked(board, kSq, opposite(side));
}

export function applyUciMove(pos, uci) {
    const from = sqToIdx(uci.slice(0, 2));
    const to = sqToIdx(uci.slice(2, 4));
    const promo = uci.length > 4 ? uci[4] : null;
    const board = [...pos.board];
    const piece = board[from];
    const target = board[to];
    const side = pos.side;
    let castling = pos.castling;
    let ep = '-';
    let halfmove = pos.halfmove + 1;

    board[from] = '.';

    if (piece.toLowerCase() === 'p' && uci.slice(2, 4) === pos.ep) {
        const capSq = side === 'w' ? to + 8 : to - 8;
        board[capSq] = '.';
        halfmove = 0;
    }

    if (piece.toLowerCase() === 'k' && Math.abs(to - from) === 2) {
        if (to === 62) { board[61] = board[63]; board[63] = '.'; }
        if (to === 58) { board[59] = board[56]; board[56] = '.'; }
        if (to === 6)  { board[5] = board[7]; board[7] = '.'; }
        if (to === 2)  { board[3] = board[0]; board[0] = '.'; }
    }

    if (promo) {
        board[to] = side === 'w' ? promo.toUpperCase() : promo.toLowerCase();
        halfmove = 0;
    } else {
        board[to] = piece;
    }

    if (piece.toLowerCase() === 'p') halfmove = 0;
    if (target !== '.') halfmove = 0;

    if (piece.toLowerCase() === 'p' && Math.abs(to - from) === 16) {
        ep = idxToSq((from + to) / 2);
    }

    if (piece === 'K') castling = castling.replace(/[KQ]/g, '');
    if (piece === 'k') castling = castling.replace(/[kq]/g, '');
    if (from === 63 || to === 63) castling = castling.replace('K', '');
    if (from === 56 || to === 56) castling = castling.replace('Q', '');
    if (from === 7 || to === 7) castling = castling.replace('k', '');
    if (from === 0 || to === 0) castling = castling.replace('q', '');
    if (!castling) castling = '-';

    return {
        board, side: opposite(side), castling, ep, halfmove,
        fullmove: pos.fullmove + (side === 'b' ? 1 : 0),
    };
}

export function generateLegalMoves(pos) {
    const moves = [];
    const { board, side, castling, ep } = pos;
    const enemy = opposite(side);

    for (let i = 0; i < 64; i++) {
        const piece = board[i];
        if (piece === '.' || colorOf(piece) !== side) continue;
        const r = i >> 3, c = i & 7;
        const lower = piece.toLowerCase();

        if (lower === 'p') {
            const dir = side === 'w' ? -1 : 1;
            const startRank = side === 'w' ? 6 : 1;
            const promoRank = side === 'w' ? 0 : 7;
            const oneR = r + dir;
            if (inBounds(oneR, c) && board[oneR * 8 + c] === '.') {
                if (oneR === promoRank) for (const p of ['q','r','b','n']) moves.push(idxToSq(i) + idxToSq(oneR * 8 + c) + p);
                else {
                    moves.push(idxToSq(i) + idxToSq(oneR * 8 + c));
                    if (r === startRank) {
                        const twoR = r + dir * 2;
                        if (board[twoR * 8 + c] === '.') moves.push(idxToSq(i) + idxToSq(twoR * 8 + c));
                    }
                }
            }
            for (const dc of [-1, 1]) {
                const nr = r + dir, nc = c + dc;
                if (!inBounds(nr, nc)) continue;
                const to = nr * 8 + nc;
                const toSq = idxToSq(to);
                if ((board[to] !== '.' && colorOf(board[to]) === enemy) || toSq === ep) {
                    if (nr === promoRank) for (const p of ['q','r','b','n']) moves.push(idxToSq(i) + toSq + p);
                    else moves.push(idxToSq(i) + toSq);
                }
            }
        } else if (lower === 'n') {
            for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
                const nr = r + dr, nc = c + dc;
                if (!inBounds(nr, nc)) continue;
                const t = board[nr * 8 + nc];
                if (t === '.' || colorOf(t) === enemy) moves.push(idxToSq(i) + idxToSq(nr * 8 + nc));
            }
        } else if (lower === 'k') {
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = r + dr, nc = c + dc;
                if (!inBounds(nr, nc)) continue;
                const t = board[nr * 8 + nc];
                if (t === '.' || colorOf(t) === enemy) moves.push(idxToSq(i) + idxToSq(nr * 8 + nc));
            }
            const kSq = side === 'w' ? 60 : 4;
            if (i === kSq) {
                if (side === 'w') {
                    if (castling.includes('K') && board[61]==='.' && board[62]==='.' && board[63]==='R'
                        && !isInCheck(board, side) && !isSquareAttacked(board, 61, enemy) && !isSquareAttacked(board, 62, enemy))
                        moves.push('e1g1');
                    if (castling.includes('Q') && board[59]==='.' && board[58]==='.' && board[57]==='.' && board[56]==='R'
                        && !isInCheck(board, side) && !isSquareAttacked(board, 59, enemy) && !isSquareAttacked(board, 58, enemy))
                        moves.push('e1c1');
                } else {
                    if (castling.includes('k') && board[5]==='.' && board[6]==='.' && board[7]==='r'
                        && !isInCheck(board, side) && !isSquareAttacked(board, 4, enemy) && !isSquareAttacked(board, 5, enemy) && !isSquareAttacked(board, 6, enemy))
                        moves.push('e8g8');
                    if (castling.includes('q') && board[3]==='.' && board[2]==='.' && board[1]==='.' && board[0]==='r'
                        && !isInCheck(board, side) && !isSquareAttacked(board, 4, enemy) && !isSquareAttacked(board, 3, enemy) && !isSquareAttacked(board, 2, enemy))
                        moves.push('e8c8');
                }
            }
        } else {
            const dirs = lower === 'b' ? [[-1,-1],[-1,1],[1,-1],[1,1]]
                       : lower === 'r' ? [[-1,0],[1,0],[0,-1],[0,1]]
                       : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
            for (const [dr, dc] of dirs) {
                let nr = r + dr, nc = c + dc;
                while (inBounds(nr, nc)) {
                    const t = board[nr * 8 + nc];
                    if (t === '.') { moves.push(idxToSq(i) + idxToSq(nr * 8 + nc)); }
                    else { if (colorOf(t) === enemy) moves.push(idxToSq(i) + idxToSq(nr * 8 + nc)); break; }
                    nr += dr; nc += dc;
                }
            }
        }
    }

    return moves.filter(uci => {
        const next = applyUciMove(pos, uci);
        return !isInCheck(next.board, side);
    });
}

export function getBoardKey(pos) {
    return pos.board.join('') + pos.side + pos.castling + pos.ep;
}

export function insufficientMaterial(board) {
    const pieces = board.filter(p => p !== '.');
    if (pieces.length === 2) return true;
    if (pieces.length === 3) {
        const minor = pieces.find(p => p.toLowerCase() === 'b' || p.toLowerCase() === 'n');
        if (minor) return true;
    }
    if (pieces.length === 4) {
        const bishops = pieces.filter(p => p.toLowerCase() === 'b');
        if (bishops.length === 2) {
            const bSqs = [];
            for (let i = 0; i < 64; i++) if (board[i].toLowerCase() === 'b') bSqs.push(i);
            if (bSqs.length === 2) {
                const c1 = ((bSqs[0] >> 3) + (bSqs[0] & 7)) % 2;
                const c2 = ((bSqs[1] >> 3) + (bSqs[1] & 7)) % 2;
                if (c1 === c2) return true;
            }
        }
    }
    return false;
}

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
