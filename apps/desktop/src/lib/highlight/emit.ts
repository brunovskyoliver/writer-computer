/**
 * The two text forms a highlight takes in the document, the detector that
 * reads them back, and the selection→context decision shared by the bar and
 * the write path. Contract: SPECs/formula-highlight-colors/contracts/
 * document-format.md — the forms are written and recognised *exactly*:
 * `\textcolor{#rrggbb}{…}` inside math, `<span style="color:#rrggbb">…</span>`
 * in prose. Anything else (`\color`, `<mark>`, a span carrying other CSS) is
 * not a Writer highlight and is left strictly alone.
 */

import type { EditorState } from "@codemirror/state";
import { mathContext, type MathContext, type MathNode } from "@/lib/latex-snippets/math-context";
import { HIGHLIGHT_PALETTE, type PaletteColour } from "./palette";

/**
 * What the user perceives and what the emitters read back. `from`/`to` are the
 * document positions of the *inner text* — the glyphs that get the colour,
 * excluding the wrapper.
 */
export interface Highlight {
  from: number;
  to: number;
  /** A palette entry when the document's hex matches one; a bare hex when it
   *  does not. An off-palette hex is rendered as written and never rewritten
   *  to the nearest palette entry (spec edge case). */
  colour: PaletteColour | { hex: string };
  context: "math" | "prose";
}

/** A detected wrapper: everything `Highlight` has, plus the wrapper's own
 *  bounds and the raw hex — what the normalise step needs to strip it. */
export interface DetectedHighlight extends Highlight {
  wrapperFrom: number;
  wrapperTo: number;
  hex: string;
}

/** Math or prose, resolved from where the selection sits (FR-007). `math`
 *  carries the enclosing node so the write path can clamp to the formula span
 *  and never touch the `$…$` delimiters. */
export type HighlightContext = { kind: "math"; node: MathNode } | { kind: "prose" };

const MATH_KINDS = new Set<MathContext["kind"]>(["inline", "display", "text"]);

/**
 * Decide the context for a selection. Both ends are probed and must agree
 * (data-model.md): a selection starting in math and ending in prose is refused
 * rather than guessed at, so `$$` delimiters are never swallowed into a
 * highlight. `code` at either end refuses (FR-002). `\text{…}` counts as math —
 * an HTML span inside it would not render. Never cache the result across a
 * document change (FR-017).
 */
export function highlightContext(
  state: EditorState,
  from: number,
  to: number,
): HighlightContext | null {
  const a = mathContext(state, from);
  const b = mathContext(state, to);
  if (MATH_KINDS.has(a.kind) && MATH_KINDS.has(b.kind)) {
    const aNode = (a as { node: MathNode }).node;
    const bNode = (b as { node: MathNode }).node;
    // Both ends in math, but they must be the *same* formula — a selection
    // spanning two math nodes would swallow the prose between them.
    if (aNode.from === bNode.from && aNode.to === bNode.to) {
      return { kind: "math", node: aNode };
    }
    return null;
  }
  if (a.kind === "prose" && b.kind === "prose") return { kind: "prose" };
  return null;
}

/** The index after `text[i] === "\\"` — escapes consume the next char, so a
 *  `\{` or `\}` never counts as a group delimiter and `\\` is one token. */
function nextIndex(text: string, i: number): number {
  return text[i] === "\\" ? i + 2 : i + 1;
}

/** The `}` closing the `{` at `openIndex`, or null when unbalanced. */
export function matchBrace(text: string, openIndex: number): number | null {
  let depth = 0;
  for (let i = openIndex; i < text.length; i = nextIndex(text, i)) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

const MATH_WRAPPER_RE = /\\textcolor\{(#[0-9a-f]{6})\}\{/g;
const PROSE_WRAPPER_RE = /<span style="color:(#[0-9a-f]{6})">/g;

/** The prose form's markup, shared by the emitter, the detector and the
 *  concealment spec so the format string lives in exactly one place
 *  (Constitution III). `PROSE_SPAN_OPEN_RE` is anchored — it matches a whole
 *  `HTMLTag` node's text; `PROSE_SPAN_OPEN_SEARCH_RE` finds an opening tag
 *  inside a run of text. */
export const PROSE_SPAN_OPEN_RE = /^<span style="color:(#[0-9a-f]{6})">$/;
export const PROSE_SPAN_OPEN_SEARCH_RE = /<span style="color:#[0-9a-f]{6}">/;
export const PROSE_SPAN_CLOSE = "</span>";

/** The opening tag for `hex` — assembled here and nowhere else. */
export const proseSpanOpen = (hex: string): string => `<span style="color:${hex}">`;

function colourFor(hex: string): PaletteColour | { hex: string } {
  return HIGHLIGHT_PALETTE.find((c) => c.hex === hex) ?? { hex };
}

/**
 * Scan `text` for Writer highlight wrappers; `base` offsets the result into
 * document coordinates. Recognises exactly the two emitted forms — a
 * hand-written `\color{...}`, a `<span>` carrying other CSS, or a `<mark>` is
 * not a highlight and raises nothing. Malformed remnants (an unmatched
 * `\textcolor` open, a span with no `</span>`) are skipped.
 */
export function detectHighlights(text: string, base = 0): DetectedHighlight[] {
  const found: DetectedHighlight[] = [];

  for (const match of text.matchAll(MATH_WRAPPER_RE)) {
    const openBrace = match.index + match[0].length - 1;
    const close = matchBrace(text, openBrace);
    if (close === null) continue;
    found.push({
      wrapperFrom: match.index + base,
      wrapperTo: close + 1 + base,
      from: openBrace + 1 + base,
      to: close + base,
      hex: match[1],
      colour: colourFor(match[1]),
      context: "math",
    });
  }

  for (const match of text.matchAll(PROSE_WRAPPER_RE)) {
    const innerStart = match.index + match[0].length;
    const close = text.indexOf(PROSE_SPAN_CLOSE, innerStart);
    if (close === -1) continue;
    found.push({
      wrapperFrom: match.index + base,
      wrapperTo: close + PROSE_SPAN_CLOSE.length + base,
      from: innerStart + base,
      to: close + base,
      hex: match[1],
      colour: colourFor(match[1]),
      context: "prose",
    });
  }

  return found.sort((a, b) => a.wrapperFrom - b.wrapperFrom);
}

/**
 * The math emitter (FR-005): the fragment is wrapped byte-for-byte — a prefix,
 * the untouched document text, a suffix. Written inside the `$…$`/`$$…$$`
 * delimiters by the caller; they are never part of the range passed in.
 */
export function emitMathHighlight(fragment: string, hex: string): string {
  return `\\textcolor{${hex}}{${fragment}}`;
}

/** A run of blank lines between paragraphs — at least two newlines with only
 *  whitespace between and around them, so a whitespace-only line folds into
 *  the separator instead of surviving as a segment of its own. Single
 *  newlines (soft breaks) stay inside a paragraph and never match. */
const PARAGRAPH_SPLIT = /\n[\t\r ]*\n[\t\n\r ]*/g;

/**
 * The paragraph ranges inside `text`: the runs between blank-line
 * separators, skipping whitespace-only runs, which carry nothing to colour.
 * Each returned range is what gets its own `<span>` — a span must never
 * straddle a blank line (contract, research R9).
 */
export function proseParagraphRanges(text: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PARAGRAPH_SPLIT)) {
    if (text.slice(cursor, match.index).trim().length > 0) {
      ranges.push({ from: cursor, to: match.index });
    }
    cursor = match.index + match[0].length;
  }
  if (text.slice(cursor).trim().length > 0) ranges.push({ from: cursor, to: text.length });
  return ranges;
}

/**
 * The prose emitter (FR-006): the text byte-for-byte inside a colour span —
 * the colour is on the glyphs, not a background box (FR-004), and inline
 * HTML so every CommonMark reader passes it through to the rendered output
 * rather than showing raw syntax (SC-004). A fragment spanning a blank line
 * emits one span per paragraph, never a single span across a block
 * boundary — load-bearing, not cosmetic: a straddling span parses as an
 * opening `HTMLTag` in one `Paragraph` and a closing one in the next, and
 * the concealment pairing could never match it (research R9).
 */
export function emitProseHighlight(fragment: string, hex: string): string {
  let out = "";
  let cursor = 0;
  for (const p of proseParagraphRanges(fragment)) {
    out +=
      fragment.slice(cursor, p.from) +
      proseSpanOpen(hex) +
      fragment.slice(p.from, p.to) +
      PROSE_SPAN_CLOSE;
    cursor = p.to;
  }
  return out + fragment.slice(cursor);
}
