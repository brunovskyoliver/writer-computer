/**
 * The table behind the "Insert Math Symbol" palette intent (FR-9): ~150
 * common LaTeX commands grouped the way a student looks for them. `code`
 * is the exact source inserted into the document (leading `\` included);
 * `name` is the searchable label.
 */

export interface MathSymbol {
  code: string;
  name: string;
  group: string;
}

const g = (group: string, entries: Array<[string, string]>): MathSymbol[] =>
  entries.map(([code, name]) => ({ code, name, group }));

export const MATH_SYMBOLS: MathSymbol[] = [
  ...g("Greek", [
    ["\\alpha", "alpha"],
    ["\\beta", "beta"],
    ["\\gamma", "gamma"],
    ["\\delta", "delta"],
    ["\\epsilon", "epsilon"],
    ["\\varepsilon", "varepsilon"],
    ["\\zeta", "zeta"],
    ["\\eta", "eta"],
    ["\\theta", "theta"],
    ["\\vartheta", "vartheta"],
    ["\\iota", "iota"],
    ["\\kappa", "kappa"],
    ["\\lambda", "lambda"],
    ["\\mu", "mu"],
    ["\\nu", "nu"],
    ["\\xi", "xi"],
    ["\\pi", "pi"],
    ["\\varpi", "varpi"],
    ["\\rho", "rho"],
    ["\\varrho", "varrho"],
    ["\\sigma", "sigma"],
    ["\\varsigma", "varsigma"],
    ["\\tau", "tau"],
    ["\\upsilon", "upsilon"],
    ["\\phi", "phi"],
    ["\\varphi", "varphi"],
    ["\\chi", "chi"],
    ["\\psi", "psi"],
    ["\\omega", "omega"],
    ["\\Gamma", "Gamma"],
    ["\\Delta", "Delta"],
    ["\\Theta", "Theta"],
    ["\\Lambda", "Lambda"],
    ["\\Xi", "Xi"],
    ["\\Pi", "Pi"],
    ["\\Sigma", "Sigma"],
    ["\\Upsilon", "Upsilon"],
    ["\\Phi", "Phi"],
    ["\\Psi", "Psi"],
    ["\\Omega", "Omega"],
  ]),
  ...g("Operators", [
    ["\\pm", "plus-minus"],
    ["\\mp", "minus-plus"],
    ["\\times", "times"],
    ["\\div", "divide"],
    ["\\cdot", "cdot"],
    ["\\ast", "ast"],
    ["\\star", "star"],
    ["\\circ", "compose"],
    ["\\bullet", "bullet"],
    ["\\oplus", "oplus"],
    ["\\ominus", "ominus"],
    ["\\otimes", "otimes"],
    ["\\oslash", "oslash"],
    ["\\cap", "intersection"],
    ["\\cup", "union"],
    ["\\sqcap", "square intersection"],
    ["\\sqcup", "square union"],
    ["\\vee", "or (wedge vee)"],
    ["\\wedge", "and (wedge)"],
    ["\\setminus", "set minus"],
    ["\\amalg", "amalgam"],
    ["\\wr", "wreath product"],
  ]),
  ...g("Relations", [
    ["\\neq", "not equal"],
    ["\\leq", "less or equal"],
    ["\\geq", "greater or equal"],
    ["\\ll", "much less"],
    ["\\gg", "much greater"],
    ["\\prec", "precedes"],
    ["\\succ", "succeeds"],
    ["\\preceq", "precedes or equal"],
    ["\\succeq", "succeeds or equal"],
    ["\\sim", "similar"],
    ["\\simeq", "similar or equal"],
    ["\\approx", "approximately"],
    ["\\cong", "congruent"],
    ["\\equiv", "equivalent"],
    ["\\propto", "proportional"],
    ["\\perp", "perpendicular"],
    ["\\parallel", "parallel"],
    ["\\mid", "divides"],
    ["\\models", "models"],
    ["\\vdash", "entails"],
    ["\\asymp", "asymptotic"],
    ["\\doteq", "approaches equal"],
    ["\\in", "element of"],
    ["\\ni", "contains"],
    ["\\notin", "not element of"],
    ["\\subset", "subset"],
    ["\\supset", "superset"],
    ["\\subseteq", "subset or equal"],
    ["\\supseteq", "superset or equal"],
    ["\\emptyset", "empty set"],
    ["\\varnothing", "varnothing"],
  ]),
  ...g("Logic", [
    ["\\forall", "for all"],
    ["\\exists", "exists"],
    ["\\nexists", "does not exist"],
    ["\\neg", "not"],
    ["\\lnot", "logical not"],
    ["\\land", "logical and"],
    ["\\lor", "logical or"],
    ["\\top", "top (true)"],
    ["\\bot", "bottom (false)"],
    ["\\therefore", "therefore"],
    ["\\because", "because"],
  ]),
  ...g("Arrows", [
    ["\\to", "to (right arrow)"],
    ["\\rightarrow", "right arrow"],
    ["\\leftarrow", "left arrow"],
    ["\\leftrightarrow", "left-right arrow"],
    ["\\Rightarrow", "double right arrow"],
    ["\\Leftarrow", "double left arrow"],
    ["\\Leftrightarrow", "double left-right arrow"],
    ["\\implies", "implies"],
    ["\\impliedby", "implied by"],
    ["\\iff", "if and only if"],
    ["\\mapsto", "maps to"],
    ["\\uparrow", "up arrow"],
    ["\\downarrow", "down arrow"],
    ["\\hookrightarrow", "hook right arrow"],
    ["\\longrightarrow", "long right arrow"],
  ]),
  ...g("Big operators", [
    ["\\sum", "sum"],
    ["\\prod", "product"],
    ["\\int", "integral"],
    ["\\iint", "double integral"],
    ["\\iiint", "triple integral"],
    ["\\oint", "closed integral"],
    ["\\lim", "limit"],
    ["\\sup", "supremum"],
    ["\\inf", "infimum"],
    ["\\max", "maximum"],
    ["\\min", "minimum"],
    ["\\arg", "argument"],
    ["\\det", "determinant"],
  ]),
  ...g("Functions", [
    ["\\exp", "exp"],
    ["\\ln", "natural log"],
    ["\\log", "logarithm"],
    ["\\sin", "sine"],
    ["\\cos", "cosine"],
    ["\\tan", "tangent"],
    ["\\csc", "cosecant"],
    ["\\sec", "secant"],
    ["\\cot", "cotangent"],
    ["\\sinh", "hyperbolic sine"],
    ["\\cosh", "hyperbolic cosine"],
    ["\\tanh", "hyperbolic tangent"],
    ["\\arcsin", "arc sine"],
    ["\\arccos", "arc cosine"],
    ["\\arctan", "arc tangent"],
    ["\\sqrt{}", "square root"],
    ["\\frac{}{}", "fraction"],
    ["\\binom{}{}", "binomial"],
  ]),
  ...g("Constants & misc", [
    ["\\infty", "infinity"],
    ["\\partial", "partial derivative"],
    ["\\nabla", "nabla / gradient"],
    ["\\prime", "prime"],
    ["\\aleph", "aleph"],
    ["\\hbar", "h-bar"],
    ["\\ell", "script l"],
    ["\\Re", "real part"],
    ["\\Im", "imaginary part"],
    ["\\wp", "Weierstrass p"],
    ["\\degree", "degree"],
    ["\\angle", "angle"],
    ["\\measuredangle", "measured angle"],
    ["\\triangle", "triangle"],
    ["\\square", "square"],
    ["\\blacksquare", "filled square"],
    ["\\diamond", "diamond"],
    ["\\clubsuit", "club"],
    ["\\heartsuit", "heart"],
    ["\\ldots", "low dots"],
    ["\\cdots", "centered dots"],
    ["\\vdots", "vertical dots"],
    ["\\ddots", "diagonal dots"],
  ]),
  ...g("Accents & fonts", [
    ["\\hat{}", "hat"],
    ["\\bar{}", "bar"],
    ["\\dot{}", "dot"],
    ["\\ddot{}", "double dot"],
    ["\\tilde{}", "tilde"],
    ["\\vec{}", "vector arrow"],
    ["\\overline{}", "overline"],
    ["\\underline{}", "underline"],
    ["\\overrightarrow{}", "overrightarrow"],
    ["\\mathbb{}", "blackboard bold"],
    ["\\mathbf{}", "bold"],
    ["\\mathcal{}", "calligraphic"],
    ["\\mathrm{}", "roman"],
  ]),
  ...g("Delimiters", [
    ["\\langle", "left angle"],
    ["\\rangle", "right angle"],
    ["\\lceil", "left ceiling"],
    ["\\rceil", "right ceiling"],
    ["\\lfloor", "left floor"],
    ["\\rfloor", "right floor"],
    ["\\lvert", "left vertical bar"],
    ["\\rvert", "right vertical bar"],
    ["\\lVert", "left double bar"],
    ["\\rVert", "right double bar"],
  ]),
];

/** Symbols matching `query` by name, code, or group. Empty query = all. */
export function searchSymbols(query: string): MathSymbol[] {
  const q = query.trim().toLowerCase();
  if (q === "") return MATH_SYMBOLS;
  return MATH_SYMBOLS.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      s.group.toLowerCase().includes(q),
  );
}

/**
 * Source text and caret offset (within `text`) for inserting `code`.
 * Inside math the bare code is inserted; in prose it is wrapped in
 * `$…$`. When the code carries a `{}` group the caret lands inside it,
 * otherwise after the inserted text.
 */
export function symbolInsertion(code: string, inMath: boolean): { text: string; caret: number } {
  const groupAt = code.indexOf("{}");
  const caretInCode = groupAt === -1 ? code.length : groupAt + 1;
  if (inMath) return { text: code, caret: caretInCode };
  return {
    text: `$${code}$`,
    caret: groupAt === -1 ? code.length + 2 : caretInCode + 1,
  };
}
