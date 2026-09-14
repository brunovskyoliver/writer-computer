/**
 * Single source for the snippet file's vocabulary: option letters, modes,
 * error codes and the two constants the engine needs at runtime. The parser,
 * compiler, matcher, Settings UI and tests all import from here so adding a
 * letter or a code is one edit (docs/consolidation.md).
 *
 * Format reference: SPECs/latex-suite/contracts/snippet-file-format.md
 */

/** Every letter the `options` field may contain. */
export const OPTION_LETTERS = "tmnMArw";

/** The mode letters; exactly one of these is required per entry. */
export const MODE_LETTERS = "tmnM";

export type SnippetMode = "text" | "math" | "inline" | "display";

/** Mode letter → mode name. `math` covers both inline and display. */
export const letterToMode: Record<string, SnippetMode> = {
  t: "text",
  m: "math",
  n: "inline",
  M: "display",
};

/**
 * Load-time and runtime entry failures. Load-time codes come from the parser
 * and the compiler; `pattern-timeout` / `pattern-threw` are set by the matcher
 * when a snippet's regex misbehaves and gets disabled for the session.
 */
export const ENTRY_ERROR_CODES = [
  "not-an-object",
  "missing-field",
  "invalid-options",
  "invalid-pattern",
  "missing-capture",
  "unknown-variable",
  "invalid-priority",
  "function-replacement",
  "unsupported-value",
  "pattern-timeout",
  "pattern-threw",
  "invalid-variable",
] as const;

export type EntryErrorCode = (typeof ENTRY_ERROR_CODES)[number];

/** One skipped entry. `index` is its position in the file's array (0-based),
 *  `line` the line of the object literal, `trigger` the literal trigger when
 *  there is one — everything Settings needs to point the user at the entry. */
export type EntryError = {
  code: EntryErrorCode;
  index: number;
  line?: number;
  trigger?: string;
  message: string;
};

/** A whole-file failure: unreadable file or a JavaScript syntax error. */
export type LoadError = {
  message: string;
  line?: number;
  column?: number;
};

/** A single `RegExp.exec` may not take longer than this. Over budget, the
 *  snippet is disabled and reported instead of stalling every keystroke. */
export const PATTERN_TIME_BUDGET_MS = 20;

/** File name inside the app's global config directory. */
export const SNIPPET_FILE_NAME = "latex-snippets.js";
