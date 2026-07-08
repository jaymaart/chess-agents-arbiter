// Canonical engine-language type + file-type gate. `js`/`py` are interpreted;
// `cpp`/`c`/`rust` are compiled from source (see compile.ts). Submitters always
// upload source, never prebuilt binaries.
export type EngineLanguage = "js" | "py" | "cpp" | "c" | "rust";

// Extension → language. Order is irrelevant (suffixes are distinct) but listed
// most-specific-first for readability.
const EXT_TO_LANGUAGE: { ext: string; language: EngineLanguage }[] = [
  { ext: ".js", language: "js" },
  { ext: ".py", language: "py" },
  { ext: ".cpp", language: "cpp" },
  { ext: ".cc", language: "cpp" },
  { ext: ".cxx", language: "cpp" },
  { ext: ".c", language: "c" },
  { ext: ".rs", language: "rust" },
];

export function validateFileType(storageKey: string): {
  isValid: boolean;
  language?: EngineLanguage;
  error?: string;
} {
  const lower = storageKey.toLowerCase();
  for (const { ext, language } of EXT_TO_LANGUAGE) {
    if (lower.endsWith(ext)) return { isValid: true, language };
  }
  return { isValid: false, error: "Unsupported file type. Accepted: .js, .py, .cpp, .c, .rs." };
}

/**
 * On-disk source filename extension for a language. JS uses `.cjs` to force the
 * CommonJS loader under both node and deno; compiled languages use the exact
 * extension their compiler expects (notably `.rs`, not `.rust`).
 */
export function sourceExtension(language: EngineLanguage): string {
  switch (language) {
    case "js": return ".cjs";
    case "py": return ".py";
    case "cpp": return ".cpp";
    case "c": return ".c";
    case "rust": return ".rs";
  }
}
