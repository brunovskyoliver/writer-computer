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

type CommandRole = { operand: boolean; literalArgs?: number };
const COMMAND_ROLES: Record<string, CommandRole | undefined> = {
  ...Object.fromEntries(
    (
      "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega " +
      "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega infty ell imath jmath partial nabla " +
      "sin cos tan cot sec csc sinh cosh tanh coth arcsin arccos arctan log ln exp lim max min sup inf sum prod int oint"
    )
      .split(" ")
      .map((name) => [name, { operand: true }]),
  ),
  ...Object.fromEntries(
    "text textnormal textrm textsf texttt textbf textit textup textmd textsc mbox operatorname"
      .split(" ")
      .map((name) => [name, { operand: true, literalArgs: 1 }]),
  ),
  textcolor: { operand: true, literalArgs: 1 },
  href: { operand: true, literalArgs: 1 },
  url: { operand: true, literalArgs: 1 },
  tag: { operand: false, literalArgs: 1 },
  label: { operand: false, literalArgs: 1 },
  ref: { operand: true, literalArgs: 1 },
  eqref: { operand: true, literalArgs: 1 },
  color: { operand: false, literalArgs: 1 },
  hspace: { operand: false, literalArgs: 1 },
  vspace: { operand: false, literalArgs: 1 },
  rule: { operand: false, literalArgs: 2 },
  begin: { operand: false, literalArgs: 1 },
  end: { operand: false, literalArgs: 1 },
};

const letter = (char: string | undefined) => char !== undefined && /[A-Za-z]/.test(char);
const operandChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

function skipSpace(formula: string, at: number): number {
  while (at < formula.length && /\s/.test(formula[at]!)) at += 1;
  return at;
}

/** TeX ignores comments as well as whitespace between a command and its argument. */
function skipTrivia(formula: string, at: number, mask: Uint8Array): number {
  at = skipSpace(formula, at);
  while (formula[at] === "%") {
    const newline = formula.indexOf("\n", at + 1);
    const to = newline === -1 ? formula.length : newline;
    mask.fill(2, at, to);
    at = skipSpace(formula, to);
  }
  return at;
}

/** Invocation-local mask: 1 is literal syntax, 2 is comment text. */
function starMask(formula: string): Uint8Array {
  const mask = new Uint8Array(formula.length);
  for (let i = 0; i < formula.length; i += 1) {
    if (formula[i] === "%") {
      const newline = formula.indexOf("\n", i + 1);
      const to = newline === -1 ? formula.length : newline;
      mask.fill(2, i, to);
      i = to - 1;
    } else if (formula[i] === "^") {
      const at = skipTrivia(formula, i + 1, mask);
      if (formula[at] === "*") mask[at] = 1;
      if (formula[at] === "{") {
        const to = (matchBrace(formula, at) ?? formula.length - 1) + 1;
        mask.fill(1, i, to);
        i = to - 1;
      }
    } else if (formula[i] === "\\") {
      let end = i + 1;
      while (letter(formula[end])) end += 1;
      if (end === i + 1) {
        mask.fill(1, i, Math.min(i + 2, formula.length));
        i += 1;
        continue;
      }
      const name = formula.slice(i + 1, end);
      const role = COMMAND_ROLES[name];
      let at = skipTrivia(formula, end, mask);
      const starred = formula[at] === "*" && !(role?.operand && !role.literalArgs);
      if (starred) {
        mask[at] = 1;
        at = skipTrivia(formula, at + 1, mask);
      }
      let args = role?.literalArgs ?? (starred ? Infinity : 0);
      let consumed = end;
      for (let arg = 0; arg < args && formula[at] === "{"; arg += 1) {
        const to = (matchBrace(formula, at) ?? formula.length - 1) + 1;
        if (arg === 0 && name === "begin" && COLSPEC_ENV.has(formula.slice(at + 1, to - 1)))
          args += 1;
        mask.fill(1, at, to);
        consumed = to;
        at = skipTrivia(formula, to, mask);
      }
      i = consumed - 1;
    }
  }
  return mask;
}

/** Conservative source-token boundaries. Unknown suffix commands stay literal. */
function betweenOperands(formula: string, pos: number, mask: Uint8Array): boolean {
  let left = pos - 1;
  while (left >= 0 && /\s/.test(formula[left]!)) left -= 1;
  if (left < 0 || mask[left] === 2) return false;
  const lhs = formula[left];
  if (!operandChar(lhs) && !"}])|".includes(lhs!)) return false;
  if (letter(lhs)) {
    let start = left;
    while (letter(formula[start - 1])) start -= 1;
    let slash = start - 1;
    while (formula[slash] === "\\") slash -= 1;
    if ((start - 1 - slash) % 2 === 1) {
      const role = COMMAND_ROLES[formula.slice(start, left + 1)];
      if (!role?.operand || role.literalArgs) return false;
    }
  }
  let right = skipSpace(formula, pos + 1);
  if (formula[right] === "+" || formula[right] === "-") right = skipSpace(formula, right + 1);
  if (right >= formula.length || mask[right] === 2) return false;
  const rhs = formula[right];
  if (operandChar(rhs) || "{([|".includes(rhs!)) return true;
  if (rhs !== "\\") return false;
  let end = right + 1;
  while (letter(formula[end])) end += 1;
  if (end === right + 1) return formula[end] === "{";
  return COMMAND_ROLES[formula.slice(right + 1, end)]?.operand !== false;
}

export interface TidyResult {
  text: string;
  /** Number of rewrites applied — 0 means nothing changed. */
  changes: number;
}

export function tidyFormula(formula: string): TidyResult {
  const bodies = cellEnvBodies(formula);
  const protectedStars = starMask(formula);

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
    if (protectedStars[i] || !betweenOperands(formula, i, protectedStars)) continue;
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
