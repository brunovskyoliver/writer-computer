/**
 * Wrap the selection in `\underbrace` / `\overbrace` with an empty annotation
 * group; the caret lands inside it so the note is typed next. Inside math the
 * selection wraps in place; in prose the command emits
 * `$\underbrace{\text{…}}_{\text{…}}$` so the bracket renders in either
 * context. Complete `$…$` islands inside a prose selection are lifted out of
 * `\text{}` and re-emitted as math — `rows $*$ columns` becomes
 * `\text{rows }*\text{ columns}` — so the result is still one formula with no
 * stray `$` for the markdown layer to re-split on. KaTeX sizes the brace and
 * its note to the content, which is what makes the annotation adapt to
 * whatever is typed.
 *
 * `emitBraceWrap` is the pure half — the command only resolves context,
 * validates, and dispatches. Rules: SPECs/matrix-brace-tools/spec.md.
 */

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, type StateCommand } from "@codemirror/state";
import { mathContext, type MathContext, type MathNode } from "@/lib/latex-snippets/math-context";
import { showEditorNotice } from "./editor-notice-store";
import { validateMath } from "./math-renderer";
import { enterVimInsertMode } from "./vim-mode";

export type BraceSide = "under" | "over";

export interface BraceWrap {
  insert: string;
  /** Caret offset inside `insert` — inside the annotation braces. */
  caret: number;
}

const MATH_KINDS = new Set<MathContext["kind"]>(["inline", "display", "text"]);

/** `$…$`/`$$…$$` islands inside a prose fragment — the same spans the math
 *  scanner recognises (Pandoc guards: an unescaped opener needs non-blank
 *  content next, an inline closer can't sit after whitespace or before a
 *  digit). Anything else with a `$` stays prose. */
interface MathIsland {
  from: number;
  to: number;
  innerFrom: number;
  innerTo: number;
}

const isBlank = (ch: string | undefined): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === undefined;

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

function mathIslands(fragment: string): MathIsland[] {
  const islands: MathIsland[] = [];
  let i = 0;
  while (i < fragment.length) {
    if (fragment[i] === "\\") {
      i += 2;
      continue;
    }
    if (fragment[i] !== "$") {
      i += 1;
      continue;
    }
    const wide = fragment[i + 1] === "$";
    const innerFrom = i + (wide ? 2 : 1);
    if (!wide && isBlank(fragment[innerFrom])) {
      i += 1;
      continue;
    }
    let innerTo = -1;
    for (let j = innerFrom; j < fragment.length; j += 1) {
      if (fragment[j] === "\\") {
        j += 1;
        continue;
      }
      if (wide) {
        if (fragment.startsWith("$$", j)) innerTo = j;
      } else if (fragment[j] === "$" && !isBlank(fragment[j - 1]) && !isDigit(fragment[j + 1])) {
        innerTo = j;
      }
      if (innerTo !== -1) break;
    }
    if (innerTo === -1) {
      i += 1;
      continue;
    }
    islands.push({ from: i, to: innerTo + (wide ? 2 : 1), innerFrom, innerTo });
    i = innerTo + (wide ? 2 : 1);
  }
  return islands;
}

/** TeX specials a `\text{…}` group can't hold raw; `\x` forms render the
 *  literal character, so currency and braces in prose still wrap. */
const PROSE_ESCAPES = new Set(["$", "&", "#", "_", "{", "}", "%"]);

function escapeProseRun(run: string): string {
  let out = "";
  for (let i = 0; i < run.length; i += 1) {
    const ch = run[i];
    if (ch === "\\") {
      out += run.slice(i, i + 2);
      i += 1;
    } else {
      out += PROSE_ESCAPES.has(ch) ? `\\${ch}` : ch;
    }
  }
  return out;
}

/** The prose form's brace body: text runs inside `\text{}`, math islands raw
 *  — the emitted formula then holds no `$` delimiters of its own. */
function proseBraceBody(fragment: string): string {
  let body = "";
  let cursor = 0;
  for (const island of mathIslands(fragment)) {
    if (island.from > cursor)
      body += `\\text{${escapeProseRun(fragment.slice(cursor, island.from))}}`;
    body += fragment.slice(island.innerFrom, island.innerTo);
    cursor = island.to;
  }
  if (cursor < fragment.length) body += `\\text{${escapeProseRun(fragment.slice(cursor))}}`;
  return body || "\\text{}";
}

export function emitBraceWrap(fragment: string, side: BraceSide, math: boolean): BraceWrap {
  const macro = side === "under" ? "\\underbrace" : "\\overbrace";
  const script = side === "under" ? "_" : "^";
  const annotation = math ? "" : "\\text{}";
  const body = math ? fragment : proseBraceBody(fragment);
  const insert = math
    ? `${macro}{${body}}${script}{}`
    : `$${macro}{${body}}${script}{${annotation}}$`;
  return { insert, caret: insert.length - (math ? 1 : 3) };
}

const PARSE_BUDGET_MS = 50;
const MIXED_NOTICE = "The selection has to be all math or all prose — not a mix of both.";

/** The one write path for both commands (FR-4, FR-5). Returns whether the
 *  keypress was consumed — the notices explain the cases that write nothing.
 *  A successful wrap drops Vim into insert mode (FR-7): the caret is already
 *  in the note, so the next keypress must type, not move. */
export function braceAnnotation(side: BraceSide): StateCommand {
  return (target) => {
    const { state, dispatch } = target;
    const sel = state.selection.main;
    if (state.selection.ranges.length > 1) return false;
    if (sel.empty) {
      showEditorNotice("Select the text the brace should cover first.");
      return true;
    }

    ensureSyntaxTree(state, state.doc.lineAt(sel.to).to, PARSE_BUDGET_MS);
    const a = mathContext(state, sel.from);
    const b = mathContext(state, sel.to);
    const aMath = MATH_KINDS.has(a.kind) ? (a as { node: MathNode }).node : null;
    const bMath = MATH_KINDS.has(b.kind) ? (b as { node: MathNode }).node : null;

    if (a.kind === "code" || b.kind === "code") {
      showEditorNotice(MIXED_NOTICE);
      return true;
    }
    if (aMath) {
      // Starting inside a formula is a real mix unless the selection stays in
      // the same node to the end. Ending on a node's closing `$` is not a mix
      // — the island is complete inside a prose selection.
      if (bMath && aMath.from === bMath.from && aMath.to === bMath.to) {
        return wrapMath(target, aMath, side);
      }
      showEditorNotice(MIXED_NOTICE);
      return true;
    }
    if (bMath && bMath.to !== sel.to) {
      showEditorNotice(MIXED_NOTICE);
      return true;
    }

    const fragment = state.doc.sliceString(sel.from, sel.to);
    // A blank line ends the paragraph, and the emitted `$…$` only parses
    // inside one — a crossing selection would leave raw `$` in the source.
    if (/\n\s*\n/.test(fragment)) {
      showEditorNotice("The brace can't cross a paragraph break — shorten the selection.");
      return true;
    }
    const { insert, caret } = emitBraceWrap(fragment, side, false);
    if (!validateMath(insert.slice(1, -1))) {
      showEditorNotice(
        "That selection can't be bracketed — it contains characters that would break the formula.",
      );
      return true;
    }
    dispatch(
      state.update({
        changes: { from: sel.from, to: sel.to, insert },
        selection: EditorSelection.cursor(sel.from + caret),
        userEvent: "input.format.brace",
      }),
    );
    enterVimInsertMode(target);
    return true;
  };
}

/** The math half of `braceAnnotation`: wrap the clamped formula span in
 *  place, validating the whole resulting formula before dispatch. */
function wrapMath(target: Parameters<StateCommand>[0], node: MathNode, side: BraceSide): boolean {
  const { state, dispatch } = target;
  const sel = state.selection.main;
  const from = Math.max(sel.from, node.formulaFrom);
  const to = Math.min(sel.to, node.formulaTo);
  if (from >= to) {
    showEditorNotice("Select the part of the formula the brace should cover.");
    return true;
  }
  const formula = state.doc.sliceString(node.formulaFrom, node.formulaTo);
  const fragment = formula.slice(from - node.formulaFrom, to - node.formulaFrom);
  const { insert, caret } = emitBraceWrap(fragment, side, true);
  const next =
    formula.slice(0, from - node.formulaFrom) + insert + formula.slice(to - node.formulaFrom);
  if (!validateMath(next)) {
    showEditorNotice("That selection can't be bracketed — the formula would stop rendering.");
    return true;
  }
  dispatch(
    state.update({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + caret),
      userEvent: "input.format.brace",
    }),
  );
  enterVimInsertMode(target);
  return true;
}
