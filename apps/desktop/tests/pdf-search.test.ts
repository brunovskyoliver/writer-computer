import { describe, expect, test } from "vite-plus/test";

import {
  findMatchRanges,
  isCaseSensitiveQuery,
  MAX_MATCHES_PER_FILE,
  matchPdfPages,
  pdfTextItemsToLines,
} from "../src/lib/pdf-search";
import type { ContextLine } from "../src/types/fs";

const BASE = { path: "/ws/doc.pdf", relativePath: "doc.pdf", modifiedAt: 7 };

describe("pdfTextItemsToLines", () => {
  test("items join into lines split on hasEOL", () => {
    const items = [
      { str: "Hello " },
      { str: "world", hasEOL: true },
      { str: "next line", hasEOL: true },
    ];
    expect(pdfTextItemsToLines(items)).toEqual(["Hello world", "next line"]);
  });

  test("a trailing fragment with no hasEOL is still a line", () => {
    expect(pdfTextItemsToLines([{ str: "tail" }])).toEqual(["tail"]);
  });

  test("non-text items (no str) are skipped", () => {
    const items = [{ str: "a", hasEOL: true }, {}, { str: "b", hasEOL: true }];
    expect(pdfTextItemsToLines(items)).toEqual(["a", "b"]);
  });
});

describe("findMatchRanges / smart case", () => {
  test("lowercase query is case-insensitive", () => {
    expect(findMatchRanges("Hello HELLO", "hello", false)).toEqual([
      [0, 5],
      [6, 5],
    ]);
  });

  test("uppercase in the query makes it case-sensitive", () => {
    expect(isCaseSensitiveQuery("Hello")).toBe(true);
    expect(isCaseSensitiveQuery("hello")).toBe(false);
    expect(findMatchRanges("Hello hello", "Hello", true)).toEqual([[0, 5]]);
  });

  test("ranges are char offsets, non-overlapping, in document order", () => {
    expect(findMatchRanges("aaa", "aa", false)).toEqual([[0, 2]]);
    expect(findMatchRanges("abab", "ab", false)).toEqual([
      [0, 2],
      [2, 2],
    ]);
  });

  test("multi-byte characters count as one char", () => {
    expect(findMatchRanges("aé hit", "hit", false)).toEqual([[3, 3]]);
  });

  test("empty needle or missing match yields no ranges", () => {
    expect(findMatchRanges("abc", "", false)).toEqual([]);
    expect(findMatchRanges("abc", "z", false)).toEqual([]);
  });
});

describe("matchPdfPages", () => {
  test("matches produce kind pdf with 1-based page numbers", () => {
    const pages = [["nothing here"], ["line one", "a hit line", "line three"]];
    const { matches } = matchPdfPages(pages, "hit", BASE);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      kind: "pdf",
      page: 2,
      line_number: null,
      path: "/ws/doc.pdf",
      relative_path: "doc.pdf",
      modified_at: 7,
      match_ranges: [[2, 3]],
    });
  });

  test("context is the matched line plus up to two lines each side", () => {
    const pages = [["l1", "l2", "l3 hit", "l4", "l5"]];
    const { matches } = matchPdfPages(pages, "hit", BASE);
    expect(matches[0]!.context.map((line: ContextLine) => line.line_number)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("context clamps at page boundaries", () => {
    const pages = [["hit on first", "l2"]];
    const { matches } = matchPdfPages(pages, "hit", BASE);
    expect(matches[0]!.context.map((line: ContextLine) => line.line_number)).toEqual([1, 2]);
  });

  test("smart case matches the Rust side", () => {
    const pages = [["Hello", "hello"]];
    expect(matchPdfPages(pages, "Hello", BASE).matches).toHaveLength(1);
    expect(matchPdfPages(pages, "hello", BASE).matches).toHaveLength(2);
  });

  test("per-file cap truncates", () => {
    const pages = [Array.from({ length: MAX_MATCHES_PER_FILE + 3 }, () => "hit")];
    const { matches, truncated } = matchPdfPages(pages, "hit", BASE);
    expect(matches).toHaveLength(MAX_MATCHES_PER_FILE);
    expect(truncated).toBe(true);
  });
});
