/**
 * Token colours for raw LaTeX: the source inside unfolded `$…$` / `$$…$$`
 * math and inside ```latex / ```tex fences.
 *
 * A small stream tokenizer (`latexSourceLanguage`) splits the source into six
 * classes and is nested under the Markdown tree with `parseMixed`, so the
 * fences and the math formulas share one implementation. `stex` from
 * `@codemirror/legacy-modes` cannot produce five distinct classes — see
 * SPECs/latex-suite/research.md R5.
 *
 * Every character falls in exactly one token, including whitespace: entering a
 * mounted tree resets the inherited highlight class, so `mathFormulaTag`'s
 * code font no longer reaches these tokens and the scoped style has to
 * re-apply it through `all`.
 */

import {
  bracketMatching,
  HighlightStyle,
  LanguageDescription,
  StreamLanguage,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, Prec, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import { parseMixed, type SyntaxNode } from "@lezer/common";
import { Tag, tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { useSettingsStore } from "@/stores/settings-store";

/** Plain text inside LaTeX source: letters, punctuation and whitespace. Has no
 *  colour of its own — it exists so `all` can reach every character. */
export const latexTextTag = Tag.define();

const BRACKETS = "{}[]()";
const OPERATORS = "^_&";
/** Anything that ends a run of plain text: it starts a token of its own. */
const SPECIAL = /[{}[\]()^_&\\%$0-9]/;

const isLetter = (ch: string): boolean => /[a-zA-Z]/.test(ch);
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

export const latexSourceLanguage = StreamLanguage.define({
  name: "latex",
  token(stream) {
    const ch = stream.next();
    if (ch === undefined) return null;

    if (ch === "\\") {
      // `\\` is a line break, not a control sequence.
      if (stream.eat("\\")) return "operator";
      if (stream.eatWhile(isLetter)) return "keyword";
      stream.next(); // `\,` `\{` `\%` … — one non-letter belongs to the command
      return "keyword";
    }
    if (ch === "%") {
      stream.skipToEnd();
      return "lineComment";
    }
    if (ch === "$") {
      stream.eat("$");
      return "processingInstruction";
    }
    if (BRACKETS.includes(ch)) return "bracket";
    if (OPERATORS.includes(ch)) return "operator";
    if (isDigit(ch)) {
      stream.eatWhile(isDigit);
      stream.match(/^\.\d+/);
      return "number";
    }

    // Everything else, consumed in runs. `next()` above already advanced, so
    // this branch can never leave the stream where it was.
    stream.eatWhile((next: string) => !SPECIAL.test(next));
    return "latexText";
  },
  tokenTable: { latexText: latexTextTag },
});

/** Nest the LaTeX tokenizer under every `MathFormula` node. */
export const latexMathNesting: MarkdownConfig = {
  wrap: parseMixed((node) =>
    node.name === "MathFormula" ? { parser: latexSourceLanguage.parser } : null,
  ),
};

/** `codeLanguages` for `markdown()`: `latex`/`tex` fences get the tokenizer
 *  above, everything else keeps the stock language-data lookup. */
export function latexAwareCodeLanguages(info: string) {
  const name = info.trim().toLowerCase();
  if (name === "latex" || name === "tex") return latexSourceLanguage;
  return LanguageDescription.matchLanguageName(languages, info, true);
}

const codeFont = {
  fontFamily: "var(--pm-code-font, monospace)",
  fontSize: "var(--writer-editor-font-size, 16px)",
};

/** Five distinct colours plus muted delimiters (SC-007). Scoped to the nested
 *  tokenizer, so nothing outside LaTeX source is touched. */
const colouredLatexStyle = HighlightStyle.define(
  [
    { tag: tags.keyword, color: "var(--pm-syntax-keyword)" },
    { tag: tags.bracket, color: "var(--pm-syntax-atom)" },
    { tag: tags.operator, color: "var(--pm-syntax-special-variable-macro)" },
    { tag: tags.number, color: "var(--pm-syntax-literal)" },
    { tag: tags.lineComment, color: "var(--pm-syntax-comment)" },
    { tag: tags.processingInstruction, color: "var(--pm-muted-color)" },
    // No colour of its own; `all` gives it the font.
    { tag: latexTextTag },
  ],
  { scope: latexSourceLanguage, all: codeFont },
);

/** `latex.highlight-source` off: the code font stays, the colours go. */
const plainLatexStyle = HighlightStyle.define([], {
  scope: latexSourceLanguage,
  // General code highlighting also sees these tokens. Explicitly inherit the
  // editor colour so disabling the LaTeX palette cannot expose that fallback.
  all: { ...codeFont, color: "inherit" },
});

function isHighlightOn(): boolean {
  return useSettingsStore.getState().settings["latex.highlight-source"] !== false;
}

function styleFor(on: boolean): Extension {
  return Prec.high(syntaxHighlighting(on ? colouredLatexStyle : plainLatexStyle));
}

/** The enclosing `Math` node, or `null` outside math. The nested LaTeX tree is
 *  mounted over `MathFormula`, so the walk has to cross the mount boundary —
 *  it does: the mounted root's `parent` is the `Math` node. */
function enclosingMath(node: SyntaxNode | null): SyntaxNode | null {
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name === "Math") return cur;
  }
  return null;
}

function isLatexFence(state: EditorState, node: SyntaxNode | null): boolean {
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name !== "FencedCode") continue;
    const info = cur.getChild("CodeInfo");
    if (!info) return false;
    const name = state.doc.sliceString(info.from, info.to).trim().toLowerCase();
    return name === "latex" || name === "tex";
  }
  return false;
}

/** Bracket matching is only wanted where brackets are syntax: inside math
 *  source and `latex`/`tex` fences. Exported for tests — driving
 *  `bracketMatching` end to end needs a mounted view. */
export function insideLatexSource(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolveInner(pos, 1);
  return enclosingMath(node) !== null || isLatexFence(state, node);
}

const matchingMark = Decoration.mark({ class: "cm-matchingBracket" });
const nonmatchingMark = Decoration.mark({ class: "cm-nonmatchingBracket" });

/**
 * `renderMatch` returning `[]` outside LaTeX source is the whole scope: no
 * other extension in this app installs `bracketMatching`, so these marks only
 * ever exist inside math and latex fences. That makes a `.cm-latex-source`
 * tagging plugin (and the CSS descendant selector it would need) pure
 * overhead — `latex-snippets.css` styles the two classes directly.
 */
const scopedBracketMatching = bracketMatching({
  renderMatch: (match, state) => {
    if (!insideLatexSource(state, match.start.from)) return [];
    const mark = match.matched ? matchingMark : nonmatchingMark;
    const marks = [mark.range(match.start.from, match.start.to)];
    if (match.end) marks.push(mark.range(match.end.from, match.end.to));
    return marks;
  },
});

/**
 * Colours for LaTeX source plus bracket matching scoped to it.
 *
 * Parsing stays on whatever `latex.highlight-source` says — its cost is
 * negligible and the tree shape stays stable for `mathContext`. Only the
 * style swaps, through one compartment reconfigure per setting change.
 */
export function latexHighlighting(): Extension {
  const compartment = new Compartment();
  return [
    compartment.of(styleFor(isHighlightOn())),
    ViewPlugin.define((view) => {
      let current = isHighlightOn();
      const unsubscribe = useSettingsStore.subscribe((state) => {
        const next = state.settings["latex.highlight-source"] !== false;
        if (next === current) return;
        current = next;
        view.dispatch({ effects: compartment.reconfigure(styleFor(next)) });
      });
      return { destroy: unsubscribe };
    }),
    scopedBracketMatching,
  ];
}
