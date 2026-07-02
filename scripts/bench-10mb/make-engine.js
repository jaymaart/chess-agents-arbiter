// Generates a synthetic ~10MB engine for arbiter timing tests. It embeds a
// "net" as a base64 STRING (parse-cheap; a giant array literal would be slow to
// load), decodes it ONCE at boot, and does a light pass over it per move to
// simulate inference and keep it resident.
//
// This is a TIMING fixture, not a legal player — the bench feeds it FENs and
// measures response time; it doesn't play a real game.
//
//   node make-engine.js [targetFileMB=9.8]
//
const fs = require("fs");
const path = require("path");

const targetFileMB = Number(process.argv[2] || 9.8);
const b64Bytes = Math.max(1024, Math.floor(targetFileMB * 1024 * 1024) - 400);
const decodedLen = Math.floor((b64Bytes * 3) / 4);

const buf = Buffer.alloc(decodedLen);
for (let i = 0; i < decodedLen; i++) buf[i] = (i * 131 + 7) & 0xff; // deterministic fill
const b64 = buf.toString("base64");

const engine = `// AUTO-GENERATED synthetic engine (timing fixture). Do not submit as a real
// entry — it does not play legal chess. Embedded net is loaded once at boot.
const NET_B64 = ${JSON.stringify(b64)};
const net = Buffer.from(NET_B64, "base64"); // decode once, at boot
const readline = require("readline");
readline.createInterface({ input: process.stdin }).on("line", () => {
  // Touch the whole net so it stays resident and isn't optimized away — stands
  // in for a per-move net evaluation.
  let acc = 0;
  for (let i = 0; i < net.length; i += 512) acc = (acc + net[i]) & 0xffff;
  process.stdout.write((acc & 1 ? "e2e4" : "d2d4") + "\\n");
});
`;

const out = path.join(__dirname, "engine-10mb.js");
fs.writeFileSync(out, engine);
console.log(`wrote ${out} — ${(fs.statSync(out).size / 1048576).toFixed(2)}MB file (net ${(decodedLen / 1048576).toFixed(2)}MB decoded)`);
