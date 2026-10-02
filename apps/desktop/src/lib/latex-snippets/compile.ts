/**
 * Turn parsed entries into the pre-sorted, pre-bucketed set the editor scans
 * on every keystroke. All validation lives here: after this module, matching
 * is a straight loop over compiled, bounded patterns.
 *
 * Rules: SPECs/latex-suite/contracts/snippet-file-format.md ("Option letters",
 * "Trigger semantics") and SPECs/latex-suite/data-model.md.
 */

import { createSnippetPattern, PATTERN_SOURCE_LIMIT, type SnippetPattern } from "./bounded-pattern";
import {
  letterToMode,
  MODE_LETTERS,
  OPTION_LETTERS,
  type EntryError,
  type SnippetMode,
} from "./options";
import type { SnippetEntry } from "./parse-snippet-file";
import {
  hasVisual,
  maxCaptureIndex,
  parseReplacement,
  type ReplacementSegment,
} from "./replacement";

export type CompiledSnippet = {
  id: number;
  pattern: SnippetPattern;
  /** The literal trigger, or `null` for a regex trigger. Visual matching and
   *  error messages use it. */
  triggerText: string | null;
  template: ReplacementSegment[];
  mode: SnippetMode;
  automatic: boolean;
  visual: boolean;
  priority: number;
  captureCount: number;
  /** Length of the trigger's source. Longer triggers are scanned first so a
   *  short trigger that is a suffix of a longer one (`iint` in `iiint`) cannot
   *  steal the match. */
  triggerLength: number;
  description?: string;
  /** Set by the matcher when this snippet's regex times out or throws; a
   *  disabled snippet is skipped until the next reload. */
  disabled: EntryError | null;
};

/** The three buckets a caret can be in. `math` snippets land in both math
 *  buckets at compile time so the matcher never branches on mode. */
export type MatchMode = "text" | "inline" | "display";

export type CompiledSnippetSet = {
  byMode: Record<MatchMode, { auto: CompiledSnippet[]; tab: CompiledSnippet[] }>;
  /** `\`${mode}:${triggerText}\`` → visual snippets with that exact trigger. */
  visual: Map<string, CompiledSnippet[]>;
  count: number;
};

export const EMPTY_SNIPPET_SET: CompiledSnippetSet = {
  byMode: {
    text: { auto: [], tab: [] },
    inline: { auto: [], tab: [] },
    display: { auto: [], tab: [] },
  },
  visual: new Map(),
  count: 0,
};

/** `${NAME}` — but not `${VISUAL}` and not the `${0:placeholder}` tabstops. */
const VARIABLE_REFERENCE = /\$\{([^}]*)\}/g;

/**
 * Parse the `latex.snippet-variables` setting: one `NAME=alternation` per
 * item, split on the first `=` so a value may contain further `=`.
 */
export function parseVariables(items: string[]): {
  variables: Map<string, string>;
  errors: EntryError[];
} {
  const variables = new Map<string, string>();
  const errors: EntryError[] = [];

  items.forEach((item, index) => {
    const separator = item.indexOf("=");
    const name = separator === -1 ? "" : item.slice(0, separator).trim();
    if (separator === -1 || name.length === 0) {
      errors.push({
        code: "invalid-variable",
        index,
        message: `Snippet variable "${item}" is not in NAME=value form`,
      });
      return;
    }
    variables.set(name, item.slice(separator + 1));
  });

  return { variables, errors };
}

type CompileFailure = { code: EntryError["code"]; message: string };

/** Count projected trigger length before constructing its expanded value. */
function substitute(
  text: string,
  variables: Map<string, string>,
  limit = Infinity,
): { text: string } | CompileFailure {
  const chunks: string[] = [];
  let length = 0;
  let from = 0;
  VARIABLE_REFERENCE.lastIndex = 0;
  for (let match = VARIABLE_REFERENCE.exec(text); match; match = VARIABLE_REFERENCE.exec(text)) {
    const name = match[1]!;
    const value = name === "VISUAL" || /^\d(?::|$)/.test(name) ? match[0] : variables.get(name);
    if (value === undefined)
      return { code: "unknown-variable", message: `Unknown snippet variable \${${name}}` };
    length += match.index - from + value.length;
    if (length > limit)
      return {
        code: "invalid-pattern",
        message: `Snippet triggers are limited to ${limit} characters`,
      };
    if (match.index > from) chunks.push(text.slice(from, match.index));
    if (value.length > 0) chunks.push(value);
    from = match.index + match[0].length;
  }
  if (length + text.length - from > limit)
    return {
      code: "invalid-pattern",
      message: `Snippet triggers are limited to ${limit} characters`,
    };
  chunks.push(text.slice(from));
  return { text: chunks.join("") };
}

function validateOptions(options: string): string | null {
  for (const letter of options) {
    if (!OPTION_LETTERS.includes(letter)) return `Unknown option letter "${letter}"`;
  }
  const modes = [...options].filter((letter) => MODE_LETTERS.includes(letter));
  if (modes.length === 0) return `Options "${options}" need one mode letter (t, m, n or M)`;
  if (modes.length > 1) return `Options "${options}" have more than one mode letter`;
  return null;
}

function compileEntry(
  entry: SnippetEntry,
  variables: Map<string, string>,
): CompiledSnippet | CompileFailure {
  const isRegex = entry.trigger.kind === "regex" || entry.options.includes("r");
  const rawSource = entry.trigger.kind === "regex" ? entry.trigger.source : entry.trigger.value;

  if (rawSource.length > PATTERN_SOURCE_LIMIT) {
    return {
      code: "invalid-pattern",
      message: `Snippet triggers are limited to ${PATTERN_SOURCE_LIMIT} characters`,
    };
  }
  const triggerSource = substitute(rawSource, variables, PATTERN_SOURCE_LIMIT);
  if ("code" in triggerSource) return triggerSource;
  const replacement = substitute(entry.replacement, variables);
  if ("code" in replacement) return replacement;

  const optionsProblem = validateOptions(entry.options);
  if (optionsProblem) return { code: "invalid-options", message: optionsProblem };

  if (entry.priority !== undefined && !Number.isFinite(entry.priority)) {
    return { code: "invalid-priority", message: `Priority ${entry.priority} is not a number` };
  }

  if (entry.trigger.kind === "regex" && entry.trigger.flags.includes("v")) {
    return {
      code: "invalid-pattern",
      message: "The `v` regex flag is not supported; use `u` semantics",
    };
  }

  let pattern: SnippetPattern;
  try {
    // Anchored at the caret: the subject is the line up to the caret, so the
    // trigger always matches the text that was just typed.
    pattern = createSnippetPattern(triggerSource.text, isRegex, entry.options.includes("w"));
  } catch (error) {
    return { code: "invalid-pattern", message: (error as Error).message };
  }
  const captureCount = pattern.captureCount;

  const template = parseReplacement(replacement.text);
  const maxCapture = maxCaptureIndex(template);
  if (maxCapture !== null && maxCapture >= captureCount) {
    return {
      code: "missing-capture",
      message: `[[${maxCapture}]] needs ${maxCapture + 1} capture groups, the trigger has ${captureCount}`,
    };
  }

  const modeLetter = [...entry.options].find((letter) => MODE_LETTERS.includes(letter))!;

  return {
    id: entry.index,
    pattern,
    triggerText: entry.trigger.kind === "string" ? entry.trigger.value : null,
    template,
    mode: letterToMode[modeLetter]!,
    automatic: entry.options.includes("A"),
    visual: hasVisual(template),
    priority: entry.priority ?? 0,
    captureCount,
    triggerLength: triggerSource.text.length,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    disabled: null,
  };
}

/** The buckets a compiled snippet is scanned in. `math` covers both. */
function matchModes(mode: SnippetMode): MatchMode[] {
  return mode === "math" ? ["inline", "display"] : [mode];
}

/**
 * Compile every entry. A failing entry is skipped with an `EntryError` and the
 * rest still load (FR-018). The result is sorted (priority descending, then
 * file order) so matching never sorts.
 */
export function compileSnippetSet(
  entries: SnippetEntry[],
  variables: Map<string, string>,
): { set: CompiledSnippetSet; errors: EntryError[] } {
  const set: CompiledSnippetSet = {
    byMode: {
      text: { auto: [], tab: [] },
      inline: { auto: [], tab: [] },
      display: { auto: [], tab: [] },
    },
    visual: new Map(),
    count: 0,
  };
  const errors: EntryError[] = [];

  for (const entry of entries) {
    const snippet = compileEntry(entry, variables);
    if (!("pattern" in snippet)) {
      errors.push({
        code: snippet.code,
        index: entry.index,
        line: entry.line,
        ...(entry.trigger.kind === "string" ? { trigger: entry.trigger.value } : {}),
        message: snippet.message,
      });
      continue;
    }

    set.count += 1;
    for (const mode of matchModes(snippet.mode)) {
      set.byMode[mode][snippet.automatic ? "auto" : "tab"].push(snippet);
      if (snippet.visual && snippet.triggerText !== null) {
        const key = `${mode}:${snippet.triggerText}`;
        const bucket = set.visual.get(key);
        if (bucket) bucket.push(snippet);
        else set.visual.set(key, [snippet]);
      }
    }
  }

  // Priority is the author's explicit override; within one priority the
  // longest trigger wins, and only then does file order decide.
  const byPriority = (a: CompiledSnippet, b: CompiledSnippet) =>
    b.priority - a.priority || b.triggerLength - a.triggerLength || a.id - b.id;
  for (const mode of ["text", "inline", "display"] as const) {
    set.byMode[mode].auto.sort(byPriority);
    set.byMode[mode].tab.sort(byPriority);
  }
  for (const bucket of set.visual.values()) bucket.sort(byPriority);

  return { set, errors };
}
