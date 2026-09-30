/**
 * What `\` completes to: LaTeX commands and environments, each with the
 * template it inserts (`$0`, `${1:placeholder}` stops, the snippet grammar).
 * Math symbols come from the symbol palette's table, so the two never drift.
 *
 * Rules: SPECs/latex-completions/spec.md.
 */

import { MATH_SYMBOLS } from "@/lib/math/symbols";
import { parseReplacement } from "@/lib/latex-snippets/replacement";

/** Where an entry is offered: inside math, in LaTeX prose, or both. */
export type CompletionMode = "math" | "text" | "both";

export type LatexCommand = {
  /** What is shown and matched, backslash included: `\frac`. */
  label: string;
  template: string;
  mode: CompletionMode;
  detail: string;
  /** Math rendered beside the label as a preview. */
  glyph?: string;
  /** Open the completion list again after inserting (`\begin{` → envs). */
  retrigger?: boolean;
};

export type LatexEnvironment = {
  name: string;
  /** The text after `\begin{`, from the name's closing brace on. */
  body: string;
  mode: "math" | "text";
  detail: string;
};

const cmd = (
  label: string,
  template: string,
  mode: CompletionMode,
  detail: string,
  glyph?: string,
): LatexCommand => ({ label, template, mode, detail, ...(glyph ? { glyph } : {}) });

/** Commands with arguments — templates put the caret in the first one. */
const STRUCTURED: LatexCommand[] = [
  // Math constructions
  cmd("\\frac", "\\frac{$0}{$1}$2", "math", "fraction", "\\frac{a}{b}"),
  // Previewed as `\frac`: a display-size glyph overflows the list row.
  cmd("\\dfrac", "\\dfrac{$0}{$1}$2", "math", "display fraction", "\\frac{a}{b}"),
  cmd("\\sqrt", "\\sqrt{$0}$1", "math", "square root", "\\sqrt{x}"),
  cmd("\\sqrt[n]", "\\sqrt[$0]{$1}$2", "math", "n-th root", "\\sqrt[n]{x}"),
  cmd("\\binom", "\\binom{$0}{$1}$2", "math", "binomial", "\\binom{n}{k}"),
  cmd("\\sum", "\\sum_{$0}^{$1}$2", "math", "sum with limits", "\\sum_{i}^{n}"),
  cmd("\\prod", "\\prod_{$0}^{$1}$2", "math", "product with limits", "\\prod_{i}^{n}"),
  cmd("\\int", "\\int_{$0}^{$1}$2", "math", "integral with limits", "\\int_{a}^{b}"),
  cmd("\\lim", "\\lim_{${0:n} \\to ${1:\\infty}}$2", "math", "limit", "\\lim_{n \\to \\infty}"),
  cmd("\\vec", "\\vec{$0}$1", "math", "vector arrow", "\\vec{v}"),
  cmd("\\hat", "\\hat{$0}$1", "math", "hat accent", "\\hat{x}"),
  cmd("\\bar", "\\bar{$0}$1", "math", "bar accent", "\\bar{x}"),
  cmd("\\dot", "\\dot{$0}$1", "math", "dot accent", "\\dot{x}"),
  cmd("\\overline", "\\overline{$0}$1", "math", "line over", "\\overline{AB}"),
  cmd("\\underbrace", "\\underbrace{$0}_{$1}$2", "math", "brace below", "\\underbrace{a+b}_{n}"),
  cmd("\\overbrace", "\\overbrace{$0}^{$1}$2", "math", "brace above", "\\overbrace{a+b}^{n}"),
  cmd("\\text", "\\text{$0}$1", "math", "text inside math"),
  cmd("\\mathrm", "\\mathrm{$0}$1", "math", "upright", "\\mathrm{d}"),
  cmd("\\mathbf", "\\mathbf{$0}$1", "math", "bold", "\\mathbf{A}"),
  cmd("\\mathbb", "\\mathbb{$0}$1", "math", "blackboard", "\\mathbb{R}"),
  cmd("\\mathcal", "\\mathcal{$0}$1", "math", "calligraphic", "\\mathcal{L}"),
  cmd("\\operatorname", "\\operatorname{$0}$1", "math", "named operator", "\\operatorname{rank}"),
  cmd("\\left(", "\\left( $0 \\right)$1", "math", "sized parentheses", "\\left( x \\right)"),
  cmd("\\left[", "\\left[ $0 \\right]$1", "math", "sized brackets", "\\left[ x \\right]"),
  cmd("\\left|", "\\left| $0 \\right|$1", "math", "sized bars", "\\left| x \\right|"),
  cmd("\\boxed", "\\boxed{$0}$1", "math", "boxed result", "\\boxed{x=1}"),
  cmd(
    "\\textcolor",
    "\\textcolor{${0:#cf222e}}{$1}$2",
    "both",
    "coloured",
    "\\textcolor{#cf222e}{x}",
  ),
  cmd("\\begin", "\\begin{$0", "both", "environment…"),
  cmd("\\label", "\\label{$0}$1", "both", "label for \\ref"),
  cmd("\\ref", "\\ref{$0}$1", "both", "reference"),
  cmd("\\eqref", "\\eqref{$0}$1", "both", "equation reference"),
  // Document structure
  cmd("\\section", "\\section{$0}$1", "text", "section"),
  cmd("\\subsection", "\\subsection{$0}$1", "text", "subsection"),
  cmd("\\subsubsection", "\\subsubsection{$0}$1", "text", "subsubsection"),
  cmd("\\chapter", "\\chapter{$0}$1", "text", "chapter"),
  cmd("\\paragraph", "\\paragraph{$0}$1", "text", "paragraph heading"),
  cmd("\\textbf", "\\textbf{$0}$1", "text", "bold"),
  cmd("\\textit", "\\textit{$0}$1", "text", "italic"),
  cmd("\\emph", "\\emph{$0}$1", "text", "emphasis"),
  cmd("\\underline", "\\underline{$0}$1", "text", "underline"),
  cmd("\\texttt", "\\texttt{$0}$1", "text", "monospace"),
  cmd("\\footnote", "\\footnote{$0}$1", "text", "footnote"),
  cmd("\\cite", "\\cite{$0}$1", "text", "citation"),
  cmd("\\item", "\\item $0", "text", "list item"),
  cmd("\\includegraphics", "\\includegraphics[width=${0:\\linewidth}]{$1}$2", "text", "image"),
  cmd("\\caption", "\\caption{$0}$1", "text", "caption"),
  cmd("\\centering", "\\centering", "text", "centre the float"),
  cmd("\\usepackage", "\\usepackage{$0}$1", "text", "load a package"),
  cmd("\\documentclass", "\\documentclass{${0:article}}$1", "text", "document class"),
  cmd("\\title", "\\title{$0}$1", "text", "title"),
  cmd("\\author", "\\author{$0}$1", "text", "author"),
  cmd("\\date", "\\date{${0:\\today}}$1", "text", "date"),
  cmd("\\maketitle", "\\maketitle", "text", "title block"),
  cmd("\\tableofcontents", "\\tableofcontents", "text", "table of contents"),
  cmd("\\newpage", "\\newpage", "text", "page break"),
  cmd("\\input", "\\input{$0}$1", "text", "include a file"),
  cmd("\\include", "\\include{$0}$1", "text", "include a chapter"),
  cmd("\\bibliography", "\\bibliography{$0}$1", "text", "bibliography file"),
  cmd("\\bibliographystyle", "\\bibliographystyle{${0:plain}}$1", "text", "bibliography style"),
  cmd("\\url", "\\url{$0}$1", "text", "URL"),
  cmd("\\href", "\\href{$0}{$1}$2", "text", "link"),
  cmd("\\hline", "\\hline", "text", "table rule"),
  cmd("\\noindent", "\\noindent", "text", "no indent"),
  cmd("\\vspace", "\\vspace{$0}$1", "text", "vertical space"),
  cmd("\\hspace", "\\hspace{$0}$1", "text", "horizontal space"),
];

/** Every command `\` offers, symbols first, without duplicate labels. */
export const LATEX_COMMANDS: LatexCommand[] = (() => {
  const byLabel = new Map<string, LatexCommand>();
  for (const entry of STRUCTURED) {
    byLabel.set(entry.label, entry.label === "\\begin" ? { ...entry, retrigger: true } : entry);
  }
  for (const symbol of MATH_SYMBOLS) {
    // Symbols with arguments are in STRUCTURED with a template already.
    if (byLabel.has(symbol.code) || !/^\\[A-Za-z]+$/.test(symbol.code)) continue;
    byLabel.set(symbol.code, {
      label: symbol.code,
      template: symbol.code,
      mode: "math",
      detail: symbol.group.toLowerCase(),
      glyph: symbol.code,
    });
  }
  return [...byLabel.values()];
})();

const env = (
  name: string,
  body: string,
  mode: "math" | "text",
  detail: string,
): LatexEnvironment => ({ name, body, mode, detail });

const block = (name: string, inner = "\t$0") => `}\n${inner}\n\\end{${name}}`;

export const LATEX_ENVIRONMENTS: LatexEnvironment[] = [
  env("itemize", block("itemize", "\t\\item $0"), "text", "bullet list"),
  env("enumerate", block("enumerate", "\t\\item $0"), "text", "numbered list"),
  env("description", block("description", "\t\\item[$0] $1"), "text", "description list"),
  env(
    "figure",
    `}[\${0:htbp}]\n\t\\centering\n\t\\includegraphics[width=\${1:\\linewidth}]{$2}\n\t\\caption{$3}\n\t\\label{fig:$4}\n\\end{figure}`,
    "text",
    "figure with image",
  ),
  env(
    "table",
    `}[\${0:htbp}]\n\t\\centering\n\t\\begin{tabular}{\${1:cc}}\n\t\t$2\n\t\\end{tabular}\n\t\\caption{$3}\n\t\\label{tab:$4}\n\\end{table}`,
    "text",
    "table with tabular",
  ),
  env("tabular", `}{\${0:cc}}\n\t$1\n\\end{tabular}`, "text", "table body"),
  env("equation", block("equation"), "text", "numbered equation"),
  env("equation*", block("equation*"), "text", "unnumbered equation"),
  env("align", block("align"), "text", "aligned equations"),
  env("align*", block("align*"), "text", "aligned, unnumbered"),
  env("gather", block("gather"), "text", "centred equations"),
  env("center", block("center"), "text", "centred block"),
  env("abstract", block("abstract"), "text", "abstract"),
  env("quote", block("quote"), "text", "quotation"),
  env("minipage", `}{\${0:0.5\\linewidth}}\n\t$1\n\\end{minipage}`, "text", "side-by-side box"),
  env("verbatim", block("verbatim"), "text", "verbatim text"),
  env("proof", block("proof"), "text", "proof"),
  env("theorem", block("theorem"), "text", "theorem"),
  env("definition", block("definition"), "text", "definition"),
  env("bmatrix", block("bmatrix", "$0"), "math", "[ ] matrix"),
  env("pmatrix", block("pmatrix", "$0"), "math", "( ) matrix"),
  env("vmatrix", block("vmatrix", "$0"), "math", "| | determinant"),
  env("Bmatrix", block("Bmatrix", "$0"), "math", "{ } matrix"),
  env("Vmatrix", block("Vmatrix", "$0"), "math", "‖ ‖ matrix"),
  env("matrix", block("matrix", "$0"), "math", "bare matrix"),
  env("smallmatrix", block("smallmatrix", "$0"), "math", "inline matrix"),
  env("cases", block("cases", "$0"), "math", "piecewise"),
  env("aligned", block("aligned", "$0"), "math", "aligned block"),
  env("gathered", block("gathered", "$0"), "math", "gathered block"),
  env("split", block("split", "$0"), "math", "split equation"),
  env("array", `}{\${0:cc}}\n$1\n\\end{array}`, "math", "array with column spec"),
];

export type RenderedTemplate = {
  text: string;
  /** Offsets into `text`. */
  stops: { from: number; to: number; group: number }[];
};

/** A template's text with its stops located — the snippet grammar, minus
 *  captures and `${VISUAL}`, which completions never carry. */
export function renderTemplate(template: string): RenderedTemplate {
  let text = "";
  const stops: RenderedTemplate["stops"] = [];
  for (const segment of parseReplacement(template)) {
    if (segment.kind === "literal") {
      text += segment.text;
    } else if (segment.kind === "tabstop") {
      const placeholder = segment.placeholder ?? "";
      stops.push({ from: text.length, to: text.length + placeholder.length, group: segment.index });
      text += placeholder;
    }
  }
  return { text, stops };
}

/** Labels defined with `\label{…}` in `text`, in order, without repeats. */
export function labelsIn(text: string): string[] {
  const labels = new Set<string>();
  for (const match of text.matchAll(/\\label\{([^}]+)\}/g)) labels.add(match[1]!.trim());
  return [...labels];
}

/** `@article{key, … title = {…}` entries of a `.bib` file. */
export function bibEntriesIn(text: string): { key: string; title: string | null }[] {
  const entries: { key: string; title: string | null }[] = [];
  const starts = [...text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)];
  starts.forEach((match, index) => {
    if (/^(string|comment|preamble)$/i.test(match[1]!)) return;
    const end = starts[index + 1]?.index ?? text.length;
    const body = text.slice(match.index, end);
    const title = /\btitle\s*=\s*[{"]\{?([^}"]+)/i.exec(body)?.[1]?.trim() ?? null;
    entries.push({ key: match[2]!, title });
  });
  return entries;
}

/** Macros the document defines — `\newcommand{\R}{…}`, `\newcommand\vv[1]{…}`,
 *  `\DeclareMathOperator{\rank}{rank}` — as completions whose template has one
 *  stop per argument. */
export function macrosIn(text: string): { label: string; template: string }[] {
  const found = new Map<string, string>();
  const definitions =
    /\\(?:re)?newcommand\*?\s*\{?(\\[A-Za-z]+)\}?\s*(?:\[(\d)\])?|\\DeclareMathOperator\*?\s*\{(\\[A-Za-z]+)\}/g;
  for (const match of text.matchAll(definitions)) {
    const label = match[1] ?? match[3]!;
    const args = Number(match[2] ?? 0);
    let template = label;
    for (let i = 0; i < args; i += 1) template += `{$${i}}`;
    if (args > 0) template += `$${args}`;
    found.set(label, template);
  }
  return [...found].map(([label, template]) => ({ label, template }));
}
