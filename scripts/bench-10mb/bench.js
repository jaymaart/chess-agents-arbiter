// Measures per-move timing of the synthetic 10MB engine under both models:
//   PERSISTENT (arbiter now) — one process, fed FEN after FEN (net loads once)
//   ONE-SHOT   (old model)   — a fresh process per move (net reloads every move)
//
// Run on the ARBITER host to get real hardware numbers:
//   node make-engine.js 9.8    # generate engine-10mb.js
//   node bench.js              # compare the two models
//
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "engine-10mb.js");
if (!fs.existsSync(ENGINE)) {
  console.error("engine-10mb.js not found — run `node make-engine.js` first.");
  process.exit(1);
}

// A handful of distinct positions to feed. Legality is irrelevant (timing only).
const FENS = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2",
  "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
  "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4",
  "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5",
  "r2q1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P1b1/2NP1N2/PPP2PPP/R2Q1RK1 w - - 8 8",
  "r4rk1/ppp1qppp/2np1n2/2b1p1B1/2B1P1b1/2NPQN2/PPP2PPP/R4RK1 b - - 12 10",
  "2r2rk1/pp2qppp/2np1n2/2b1p1B1/2B1P1b1/2NPQN2/PPP2PPP/2R2RK1 w - - 16 12",
  "2r2rk1/pp2qppp/3p1n2/2bpp1B1/2B1P1b1/2NPQN2/PPP2PPP/2R2RK1 w - d6 0 14",
];

const now = () => Number(process.hrtime.bigint()) / 1e6;

function readOneMove(child) {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) { child.stdout.off("data", onData); resolve(buf.slice(0, nl).trim()); }
    };
    child.stdout.on("data", onData);
  });
}

async function benchPersistent(rounds) {
  const child = spawn("node", [ENGINE], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  child.stdin.on("error", () => {});
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const fen = FENS[i % FENS.length];
    const t = now();
    child.stdin.write(fen + "\n");
    await readOneMove(child);
    times.push(now() - t);
  }
  child.kill();
  return times;
}

async function benchOneShot(rounds) {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const fen = FENS[i % FENS.length];
    const t = now();
    await new Promise((resolve) => {
      const child = spawn("node", [ENGINE], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
      child.stdin.on("error", () => {});
      readOneMove(child).then(() => { child.kill(); resolve(); });
      child.stdin.write(fen + "\n");
    });
    times.push(now() - t);
  }
  return times;
}

const stats = (a) => {
  const rest = a.slice(1);
  const avg = rest.reduce((s, x) => s + x, 0) / rest.length;
  return `first=${a[0].toFixed(0)}ms  steady[min/avg/max]=${Math.min(...rest).toFixed(0)}/${avg.toFixed(0)}/${Math.max(...rest).toFixed(0)}ms`;
};

(async () => {
  const ROUNDS = Number(process.argv[2] || 30);
  const sizeMb = (fs.statSync(ENGINE).size / 1048576).toFixed(2);
  console.log(`engine: ${sizeMb}MB, ${ROUNDS} moves\n`);
  const p = await benchPersistent(ROUNDS);
  const o = await benchOneShot(ROUNDS);
  console.log("PERSISTENT (arbiter now):", stats(p));
  console.log("ONE-SHOT   (old model):  ", stats(o));
  const pSteady = p.slice(1).reduce((s, x) => s + x, 0) / (p.length - 1);
  const oSteady = o.slice(1).reduce((s, x) => s + x, 0) / (o.length - 1);
  console.log(`\nSteady-state speedup: ${(oSteady / pSteady).toFixed(1)}x  (persistent loads the ${sizeMb}MB once; one-shot reloads it every move).`);
})();
