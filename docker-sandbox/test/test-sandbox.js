// =============================================================================
// Quick test — run a game between two simple agents in Docker sandbox
// =============================================================================

import { playGame } from '../src/sandboxed-referee.js';

// Simple deterministic JS agent (CommonJS, reads FEN from stdin)
const RANDOM_JS = `const fen = require('fs').readFileSync(0, 'utf8').trim();
const FILES = 'abcdefgh';
function idx(sq) { return (8 - parseInt(sq[1])) * 8 + FILES.indexOf(sq[0]); }
function sq(i) { return FILES[i % 8] + (8 - Math.floor(i / 8)); }
const parts = fen.split(' ');
const board = [];
for (const ch of parts[0]) {
  if (ch === '/') continue;
  if (ch >= '1' && ch <= '8') { for (let i = 0; i < +ch; i++) board.push('.'); }
  else board.push(ch);
}
const side = parts[1];
const moves = [];
for (let i = 0; i < 64; i++) {
  const p = board[i]; if (p === '.') continue;
  const isWhite = p === p.toUpperCase();
  if ((side === 'w') !== isWhite) continue;
  const r = Math.floor(i / 8), c = i % 8;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
    const t = board[nr * 8 + nc];
    if (t === '.' || (t === t.toUpperCase()) !== isWhite) moves.push(sq(i) + sq(nr * 8 + nc));
  }
}
let h = 0; for (const ch of fen) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
process.stdout.write((moves[Math.abs(h) % Math.max(1, moves.length)] || '0000') + '\\n');
`;

console.log('=== Testing Sandboxed Referee ===');
console.log('Running a game between two random JS agents in Docker...\n');

const start = Date.now();
const result = await playGame({
    matchId: 'test-001',
    whiteCode: RANDOM_JS,
    whiteLang: 'js',
    whiteName: 'RandomWhite',
    blackCode: RANDOM_JS,
    blackLang: 'js',
    blackName: 'RandomBlack',
});
const elapsed = Date.now() - start;

console.log(`Result: ${result.pgnResult} (${result.reason})`);
console.log(`Plies:  ${result.plies}`);
console.log(`Time:   ${elapsed}ms`);
console.log(`\nPGN:\n${result.pgn}`);
