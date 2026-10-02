/**
 * A strict evaluator for the LaTeX subset that shows up as *closed* formulas
 * in derivation notes: arithmetic, powers, fractions, roots, parentheses
 * (including `\left(…\right)`), elementary functions, `\lvert…\rvert`/`|…|`
 * absolute value, and the constants `\pi`, `e`, `i`, `j` — complex
 * arithmetic throughout, so `2660-2565*j` evaluates the way the notes mean
 * it. Plot syntax also recognizes bare `sin(x)`-style names and ordinary
 * powers; rendered TeX keeps its own token boundaries.
 *
 * Anything outside the subset — `\text`, environments, `\\`, `\%`, unknown
 * commands, unknown letters — reports `open`, never a guess. Free variables
 * are returned so callers can bind them (check-step samples, plot's `x`).
 *
 * Rules: SPECs/math-workflow/spec.md (FR-6, FR-7).
 */

import { topLevelMask } from "./scan";

export interface Complex {
  re: number;
  im: number;
}

const cx = (re: number, im = 0): Complex => ({ re, im });
const add = (a: Complex, b: Complex) => cx(a.re + b.re, a.im + b.im);
const sub = (a: Complex, b: Complex) => cx(a.re - b.re, a.im - b.im);
const mul = (a: Complex, b: Complex) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: Complex, b: Complex) => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const neg = (a: Complex) => cx(-a.re, -a.im);
const abs = (a: Complex) => Math.hypot(a.re, a.im);
const arg = (a: Complex) => Math.atan2(a.im, a.re);
const exp = (a: Complex) => {
  const k = Math.exp(a.re);
  return cx(k * Math.cos(a.im), k * Math.sin(a.im));
};
const ln = (a: Complex) => cx(Math.log(abs(a)), arg(a));
const pow = (a: Complex, b: Complex): Complex => {
  if (a.re === 0 && a.im === 0 && b.im === 0 && Number.isFinite(b.re) && b.re > 0) return cx(0);
  // Real base + real integer exponent: the common case stays exact-ish.
  if (a.im === 0 && b.im === 0 && Number.isInteger(b.re)) {
    return cx(Math.pow(a.re, b.re));
  }
  return exp(mul(b, ln(a)));
};
const sqrt = (a: Complex) => pow(a, cx(0.5));
const sin = (a: Complex) => cx(Math.sin(a.re) * Math.cosh(a.im), Math.cos(a.re) * Math.sinh(a.im));
const cos = (a: Complex) => cx(Math.cos(a.re) * Math.cosh(a.im), -Math.sin(a.re) * Math.sinh(a.im));
const sinh = (a: Complex) => cx(Math.sinh(a.re) * Math.cos(a.im), Math.cosh(a.re) * Math.sin(a.im));
const cosh = (a: Complex) => cx(Math.cosh(a.re) * Math.cos(a.im), Math.sinh(a.re) * Math.sin(a.im));
const tan = (a: Complex) => div(sin(a), cos(a));
const tanh = (a: Complex) => div(sinh(a), cosh(a));
const asin = (a: Complex) => {
  const i = cx(0, 1);
  return mul(neg(i), ln(add(mul(i, a), sqrt(sub(cx(1), mul(a, a))))));
};
const acos = (a: Complex) => sub(cx(Math.PI / 2), asin(a));
const atan = (a: Complex) => {
  const i = cx(0, 1);
  return mul(div(i, cx(2)), sub(ln(sub(cx(1), mul(i, a))), ln(add(cx(1), mul(i, a)))));
};
const asinh = (a: Complex) => ln(add(a, sqrt(add(mul(a, a), cx(1)))));
const acosh = (a: Complex) => ln(add(a, mul(sqrt(add(a, cx(1))), sqrt(sub(a, cx(1))))));
const atanh = (a: Complex) => mul(cx(0.5), sub(ln(add(cx(1), a)), ln(sub(cx(1), a))));

/** Function table shared by `\name` and bare `name` forms. `^{‑1}` after a
 *  name maps through INVERSES. */
const FUNCTIONS: Record<string, (z: Complex) => Complex> = {
  sin,
  cos,
  tan,
  sec: (z) => div(cx(1), cos(z)),
  csc: (z) => div(cx(1), sin(z)),
  cot: (z) => div(cx(1), tan(z)),
  sinh,
  cosh,
  tanh,
  arcsin: asin,
  arccos: acos,
  arctan: atan,
  arcsinh: asinh,
  arccosh: acosh,
  arctanh: atanh,
  exp,
  ln,
  log: (z) => div(ln(z), cx(Math.LN10)),
  sqrt,
};

const INVERSES: Record<string, string> = {
  sin: "arcsin",
  cos: "arccos",
  tan: "arctan",
  sinh: "arcsinh",
  cosh: "arccosh",
  tanh: "arctanh",
  arcsin: "sin",
  arccos: "cos",
  arctan: "tan",
  arcsinh: "sinh",
  arccosh: "cosh",
  arctanh: "tanh",
};

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

export type Expr =
  | { t: "num"; v: Complex }
  | { t: "var"; name: string }
  | { t: "neg"; a: Expr }
  | { t: "abs"; a: Expr }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Expr; b: Expr }
  | { t: "fn"; name: string; arg: Expr };

const numLit = (re: number, im = 0): Expr => ({ t: "num", v: cx(re, im) });

export class OpenFormula extends Error {}

/** Characters that begin a factor — the juxtaposition test at term level. */
const FACTOR_START = /[\d.(|a-zA-Z\\]/;
const FRACTION_COMMANDS = new Set(["frac", "dfrac", "tfrac"]);

class Parser {
  pos = 0;
  /** Inside a `|…|` absolute-value group a `|` is the closer, not a factor
   *  start — juxtaposition checks this. */
  private absDepth = 0;
  constructor(
    readonly src: string,
    readonly syntax: "tex" | "plot",
  ) {}

  private ws() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos += 1;
  }

  private peek(): string {
    this.ws();
    return this.src[this.pos] ?? "";
  }

  private eat(text: string): boolean {
    if (this.src.startsWith(text, this.pos)) {
      this.pos += text.length;
      return true;
    }
    return false;
  }

  private expect(text: string) {
    if (!this.eat(text)) throw new OpenFormula(`expected ${text} at ${this.pos}`);
  }

  /** `\name` or bare `name`, or a single control symbol like `\,`. */
  private command(): string | null {
    if (this.src[this.pos] !== "\\") return null;
    const match = /^\\([a-zA-Z]+|.)/.exec(this.src.slice(this.pos));
    if (!match) return null;
    this.pos += match[0].length;
    return match[1]!;
  }

  parse(): Expr {
    const expr = this.expr();
    if (this.peek() !== "") throw new OpenFormula(`trailing input at ${this.pos}`);
    return expr;
  }

  private expr(): Expr {
    let left = this.term();
    for (;;) {
      const ch = this.peek();
      if (ch === "+" || ch === "-") {
        this.pos += 1;
        left = { t: "bin", op: ch, a: left, b: this.term() };
      } else {
        return left;
      }
    }
  }

  private term(): Expr {
    let left = this.signed();
    for (;;) {
      const ch = this.peek();
      if (ch === "*" || ch === "/") {
        this.pos += 1;
        left = { t: "bin", op: ch, a: left, b: this.signed() };
        continue;
      }
      if (ch === "\\") {
        const save = this.pos;
        const name = this.command();
        if (name === "cdot" || name === "times" || name === "div") {
          left = { t: "bin", op: name === "div" ? "/" : "*", a: left, b: this.signed() };
          continue;
        }
        // Terminators end the term — `\right`, `\end`, `\rvert`, `\\` are
        // never juxtaposed factors.
        this.pos = save;
        if (name === "right" || name === "end" || name === "rvert" || name === "\\") {
          return left;
        }
      }
      if (ch === "|" && this.absDepth > 0) return left; // |…| closer
      // Juxtaposition: `2x`, `2\pi`, `2(x+1)`, `x \sin y`.
      if (FACTOR_START.test(ch)) {
        left = { t: "bin", op: "*", a: left, b: this.signed() };
        continue;
      }
      return left;
    }
  }

  /** Unary +/- binds looser than `^` — `-x^2` is `-(x^2)`. */
  private signed(): Expr {
    const ch = this.peek();
    if (ch === "+" || ch === "-") {
      this.pos += 1;
      const operand = this.signed();
      return ch === "-" ? { t: "neg", a: operand } : operand;
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.postfix();
    if (this.peek() === "^") {
      this.pos += 1;
      const exponent = this.exponent();
      return { t: "bin", op: "^", a: base, b: exponent };
    }
    return base;
  }

  private exponent(): Expr {
    if (this.syntax === "plot") return this.signed();
    if (this.peek() === "\\") return this.commandAtom("script");
    return this.groupOrAtom();
  }

  /** A `{…}` group or a *single token* atom — TeX argument rules, so
   *  `\frac12` reads `1` and `2` as two separate arguments. */
  private groupOrAtom(): Expr {
    this.ws();
    const ch = this.src[this.pos] ?? "";
    if (ch === "{") {
      this.pos += 1;
      const inner = this.expr();
      this.expect("}");
      return inner;
    }
    if (ch === "\\") return this.commandAtom(this.syntax === "tex" ? "argument" : "expression");
    if (/\d/.test(ch)) {
      this.pos += 1;
      return numLit(Number(ch));
    }
    if (/[a-zA-Z]/.test(ch)) {
      this.pos += 1;
      return this.named(ch, this.syntax === "plot");
    }
    if (this.syntax === "tex") throw new OpenFormula("Unsupported unbraced argument; use braces");
    return this.postfix();
  }

  private postfix(): Expr {
    return this.atom();
  }

  private atom(): Expr {
    const ch = this.peek();
    if (ch === "") throw new OpenFormula("unexpected end");

    // Numbers.
    const num = /^(\d+\.?\d*|\.\d+)/.exec(this.src.slice(this.pos));
    if (num) {
      this.pos += num[0].length;
      return numLit(parseFloat(num[0]));
    }

    if (ch === "(") {
      this.pos += 1;
      const inner = this.expr();
      this.expect(")");
      return inner;
    }

    if (ch === "|") {
      this.pos += 1;
      this.absDepth += 1;
      const inner = this.expr();
      this.expect("|");
      this.absDepth -= 1;
      return { t: "abs", a: inner };
    }

    if (ch === "\\") return this.commandAtom();

    if (/[a-zA-Z]/.test(ch)) {
      // Multi-letter words only survive whole when they name a function or
      // constant — `ab` is a·b, `asin` is a·sin(…). Anything else consumes
      // one letter and lets juxtaposition multiply the rest.
      const word = /^[a-zA-Z]+/.exec(this.src.slice(this.pos))![0];
      const whole = this.syntax === "plot" && (word in FUNCTIONS || word === "pi");
      const name = whole ? word : word[0]!;
      this.pos += name.length;
      return this.named(name);
    }

    if (ch === "{") {
      this.pos += 1;
      const inner = this.expr();
      this.expect("}");
      return inner;
    }

    throw new OpenFormula(`unexpected ${JSON.stringify(ch)}`);
  }

  private commandAtom(context: "expression" | "script" | "argument" = "expression"): Expr {
    const name = this.command()!;
    if (
      (context === "argument" && name !== "pi") ||
      (context === "script" && name !== "pi" && !FRACTION_COMMANDS.has(name))
    ) {
      throw new OpenFormula(`Unsupported unbraced ${context} command \\${name}; use braces`);
    }

    if (name === "left") {
      const open = this.src[this.pos];
      this.pos += 1;
      if (open === "|") {
        const inner = this.expr();
        this.expect("\\right");
        if (this.src[this.pos] !== "|") throw new OpenFormula("unbalanced \\left|");
        this.pos += 1;
        return { t: "abs", a: inner };
      }
      if (open === "(" || open === "[") {
        const inner = this.expr();
        this.expect("\\right");
        const close = this.src[this.pos];
        if (close !== ")" && close !== "]" && close !== ".") {
          throw new OpenFormula("unbalanced \\left(");
        }
        this.pos += 1;
        return inner;
      }
      throw new OpenFormula(`unsupported \\left${open}`);
    }
    if (name === "right") throw new OpenFormula("unbalanced \\right");

    if (FRACTION_COMMANDS.has(name)) {
      const num = this.groupOrAtom();
      const den = this.groupOrAtom();
      return { t: "bin", op: "/", a: num, b: den };
    }

    if (name === "sqrt") {
      this.ws();
      let index: Expr | null = null;
      if (this.src[this.pos] === "[") {
        this.pos += 1;
        index = this.expr();
        this.expect("]");
      }
      const radicand = this.groupOrAtom();
      if (index) {
        return { t: "bin", op: "^", a: radicand, b: { t: "bin", op: "/", a: numLit(1), b: index } };
      }
      return { t: "fn", name: "sqrt", arg: radicand };
    }

    if (name === "lvert" || name === "rvert") {
      // \lvert expr \rvert
      if (name === "rvert") throw new OpenFormula("unbalanced \\rvert");
      const inner = this.expr();
      const save2 = this.pos;
      this.ws();
      if (this.command() !== "rvert") {
        this.pos = save2;
        throw new OpenFormula("unbalanced \\lvert");
      }
      return { t: "abs", a: inner };
    }

    if (name === "pi") return numLit(Math.PI);

    if (name in FUNCTIONS) return this.fnCall(name);

    // Everything else — \text, \begin, \\, \%, spacing, accents, unknown —
    // marks the formula open rather than guessing.
    throw new OpenFormula(`unsupported \\${name}`);
  }

  /** `\sin^2 x`, `\cosh^{-1}(2)`, `\ln x` — the `^{…}` belongs to the
   *  function name here, so it is read before the argument. */
  private fnCall(name: string): Expr {
    let fn = name;
    let powerOf: Expr | null = null;
    this.ws();
    if (this.src[this.pos] === "^") {
      this.pos += 1;
      const exp = this.exponent();
      // `-1` means the inverse function; anything else powers the result.
      const isNegOne = exp.t === "neg" && exp.a.t === "num" && exp.a.v.re === 1 && exp.a.v.im === 0;
      if (isNegOne && INVERSES[fn]) {
        fn = INVERSES[fn]!;
      } else {
        powerOf = exp;
      }
    }
    const arg = this.signed();
    let node: Expr = { t: "fn", name: fn, arg };
    if (powerOf) node = { t: "bin", op: "^", a: node, b: powerOf };
    return node;
  }

  /** A bare word: `x` → variable, `e`/`i`/`j`/`pi` → constant, `sin` → fn. */
  private named(name: string, allowSubscript = true): Expr {
    if (name in FUNCTIONS) return this.fnCall(name);
    if (name === "pi") return numLit(Math.PI);
    if (name === "e") return numLit(Math.E);
    if (name === "i" || name === "j") return numLit(0, 1);
    // Multi-letter words that aren't functions are not silently variables —
    // `sinh` got here only if unknown, `text` stays open.
    if (name.length > 1) {
      // A trailing _suffix still can't rescue it.
      throw new OpenFormula(`unknown word ${name}`);
    }
    let varName = name;
    if (allowSubscript && this.src[this.pos] === "_") {
      this.pos += 1;
      if (this.src[this.pos] === "{") {
        this.pos += 1;
        const start = this.pos;
        let depth = 1;
        while (depth > 0 && this.pos < this.src.length) {
          if (this.src[this.pos] === "{") depth += 1;
          else if (this.src[this.pos] === "}") depth -= 1;
          this.pos += 1;
        }
        varName = `${name}_${this.src.slice(start, this.pos - 1)}`;
      } else {
        varName = `${name}_${this.src[this.pos]}`;
        this.pos += 1;
      }
    }
    return { t: "var", name: varName };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type EvalOutcome =
  | { kind: "value"; value: Complex }
  | { kind: "open"; reason: string; freeVars: string[] }
  | { kind: "error"; message: string };

export function parseExpression(src: string, syntax: "tex" | "plot" = "tex"): Expr {
  return new Parser(src, syntax).parse();
}

export function freeVariables(expr: Expr): string[] {
  const found = new Set<string>();
  const walk = (e: Expr) => {
    switch (e.t) {
      case "var":
        found.add(e.name);
        break;
      case "neg":
      case "abs":
        walk(e.a);
        break;
      case "bin":
        walk(e.a);
        walk(e.b);
        break;
      case "fn":
        walk(e.arg);
        break;
    }
  };
  walk(expr);
  return [...found].sort();
}

export function evaluateExpr(expr: Expr, env: Record<string, Complex>): Complex {
  switch (expr.t) {
    case "num":
      return expr.v;
    case "var": {
      const bound = env[expr.name];
      if (!bound) throw new OpenFormula(`free variable ${expr.name}`);
      return bound;
    }
    case "neg":
      return neg(evaluateExpr(expr.a, env));
    case "abs":
      return cx(abs(evaluateExpr(expr.a, env)));
    case "fn":
      return FUNCTIONS[expr.name]!(evaluateExpr(expr.arg, env));
    case "bin": {
      const a = evaluateExpr(expr.a, env);
      const b = evaluateExpr(expr.b, env);
      if (expr.op === "+") return add(a, b);
      if (expr.op === "-") return sub(a, b);
      if (expr.op === "*") return mul(a, b);
      if (expr.op === "/") return div(a, b);
      return pow(a, b);
    }
  }
}

/** Evaluate a source string against `env`. Free variables report `open`
 *  with the names still needed; anything outside the subset is `open` too
 *  (it is never an error to skip). */
export function evaluateSource(src: string, env: Record<string, Complex> = {}): EvalOutcome {
  try {
    const expr = parseExpression(src);
    const free = freeVariables(expr).filter((name) => !(name in env));
    if (free.length > 0) {
      return {
        kind: "open",
        reason: `free variable${free.length > 1 ? "s" : ""}: ${free.join(", ")}`,
        freeVars: free,
      };
    }
    const value = evaluateExpr(expr, env);
    if (!Number.isFinite(value.re) || !Number.isFinite(value.im)) {
      return { kind: "open", reason: "non-finite result", freeVars: [] };
    }
    return { kind: "value", value };
  } catch (err) {
    if (err instanceof OpenFormula) {
      return { kind: "open", reason: err.message, freeVars: [] };
    }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Split on top-level `=` / `\approx` — braces and environments mask. */
export function equalitySides(src: string): string[] | null {
  const mask = topLevelMask(src);
  const cuts: number[] = [];
  for (let i = 0; i < src.length; i += 1) {
    if (!mask[i]) continue;
    if (src[i] === "=") {
      cuts.push(i);
    } else if (src.startsWith("\\approx", i) || src.startsWith("\\doteq", i)) {
      cuts.push(i);
      i += src.startsWith("\\approx", i) ? 6 : 5;
    }
  }
  if (cuts.length === 0) return null;
  const sides: string[] = [];
  let at = 0;
  for (const cut of cuts) {
    sides.push(src.slice(at, cut).trim());
    // Skip the relation token itself.
    at = src[cut] === "=" ? cut + 1 : cut + (src.startsWith("\\approx", cut) ? 7 : 6);
  }
  sides.push(src.slice(at).trim());
  return sides.some((s) => s === "") ? null : sides;
}

const EPS = 1e-9;

/** Relative comparison tolerant of float noise. */
export function sameValue(a: Complex, b: Complex): boolean {
  if (![a.re, a.im, b.re, b.im].every(Number.isFinite)) return false;
  const scale = Math.max(1, Math.abs(a.re), Math.abs(a.im), Math.abs(b.re), Math.abs(b.im));
  const ar = a.re / scale,
    ai = a.im / scale;
  const br = b.re / scale,
    bi = b.im / scale;
  const norm = Math.max(1 / scale, Math.hypot(ar, ai), Math.hypot(br, bi));
  return Math.hypot(ar - br, ai - bi) <= EPS * norm;
}

// ---------------------------------------------------------------------------
// Step checking (FR-7) — numeric, not symbolic
// ---------------------------------------------------------------------------

/** Deterministic sample values: non-special, mixed sign/magnitude so dropped
 *  signs and wrong coefficients both show. Three trials are enough for the
 *  slips these notes actually contain. */
const SAMPLES = [1.7, -2.3, 0.61, 3.7, -0.77, 4.3, -1.1, 2.9];

function sampleEnv(vars: string[], trial: number): Record<string, Complex> {
  const env: Record<string, Complex> = {};
  vars.forEach((name, index) => {
    env[name] = cx(SAMPLES[(index + trial * 3) % SAMPLES.length]!);
  });
  return env;
}

/** Only single equations reduce to a residual; expressions retain their value. */
function differenceSource(src: string, sides: string[] | null): string {
  return sides ? `(${sides[0]})-(${sides[1]})` : src;
}

export type CheckResult =
  | { kind: "equal" }
  | { kind: "differs"; varName: string; sample: number; prev: Complex; next: Complex }
  | { kind: "open"; reason: string }
  | { kind: "error"; message: string };

/** Compare expressions pointwise, or single-equation residuals up to a
 * constant nonzero factor. These are numeric checks, not symbolic proofs. */
export function checkEquivalent(prevSrc: string, nextSrc: string): CheckResult {
  const prevSides = equalitySides(prevSrc);
  const nextSides = equalitySides(nextSrc);
  if ((prevSides && prevSides.length !== 2) || (nextSides && nextSides.length !== 2)) {
    return { kind: "open", reason: "Equation chains are not supported" };
  }
  if (Boolean(prevSides) !== Boolean(nextSides)) {
    return { kind: "open", reason: "Compare two expressions or two single equations" };
  }
  const proportional = prevSides !== null;
  let prevExpr: Expr;
  let nextExpr: Expr;
  try {
    prevExpr = parseExpression(differenceSource(prevSrc, prevSides));
    nextExpr = parseExpression(differenceSource(nextSrc, nextSides));
  } catch (err) {
    return {
      kind: "open",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const vars = [...new Set([...freeVariables(prevExpr), ...freeVariables(nextExpr)])].sort();

  let ratio: Complex | null = null;
  let successfulTrials = 0;
  const requiredTrials = vars.length > 0 ? 3 : 1;
  const candidates = vars.length > 0 ? SAMPLES.length : 1;
  for (let trial = 0; trial < candidates && successfulTrials < requiredTrials; trial += 1) {
    const env = sampleEnv(vars, trial);
    let prev: Complex;
    let next: Complex;
    try {
      prev = evaluateExpr(prevExpr, env);
      next = evaluateExpr(nextExpr, env);
    } catch {
      continue; // A sample lands on a singularity — try the next one.
    }
    if (![prev.re, prev.im, next.re, next.im].every(Number.isFinite)) continue;

    if (!proportional) {
      if (sameValue(prev, next)) {
        successfulTrials += 1;
        continue;
      }
      const varName = vars[0] ?? "";
      return { kind: "differs", varName, sample: env[varName]?.re ?? 0, prev, next };
    }

    const prevZero = abs(prev) <= EPS;
    const nextZero = abs(next) <= EPS;
    if (prevZero !== nextZero) {
      // One side's residual vanishes where the other's doesn't.
      const varName = vars[0] ?? "";
      return { kind: "differs", varName, sample: env[varName]?.re ?? 0, prev, next };
    }
    if (prevZero && nextZero) {
      successfulTrials += 1;
      continue;
    }

    const r = div(prev, next);
    if (![r.re, r.im].every(Number.isFinite) || (r.re === 0 && r.im === 0)) continue;
    if (ratio === null) {
      ratio = r;
    } else if (!sameValue(r, ratio)) {
      const varName = vars[0] ?? "";
      return { kind: "differs", varName, sample: env[varName]?.re ?? 0, prev, next };
    }
    successfulTrials += 1;
  }
  return successfulTrials >= requiredTrials
    ? { kind: "equal" }
    : { kind: "open", reason: "Not enough finite samples to compare these steps" };
}

/** `a+bj` / `a - bj` in the notes' own `j` convention; ~6 significant
 *  digits, trailing zeros trimmed. */
export function formatComplex(c: Complex): string {
  const round = (n: number) => {
    if (n === 0) return "0";
    const digits = Math.max(0, 5 - Math.floor(Math.log10(Math.abs(n))));
    const text = n.toFixed(Math.min(digits, 10));
    return text.includes(".") && !text.includes("e") ? text.replace(/\.?0+$/, "") : text;
  };
  const tiny = 1e-10 * Math.max(1, Math.abs(c.re), Math.abs(c.im));
  const re = Math.abs(c.re) < tiny ? 0 : c.re;
  const im = Math.abs(c.im) < tiny ? 0 : c.im;
  if (im === 0) return round(re);
  if (re === 0) return `${round(im)}j`;
  const sign = im < 0 ? "-" : "+";
  return `${round(re)} ${sign} ${round(Math.abs(im))}j`;
}
