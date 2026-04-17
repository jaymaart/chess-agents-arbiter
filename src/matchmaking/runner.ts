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
  process.env.MOVE_TIMEOUT_MS || (DOCKER_SANDBOX ? "8000" : "15000"),
  10
);
// First move needs extra headroom for process/container cold start, interpreter
// boot, and agent-side imports (e.g. `import chess` in Python). Without this,
// engines regularly "time out on move 1" before they've actually started
// thinking.
const FIRST_MOVE_TIMEOUT_MS = parseInt(
  process.env.FIRST_MOVE_TIMEOUT_MS || String(Math.max(MOVE_TIMEOUT_MS * 3, 20000)),
  10
);
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "agentchess-sandbox:latest";
const AGENT_MEMORY_LIMIT = process.env.AGENT_MEMORY_LIMIT || "256m";

// On Windows, `python3` is not a default alias — only `python` or `py`.
// On macOS/Linux, `python3` is the canonical name.
const PYTHON_CMD = process.platform === "win32" ? "python" : "python3";

// ---------------------------------------------------------------------------
// Bare subprocess engine controller (existing behavior)
// ---------------------------------------------------------------------------

class EngineController {
  private child: ChildProcess | null = null;
  private config: AgentConfig;
  private isDead = false;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  private spawn() {
    const runtime = this.config.language === "js" ? "node" : PYTHON_CMD;
    // Pass full process.env — on Windows, node.exe requires SYSTEMROOT (and
    // other vars) to initialize. Stripping env to just PATH caused subprocesses
    // to exit with code 1 before producing any output.
    this.child = spawn(runtime, [this.config.path], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32", // Windows needs shell resolution for python/py
    });

    this.child.on("exit", () => {
      this.isDead = true;
      this.child = null;
    });
  }

  async getMove(fen: string, timeoutMs: number = MOVE_TIMEOUT_MS): Promise<string> {
    this.isDead = false;
    this.spawn();

    const child = this.child!;

    return new Promise((resolve, reject) => {
      let completed = false;
      let stdout = "";
      let stderr = "";

      const onData = (data: Buffer) => {
        stdout += data.toString();
        if (!completed && stdout.includes("\n")) {
          const lines = stdout.split("\n");
          for (const line of lines) {
            const match = line.match(UCI_MOVE_REGEX);
            if (match && !completed) {
              completed = true;
              cleanup();
              resolve(match[0]);
              return;
            }
          }
        }
      };

      const onStderr = (data: Buffer) => {
        stderr += data.toString();
      };

      const onExit = (code: number | null) => {
        if (!completed) {
          completed = true;
          cleanup();
          const match = stdout.match(UCI_MOVE_REGEX);
          if (match) {
            resolve(match[0]);
          } else {
            const details = stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500) || "(no output)";
            reject(new Error(`engine exited with code ${code} without a valid move: ${details}`));
          }
        }
      };

      const onError = (err: Error) => {
        if (!completed) {
          completed = true;
          cleanup();
          reject(new Error(`engine error: ${err.message}`));
        }
      };

      const timeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          cleanup();
          child.kill("SIGKILL");
          const details = stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500);
          reject(new Error(details ? `move timeout (${timeoutMs}ms): ${details}` : `move timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout?.removeListener("data", onData);
        child.stderr?.removeListener("data", onStderr);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onStderr);
      child.on("exit", onExit);
      child.on("error", onError);

      child.stdin?.write(fen + "\n");
      child.stdin?.end();
    });
  }

  stop() {
    if (this.child && !this.isDead) {
      this.child.kill();
    }
  }
}

// ---------------------------------------------------------------------------
// Docker sandboxed engine controller
//
// One container per agent per game. Container starts with `sleep infinity`,
// agent code is piped in via `docker exec`, then each move is a `docker exec`
// call. On crash, restarts the container and retries once before forfeiting.
//
// Security flags: --network none, --read-only, --cap-drop ALL, memory/PID
// limits, tmpfs /tmp. Container runs as non-root (defined in the image).
// ---------------------------------------------------------------------------

class DockerEngineController {
  private containerName: string;
  private config: AgentConfig;
  private containerStarted = false;
  private codeWritten = false;
  private readonly agentPathInContainer: string;

  constructor(config: AgentConfig, matchId: string, side: string) {
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

  async getMove(fen: string, timeoutMs: number = MOVE_TIMEOUT_MS): Promise<string> {
    if (!this.containerStarted) this.startContainer();
    if (!this.codeWritten) this.writeCodeToContainer();
    return this.execMove(fen, false, timeoutMs);
  }

  private execMove(fen: string, isRetry: boolean, timeoutMs: number): Promise<string> {
    const runtime = this.config.language === "js" ? "node" : "python3";

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let completed = false;

      const child = spawn("docker", [
        "exec", "-i", this.containerName,
        runtime, this.agentPathInContainer,
      ], { stdio: ["pipe", "pipe", "pipe"] });

      const timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          child.kill("SIGKILL");
          const details = stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500);
          reject(new Error(details ? `move timeout (${timeoutMs}ms): ${details}` : `move timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (!completed && stdout.includes("\n")) {
          const m = stdout.match(UCI_MOVE_REGEX);
          if (m) {
            completed = true;
            clearTimeout(timer);
            child.kill();
            resolve(m[0]);
          }
        }
      });

      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      child.on("exit", (code) => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          const m = stdout.match(UCI_MOVE_REGEX);
          if (m) { resolve(m[0]); return; }

          const err = new Error(`engine exited ${code}: ${stderr.slice(0, 200) || stdout.slice(0, 200) || "(no output)"}`);

          if (!isRetry) {
            // Restart container and retry once
            this.stopContainer();
            try {
              this.startContainer();
              this.writeCodeToContainer();
            } catch {
              reject(err);
              return;
            }
            this.execMove(fen, true, timeoutMs).then(resolve).catch(reject);
          } else {
            reject(err);
          }
        }
      });

      child.on("error", (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          reject(new Error(`docker exec error: ${err.message}`));
        }
      });

      child.stdin?.write(fen + "\n");
      child.stdin?.end();
    });
  }

  private stopContainer(): void {
    if (this.containerStarted) {
      try {
        execFileSync("docker", ["rm", "-f", this.containerName], {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        });
      } catch {}
      this.containerStarted = false;
      this.codeWritten = false;
    }
  }

  stop(): void {
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
        // Failsafe: if the *first* move for this side fails, retry once with
        // the same (generous) budget. Cold-start flakiness shouldn't forfeit
        // a game on move 1.
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
  const headers = [
    `[Event "Chess Agents Arena"]`,
    `[Round "${round}"]`,
    `[White "${whiteName}"]`,
    `[Black "${blackName}"]`,
    `[Result "${result}"]`,
    `[Termination "${termination}"]`,
  ];
  // chess.pgn() in chess.js v1 includes its own header block (e.g. [Result "1-0"]).
  // Strip those so the server's game-count check doesn't see duplicate [Result] tags.
  const moveText = chess.pgn().split("\n").filter(l => !l.startsWith("[")).join("\n").trim();
  return headers.join("\n") + "\n\n" + moveText + " " + result;
}
