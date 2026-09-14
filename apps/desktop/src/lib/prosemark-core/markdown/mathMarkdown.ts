import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { styleTags, Tag } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";

/** Highlight tag for `$` / `$$` math delimiters. */
export const mathDelimiterTag = Tag.define();

/** Highlight tag for raw math source between delimiters. */
export const mathFormulaTag = Tag.define();

const isEscapedDollar = (cx: InlineContext, pos: number): boolean => {
  let backslashes = 0;
  for (let p = pos - 1; p >= cx.offset; p--) {
    if (cx.char(p) !== 92 /* \ */) break;
    backslashes++;
  }
  return backslashes % 2 === 1;
};

const isWhitespace = (code: number): boolean =>
  code === 32 /* space */ || code === 9 /* tab */ || code === 10 /* \n */ || code === 13; /* \r */

const isDigit = (code: number): boolean => code >= 48 /* 0 */ && code <= 57; /* 9 */

const findClosingDoubleDollar = (cx: InlineContext, from: number): number => {
  for (let pos = from; pos < cx.end - 1; pos++) {
    if (cx.char(pos) === 36 /* $ */ && cx.char(pos + 1) === 36 /* $ */) {
      if (!isEscapedDollar(cx, pos)) return pos;
    }
  }
  return -1;
};

// Pandoc-style closer: a `$` preceded by whitespace or followed by a digit
// doesn't close inline math, so currency prose like "I paid $5 and $10 more"
// stays plain text.
const findClosingSingleDollar = (cx: InlineContext, from: number): number => {
  for (let pos = from; pos < cx.end; pos++) {
    if (cx.char(pos) !== 36 /* $ */) continue;
    if (isEscapedDollar(cx, pos)) continue;
    if (pos > from && isWhitespace(cx.char(pos - 1))) continue;
    if (pos + 1 < cx.end && isDigit(cx.char(pos + 1))) continue;
    return pos;
  }
  return -1;
};

/**
 * `$...$` and `$$...$$` math delimiters (TeX-style). A literal dollar is `\$`.
 *
 * Inline `$...$` follows Pandoc's guards: the content must be non-empty and
 * must not start or end with whitespace, and the closing `$` must not be
 * immediately followed by a digit. Display `$$...$$` is lenient.
 *
 * The outer node is **`Math`** so the same tree can be used with LaTeX (MathJax),
 * Typst, or other renderers in `@prosemark/*` packages.
 */
export const mathMarkdownSyntaxExtension: MarkdownConfig = {
  defineNodes: [{ name: "Math" }, { name: "MathMark" }, { name: "MathFormula" }],
  props: [
    styleTags({
      MathMark: mathDelimiterTag,
      MathFormula: mathFormulaTag,
    }),
  ],
  parseBlock: [
    {
      name: "DisplayMath",
      before: "FencedCode",
      parse(cx, line) {
        if (cx.depth > 1 || line.text.slice(line.pos).trimEnd() !== "$$") return false;
        const from = cx.lineStart + line.pos;
        const marks = [cx.elt("MathMark", from, from + 2)];
        while (cx.nextLine()) {
          const text = line.text;
          let offset = -1;
          for (let at = line.pos; at < text.length - 1; at++) {
            if (text.slice(at, at + 2) !== "$$") continue;
            let slashes = 0;
            for (let p = at - 1; p >= 0 && text[p] === "\\"; p--) slashes++;
            if (slashes % 2 === 0) {
              offset = at;
              break;
            }
          }
          if (offset < 0) continue;
          const close = cx.lineStart + offset;
          const suffix = text.slice(offset + 2);
          marks.push(cx.elt("MathFormula", from + 2, close));
          marks.push(cx.elt("MathMark", close, close + 2));
          cx.nextLine();
          cx.addElement(cx.elt("Math", from, close + 2, marks));
          if (suffix.trim()) {
            cx.addElement(
              cx.elt(
                "Paragraph",
                close + 2,
                close + 2 + suffix.length,
                cx.parser.parseInline(suffix, close + 2),
              ),
            );
          }
          return true;
        }
        // Like an unclosed code fence, keep the remaining source together.
        // One mark means mathFormulaSpan refuses to fold incomplete math.
        cx.addElement(cx.elt("Math", from, cx.prevLineEnd(), marks));
        return true;
      },
      endLeaf(cx, line) {
        return cx.depth === 1 && line.text.slice(line.pos).trimEnd() === "$$";
      },
    },
  ],
  parseInline: [
    {
      name: "Math",
      parse: (cx: InlineContext, next: number, pos: number): number => {
        if (next !== 36 /* $ */) return -1;
        if (isEscapedDollar(cx, pos)) return -1;

        const display = pos + 1 < cx.end && cx.char(pos + 1) === 36; /* $ */
        const contentFrom = display ? pos + 2 : pos + 1;

        // Inline math opener must be immediately followed by non-whitespace
        // content (Pandoc), so "$ 5" never opens math.
        if (!display) {
          if (contentFrom >= cx.end) return -1;
          if (isWhitespace(cx.char(contentFrom))) return -1;
        }

        const closePos = display
          ? findClosingDoubleDollar(cx, contentFrom)
          : findClosingSingleDollar(cx, contentFrom);
        if (closePos < 0) return -1;

        const contentTo = closePos;
        const outerTo = display ? closePos + 2 : closePos + 1;

        const openEnd = display ? pos + 2 : pos + 1;
        return cx.addElement(
          cx.elt("Math", pos, outerTo, [
            cx.elt("MathMark", pos, openEnd),
            cx.elt("MathFormula", contentFrom, contentTo),
            cx.elt("MathMark", contentTo, outerTo),
          ]),
        );
      },
      before: "Escape",
    },
  ],
};

/**
 * The formula span of a `Math` node: everything between the two `MathMark`
 * delimiters, or `null` when the node is malformed.
 *
 * Read from the delimiters rather than from the `MathFormula` child because a
 * nested parser (the LaTeX tokenizer in `latex-highlighting.ts`) mounts its
 * own tree over `MathFormula`, which hides that node from `getChild`. The
 * marks are part of the Markdown tree and always survive.
 */
export function mathFormulaSpan(math: SyntaxNode): { from: number; to: number } | null {
  const marks = math.getChildren("MathMark");
  if (marks.length !== 2) return null;
  return { from: marks[0].to, to: marks[1].from };
}
