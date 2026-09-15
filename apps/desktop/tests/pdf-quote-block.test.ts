import { describe, expect, test } from "vite-plus/test";
import { pdfQuoteBlockAt } from "../src/components/editor-area/pdf-quote-block";

/** The doc interface `pdfQuoteBlockAt` reads, built from plain text. */
function docOf(text: string) {
  const texts = text.split("\n");
  const lines = texts.map((lineText, index) => {
    const from = texts.slice(0, index).reduce((sum, previous) => sum + previous.length + 1, 0);
    return { number: index + 1, from, to: from + lineText.length, text: lineText };
  });
  return {
    lines: lines.length,
    line: (n: number) => lines[n - 1]!,
    lineAt: (pos: number) => lines.find((line) => pos >= line.from && pos <= line.to) ?? lines[0]!,
  };
}

const QUOTE = [
  "Some note text.",
  "",
  "> The unexamined life",
  "> is not worth living.",
  "",
  "[[papers/apology.pdf#page=12&text=The%20unexamined|apology.pdf p.12]]",
  "",
  "More note text.",
].join("\n");

describe("pdfQuoteBlockAt", () => {
  test("finds the link from any line of the blockquote above it", () => {
    const doc = docOf(QUOTE);
    const first = pdfQuoteBlockAt(doc, doc.line(3).from);
    const second = pdfQuoteBlockAt(doc, doc.line(4).from + 5);
    expect(first?.target).toContain("papers/apology.pdf#page=12");
    expect(second).toEqual(first);
    // The block spans both quoted lines, so hover and the editing check cover
    // the whole passage rather than one line of it.
    expect(first).toMatchObject({ from: doc.line(3).from, to: doc.line(4).to });
  });

  test("is null off the quote", () => {
    const doc = docOf(QUOTE);
    expect(pdfQuoteBlockAt(doc, doc.line(1).from)).toBeNull();
    expect(pdfQuoteBlockAt(doc, doc.line(8).from)).toBeNull();
  });

  test("ignores a quote followed by a note link rather than a PDF one", () => {
    const doc = docOf("> Just a quote.\n\n[[some-note|Some note]]\n");
    expect(pdfQuoteBlockAt(doc, doc.line(1).from)).toBeNull();
  });

  test("ignores a line that merely contains a link", () => {
    // A sentence mentioning a PDF is prose, not a citation: turning the
    // paragraph above it into a button would hijack ordinary clicks.
    const doc = docOf("> Just a quote.\n\nSee [[papers/apology.pdf#page=1|it]] for more.\n");
    expect(pdfQuoteBlockAt(doc, doc.line(1).from)).toBeNull();
  });

  test("works with no blank line between the quote and the link", () => {
    const doc = docOf("> Quoted.\n[[papers/apology.pdf#page=3|apology.pdf p.3]]\n");
    expect(pdfQuoteBlockAt(doc, doc.line(1).from)?.target).toContain("page=3");
  });
});
