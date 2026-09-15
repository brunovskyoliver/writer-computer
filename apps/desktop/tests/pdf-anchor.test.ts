import { describe, expect, test } from "vite-plus/test";

import {
  TEXT_HINT_MAX,
  encodeAnchorFragment,
  normalizePageText,
  parseAnchorFragment,
  rectToViewport,
  refindPassage,
  quoteMarkdown,
  regionAnchor,
  textAnchor,
  type PdfAnchor,
} from "../src/lib/pdf-anchor";
import { parseWikiLink } from "../src/lib/wiki-links";

describe("round trip", () => {
  test("a text anchor survives encode → parse", () => {
    const anchor: PdfAnchor = { kind: "text", page: 12, text: "The unexamined life" };
    const parsed = parseAnchorFragment(encodeAnchorFragment(anchor));
    expect(parsed).toEqual({ kind: "anchor", anchor });
  });

  test("a region anchor survives encode → parse", () => {
    const anchor: PdfAnchor = {
      kind: "region",
      page: 14,
      rect: { x: 0.12, y: 0.31, w: 0.44, h: 0.18 },
    };
    expect(encodeAnchorFragment(anchor)).toBe("page=14&rect=0.12,0.31,0.44,0.18");
    expect(parseAnchorFragment(encodeAnchorFragment(anchor))).toEqual({ kind: "anchor", anchor });
  });

  test("rect components are written at six significant digits, not padded", () => {
    const anchor: PdfAnchor = {
      kind: "region",
      page: 1,
      rect: { x: 1 / 3, y: 0, w: 0.5, h: 0.1234567891 },
    };
    expect(encodeAnchorFragment(anchor)).toBe("page=1&rect=0.333333,0,0.5,0.123457");
  });

  test("text is truncated before encoding, so no escape is cut in half", () => {
    const anchor = textAnchor(3, "é".repeat(TEXT_HINT_MAX + 40))!;
    const fragment = encodeAnchorFragment(anchor);
    const parsed = parseAnchorFragment(fragment);
    expect(parsed).toEqual({
      kind: "anchor",
      anchor: { kind: "text", page: 3, text: "é".repeat(TEXT_HINT_MAX) },
    });
  });

  test("a pipe or bracket in the text cannot terminate the link", () => {
    const anchor = textAnchor(2, "a|b]c")!;
    const fragment = encodeAnchorFragment(anchor);
    expect(fragment).not.toMatch(/[|\]]/);
    expect(parseAnchorFragment(fragment)).toEqual({ kind: "anchor", anchor });
  });
});

describe("parse rejects rather than guesses", () => {
  test("no fragment is a plain page link at page 1", () => {
    expect(parseAnchorFragment(null)).toEqual({ kind: "page", page: 1 });
    expect(parseAnchorFragment("")).toEqual({ kind: "page", page: 1 });
  });

  test("page with no anchor parameter highlights nothing", () => {
    expect(parseAnchorFragment("page=7")).toEqual({ kind: "page", page: 7 });
  });

  const unreadable: [label: string, fragment: string][] = [
    ["an out-of-range rect", "page=4&rect=1.4,0.1,0.2,0.2"],
    ["a negative rect component", "page=4&rect=-0.1,0.1,0.2,0.2"],
    ["a zero-area rect", "page=4&rect=0.1,0.1,0,0.2"],
    ["too few rect components", "page=4&rect=0.1,0.1,0.2"],
    ["a non-numeric rect", "page=4&rect=a,b,c,d"],
    ["both text and rect", "page=4&text=hi&rect=0.1,0.1,0.2,0.2"],
    ["malformed percent-encoding", "page=4&text=%E0%A4%A"],
    ["an empty text", "page=4&text="],
  ];

  for (const [label, fragment] of unreadable) {
    test(`${label} keeps the page and reports, never highlights`, () => {
      const parsed = parseAnchorFragment(fragment);
      expect(parsed.kind).toBe("unreadable");
      expect(parsed).toMatchObject({ page: 4 });
    });
  }

  test("a bad page falls back to page 1 and reports", () => {
    expect(parseAnchorFragment("page=0&text=hi")).toMatchObject({ kind: "unreadable", page: 1 });
    expect(parseAnchorFragment("page=x&text=hi")).toMatchObject({ kind: "unreadable", page: 1 });
  });

  test("unknown future parameters are ignored, not failed", () => {
    expect(parseAnchorFragment("page=5&zoom=2&text=hi")).toEqual({
      kind: "anchor",
      anchor: { kind: "text", page: 5, text: "hi" },
    });
    expect(parseAnchorFragment("page=5&zoom=2")).toEqual({ kind: "page", page: 5 });
  });
});

describe("capture clamps where parse rejects", () => {
  test("a drag off the page edge is clamped to the edge", () => {
    expect(regionAnchor(1, { x: -0.2, y: 0.5, w: 0.5, h: 0.9 })).toEqual({
      kind: "region",
      page: 1,
      rect: { x: 0, y: 0.5, w: 0.3, h: 0.5 },
    });
  });

  test("a zero-area drag produces no anchor", () => {
    expect(regionAnchor(1, { x: 0.5, y: 0.5, w: 0, h: 0.2 })).toBeNull();
    expect(regionAnchor(1, { x: 1, y: 0.5, w: 0.2, h: 0.2 })).toBeNull();
  });

  test("an empty selection produces no anchor", () => {
    expect(textAnchor(1, "   ")).toBeNull();
    expect(textAnchor(0, "hi")).toBeNull();
  });
});

describe("rectToViewport", () => {
  test("the same fractions land on the same part of the page at two zoom levels", () => {
    const rect = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
    const small = rectToViewport(rect, { width: 400, height: 600 });
    const large = rectToViewport(rect, { width: 800, height: 1200 });
    expect(small).toEqual({ left: 100, top: 300, width: 200, height: 150 });
    expect(large.left / large.width).toBeCloseTo(small.left / small.width);
    expect(large.top / large.height).toBeCloseTo(small.top / small.height);
  });
});

describe("refindPassage", () => {
  const pages = new Map([
    [3, "some other words"],
    [4, "the   quoted\npassage lives here"],
    [7, "the quoted passage lives here"],
  ]);
  const getPageText = async (page: number) => pages.get(page) ?? "";

  test("whitespace differences do not defeat an exact match", async () => {
    expect(await refindPassage("the quoted passage", 4, 10, getPageText)).toMatchObject({
      kind: "found",
      page: 4,
    });
  });

  // The regression this exists for: the two readings of one page disagree on
  // whitespace. A DOM selection over the text layer glues adjacent items
  // together ("thequoted"), while `getTextContent` joins them with a space.
  // Comparing on collapsed whitespace made every multi-item passage unfindable,
  // so a quote link jumped nowhere and highlighted nothing.
  test("matches a selection that glued two items against space-joined page text", async () => {
    const asSelected = "Thequoted passage lives here";
    const asExtracted = async () => "The quoted passage lives here";
    expect(await refindPassage(asSelected, 1, 1, asExtracted)).toMatchObject({
      kind: "found",
      page: 1,
    });
  });

  test("a passage that shifted one page is found nearest-first", async () => {
    const shifted = new Map([
      [5, "the quoted passage"],
      [7, "the quoted passage"],
    ]);
    const result = await refindPassage(
      "the quoted passage",
      6,
      10,
      async (p) => shifted.get(p) ?? "",
    );
    expect(result).toMatchObject({ kind: "found", page: 5 });
  });

  test("outside the window it is not located, and no full scan runs", async () => {
    const visited: number[] = [];
    const result = await refindPassage("the quoted passage", 1, 100, async (page) => {
      visited.push(page);
      return page === 50 ? "the quoted passage" : "";
    });
    expect(result).toEqual({ kind: "not-located" });
    expect(visited).toEqual([1, 2, 3]);
  });

  test("an empty needle is never located", async () => {
    expect(await refindPassage("   ", 4, 10, getPageText)).toEqual({ kind: "not-located" });
  });
});

describe("normalizePageText", () => {
  test("collapses the runs pdf.js extraction inserts", () => {
    expect(normalizePageText("  a \n b\t\tc ")).toBe("a b c");
  });
});

describe("quoteMarkdown", () => {
  const anchor = textAnchor(12, "The unexamined life is not worth living.")!;

  test("emits the contract's blockquote + link shape", () => {
    expect(
      quoteMarkdown("papers/apology.pdf", anchor, "The unexamined life is not worth living."),
    ).toBe(
      "> The unexamined life is not worth living.\n\n" +
        "[[papers/apology.pdf#page=12&text=The%20unexamined%20life%20is%20not%20worth%20living.|apology.pdf p.12]]",
    );
  });

  test("round-trips through the link parser it will be read back by", () => {
    const link = quoteMarkdown("papers/apology.pdf", anchor, "x").split("\n\n")[1];
    const parsed = parseWikiLink(link.slice(2, -2));
    expect(parsed.path).toBe("papers/apology.pdf");
    expect(parseAnchorFragment(parsed.fragment)).toEqual({ kind: "anchor", anchor });
  });

  test("quotes every line, so a multi-line passage keeps the link outside the quote", () => {
    expect(quoteMarkdown("a.pdf", anchor, "one\ntwo")).toMatch(/^> one\n> two\n\n\[\[/);
  });
});
