/**
 * expandAndValidate — the FR-008/FR-009 ladder. Before anything is written
 * into a formula, an ordered list of candidate ranges walks three cheap
 * syntactic guards and then `katex.__parse` (injected by the caller). The
 * first candidate clearing both is written; if none does, the document is
 * left untouched and `reason` goes to the notice channel.
 *
 * The guards are not belt-and-braces: `\textcolor{c}{^2}` *parses* while
 * meaning a superscript with no base, so "first candidate that parses" would
 * silently colour the wrong thing. Everything beyond the three guards is
 * KaTeX's call — the brace counter below locates the ladder's wider
 * candidates and never learns command arity, `\left`/`\right`, or
 * environments. See SPECs/formula-highlight-colors/research.md R2.
 */

export type AppliedRange =
  | { ok: true; from: number; to: number; expanded: boolean }
  | { ok: false; reason: string };

/** `(formulaWithWrap) => renders?` — `validateMath` in math-renderer.ts. */
export type MathValidator = (formula: string) => boolean;

const isLetter = (c: string | undefined): boolean => c !== undefined && /[a-zA-Z]/.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

const SKIP = (text: string, i: number) => (text[i] === "\\" ? i + 2 : i + 1);

/** Index↔index for every balanced, unescaped brace pair in `text`. */
function bracePairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < text.length; i = SKIP(text, i)) {
    if (text[i] === "{") stack.push(i);
    else if (text[i] === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        pairs.set(open, i);
        pairs.set(i, open);
      }
    }
  }
  return pairs;
}

/**
 * The three syntactic guards, run on the candidate fragment before `__parse`
 * ever sees it: no leading `^`/`_` (an operator torn from its base), brace
 * depth returns to zero and never goes negative, and no trailing lone `\`.
 * Exported for the guard tests.
 */
export function passesGuards(fragment: string): boolean {
  let i = 0;
  while (isSpace(fragment[i])) i += 1;
  if (fragment[i] === "^" || fragment[i] === "_") return false;

  let depth = 0;
  for (let j = i; j < fragment.length; j = SKIP(fragment, j)) {
    if (fragment[j] === "{") depth += 1;
    else if (fragment[j] === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  if (depth !== 0) return false;

  // A trailing run of `\` of odd length ends the candidate mid-escape; `\\`
  // is a complete token and fine.
  let end = fragment.length;
  while (end > 0 && isSpace(fragment[end - 1])) end -= 1;
  let slashes = 0;
  for (let j = end - 1; j >= 0 && fragment[j] === "\\"; j -= 1) slashes += 1;
  return slashes % 2 === 0;
}

/** The start of the base a `^`/`_` at `op` binds to: a balanced group, a
 *  control sequence, or a single character. */
function baseStart(formula: string, op: number): number {
  const before = op - 1;
  if (before < 0) return op;
  if (formula[before] === "}") {
    const open = bracePairs(formula).get(before);
    if (open !== undefined) return open;
    return before;
  }
  if (isLetter(formula[before])) {
    let k = before;
    while (k > 0 && isLetter(formula[k - 1])) k -= 1;
    if (k > 0 && formula[k - 1] === "\\") k -= 1;
    return k;
  }
  return before;
}

interface Range {
  from: number;
  to: number;
}

/**
 * The ladder, in order — C0 the user's exact range; C1 trimmed of
 * whitespace; C2 widened over a split control sequence and right until brace
 * depth returns to zero; C3 the enclosing `{…}` group widened left over an
 * owning command and over any `^`/`_` and its base, then right over the
 * command's remaining argument groups. Every step is a contiguous widening
 * (or, for C1, a whitespace trim): no braces are ever inserted outside the
 * user's selection.
 */
function ladder(formula: string, from: number, to: number): Range[] {
  const out: Range[] = [];
  const add = (f: number, t: number) => {
    if (f >= t) return;
    if (!out.some((c) => c.from === f && c.to === t)) out.push({ from: f, to: t });
  };

  add(from, to);

  // C1 — trim surrounding whitespace.
  {
    let f = from;
    let t = to;
    while (f < t && isSpace(formula[f])) f += 1;
    while (t > f && isSpace(formula[t - 1])) t -= 1;
    add(f, t);
  }

  // C2 — a partial control sequence on either side, then right until brace
  // depth returns to zero.
  {
    let f = from;
    let t = to;
    // Left end inside `\letters`: take the whole command.
    let j = f;
    while (j > 0 && isLetter(formula[j - 1])) j -= 1;
    if (j > 0 && formula[j - 1] === "\\") f = j - 1;
    // Right end inside a command: extend over its remaining letters.
    if (t > f && isLetter(formula[t - 1])) {
      let k = t - 1;
      while (k > 0 && isLetter(formula[k - 1])) k -= 1;
      if (k > 0 && formula[k - 1] === "\\") {
        while (isLetter(formula[t])) t += 1;
      }
    }
    // Right until every `{` the candidate opened is closed.
    let depth = 0;
    for (let i = f; i < t; i = SKIP(formula, i)) {
      if (formula[i] === "{") depth += 1;
      else if (formula[i] === "}") depth -= 1;
    }
    while (depth > 0 && t < formula.length) {
      const c = formula[t];
      if (c === "\\") {
        t += 2; // escapes consume the next char — `\{` is not a group delimiter
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      t += 1;
    }
    add(f, t);
  }

  // C3 — structure.
  {
    const pairs = bracePairs(formula);
    let f = from;
    let t = to;

    // Contents of the innermost group that strictly contains the selection.
    let innermost: Range | null = null;
    for (const [open, close] of pairs) {
      if (formula[open] !== "{") continue;
      if (open < f && close >= t) {
        if (innermost === null || open > innermost.from - 1) {
          innermost = { from: open + 1, to: close };
        }
      }
    }
    if (innermost) {
      f = innermost.from;
      t = innermost.to;
    }

    // Pull in the partner of every brace the range straddles, until no brace
    // crosses a boundary.
    for (;;) {
      let moved = false;
      for (let i = f; i < t; i = SKIP(formula, i)) {
        const partner = pairs.get(i);
        if (partner === undefined) continue;
        if (formula[i] === "}" && partner < f) {
          f = partner;
          moved = true;
          break;
        }
        if (formula[i] === "{" && partner >= t) {
          t = partner + 1;
          moved = true;
          break;
        }
      }
      if (!moved) break;
    }

    // Widen left over an owning command and over `^`/`_` chains with their
    // bases — `2` in `x^2` becomes `x^2`, `{a}` in `\frac{a}{b}` becomes
    // `\frac{a}`…
    let includedCommand = false;
    for (;;) {
      if (f === 0) break;
      const prev = formula[f - 1];
      if (prev === "^" || prev === "_") {
        f = baseStart(formula, f - 1);
        continue;
      }
      if (prev === "\\") {
        f -= 1;
        // The command now starts the range — its argument groups still sit
        // to the right and get pulled in below.
        includedCommand = true;
        continue;
      }
      if (prev === "{" || isLetter(prev)) {
        // An owning command ends at the `{`/letter run: `\frac{a}` widens to
        // include `\frac`; a bare `{` or a letter run with no `\` owns
        // nothing and stops the walk.
        let k = prev === "{" ? f - 1 : f;
        while (k > 0 && isLetter(formula[k - 1])) k -= 1;
        if (k > 0 && formula[k - 1] === "\\") {
          if (prev === "{") {
            // Taking the command means taking its whole argument group — the
            // `}` that closes the `{` we just stepped over.
            const close = pairs.get(f - 1);
            if (close !== undefined && close + 1 > t) t = close + 1;
          }
          f = k - 1;
          includedCommand = true;
          continue;
        }
        if (isLetter(prev)) {
          // Letters with no backslash aren't a command, but the run is one
          // symbol — include it rather than split it.
          f = k;
          continue;
        }
        break;
      }
      break;
    }

    // A command we just took still owns the argument groups after the range —
    // `\frac{a}` without its `{b}` is not a candidate KaTeX can accept.
    if (includedCommand) {
      for (;;) {
        if (formula[t] === "{") {
          const close = pairs.get(t);
          if (close === undefined) break;
          t = close + 1;
          continue;
        }
        if (formula[t] === "[") {
          const close = formula.indexOf("]", t + 1);
          if (close === -1) break;
          t = close + 1;
          continue;
        }
        break;
      }
    }

    add(f, t);
  }

  return out;
}

const WRAP_PREFIX = "\\textcolor{#000000}{";
const WRAP_SUFFIX = "}";

const UNRESCUABLE = "That selection can't be coloured — it isn't a whole fragment of the formula.";

/**
 * Walk the ladder and accept the first candidate that clears the guards and
 * parses. `from`/`to` are offsets inside `formula`. `expanded` is true when
 * the applied range differs from what was asked for — the caller must make
 * the applied range visible (FR-008).
 */
export function expandAndValidate(
  formula: string,
  from: number,
  to: number,
  validate: MathValidator,
): AppliedRange {
  for (const candidate of ladder(formula, from, to)) {
    const fragment = formula.slice(candidate.from, candidate.to);
    if (!passesGuards(fragment)) continue;
    const wrapped =
      formula.slice(0, candidate.from) +
      WRAP_PREFIX +
      fragment +
      WRAP_SUFFIX +
      formula.slice(candidate.to);
    if (validate(wrapped)) {
      return {
        ok: true,
        from: candidate.from,
        to: candidate.to,
        expanded: candidate.from !== from || candidate.to !== to,
      };
    }
  }
  return { ok: false, reason: UNRESCUABLE };
}
