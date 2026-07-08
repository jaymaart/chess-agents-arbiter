import { execFileSync } from "child_process";
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
const SPECS: Record<CompiledLanguage, CompileSpec> = {
  cpp: {
    compiler: "g++",
    args: (src, out) => ["-std=c++20", "-O2", "-static", "-s", "-o", out, src],
  },
  c: {
    compiler: "gcc",
    args: (src, out) => ["-std=c17", "-O2", "-static", "-s", "-o", out, src],
  },
  rust: {
    compiler: "rustc",
    args: (src, out) => ["-O", "-C", "target-feature=+crt-static", "-o", out, src],
  },
};

export interface CompileResult {
  ok: boolean;
  binaryPath?: string;
  // Compiler stderr (trimmed), surfaced to the submitter as validationNotes on
  // a failed build — the single most useful thing for them to see.
  error?: string;
}

/**
 * Compiles a source file to a cached static binary. Idempotent: repeated calls
 * for identical source return the cached binary without recompiling.
 */
export function compileEngine(sourcePath: string, language: CompiledLanguage): CompileResult {
  const spec = SPECS[language];
  const source = fs.readFileSync(sourcePath);
  const hash = crypto.createHash("sha256").update(language).update(source).digest("hex");

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const binaryPath = path.join(CACHE_DIR, `${language}-${hash}`);
  if (fs.existsSync(binaryPath)) return { ok: true, binaryPath };

  // Compile to a per-process temp path, then atomically rename into the cache
  // so concurrent compiles of the same version can't hand out a partial binary.
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
    const stderr = (e?.stderr?.toString?.() || e?.message || "").trim();
    const tail = stderr.split("\n").slice(-30).join("\n").slice(-2000).trim();
    return { ok: false, error: tail ? `Compilation failed:\n\n${tail}` : "Compilation failed." };
  }

  try {
    fs.renameSync(tmpOut, binaryPath);
  } catch {
    // Lost a race to another compile of the same source — clean up and use the
    // winner if it now exists.
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
  }
  if (!fs.existsSync(binaryPath)) return { ok: false, error: "Compilation produced no binary." };
  fs.chmodSync(binaryPath, 0o755);
  return { ok: true, binaryPath };
}
