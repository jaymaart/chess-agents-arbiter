import { spawn, ChildProcess, execFileSync, spawnSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import { Chess } from "chess.js";

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
  language: "js" | "py";
  name: string;
}

const UCI_MOVE_REGEX = /[a-h][1-8][a-h][1-8][qrbn]?/;
const MAX_PLIES = 500;
const DOCKER_SANDBOX = process.env.DOCKER_SANDBOX === "true";
const MOVE_TIMEOUT_MS = parseInt(
  process.env.MOVE_TIMEOUT_MS || (DOCKER_SANDBOX ? "15000" : "20000"),
  10
);
// First move needs extra headroom for process/container cold start, interpreter
// boot, and agent-side imports (e.g. `import chess` in Python) — plus, for large
// engines, loading the net/tables once. Without this, engines regularly "time
// out on move 1" before they've actually started thinking.
const FIRST_MOVE_TIMEOUT_MS = parseInt(
  process.env.FIRST_MOVE_TIMEOUT_MS || String(Math.max(MOVE_TIMEOUT_MS * 3, 45000)),
  10
);
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "agentchess-sandbox:latest";
const AGENT_MEMORY_LIMIT = process.env.AGENT_MEMORY_LIMIT || "256m";

// On Windows, `python3` is not a default alias — only `python` or `py`.
// On macOS/Linux, `python3` is the canonical name.
const PYTHON_CMD = process.platform === "win32" ? "python" : "python3";

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

abstract class PersistentController {
  protected child: ChildProcess | null = null;
  protected dead = true;
  private stdoutBuf = "";
  protected stderrBuf = "";
  private pending: { resolve: (m: string) => void; reject: (e: Error) => void } | null = null;

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
    child.stdout?.on("data", (d: Buffer) => { this.stdoutBuf += d.toString(); this.scan(); });
    child.stderr?.on("data", (d: Buffer) => { this.stderrBuf += d.toString(); });
    child.on("error", (err) => {
      this.dead = true;
      this.child = null;
      this.rejectPending(new Error(`engine error: ${err.message}`));
    });
    child.on("exit", () => { this.dead = true; });
    // Settle on "close" (after stdout fully drains), not "exit": a move printed
    // immediately before exit can otherwise be missed (exit races the data).
    child.on("close", (code) => {
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

  /** Ask the engine for its move in `fen`. The process persists between calls; a
   *  one-shot engine that exited last move is respawned first. */
  async getMove(fen: string, timeoutMs: number = MOVE_TIMEOUT_MS): Promise<string> {
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
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          const details = this.stderrBuf.trim().slice(0, 500) || this.stdoutBuf.trim().slice(0, 500);
          reject(new Error(details ? `move timeout (${timeoutMs}ms): ${details}` : `move timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      this.pending = {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };

      try { child.stdin?.write(fen + "\n"); } catch { /* settled by close / timeout */ }
      this.scan(); // in case output was buffered before the request registered
    });
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
  constructor(private config: AgentConfig) { super(); }

  protected spawnChild(): ChildProcess {
    const runtime = this.config.language === "js" ? "node" : PYTHON_CMD;
    // Pass full process.env — on Windows, node.exe requires SYSTEMROOT (and other
    // vars) to initialize; stripping to just PATH caused subprocesses to exit
    // with code 1 before producing any output.
    return spawn(runtime, [this.config.path], {
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
    // python3 inside the Linux sandbox image (not the host PYTHON_CMD).
    const runtime = this.config.language === "js" ? "node" : "python3";
    return spawn("docker", [
      "exec", "-i", this.containerName,
      runtime, this.agentPathInContainer,
    ], { stdio: ["pipe", "pipe", "pipe"] });
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

  const makeController = (agent: AgentConfig, side: string) =>
    DOCKER_SANDBOX
      ? new DockerEngineController(agent, matchId || "unknown", `${side}-r${round}`)
      : new EngineController(agent);

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
        move = await currentController.getMove(fen, budgetMs);
      } catch (err: any) {
        // Failsafe: if the *first* move for this side fails, retry once with the
        // same (generous) budget. Cold-start flakiness shouldn't forfeit on move 1.
        if (isFirstMoveForSide) {
          console.warn(`  First-move failure for ${side === "w" ? "white" : "black"} (${err?.message || "unknown"}) — retrying once`);
          try {
            move = await currentController.getMove(fen, budgetMs);
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
  const pgnTag = (s: string) => (s ?? "").replace(/[\\"]/g, "").replace(/[\r\n\t]+/g, " ").trim();
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
