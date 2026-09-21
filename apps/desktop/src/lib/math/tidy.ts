/**
 * "Tidy notation" — the pure half of the `math.tidy` command. Two fixes,
 * both learned from real derivation notes:
 *
 * - Inside matrix-like environment bodies, `\;` `\,` `\:` used as element
 *   separators become ` & ` (they render as spacing, not columns — almost
 *   never the intent inside a matrix).
 * - `*` between operands becomes ` \cdot `, except the conjugate forms
 *   `^*`, `^{*}`, and `*` inside a `^{…}` group.
 *
 * `\text{…}` groups pass through untouched — a `*` there is prose. The
 * function reports a change count so the command can say what it did.
 *
 * Rules: SPECs/math-workflow/spec.md (FR-4).
 */

import { ENV_RE, matchBrace } from "./scan";

/** Environments whose bodies use `&` as the cell separator and where a `\;`
 *  family spacing command is almost surely a mis-typed separator. `cases`,
 *  `aligned` and friends are excluded: there `\;` is deliberate spacing and
 *  an extra `&` would invent a column. */
const CELL_ENV = /^(?:[pbBvV]?matrix\*?|smallmatrix|array|subarray)$/;

/** Environments with a `{…}` column spec between the name and the body. */
const COLSPEC_ENV = new Set(["array", "subarray", "alignedat"]);

const SEPARATOR_RE = /\\[;:,]/g;

/** Body spans of every cell-separator environment in `formula`. Bodies can
 *  nest — an outer matrix's body legitimately contains an inner one, and
 *  both use the same `&` grammar, so overlapping spans are fine. */
function cellEnvBodies(formula: string): Array<{ from: number; to: number }> {
  const stack: { name: string; beginEnd: number }[] = [];
  const bodies: Array<{ from: number; to: number }> = [];

  for (const match of formula.matchAll(ENV_RE)) {
    // `\\begin` is a row break followed by the word "begin", not an opener.
    if (match.index > 0 && formula[match.index - 1] === "\\") continue;
    const name = match[2]!;
    if (match[1] === "begin") {
      stack.push({ name, beginEnd: match.index + match[0].length });
      continue;
    }
    for (let at = stack.length - 1; at >= 0; at -= 1) {
      if (stack[at]!.name !== name) continue;
      const open = stack.splice(at, 1)[0]!;
      if (!CELL_ENV.test(open.name)) break;

      let bodyFrom = open.beginEnd;
      if (COLSPEC_ENV.has(open.name) && formula[bodyFrom] === "{") {
        const close = matchBrace(formula, bodyFrom);
        if (close !== null) bodyFrom = close + 1;
      }
      bodies.push({ from: bodyFrom, to: match.index });
      break;
    }
  }
  return bodies;
}

/** The `\text{…}` spans — their content is prose and stays literal. */
function proseGroups(formula: string): Array<{ from: number; to: number }> {
  const groups: Array<{ from: number; to: number }> = [];
  let at = 0;
  for (;;) {
    const open = formula.indexOf("\\text{", at);
    if (open === -1) break;
    const close = matchBrace(formula, open + "\\text".length);
    if (close === null) break;
    groups.push({ from: open, to: close + 1 });
    at = close + 1;
  }
  return groups;
}

const inSpans = (spans: Array<{ from: number; to: number }>, pos: number) =>
  spans.some((span) => pos >= span.from && pos < span.to);

/** A `*` at `pos` is a conjugate marker, not multiplication, when it follows
 *  `^` directly or opens the `^{…}` group (`^{*}`). */
function isConjugateStar(formula: string, pos: number): boolean {
  let prev = pos - 1;
  while (prev >= 0 && (formula[prev] === " " || formula[prev] === "\t")) prev -= 1;
  if (prev < 0) return false;
  if (formula[prev] === "^") return true;
  if (formula[prev] === "{") return prev > 0 && formula[prev - 1] === "^";
  return false;
}

export interface TidyResult {
  text: string;
  /** Number of rewrites applied — 0 means nothing changed. */
  changes: number;
}

export function tidyFormula(formula: string): TidyResult {
  const bodies = cellEnvBodies(formula);
  const prose = proseGroups(formula);

  // Positions that become `&` / `\cdot` are collected first, then the output
  // is rebuilt once — mid-scan rewrites would shift every later offset.
  const separators: number[] = [];
  const stars: number[] = [];

  for (const body of bodies) {
    SEPARATOR_RE.lastIndex = 0;
    for (const match of formula.slice(body.from, body.to).matchAll(SEPARATOR_RE)) {
      const at = body.from + match.index;
      // `\\;` is a row break plus a stray `;` — the second `\` is the escape.
      if (at > body.from && formula[at - 1] === "\\") continue;
      separators.push(at);
    }
  }

  for (let i = 0; i < formula.length; i += 1) {
    if (formula[i] !== "*") continue;
    if (i > 0 && formula[i - 1] === "\\") continue; // \* stays literal
    if (inSpans(prose, i)) continue;
    if (isConjugateStar(formula, i)) continue;
    stars.push(i);
  }

  if (separators.length === 0 && stars.length === 0) return { text: formula, changes: 0 };

  let out = "";
  let cursor = 0;
  const emit = (pos: number, width: number, text: string) => {
    out += formula.slice(cursor, pos);
    // The replacement carries its own single spaces; drop adjacent source
    // whitespace so `a * b` becomes `a \cdot b`, not `a  \cdot  b`.
    while (out.endsWith(" ") || out.endsWith("\t")) out = out.slice(0, -1);
    out += text;
    cursor = pos + width;
    while (formula[cursor] === " " || formula[cursor] === "\t") cursor += 1;
  };

  const events = [
    ...separators.map((pos) => ({ pos, width: 2, text: " & " })),
    ...stars.map((pos) => ({ pos, width: 1, text: " \\cdot " })),
  ].sort((a, b) => a.pos - b.pos);

  for (const event of events) emit(event.pos, event.width, event.text);
  out += formula.slice(cursor);

  return { text: out, changes: events.length };
}
