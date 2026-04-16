// =============================================================================
// Quick test — run a game between two simple agents in Docker sandbox
// =============================================================================

import { playGame } from '../src/sandboxed-referee.js';

// Simple random-move JS agent
const RANDOM_JS = `
import { readFileSync } from 'node:fs';
const fen = readFileSync(0, 'utf8').trim();
const FILES = 'abcdefgh';
function parseFen(f) {
  const [pl, side, ca, ep] = f.split(' ');
  const board = [];
  for (const ch of pl) { if (ch==='/') continue; if (ch>='1'&&ch<='8') for(let i=0;i<+ch;i++) board.push('.'); else board.push(ch); }
  return { board, side, castling: ca, ep };
}
function colorOf(p) { return p==='.'?null:p===p.toUpperCase()?'w':'b'; }
function inBounds(r,c) { return r>=0&&r<8&&c>=0&&c<8; }
function sqToIdx(sq) { return (8-+sq[1])*8+FILES.indexOf(sq[0]); }
function idxToSq(i) { return FILES[i%8]+(8-(i>>3)); }
function genMoves(pos) {
  const moves=[], {board,side,ep}=pos, enemy=side==='w'?'b':'w';
  for(let i=0;i<64;i++){
    const p=board[i]; if(p==='.'||colorOf(p)!==side) continue;
    const r=i>>3,c=i&7,lo=p.toLowerCase();
    if(lo==='p'){const dir=side==='w'?-1:1,nr=r+dir;
      if(inBounds(nr,c)&&board[nr*8+c]==='.') moves.push(idxToSq(i)+idxToSq(nr*8+c));
      for(const dc of [-1,1]){const nc=c+dc;if(!inBounds(nr,nc))continue;const to=nr*8+nc,toSq=idxToSq(to);
        if((board[to]!=='.'&&colorOf(board[to])===enemy)||toSq===ep) moves.push(idxToSq(i)+toSq);}
    } else if(lo==='n'){for(const[dr,dc]of[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]){
      const nr=r+dr,nc=c+dc;if(!inBounds(nr,nc))continue;const t=board[nr*8+nc];
      if(t==='.'||colorOf(t)===enemy) moves.push(idxToSq(i)+idxToSq(nr*8+nc));}
    } else if(lo==='k'){for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      if(!dr&&!dc)continue;const nr=r+dr,nc=c+dc;if(!inBounds(nr,nc))continue;const t=board[nr*8+nc];
      if(t==='.'||colorOf(t)===enemy) moves.push(idxToSq(i)+idxToSq(nr*8+nc));}
    } else {const dirs=lo==='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:lo==='r'?[[-1,0],[1,0],[0,-1],[0,1]]
      :[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for(const[dr,dc]of dirs){let nr=r+dr,nc=c+dc;while(inBounds(nr,nc)){const t=board[nr*8+nc];
        if(t==='.'){moves.push(idxToSq(i)+idxToSq(nr*8+nc));}else{if(colorOf(t)===enemy)moves.push(idxToSq(i)+idxToSq(nr*8+nc));break;}
        nr+=dr;nc+=dc;}}}
  }
  return moves;
}
const pos = parseFen(fen);
const moves = genMoves(pos);
// Simple hash for determinism
let hash = 0; for(const ch of fen) hash = ((hash<<5)-hash+ch.charCodeAt(0))|0;
const move = moves.length > 0 ? moves[Math.abs(hash) % moves.length] : '0000';
process.stdout.write(move + '\\n');
`;

console.log('=== Testing Sandboxed Referee ===');
console.log('Running a game between two random JS agents in Docker...\n');

const start = Date.now();
const result = playGame({
    matchId: 'test-001',
    whiteCode: RANDOM_JS,
    whiteLang: 'js',
    whiteName: 'RandomWhite',
    blackCode: RANDOM_JS,
    blackLang: 'js',
    blackName: 'RandomBlack',
    maxPlies: 100,
});
const elapsed = Date.now() - start;

console.log(`Result: ${result.pgnResult} (${result.reason})`);
console.log(`Plies: ${result.plies}`);
console.log(`Time: ${elapsed}ms`);
console.log(`\nPGN:\n${result.pgn}`);
