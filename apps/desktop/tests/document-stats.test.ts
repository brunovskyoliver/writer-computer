import { describe, expect, test } from "vite-plus/test";
import { getDocumentStats } from "../src/lib/document-stats";

describe("getDocumentStats", () => {
  test("empty document", () => {
    expect(getDocumentStats("")).toEqual({ words: 0, characters: 0, paragraphs: 0 });
    expect(getDocumentStats("   \n\n  ")).toEqual({ words: 0, characters: 0, paragraphs: 0 });
  });

  test("strips markdown prefixes and counts words, characters, paragraphs", () => {
    const doc = "# Title\n\n- one two\n- three\n\n> quoted `code` [link](x) [[wiki]]\n";
    expect(getDocumentStats(doc)).toEqual({ words: 8, characters: 41, paragraphs: 3 });
  });

  test("counts an emoji as one character", () => {
    expect(getDocumentStats("hi 😀")).toEqual({ words: 2, characters: 4, paragraphs: 1 });
  });

  test("collapses whitespace runs to one character", () => {
    expect(getDocumentStats("a   b\n\n\nc")).toEqual({ words: 3, characters: 5, paragraphs: 2 });
  });
});

// Frozen pre-optimization implementation for behavioral equivalence checks.
const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

function countMatches(text: string, re: RegExp): number {
  let count = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) count++;
  return count;
}

// Code points, not UTF-16 units, so an emoji counts as one character. Counting
// surrogate pairs and subtracting avoids `Array.from(text)`, which allocated one
// string per character on every keystroke.
function countCodePoints(text: string): number {
  return text.length - countMatches(text, SURROGATE_PAIR_RE);
}

// Block prefixes are stripped per line. `[ \t]` rather than `\s`: a `\s` at the
// line start swallowed the blank line before a list or heading, which merged
// paragraphs and under-counted them.
function normalizeDocumentContent(content: string) {
  return content
    .replace(/^[ \t]{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)[ \t]+/gm, "")
    .replace(/`+/g, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

function previousDocumentStats(content: string) {
  const normalized = normalizeDocumentContent(content);
  if (normalized === "") return { words: 0, characters: 0, paragraphs: 0 };

  const words = countMatches(normalized, /\S+/g);
  const characters = countCodePoints(normalized.replace(/\s+/g, " "));
  let paragraphs = 0;
  for (const paragraph of normalized.split(/\n\s*\n/)) {
    if (/\S/.test(paragraph)) paragraphs++;
  }

  return { words, characters, paragraphs };
}

test("preserves counts across generated Markdown and Unicode boundaries", () => {
  const fragments = [
    "word",
    "# heading\n",
    "- item",
    "12. item",
    "> quote",
    "`code`",
    "[[wiki]]",
    "[label](target)",
    "[a\n\nb](url)",
    "😀",
    "\uD800",
    "\uDC00",
    "\uDC00\uD800",
    "\uD800`\uDC00",
    "\r\n",
    "\n\n\n",
    ...Array.from(
      " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
    ),
  ];
  let seed = 73;
  for (let sample = 0; sample < 1000; sample++) {
    let content = "";
    for (let part = 0; part < 40; part++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      content += fragments[seed % fragments.length];
    }
    expect(getDocumentStats(content), JSON.stringify(content)).toEqual(
      previousDocumentStats(content),
    );
  }
});
