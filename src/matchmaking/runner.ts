import { spawn, ChildProcess, execFileSync, spawnSync } from "child_process";
import { readFileSync, statSync } from "fs";
import path from "path";
import { Chess } from "chess.js";
import { compileEngine, isCompiledLanguage, CompiledLanguage } from "../validation/compile";
import type { EngineLanguage } from "../validation/filetype";

export interface MatchResult {
  games: GameResult[];
  pgn: string;
}

export interface LiveMoveEvent {
  fen: string;
  move: string;
  ply: number;
  gameIndex: number;
}

export interface GameResult {
  round: number;
  white: string;
  black: string;
  result: "1-0" | "0-1" | "1/2-1/2";
  termination: string;
  pgn: string;
}

export interface AgentConfig {
  path: string;
  language: EngineLanguage;
  name: string;
}

const UCI_MOVE_REGEX = /[a-h][1-8][a-h][1-8][qrbn]?/;
const MAX_PLIES = 500;
const DOCKER_SANDBOX = process.env.DOCKER_SANDBOX === "true";
// Per-move budget. Time control is 5+0.1, so the real move budget is 5s.
// (The old 15s/20s was headroom for obfuscated engines — obfuscation was
// removed in Season 2, so engines run at native speed and 5s applies again.)
const MOVE_TIMEOUT_MS = parseInt(
  process.env.MOVE_TIMEOUT_MS || "5000",
  10
);
// First move keeps extra headroom for process/container cold start, interpreter
// boot, and agent-side imports (e.g. `import chess` in Python) — plus, for
// large engines, loading the net/tables once per game. This is startup cost,
// NOT thinking time. Without it, engines "time out on move 1" before starting.
const FIRST_MOVE_TIMEOUT_MS = parseInt(
  process.env.FIRST_MOVE_TIMEOUT_MS || String(Math.max(MOVE_TIMEOUT_MS * 3, 15000)),
  10
);
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "agentchess-sandbox:latest";
const AGENT_MEMORY_LIMIT = process.env.AGENT_MEMORY_LIMIT || "256m";

// On Windows, `python3` is not a default alias — only `python` or `py`.
// On macOS/Linux, `python3` is the canonical name.
const PYTHON_CMD = process.platform === "win32" ? "python" : "python3";

// ---------------------------------------------------------------------------
// JS engine runtime — Deno by default (Season 3+).
//
// `deno run --no-prompt` is deny-by-default: the engine gets no filesystem,
// network, env, or subprocess access at the RUNTIME level, on top of the
// static-analysis gate and the OS/container sandbox. Engines are plain
// stdin/stdout CJS/ESM (broker-runner already writes .cjs/.mjs), and Deno's
// Node compat covers the allowed surface (readline, process.stdin/stdout).
//
// JS_RUNTIME=node|deno overrides. Unset → auto: use deno when the binary is
// present, else fall back to node with a warning (older bare-mode hosts).
// ---------------------------------------------------------------------------
const JS_RUNTIME_ENV = process.env.JS_RUNTIME;
let cachedJsRuntime: "deno" | "node" | null = null;

function resolveJsRuntime(): "deno" | "node" {
  if (cachedJsRuntime) return cachedJsRuntime;
  if (JS_RUNTIME_ENV === "node" || JS_RUNTIME_ENV === "deno") {
    cachedJsRuntime = JS_RUNTIME_ENV;
  } else {
    try {
      execFileSync("deno", ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
        shell: process.platform === "win32",
      });
      cachedJsRuntime = "deno";
    } catch {
      cachedJsRuntime = "node";
      console.warn(
        "[runner] deno not found on host — JS engines fall back to node (no runtime permission sandbox). Install deno or set JS_RUNTIME=node to silence."
      );
    }
  }
  console.log(`[runner] JS engine runtime: ${cachedJsRuntime}${JS_RUNTIME_ENV ? "" : " (auto)"}`);
  return cachedJsRuntime;
}

// --no-remote: remote (https) imports can never load, even if one slipped past
// the static gate. --quiet keeps deno's own diagnostics off the UCI streams.
const DENO_RUN_ARGS = ["run", "--no-prompt", "--no-remote", "--quiet"];

function jsSpawnSpec(scriptPath: string): { cmd: string; args: string[] } {
  return resolveJsRuntime() === "deno"
    ? { cmd: "deno", args: [...DENO_RUN_ARGS, scriptPath] }
    : { cmd: "node", args: [scriptPath] };
}

// ---------------------------------------------------------------------------
// Compiled (native) engine runtime — cpp/c/rust (Season 3+).
//
// Submitters upload SOURCE; we compile it to a STATICALLY linked binary (cached
// by source hash, see compile.ts) and run that binary under the seccomp launcher
// (sandbox/engine-jail.c). Native code can evade source analysis, so seccomp is
// the real OS-level boundary — and it needs no privileges/namespaces, so it
// works in the unprivileged arbiter container where docker/unshare may not.
// ENGINE_JAIL=none runs the binary bare (local dev only).
// ---------------------------------------------------------------------------
function nativeSpawnSpec(sourcePath: string, language: CompiledLanguage): { cmd: string; args: string[] } {
  const c = compileEngine(sourcePath, language);
  if (!c.ok || !c.binaryPath) throw new Error(c.error || "Compilation failed.");
  if ((process.env.ENGINE_JAIL || "").toLowerCase() === "none") {
    // Fail closed: a stray env var must never silently run untrusted native
    // code without the seccomp boundary in a real deployment.
    if (process.env.NODE_ENV === "production") {
      throw new Error("ENGINE_JAIL=none (unsandboxed native execution) is refused in production.");
    }
    return { cmd: c.binaryPath, args: [] }; // UNSANDBOXED — dev only
  }
  return { cmd: process.env.ENGINE_JAIL || "engine-jail", args: [c.binaryPath] };
}

/**
 * Command + args to boot an engine from its SOURCE path + language: interpreted
 * → interpreter (js→deno/node, py→python); compiled → compile (cached) to a
 * static binary run under the seccomp jail. Throws on a failed compile — boot()
 * surfaces it as an engine error, scoring the game against this engine.
 */
function spawnSpecFor(language: EngineLanguage, sourcePath: string): { cmd: string; args: string[] } {
  if (language === "js") return jsSpawnSpec(sourcePath);
  if (language === "py") return { cmd: PYTHON_CMD, args: [sourcePath] };
  return nativeSpawnSpec(sourcePath, language);
}

// ---------------------------------------------------------------------------
// Persistent engine controller
//
// The engine process is booted ONCE and kept alive for the whole game: it gets
// one FEN per move on stdin and replies with one move on stdout, so it loads its
// net / tables once per game instead of once per move. Backward-compatible with
// one-shot engines (that exit after printing a move) — they're transparently
// respawned for the next move. Subclasses supply how the child is spawned (bare
// subprocess vs. docker exec).
// ---------------------------------------------------------------------------

// What we feed the engine on stdin each move: the current FEN, optionally
// followed by the full game history in UCI — "<fen> moves e2e4 e7e5 ...".
// Mirrors UCI's `position fen <FEN> moves ...`. A bare FEN carries no history,
// so an engine can't see a threefold repetition coming; the move list lets it.
// Engines that only read the 6 FEN fields can ignore the trailing tokens.
function engineInputLine(fen: string, history: string[]): string {
  return history.length ? `${fen} moves ${history.join(" ")}` : fen;
}

// chess.js move result → UCI (e.g. {from:"e7",to:"e8",promotion:"q"} → "e7e8q").
function moveToUci(m: { from: string; to: string; promotion?: string }): string {
  return `${m.from}${m.to}${m.promotion ?? ""}`;
}

abstract class PersistentController {
  protected child: ChildProcess | null = null;
  protected dead = true;
  private stdoutBuf = "";
  protected stderrBuf = "";
  private pending: { resolve: (m: string) => void; reject: (e: Error) => void } | null = null;
  /** Legacy one-shot compatibility: some agents read stdin to EOF (e.g.
   *  readFileSync(0)) and hang forever on a persistent pipe. When set, stdin is
   *  closed after each FEN — the engine exits after its move and the normal
   *  respawn path boots it fresh next move. Flipped by the first-move retry. */
  legacyEof = false;

  /** Spawn the engine child with piped stdio. Called on (re)boot. */
  protected abstract spawnChild(): ChildProcess;
  /** Optional setup before the first spawn (e.g. start a container + write code). */
  protected prepare(): void {}

  protected boot(): void {
    if (this.child && !this.dead) return;
    this.prepare();
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.dead = false;
    const child = this.spawnChild();
    this.child = child;

    // Writing a FEN to a one-shot engine that already exited surfaces as an async
    // EPIPE on stdin — swallow it; the close handler decides the move's fate.
    child.stdin?.on("error", () => { /* broken pipe on a dead engine */ });
    // GENERATION GUARD: every handler checks it still owns the current child.
    // A killed child's exit/close events fire asynchronously — possibly after a
    // retry has already booted a replacement — and must not clobber the new
    // generation's state or reject its pending move.
    child.stdout?.on("data", (d: Buffer) => {
      if (this.child !== child) return;
      this.stdoutBuf += d.toString(); this.scan();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (this.child !== child) return;
      this.stderrBuf += d.toString();
    });
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.dead = true;
      this.child = null;
      this.rejectPending(new Error(`engine error: ${err.message}`));
    });
    child.on("exit", () => { if (this.child === child) this.dead = true; });
    // Settle on "close" (after stdout fully drains), not "exit": a move printed
    // immediately before exit can otherwise be missed (exit races the data).
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.dead = true;
      this.child = null;
      this.scan();
      if (this.pending) {
        const details = this.stderrBuf.trim().slice(0, 500) || this.stdoutBuf.trim().slice(0, 500) || "(no output)";
        this.rejectPending(new Error(`engine exited with code ${code} without a valid move: ${details}`));
      }
    });
  }

  // Resolve the pending request from the first completed stdout line holding a
  // UCI move (one move per FEN); non-move lines are ignored.
  private scan(): void {
    if (!this.pending) return;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      const m = line.match(UCI_MOVE_REGEX);
      if (m) { this.resolvePending(m[0]); return; }
    }
    if (this.dead) {
      const m = this.stdoutBuf.match(UCI_MOVE_REGEX);
      if (m) this.resolvePending(m[0]);
    }
  }

  private resolvePending(move: string): void { const p = this.pending; this.pending = null; p?.resolve(move); }
  private rejectPending(err: Error): void { const p = this.pending; this.pending = null; p?.reject(err); }

  /** Ask the engine for its move in `fen` (+ UCI history for repetition
   *  detection). The process persists between calls; a one-shot engine that
   *  exited last move is respawned first. */
  async getMove(fen: string, timeoutMs: number = MOVE_TIMEOUT_MS, history: string[] = []): Promise<string> {
    if (!this.child || this.dead) this.boot();
    const child = this.child!;

    // Fresh buffers so this move is strictly the response to THIS position — a
    // persistent process must not answer from stale buffered output.
    this.stdoutBuf = "";
    this.stderrBuf = "";

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          this.dead = true;
          this.child = null;
          this.onTimeoutKill(child);
          const details = this.stderrBuf.trim().slice(0, 500) || this.stdoutBuf.trim().slice(0, 500);
          reject(new Error(details ? `move timeout (${timeoutMs}ms): ${details}` : `move timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      this.pending = {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };

      try {
        child.stdin?.write(engineInputLine(fen, history) + "\n");
        if (this.legacyEof) child.stdin?.end();
      } catch { /* settled by close / timeout */ }
      this.scan(); // in case output was buffered before the request registered
    });
  }

  /** Kill the engine after a move timeout. Base: SIGKILL the child. Docker
   *  overrides this — killing the `docker exec` client does NOT kill the
   *  process inside the container, so it also tears the container down. */
  protected onTimeoutKill(child: ChildProcess): void {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }

  abstract stop(): void;

  protected killChild(): void {
    this.pending = null;
    if (this.child && !this.dead) { try { this.child.kill(); } catch { /* ignore */ } }
    this.child = null;
    this.dead = true;
  }
}

// ---------------------------------------------------------------------------
// Bare subprocess controller
// ---------------------------------------------------------------------------

class EngineController extends PersistentController {
  // Resolved spawn command, memoized so a compiled engine is built once (via the
  // compile cache) rather than re-hashed on every respawn.
  private spec: { cmd: string; args: string[] } | null = null;

  constructor(private config: AgentConfig) { super(); }

  protected spawnChild(): ChildProcess {
    // js→deno/node, py→python, cpp/c/rust→compile+jail. A compile failure throws
    // here and propagates through boot()/getMove, scoring the game against it.
    if (!this.spec) this.spec = spawnSpecFor(this.config.language, this.config.path);
    const { cmd, args } = this.spec;
    // Pass full process.env — on Windows, node.exe requires SYSTEMROOT (and other
    // vars) to initialize; stripping to just PATH caused subprocesses to exit
    // with code 1 before producing any output. (Under deno --no-prompt the
    // engine can't read env anyway — the inherit is for runtime boot only.)
    return spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32", // Windows needs shell resolution for python/py
    });
  }

  stop(): void { this.killChild(); }
}

// ---------------------------------------------------------------------------
// Docker sandboxed controller
//
// One hardened container per agent per game (started with `sleep infinity`). The
// agent runs as a single long-lived `docker exec -i` process inside it, fed one
// FEN per move — so the net/tables load once per game, not once per docker-exec.
// On engine crash the exec is respawned into the same (still-running) container.
//
// Security flags: --network none, --read-only, --cap-drop ALL, memory/PID
// limits, tmpfs /tmp. Container runs as non-root (defined in the image).
// ---------------------------------------------------------------------------

class DockerEngineController extends PersistentController {
  private containerName: string;
  private config: AgentConfig;
  private containerStarted = false;
  private codeWritten = false;
  private readonly agentPathInContainer: string;

  constructor(config: AgentConfig, matchId: string, side: string) {
    super();
    this.config = config;
    // Container names: only alphanumeric, hyphens, underscores, dots allowed.
    const safeId = matchId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 16);
    this.containerName = `match-${safeId}-${side}`;
    this.agentPathInContainer = `/tmp/agent${path.extname(config.path)}`;
  }

  private startContainer(): void {
    execFileSync("docker", [
      "run", "-d",
      "--name", this.containerName,
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--memory", AGENT_MEMORY_LIMIT,
      "--cpus", "0.5",
      "--pids-limit", "32",
      "--tmpfs", "/tmp:size=10m,nodev,nosuid",
      SANDBOX_IMAGE,
      "sleep", "infinity",
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
    this.containerStarted = true;
  }

  private writeCodeToContainer(): void {
    const code = readFileSync(this.config.path);
    const result = spawnSync("docker", [
      "exec", "-i", this.containerName,
      "sh", "-c", `cat > ${this.agentPathInContainer}`,
    ], {
      input: code,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    if (result.status !== 0) {
      throw new Error(`Failed to write agent code to container: ${result.stderr?.toString().slice(0, 200)}`);
    }
    this.codeWritten = true;
  }

  // Ensure the container is up and the agent code is present before (re)spawning
  // the long-lived exec process. Both persist across moves within a game.
  protected prepare(): void {
    if (!this.containerStarted) this.startContainer();
    if (!this.codeWritten) this.writeCodeToContainer();
  }

  protected spawnChild(): ChildProcess {
    // Runtimes inside the Linux sandbox image (not the host commands). JS runs
    // under deno (deny-by-default permissions) unless JS_RUNTIME=node; the
    // sandbox image ships both. DENO_DIR points at the tmpfs because the
    // container rootfs is --read-only.
    let execArgs: string[];
    if (this.config.language === "js" && process.env.JS_RUNTIME !== "node") {
      execArgs = [
        "exec", "-i", "-e", "DENO_DIR=/tmp/.deno", this.containerName,
        "deno", ...DENO_RUN_ARGS, this.agentPathInContainer,
      ];
    } else {
      const runtime = this.config.language === "js" ? "node" : "python3";
      execArgs = ["exec", "-i", this.containerName, runtime, this.agentPathInContainer];
    }
    return spawn("docker", execArgs, { stdio: ["pipe", "pipe", "pipe"] });
  }

  // A timed-out engine keeps running INSIDE the container after the exec
  // client dies — it would burn the CPU quota alongside any retry exec. Tear
  // the container down; the next boot's prepare() recreates it fresh.
  protected onTimeoutKill(child: ChildProcess): void {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    this.stopContainer();
  }

  private stopContainer(): void {
    if (this.containerStarted) {
      try {
        execFileSync("docker", ["rm", "-f", this.containerName], {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        });
      } catch { /* ignore */ }
      this.containerStarted = false;
      this.codeWritten = false;
    }
  }

  stop(): void {
    this.killChild();
    this.stopContainer();
  }
}

// ---------------------------------------------------------------------------
// Match runner
// ---------------------------------------------------------------------------

export async function runMatch(
  agentA: AgentConfig,
  agentB: AgentConfig,
  options: {
    games: number;
    matchId?: string;
    onGameComplete?: (round: number, result: string, termination: string) => Promise<void>;
    onMove?: (event: LiveMoveEvent) => void;
  }
): Promise<MatchResult> {
  const results: GameResult[] = [];
  const allPgns: string[] = [];

  for (let round = 1; round <= options.games; round++) {
    const white = round % 2 === 1 ? agentA : agentB;
    const black = round % 2 === 1 ? agentB : agentA;

    console.log(`  Game ${round}/${options.games}: ${white.name} (W) vs ${black.name} (B)`);

    const gameResult = await runGame(white, black, round, options.matchId, options.onMove);
    results.push(gameResult);
    allPgns.push(gameResult.pgn);

    console.log(`  Result: ${gameResult.result} (${gameResult.termination})`);

    if (options.onGameComplete) {
      await options.onGameComplete(round, gameResult.result, gameResult.termination).catch((err) => {
        console.error(`Callback error for round ${round}:`, err);
      });
    }
  }

  return { games: results, pgn: allPgns.join("\n\n") };
}

async function runGame(
  white: AgentConfig,
  black: AgentConfig,
  round: number,
  matchId?: string,
  onMove?: (event: LiveMoveEvent) => void,
): Promise<GameResult> {
  const chess = new Chess();
  let termination = "normal";
  // Full game history in UCI, sent to engines each move so they can detect
  // threefold repetition (a bare FEN has none).
  const uciHistory: string[] = [];

  const makeController = (agent: AgentConfig, side: string) => {
    // Compiled engines are isolated by the seccomp launcher (engine-jail), need
    // no container, and the docker-sandbox image ships no compilers — so they
    // always run through the bare (seccomp-jailed) controller.
    if (DOCKER_SANDBOX && !isCompiledLanguage(agent.language)) {
      return new DockerEngineController(agent, matchId || "unknown", `${side}-r${round}`);
    }
    return new EngineController(agent);
  };

  const whiteController = makeController(white, "w");
  const blackController = makeController(black, "b");

  const firstMoveFired: Record<"w" | "b", boolean> = { w: false, b: false };

  try {
    while (!chess.isGameOver() && chess.moveNumber() <= MAX_PLIES) {
      const currentController = chess.turn() === "w" ? whiteController : blackController;
      const fen = chess.fen();
      const side = chess.turn() as "w" | "b";
      const isFirstMoveForSide = !firstMoveFired[side];
      const budgetMs = isFirstMoveForSide ? FIRST_MOVE_TIMEOUT_MS : MOVE_TIMEOUT_MS;

      let move: string;
      try {
        move = await currentController.getMove(fen, budgetMs, uciHistory);
      } catch (err: any) {
        // Failsafe: if the *first* move for this side fails, retry once with the
        // same (generous) budget. Cold-start flakiness shouldn't forfeit on move 1.
        // The retry runs in legacy EOF mode: agents that read stdin to EOF hang
        // on a persistent pipe, so closing stdin per move (one-shot, respawned
        // each move) gives them a working protocol instead of a forfeit.
        if (isFirstMoveForSide) {
          // A first-move TIMEOUT is the signature of an agent blocked reading
          // stdin to EOF — demote it to per-move EOF mode. A crash is just a
          // flake: retry on the persistent protocol. ONLY small engines are
          // demoted: read-to-EOF agents are tiny hand-rolled files, while a
          // large (NNUE-class) engine that barely missed the first-move window
          // must keep persistence — per-move respawn would make it reload its
          // net inside the 5s budget and lose on move 2.
          let smallEngine = true;
          try {
            const agentPath = (side === "w" ? white : black).path;
            smallEngine = statSync(agentPath).size < 1024 * 1024;
          } catch { /* size unknown → assume small */ }
          const demote = smallEngine && /timeout/i.test(err?.message || "");
          console.warn(`  First-move failure for ${side === "w" ? "white" : "black"} (${err?.message || "unknown"}) — retrying once${demote ? " in legacy EOF mode" : ""}`);
          try {
            if (demote) currentController.legacyEof = true;
            move = await currentController.getMove(fen, budgetMs, uciHistory);
          } catch (retryErr: any) {
            const loserColor = chess.turn();
            termination = retryErr?.message || err?.message || "agent error";
            return {
              round,
              white: white.name,
              black: black.name,
              result: loserColor === "w" ? "0-1" : "1-0",
              termination,
              pgn: buildPgn(chess, white.name, black.name, round, loserColor === "w" ? "0-1" : "1-0", termination),
            };
          }
        } else {
          const loserColor = chess.turn();
          termination = err.message || "agent error";
          return {
            round,
            white: white.name,
            black: black.name,
            result: loserColor === "w" ? "0-1" : "1-0",
            termination,
            pgn: buildPgn(chess, white.name, black.name, round, loserColor === "w" ? "0-1" : "1-0", termination),
          };
        }
      }

      firstMoveFired[side] = true;

      let moveResult;
      try {
        moveResult = chess.move({
          from: move.slice(0, 2),
          to: move.slice(2, 4),
          promotion: (move[4] as any) || undefined,
        });
      } catch {
        moveResult = null;
      }

      if (!moveResult) {
        const loserColor = chess.turn();
        termination = `illegal move: ${move}`;
        return {
          round,
          white: white.name,
          black: black.name,
          result: loserColor === "w" ? "0-1" : "1-0",
          termination,
          pgn: buildPgn(chess, white.name, black.name, round, loserColor === "w" ? "0-1" : "1-0", termination),
        };
      }

      // Record the played move so the next FEN ships with full game history.
      uciHistory.push(moveToUci(moveResult));

      // Fire live move event (fire-and-forget — never block gameplay)
      if (onMove) {
        try {
          onMove({ fen: chess.fen(), move, ply: chess.history().length, gameIndex: round });
        } catch { /* ignore */ }
      }
    }

    let result: "1-0" | "0-1" | "1/2-1/2";
    if (chess.isCheckmate()) {
      result = chess.turn() === "w" ? "0-1" : "1-0";
      termination = "checkmate";
    } else if (chess.isDraw()) {
      result = "1/2-1/2";
      if (chess.isStalemate()) termination = "stalemate";
      else if (chess.isThreefoldRepetition()) termination = "threefold repetition";
      else if (chess.isInsufficientMaterial()) termination = "insufficient material";
      else termination = "50-move rule";
    } else {
      result = "1/2-1/2";
      termination = "max plies reached";
    }

    return {
      round,
      white: white.name,
      black: black.name,
      result,
      termination,
      pgn: buildPgn(chess, white.name, black.name, round, result, termination),
    };
  } finally {
    whiteController.stop();
    blackController.stop();
  }
}

function buildPgn(
  chess: Chess,
  whiteName: string,
  blackName: string,
  round: number,
  result: string,
  termination: string
): string {
  // Sanitize free-text values embedded in quoted PGN header tags so a name or
  // termination string with a quote/backslash/newline can't break PGN structure.
  // PGN tag values: escape backslash + quote per spec (preserves the name
  // instead of silently dropping characters), collapse control whitespace.
  const pgnTag = (s: string | null | undefined) =>
    (s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]+/g, " ").trim();
  const headers = [
    `[Event "Chess Agents Arena"]`,
    `[Round "${round}"]`,
    `[White "${pgnTag(whiteName)}"]`,
    `[Black "${pgnTag(blackName)}"]`,
    `[Result "${result}"]`,
    `[Termination "${pgnTag(termination)}"]`,
  ];
  // chess.pgn() in chess.js v1 includes its own header block (e.g. [Result "1-0"]).
  // Strip those so the server's game-count check doesn't see duplicate [Result] tags.
  const moveText = chess.pgn().split("\n").filter(l => !l.startsWith("[")).join("\n").trim();
  return headers.join("\n") + "\n\n" + moveText + " " + result;
}
