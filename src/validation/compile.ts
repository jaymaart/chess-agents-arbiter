import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Compiled-engine support (Season 3+).
//
// Submitters upload SOURCE (.cpp/.c/.rs), never a prebuilt binary — so the same
// static-analysis + sandbox story that governs interpreted engines still
// applies to code we can read. This module compiles that source to a STATICALLY
// linked binary with fixed, platform-controlled flags. Static linking matters:
// the resulting binary opens no shared libraries at run time, which lets the
// seccomp launcher (sandbox/engine-jail.c) deny file opens outright.
//
// Compilation runs on the arbiter/validator (not centrally), from the source it
// already receives, cached by source hash. That fits the existing source-based
// distribution channel unchanged and sidesteps CPU-arch portability — each host
// compiles for its own architecture.
//
// Prefer compileEngineAsync (non-blocking, kills the whole compiler process
// group on timeout). The sync compileEngine remains for callers on the spawn
// hot path; it serves cache hits without blocking and only compiles inline as a
// fallback when the async prewarm didn't run.
// ---------------------------------------------------------------------------

export type CompiledLanguage = "cpp" | "c" | "rust";

export function isCompiledLanguage(lang: string): lang is CompiledLanguage {
  return lang === "cpp" || lang === "c" || lang === "rust";
}

// Compiling untrusted source is itself an attack surface (compiler bombs, deep
// template recursion, pathological inputs). Hard-cap wall time and captured
// output; the container's memory limit bounds RSS.
const COMPILE_TIMEOUT_MS = 30_000;
const COMPILE_MAX_OUTPUT = 2 * 1024 * 1024;

// On-disk cache of compiled binaries, keyed by (language + source bytes). A
// given engine version is compiled once per host and reused across every move,
// game and match. Lives under tmp so it clears on host cleanup.
const CACHE_DIR = path.join(os.tmpdir(), "chess-engine-bin-cache");

interface CompileSpec {
  compiler: string;
  args: (srcPath: string, outPath: string) => string[];
}

// Fixed flags only — no user-supplied compiler options are ever forwarded.
// `-static` (C/C++) and `+crt-static` (Rust) produce self-contained binaries.
// `-fno-diagnostics-show-caret` / `--error-format=short` stop the compiler from
// echoing source excerpts, a defense-in-depth against leaking the contents of
// any file a crafted `#include` managed to pull in (the static analyzer already
// rejects absolute/parent includes, but it is best-effort regex).
const SPECS: Record<CompiledLanguage, CompileSpec> = {
  cpp: {
    compiler: "g++",
    args: (src, out) => ["-std=c++20", "-O2", "-static", "-s", "-fno-diagnostics-show-caret", "-o", out, src],
  },
  c: {
    compiler: "gcc",
    args: (src, out) => ["-std=c17", "-O2", "-static", "-s", "-fno-diagnostics-show-caret", "-o", out, src],
  },
  rust: {
    compiler: "rustc",
    args: (src, out) => ["-O", "-C", "target-feature=+crt-static", "--error-format=short", "-o", out, src],
  },
};

export interface CompileResult {
  ok: boolean;
  binaryPath?: string;
  // Compiler stderr (trimmed + path-redacted), surfaced to the submitter as
  // validationNotes on a failed build — the single most useful thing for them
  // to see.
  error?: string;
}

// Create the cache dir private (0700) so another user on a shared host can't
// pre-plant a poisoned binary at our predictable cache path.
function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
}

// A cache hit is trusted only if it's a REGULAR file (not a symlink or special
// file) — defends against a pre-planted symlink in a shared tmp cache pointing
// execution at an attacker-controlled binary.
function cachedBinary(binaryPath: string): string | null {
  try {
    const st = fs.lstatSync(binaryPath);
    if (st.isFile() && !st.isSymbolicLink()) return binaryPath;
  } catch {
    /* not present */
  }
  return null;
}

function cachePathFor(sourcePath: string, language: CompiledLanguage): string {
  const source = fs.readFileSync(sourcePath);
  const hash = crypto.createHash("sha256").update(language).update(source).digest("hex");
  return path.join(CACHE_DIR, `${language}-${hash}`);
}

// Trim compiler stderr to a useful tail and strip on-disk paths, so we never
// echo the host's tmp layout (or, defensively, snippets keyed to other files)
// back to the submitter.
function sanitizeCompilerError(raw: string, sourcePath: string): string {
  const tail = (raw || "").split("\n").slice(-30).join("\n").slice(-2000).trim();
  return tail
    .split(sourcePath).join("engine-source")
    .split(path.dirname(sourcePath)).join("")
    .trim();
}

// Atomically move the freshly built binary into the cache (so concurrent
// compiles of the same version can't hand out a partial binary) and mark it
// executable. Returns the validated cache entry.
function finalizeCache(tmpOut: string, binaryPath: string): CompileResult {
  try {
    fs.renameSync(tmpOut, binaryPath);
  } catch {
    // Lost a race to another compile of the same source — clean up and fall
    // through to the winner if it now exists.
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
  }
  const ok = cachedBinary(binaryPath);
  if (!ok) return { ok: false, error: "Compilation produced no binary." };
  try { fs.chmodSync(binaryPath, 0o755); } catch { /* ignore */ }
  return { ok: true, binaryPath: ok };
}

/**
 * Async compile — the preferred path. Runs the compiler in its own process
 * group (so a compiler bomb's cc1plus/ld children are killed with it on
 * timeout, not orphaned) and never blocks the event loop. Idempotent: returns
 * the cached binary without recompiling when present.
 */
export function compileEngineAsync(sourcePath: string, language: CompiledLanguage): Promise<CompileResult> {
  return new Promise<CompileResult>((resolve) => {
    const spec = SPECS[language];
    let binaryPath: string;
    try {
      binaryPath = cachePathFor(sourcePath, language);
    } catch {
      resolve({ ok: false, error: "Failed to read engine source." });
      return;
    }
    ensureCacheDir();
    const hit = cachedBinary(binaryPath);
    if (hit) { resolve({ ok: true, binaryPath: hit }); return; }

    const tmpOut = `${binaryPath}.tmp-${process.pid}`;
    let settled = false;
    const rmTmp = () => { try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ } };

    let child: ReturnType<typeof spawn>;
    try {
      // detached (non-Windows) makes the child a group leader so we can signal
      // the whole tree on timeout.
      child = spawn(spec.compiler, spec.args(sourcePath, tmpOut), {
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e: any) {
      resolve({ ok: false, error: `Failed to launch compiler: ${e?.message || e}` });
      return;
    }

    const settle = (r: CompileResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let stderr = "";
    let captured = 0;
    child.stderr?.on("data", (d: Buffer) => {
      if (captured < COMPILE_MAX_OUTPUT) { stderr += d.toString(); captured += d.length; }
    });

    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
      rmTmp();
      settle({ ok: false, error: `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.` });
    }, COMPILE_TIMEOUT_MS);

    child.on("error", (e: any) => {
      rmTmp();
      settle(
        e?.code === "ENOENT"
          ? { ok: false, error: `Compiler for ${language} is not available on this host.` }
          : { ok: false, error: `Failed to launch compiler: ${e?.message || e}` },
      );
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal) { rmTmp(); settle({ ok: false, error: `Compilation terminated (${signal}).` }); return; }
      if (code !== 0) {
        rmTmp();
        const msg = sanitizeCompilerError(stderr, sourcePath);
        settle({ ok: false, error: msg ? `Compilation failed:\n\n${msg}` : "Compilation failed." });
        return;
      }
      settle(finalizeCache(tmpOut, binaryPath));
    });
  });
}

/**
 * Synchronous compile. Serves cache hits without blocking; only compiles inline
 * (blocking) as a fallback for callers on the spawn hot path when the async
 * prewarm hasn't populated the cache. Idempotent.
 */
export function compileEngine(sourcePath: string, language: CompiledLanguage): CompileResult {
  const spec = SPECS[language];
  let binaryPath: string;
  try {
    binaryPath = cachePathFor(sourcePath, language);
  } catch {
    return { ok: false, error: "Failed to read engine source." };
  }
  ensureCacheDir();
  const hit = cachedBinary(binaryPath);
  if (hit) return { ok: true, binaryPath: hit };

  const tmpOut = `${binaryPath}.tmp-${process.pid}`;
  try {
    execFileSync(spec.compiler, spec.args(sourcePath, tmpOut), {
      timeout: COMPILE_TIMEOUT_MS,
      maxBuffer: COMPILE_MAX_OUTPUT,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e: any) {
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
    if (e?.code === "ETIMEDOUT" || e?.signal === "SIGTERM") {
      return { ok: false, error: `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.` };
    }
    if (e?.code === "ENOENT") {
      return { ok: false, error: `Compiler for ${language} is not available on this host.` };
    }
    const msg = sanitizeCompilerError(e?.stderr?.toString?.() || e?.message || "", sourcePath);
    return { ok: false, error: msg ? `Compilation failed:\n\n${msg}` : "Compilation failed." };
  }

  return finalizeCache(tmpOut, binaryPath);
}
