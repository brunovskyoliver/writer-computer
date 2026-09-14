/**
 * Pick the snippet that fires for the text before the caret. Pure: it sees a
 * string, a context kind and the compiled set — never an `EditorView` — so the
 * whole decision is unit-testable.
 *
 * Rules: SPECs/latex-suite/research.md (R9) and
 * SPECs/latex-suite/contracts/editor-extension.md ("Per-keystroke decision").
 */

import type { CompiledSnippet, CompiledSnippetSet, MatchMode } from "./compile";
import type { MathContext } from "./math-context";
import { PATTERN_TIME_BUDGET_MS, type EntryError } from "./options";

export type SnippetMatch = {
  snippet: CompiledSnippet;
  /** Offsets relative to the start of the line; `-1` for a visual match, where
   *  the caller replaces the selection instead. */
  from: number;
  to: number;
  groups: (string | undefined)[];
  /** The selected text a `${VISUAL}` template wraps. */
  visualText?: string;
};

export type MatchArgs = {
  /** The line's text from its start up to the caret. */
  lineBefore: string;
  context: MathContext;
  set: CompiledSnippetSet;
  kind: "auto" | "tab";
  /** Non-empty only when a selection is being replaced (visual snippets). */
  selectionText: string;
  /** The character just typed; the visual lookup key. */
  typedText?: string;
  onDisable: (id: number, error: EntryError) => void;
};

/**
 * Which bucket a caret sits in. Note `context.kind === "text"` means *inside
 * `\text{}`* — the opposite of the `t` (prose) option letter, which maps from
 * `prose`. Both are `null` for code and `\text{}`: no snippet fires there.
 */
function bucketFor(context: MathContext): MatchMode | null {
  switch (context.kind) {
    case "prose":
      return "text";
    case "inline":
      return "inline";
    case "display":
      return "display";
    default:
      return null;
  }
}

/** Start of the `\macro` word ending at the caret, or `null`. */
function macroStart(lineBefore: string): number | null {
  const macro = /\\[A-Za-z]+$/.exec(lineBefore);
  return macro ? macro.index : null;
}

/** Run one pattern under the time budget. A snippet that overruns or throws is
 *  disabled for the session rather than stalling every keystroke (FR-019). */
function execGuarded(
  snippet: CompiledSnippet,
  lineBefore: string,
  onDisable: MatchArgs["onDisable"],
): RegExpExecArray | null {
  const started = performance.now();
  let result: RegExpExecArray | null;
  try {
    result = snippet.pattern.exec(lineBefore);
  } catch (error) {
    onDisable(snippet.id, {
      code: "pattern-threw",
      index: snippet.id,
      ...(snippet.triggerText === null ? {} : { trigger: snippet.triggerText }),
      message: `Snippet pattern threw: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
  if (performance.now() - started > PATTERN_TIME_BUDGET_MS) {
    onDisable(snippet.id, {
      code: "pattern-timeout",
      index: snippet.id,
      ...(snippet.triggerText === null ? {} : { trigger: snippet.triggerText }),
      message: `Snippet pattern took longer than ${PATTERN_TIME_BUDGET_MS}ms and was disabled`,
    });
    return null;
  }
  return result;
}

export function matchSnippet(args: MatchArgs): SnippetMatch | null {
  const { lineBefore, context, set, kind, selectionText, typedText, onDisable } = args;
  const mode = bucketFor(context);
  if (mode === null) return null;

  // A selection only ever triggers a `${VISUAL}` snippet, looked up by the
  // exact trigger that was typed over it.
  if (selectionText.length > 0) {
    if (typedText === undefined) return null;
    const candidates = set.visual.get(`${mode}:${typedText}`);
    const snippet = candidates?.find(
      (candidate) => candidate.disabled === null && candidate.automatic === (kind === "auto"),
    );
    if (!snippet) return null;
    return { snippet, from: -1, to: -1, groups: [], visualText: selectionText };
  }

  const macro = kind === "auto" ? macroStart(lineBefore) : null;

  // The list is pre-sorted (priority desc, then file order), so first hit wins.
  for (const snippet of set.byMode[mode][kind === "auto" ? "auto" : "tab"]) {
    if (snippet.disabled !== null || snippet.visual) continue;

    const found = execGuarded(snippet, lineBefore, onDisable);
    if (!found) continue;

    const from = lineBefore.length - found[0].length;
    // Typing the middle of `\text` must not fire the `text` snippet: skip any
    // match that starts strictly inside a control sequence under the caret.
    if (macro !== null && from > macro) continue;

    return { snippet, from, to: lineBefore.length, groups: found.slice(1) };
  }

  return null;
}
