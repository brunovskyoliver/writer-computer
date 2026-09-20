import { describe, expect, test } from "vite-plus/test";

import { CONTENT_SEARCH_CAP, ContentScan, createSeqGuard } from "../src/lib/content-search";
import {
  consumePendingAnchor,
  setPendingAnchor,
  setPendingLineTarget,
} from "../src/lib/pending-anchor";
import type { SearchMatch } from "../src/types/fs";

function textMatch(path: string, modifiedAt: number, lineNumber = 1): SearchMatch {
  return {
    path,
    relative_path: path,
    modified_at: modifiedAt,
    kind: "text",
    line_number: lineNumber,
    page: null,
    line_text: "hit",
    match_ranges: [[0, 3]],
    context: [{ line_number: lineNumber, text: "hit" }],
  };
}

describe("ContentScan merge and ordering", () => {
  test("batches merge sorted by modified_at descending", () => {
    const scan = new ContentScan();
    scan.applyEvent({ type: "matches", matches: [textMatch("/ws/old.md", 10)] });
    scan.applyEvent({ type: "matches", matches: [textMatch("/ws/new.md", 99)] });
    scan.applyEvent({ type: "matches", matches: [textMatch("/ws/mid.md", 50)] });

    expect(scan.matches.map((m) => m.path)).toEqual(["/ws/new.md", "/ws/mid.md", "/ws/old.md"]);
  });

  test("matches within one file keep document order", () => {
    const scan = new ContentScan();
    scan.applyEvent({
      type: "matches",
      matches: [textMatch("/ws/a.md", 10, 3), textMatch("/ws/a.md", 10, 7)],
    });
    scan.applyEvent({ type: "matches", matches: [textMatch("/ws/b.md", 10, 1)] });

    const aMatches = scan.matches.filter((m) => m.path === "/ws/a.md");
    expect(aMatches.map((m) => m.line_number)).toEqual([3, 7]);
  });

  test("overflow past the display cap sets truncated and caps the list", () => {
    const scan = new ContentScan();
    scan.addMatches(
      Array.from({ length: CONTENT_SEARCH_CAP + 5 }, (_, i) => textMatch(`/ws/f${i}.md`, i)),
    );
    expect(scan.matches).toHaveLength(CONTENT_SEARCH_CAP);
    expect(scan.truncated).toBe(true);
  });
});

describe("ContentScan done/truncated state", () => {
  test("stays scanning until done AND the pdf queue drains", () => {
    const scan = new ContentScan();
    expect(scan.applyEvent({ type: "pdf", candidate: { path: "/ws/a.pdf", modified_at: 1 } })).toBe(
      "extract",
    );
    scan.applyEvent({ type: "done", truncated: false });
    expect(scan.state).toBe("scanning");

    scan.resolvePdfCandidate([textMatch("/ws/a.pdf", 1)], false);
    expect(scan.state).toBe("done");
  });

  test("done.truncated propagates", () => {
    const scan = new ContentScan();
    scan.applyEvent({ type: "done", truncated: true });
    expect(scan.state).toBe("done");
    expect(scan.truncated).toBe(true);
  });

  test("a pdf candidate past the display cap is skipped and marks truncated", () => {
    const scan = new ContentScan();
    scan.addMatches(
      Array.from({ length: CONTENT_SEARCH_CAP }, (_, i) => textMatch(`/ws/f${i}.md`, i)),
    );
    expect(scan.applyEvent({ type: "pdf", candidate: { path: "/ws/a.pdf", modified_at: 1 } })).toBe(
      undefined,
    );
    expect(scan.truncated).toBe(true);
  });

  test("a pdf extraction overflow marks truncated", () => {
    const scan = new ContentScan();
    scan.applyEvent({ type: "pdf", candidate: { path: "/ws/a.pdf", modified_at: 1 } });
    scan.resolvePdfCandidate([], true);
    expect(scan.truncated).toBe(true);
  });

  test("fail marks the scan done — no more events will arrive", () => {
    const scan = new ContentScan();
    scan.fail();
    expect(scan.state).toBe("done");
  });
});

describe("seq guard", () => {
  test("only the latest dispatch is current", () => {
    const guard = createSeqGuard();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    guard.next();
    expect(guard.isCurrent(second)).toBe(false);
  });
});

describe("preview source", () => {
  test("the highlighted match's context is what the pane renders", () => {
    const match = textMatch("/ws/a.md", 1, 3);
    match.context = [
      { line_number: 1, text: "before" },
      { line_number: 2, text: "before" },
      { line_number: 3, text: "hit" },
      { line_number: 4, text: "after" },
      { line_number: 5, text: "after" },
    ];
    // The matched line inside the context is the one matching line_number.
    const matched = match.context.find((l) => l.line_number === match.line_number);
    expect(matched?.text).toBe("hit");
    expect(match.context).toHaveLength(5);
  });

  test("boundary contexts with fewer than five lines are valid as-is", () => {
    const match = textMatch("/ws/a.md", 1, 1);
    match.context = [
      { line_number: 1, text: "hit" },
      { line_number: 2, text: "after" },
    ];
    const matched = match.context.find((l) => l.line_number === match.line_number);
    expect(matched?.text).toBe("hit");
    expect(match.context.length).toBeLessThan(5);
  });
});

describe("pending line target handoff", () => {
  test("a line target round-trips and is consumed exactly once", () => {
    setPendingLineTarget("tab-1", "/ws/a.md", {
      line: 7,
      offset: 4,
      length: 3,
      needle: "hit",
    });
    expect(consumePendingAnchor("tab-1", "/ws/a.md")).toEqual({
      kind: "line",
      line: 7,
      offset: 4,
      length: 3,
      needle: "hit",
    });
    expect(consumePendingAnchor("tab-1", "/ws/a.md")).toBeUndefined();
  });

  test("anchors still flow through the anchor variant unchanged", () => {
    setPendingAnchor("tab-1", "/ws/a.md", "intro");
    expect(consumePendingAnchor("tab-1", "/ws/a.md")).toEqual({
      kind: "anchor",
      slug: "intro",
    });
  });

  test("a later write overwrites — targets never replay", () => {
    setPendingLineTarget("tab-1", "/ws/a.md", { line: 1, offset: 0, length: 1, needle: "x" });
    setPendingAnchor("tab-1", "/ws/a.md", "newer");
    expect(consumePendingAnchor("tab-1", "/ws/a.md")).toEqual({
      kind: "anchor",
      slug: "newer",
    });
    expect(consumePendingAnchor("tab-1", "/ws/a.md")).toBeUndefined();
  });
});
