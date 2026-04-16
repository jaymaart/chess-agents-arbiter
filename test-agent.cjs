const fen = require('fs').readFileSync(0, 'utf8').trim();
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
  const p = board[i];
  if (p === '.') continue;
  const isWhite = p === p.toUpperCase();
  if ((side === 'w') !== isWhite) continue;
  const r = Math.floor(i / 8), c = i % 8;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
      const t = board[nr * 8 + nc];
      if (t === '.' || (t === t.toUpperCase()) !== isWhite) moves.push(sq(i) + sq(nr * 8 + nc));
    }
  }
}
let h = 0;
for (const ch of fen) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
process.stdout.write((moves[Math.abs(h) % Math.max(1, moves.length)] || '0000') + '\n');
