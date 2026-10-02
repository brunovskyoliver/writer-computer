/**
 * Convert between the two ways these notes write a derivation: a run of
 * `$$` blocks (one per step) and a single `$$` holding an `aligned`
 * environment (one row per step, `&` pinning the relation column).
 *
 * `alignRun` joins, `splitAligned` un-joins. Both need to know which
 * characters sit at a formula's *top level*: `&` and `\\` inside a nested
 * `\begin{…}…\end{…}` or a `{…}` group belong to that structure and are
 * never the row's own markers.
 *
 * Rules: SPECs/math-workflow/spec.md (FR-5).
 */

import { ENV_RE, matchBrace, topLevelMask } from "./scan";

/** `&` gets its alignment column from these relations. Longest match first
 *  so `\implies` wins over `\impliedby`-prefix collisions and `=` loses to
 *  the named relations only by position, not by preference. */
const RELATIONS = [
  "\\impliedby",
  "\\implies",
  "\\approx",
  "\\simeq",
  "\\equiv",
  "\\propto",
  "\\cong",
  "\\iff",
  "\\leq",
  "\\geq",
  "\\neq",
  "\\sim",
  "\\ll",
  "\\gg",
  "=",
];

/** Envs that hold the `&`-aligned / `\\`-row grammar this module joins and
 *  splits on. */
const SPLITTABLE_ENV = /^(?:aligned|alignedat|align|align\*|gathered|split)$/;

/** A splittable environment covering the whole trimmed formula, or null. */
function splittableBody(formula: string): { name: string; from: number; to: number } | null {
  const stack: { name: string; from: number; beginEnd: number }[] = [];
  for (const match of formula.matchAll(ENV_RE)) {
    if (match.index > 0 && formula[match.index - 1] === "\\") continue;
    const name = match[2]!;
    if (match[1] === "begin") {
      stack.push({ name, from: match.index, beginEnd: match.index + match[0].length });
      continue;
    }
    for (let at = stack.length - 1; at >= 0; at -= 1) {
      if (stack[at]!.name !== name) continue;
      const open = stack.splice(at, 1)[0]!;
      if (!SPLITTABLE_ENV.test(name)) break;
      const end = match.index + match[0].length;
      if (formula.slice(0, open.from).trim() || formula.slice(end).trim()) break;

      let bodyFrom = open.beginEnd;
      if (name === "alignedat") {
        while (bodyFrom < match.index && /\s/.test(formula[bodyFrom]!)) bodyFrom += 1;
        if (formula[bodyFrom] !== "{") return null;
        const close = matchBrace(formula, bodyFrom);
        if (close === null || close >= match.index) return null;
        bodyFrom = close + 1;
      }
      return { name, from: bodyFrom, to: match.index };
    }
  }
  return null;
}

/** First top-level relation index in `step`, or -1. */
function firstRelation(step: string): number {
  const mask = topLevelMask(step);
  for (let i = 0; i < step.length; i += 1) {
    if (!mask[i]) continue;
    for (const relation of RELATIONS) {
      if (step.startsWith(relation, i)) return i;
    }
  }
  return -1;
}

/**
 * Join `$$`-block formulas into an `aligned` body: one row per step, `&`
 * before the first top-level relation. Returns null when every step is
 * blank (nothing to join). Steps already carrying a top-level `&` are left
 * as-is — the user aligned them by hand.
 */
export function alignRun(steps: string[]): string | null {
  const rows = steps
    .map((step) => step.trim())
    .filter((step) => step !== "")
    .map((step) => {
      if (topLevelMask(step).some((top, i) => top && step[i] === "&")) return step;
      const at = firstRelation(step);
      if (at === -1) return step;
      return step.slice(0, at).replace(/\s+$/, " ") + "&" + step.slice(at);
    });
  return rows.length === 0 ? null : rows.join(" \\\\\n");
}

/**
 * Split a whole `aligned`-family formula into rows: one row per
 * top-level `\\` (an optional `\\[dim]` spacing arg is consumed with it),
 * top-level `&` stripped. Returns null when there is no such environment.
 */
export function splitAligned(formula: string): string[] | null {
  const body = splittableBody(formula);
  if (!body) return null;
  const text = formula.slice(body.from, body.to);
  const mask = topLevelMask(text);

  const rows: string[] = [];
  let rowStart = 0;
  for (let i = 0; i < text.length - 1; i += 1) {
    if (!mask[i] || text[i] !== "\\" || text[i + 1] !== "\\") continue;
    // `\\begin` reached earlier would have been inside an env (masked), so a
    // top-level `\\` here is a row break. Optional [dim] arg rides along.
    rows.push(text.slice(rowStart, i));
    let next = i + 2;
    const dim = /^(\[[\d.]+\s*(?:pt|mm|cm|em|ex|mu)\])/.exec(text.slice(next));
    if (dim) next += dim[0].length;
    rowStart = next;
    i = next - 1;
  }
  rows.push(text.slice(rowStart));

  const cleaned = rows
    .map((row) => {
      const rowMask = topLevelMask(row);
      let out = "";
      for (let i = 0; i < row.length; i += 1) {
        if (row[i] === "&" && rowMask[i]) continue;
        out += row[i];
      }
      return out.trim();
    })
    .filter((row) => row !== "");

  return cleaned.length === 0 ? null : cleaned;
}
