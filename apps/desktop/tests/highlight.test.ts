import { describe, expect, test, vi } from "vite-plus/test";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { htmlBlockParserExtension } from "../src/components/editor-area/html-block-decorations";
import { latexMathNesting } from "../src/components/editor-area/latex-highlighting";
import { prosemarkMarkdownSyntaxExtensions } from "../src/lib/prosemark-core/main";
import { validateMath } from "../src/components/editor-area/math-renderer";
import {
  planDirectHighlightEdit,
  planHighlightRegions,
} from "../src/components/editor-area/highlight-command";
import {
  detectHighlights,
  emitMathHighlight,
  emitProseHighlight,
  findHighlightCoveringRange,
  highlightContext,
} from "../src/lib/highlight/emit";
import { expandAndValidate, passesGuards } from "../src/lib/highlight/math-range";
import { HIGHLIGHT_PALETTE } from "../src/lib/highlight/palette";
import {
  dismissHighlightBar,
  handleHighlightBarEscape,
  isHighlightBarOpen,
  openAndFocusHighlightBar,
  resetHighlightBarStore,
  useHighlightBarStore,
} from "../src/components/editor-area/highlight-bar-state";

/** A state parsed with the same extension stack the editor ships. */
function parseState(doc: string, selection?: { from: number; to: number }, readOnly = false) {
  return EditorState.create({
    doc,
    selection: selection ? EditorSelection.range(selection.from, selection.to) : undefined,
    extensions: [
      markdown({
        extensions: [
          GFM,
          prosemarkMarkdownSyntaxExtensions,
          htmlBlockParserExtension,
          latexMathNesting,
        ],
      }),
      EditorState.readOnly.of(readOnly),
    ],
  });
}

/** The context for the range between `«` and `»` markers. */
function contextBetween(marked: string) {
  const from = marked.indexOf("«");
  const to = marked.indexOf("»");
  const doc = marked.replace("«", "").replace("»", "");
  return highlightContext(parseState(doc), from, to - 1);
}

describe("highlight palette", () => {
  test("has six entries with unique kebab-case ids", () => {
    expect(HIGHLIGHT_PALETTE).toHaveLength(6);
    const ids = HIGHLIGHT_PALETTE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const colour of HIGHLIGHT_PALETTE) expect(colour.name.length).toBeGreaterThan(0);
  });

  test("every hex is lowercase #rrggbb", () => {
    for (const colour of HIGHLIGHT_PALETTE) {
      expect(colour.hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // WCAG luminance ratio. The floor is 2:1, not AA: the document-format
  // contract pins amber at #e0a000 (2.28 on white), and SC-006 asks for
  // "cross-theme adequacy", not maximum contrast. What the floor does rule
  // out is a colour that approaches invisible on either theme.
  const CONTRAST_FLOOR = 2;
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  test("every colour clears the floor on both editor backgrounds", () => {
    for (const colour of HIGHLIGHT_PALETTE) {
      expect(contrast(colour.hex, "#ffffff")).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      expect(contrast(colour.hex, "#111111")).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
    }
  });
});

describe("highlight context", () => {
  test("both ends in inline math → math", () => {
    const ctx = contextBetween("a $«x+y»$ b");
    expect(ctx?.kind).toBe("math");
  });

  test("both ends in display math → math", () => {
    expect(contextBetween("$$«x+y»$$")?.kind).toBe("math");
  });

  test("inside \\text{…} counts as math", () => {
    expect(contextBetween("$x + \\text{«abc»}$")?.kind).toBe("math");
  });

  test("both ends in prose → prose", () => {
    expect(contextBetween("«hello world» of prose")).toEqual({ kind: "prose" });
  });

  test("math on one end, prose on the other → refused", () => {
    expect(contextBetween("a $x«+y$ b» c")).toBeNull();
  });

  test("either end in code → refused", () => {
    expect(contextBetween("`$«x+y$`»")).toBeNull();
    expect(contextBetween("```js\nlet x« = 1»\n```")).toBeNull();
    expect(contextBetween("`co«de` rest")).toBeNull();
  });

  test("code *inside* a prose selection does not refuse — a span renders around it", () => {
    expect(contextBetween("«p `$x$` q»")).toEqual({ kind: "prose" });
  });

  test("ends in two different math nodes → refused", () => {
    expect(contextBetween("a $«x$ b $y»$ c")).toBeNull();
  });
});

describe("highlight detector", () => {
  test("reads back the math form with inner positions and hex", () => {
    const text = "\\textcolor{#e0a000}{x+y}";
    const hits = detectHighlights(text);
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit.from).toBe("\\textcolor{#e0a000}{".length);
    expect(hit.to).toBe(text.length - 1);
    expect(text.slice(hit.from, hit.to)).toBe("x+y");
    expect(hit.hex).toBe("#e0a000");
    expect(hit.context).toBe("math");
    expect(hit.colour).toMatchObject({ hex: "#e0a000", id: "amber" });
  });

  test("reads back the prose form", () => {
    const text = 'before <span style="color:#22863a">hello</span> after';
    const [hit] = detectHighlights(text);
    expect(hit.context).toBe("prose");
    expect(text.slice(hit.from, hit.to)).toBe("hello");
    expect(hit.hex).toBe("#22863a");
  });

  test("an off-palette hex is preserved as written, never snapped", () => {
    const [hit] = detectHighlights("\\textcolor{#123abc}{x}");
    expect(hit.colour).toEqual({ hex: "#123abc" });
    expect(hit.hex).toBe("#123abc");
  });

  test("unrecognised forms raise nothing", () => {
    expect(detectHighlights("\\color{#e0a000}{x}")).toHaveLength(0);
    expect(detectHighlights("<mark>x</mark>")).toHaveLength(0);
    expect(detectHighlights('<span class="foo">x</span>')).toHaveLength(0);
    // Uppercase hex and extra CSS are not the emitted form.
    expect(detectHighlights("\\textcolor{#E0A000}{x}")).toHaveLength(0);
    expect(detectHighlights('<span style="color:#e0a000;font-weight:bold">x</span>')).toHaveLength(
      0,
    );
  });

  test("malformed remnants are skipped", () => {
    expect(detectHighlights("\\textcolor{#e0a000}{x")).toHaveLength(0);
    expect(detectHighlights('<span style="color:#e0a000">x')).toHaveLength(0);
  });
});

describe("highlight write path (regions)", () => {
  const applyChanges = (
    text: string,
    changes: readonly { from: number; to: number; insert: string }[],
  ) => {
    let out = text;
    for (const change of changes.toReversed()) {
      out = out.slice(0, change.from) + change.insert + out.slice(change.to);
    }
    return out;
  };

  const renderMathPlan = (plan: ReturnType<typeof planHighlightRegions>) => {
    let out = "";
    let cursor = 0;
    for (const region of plan.regions) {
      out += plan.stripped.slice(cursor, region.from);
      out += emitMathHighlight(plan.stripped.slice(region.from, region.to), region.hex);
      cursor = region.to;
    }
    return out + plan.stripped.slice(cursor);
  };

  test("a plain selection produces one region", () => {
    const plan = planHighlightRegions("a + b", 0, 5, "#cf222e");
    expect(plan.stripped).toBe("a + b");
    expect(plan.regions).toEqual([{ from: 0, to: 5, hex: "#cf222e", isSelection: true }]);
  });

  test("selection over a whole highlight is a recolour, not a special case", () => {
    const text = "\\textcolor{#e0a000}{x+y}";
    const innerFrom = "\\textcolor{#e0a000}{".length;
    const plan = planHighlightRegions(text, innerFrom, text.length - 1, "#cf222e");
    expect(plan.stripped).toBe("x+y");
    expect(plan.regions).toEqual([{ from: 0, to: 3, hex: "#cf222e", isSelection: true }]);
  });

  test("partial overlap emits old / new / old", () => {
    const text = "\\textcolor{#e0a000}{x+y}";
    const innerFrom = "\\textcolor{#e0a000}{".length;
    // Select `+y` — the middle of the existing highlight.
    const plan = planHighlightRegions(text, innerFrom + 1, text.length - 1, "#0969da");
    expect(plan.regions).toEqual([
      { from: 0, to: 1, hex: "#e0a000", isSelection: false },
      { from: 1, to: 3, hex: "#0969da", isSelection: true },
    ]);
    // Leading remainder kept the old colour; the trailing remainder is empty.
  });

  test("removal strips only the wrapper and keeps the remainders' colours", () => {
    const text = "\\textcolor{#e0a000}{x+y}";
    const innerFrom = "\\textcolor{#e0a000}{".length;
    const plan = planHighlightRegions(text, innerFrom, text.length - 1, null);
    expect(plan.stripped).toBe("x+y");
    expect(plan.regions).toEqual([]);
    expect(plan.selection).toEqual({ from: 0, to: 3 });
  });

  test("the inner text survives stripping byte-for-byte", () => {
    const inner = "x + \\frac{a}{b}  weird   spacing";
    const text = `\\textcolor{#e0a000}{${inner}}`;
    const plan = planHighlightRegions(text, 0, text.length, "#cf222e");
    expect(plan.stripped).toBe(inner);
  });

  test.each([
    [
      "math",
      "x + \\frac{a}{b}  weird   spacing",
      emitMathHighlight,
      ["\\textcolor{#e0a000}{", "}"],
    ],
    [
      "prose",
      "text with  exact   spacing",
      emitProseHighlight,
      ['<span style="color:#e0a000">', "</span>"],
    ],
  ] as const)(
    "apply-then-remove returns %s source byte-for-byte",
    (context, original, emit, wrappers) => {
      const applied = emit(original, "#e0a000");
      const hit = detectHighlights(applied)[0];
      const remove = planDirectHighlightEdit(applied, hit.from, hit.to, null, context);
      expect(remove?.changes.map((change) => applied.slice(change.from, change.to))).toEqual(
        wrappers,
      );
      expect(applyChanges(applied, remove?.changes ?? [])).toBe(original);
    },
  );

  test("exact recolour replaces only the colour argument", () => {
    const text = "\\textcolor{#e0a000}{x+y}";
    const hit = detectHighlights(text)[0];
    const edit = planDirectHighlightEdit(text, hit.from, hit.to, "#0969da", "math");
    expect(edit?.changes).toEqual([
      { from: text.indexOf("#e0a000"), to: text.indexOf("#e0a000") + 7, insert: "#0969da" },
    ]);
    expect(applyChanges(text, edit?.changes ?? [])).toBe("\\textcolor{#0969da}{x+y}");
  });

  test("partial overlap emits three adjacent wrappers without nesting", () => {
    const text = "\\textcolor{#e0a000}{abcde}";
    const hit = detectHighlights(text)[0];
    const plan = planHighlightRegions(
      text,
      hit.from + 2,
      hit.from + 4,
      "#0969da",
      undefined,
      "math",
    );
    const rendered = renderMathPlan(plan);
    expect(rendered).toBe(
      "\\textcolor{#e0a000}{ab}\\textcolor{#0969da}{cd}\\textcolor{#e0a000}{e}",
    );
    expect(detectHighlights(rendered)).toHaveLength(3);
  });

  test("finds the active highlight covering a selection without snapping its colour", () => {
    const text = "\\textcolor{#123abc}{abcde}";
    const hit = detectHighlights(text)[0];
    expect(findHighlightCoveringRange(text, hit.from + 1, hit.to - 1, "math")?.hex).toBe("#123abc");
    expect(HIGHLIGHT_PALETTE.some((colour) => colour.hex === "#123abc")).toBe(false);
  });

  test("the math plan leaves a prose span inside the formula alone", () => {
    const text = 'x + <span style="color:#e0a000">y</span>';
    const plan = planHighlightRegions(text, 0, 1, "#cf222e", undefined, "math");
    expect(plan.stripped).toBe(text);
    expect(plan.absorbed).toHaveLength(0);
  });

  test("the prose plan leaves a \\textcolor literal alone", () => {
    const text = "\\textcolor{#e0a000}{x}";
    const plan = planHighlightRegions(text, 0, text.length, "#cf222e", undefined, "prose");
    expect(plan.stripped).toBe(text);
    expect(plan.absorbed).toHaveLength(0);
  });
});

describe("math range guards", () => {
  test("a leading ^ or _ is rejected", () => {
    expect(passesGuards("^2")).toBe(false);
    expect(passesGuards("_i")).toBe(false);
  });

  test("a candidate whose brace depth goes negative or stays open is rejected", () => {
    expect(passesGuards("a}{b")).toBe(false);
    expect(passesGuards("a{b")).toBe(false);
    expect(passesGuards("a{b}")).toBe(true);
  });

  test("a trailing lone backslash is rejected", () => {
    expect(passesGuards("x + \\")).toBe(false);
    expect(passesGuards("x \\\\")).toBe(true);
  });
});

describe("math range ladder", () => {
  const apply = (formula: string, sel: string) => {
    const from = formula.indexOf(sel);
    const res = expandAndValidate(formula, from, from + sel.length, validateMath);
    return { ...res, applied: res.ok ? formula.slice(res.from, res.to) : null };
  };

  test("an exact fragment applies unexpanded", () => {
    const res = apply("(2+5j)^4=(\\sqrt{24})^4(\\cos(4*1.190)+\\sin(4*1.190)j)", "\\cos(4*1.190)");
    expect(res).toMatchObject({ ok: true, expanded: false, applied: "\\cos(4*1.190)" });
  });

  test("unmatched parentheses stay exact — they parse", () => {
    const res = apply("f = (a+b) - c", "(a+b");
    expect(res).toMatchObject({ ok: true, expanded: false, applied: "(a+b" });
  });

  test("crossing a \\sqrt{…} boundary expands", () => {
    const res = apply("\\sqrt{2}+1", "\\sqrt{2");
    expect(res.ok && res.expanded).toBe(true);
    if (res.ok) expect(res.applied).toBe("\\sqrt{2}");
  });

  test("a split control sequence expands over the whole command", () => {
    const res = apply("x + \\cos y", "\\co");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.applied).toBe("\\cos");
  });

  test("a bare superscript expands to include its base", () => {
    const res = apply("x^2", "2");
    expect(res.ok && res.expanded).toBe(true);
    if (res.ok) expect(res.applied).toBe("x^2");
  });

  test("{a} inside \\frac{a}{b} walks to C3 and yields the whole \\frac", () => {
    const res = apply("\\frac{a}{b}+1", "{a}");
    expect(res.ok && res.expanded).toBe(true);
    if (res.ok) expect(res.applied).toBe("\\frac{a}{b}");
  });

  test("guards run before the parser ever sees the candidate", () => {
    const validate = vi.fn(validateMath);
    expandAndValidate("x^2", 1, 3, validate); // select `^2`
    for (const [formula] of validate.mock.calls) {
      expect(formula).not.toContain("\\textcolor{#000000}{^2}");
    }
    const validate2 = vi.fn(validateMath);
    expandAndValidate("{a}{b}", 1, 5, validate2); // select `a}{b`
    for (const [formula] of validate2.mock.calls) {
      expect(formula).not.toContain("\\textcolor{#000000}{a}{b");
    }
  });

  test("an escaped brace on the right is not counted as a group delimiter", () => {
    // `{a` opens a group the C2 scan must close at the real `}` — `\{` is an
    // escaped literal, so the candidate stops before ` d`, not past it.
    const res = apply("{a \\{b c} d", "{a");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.applied).toBe("{a \\{b c}");
  });

  test("an unrescuable selection returns ok: false with a reason", () => {
    // `\left( y` has no `\right` anywhere: every candidate either fails a
    // guard or still asks KaTeX for a delimiter that isn't there.
    const res = expandAndValidate("x \\left( y", 2, 10, validateMath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
  });
});

describe("math emitter", () => {
  test("emits exactly \\textcolor{#rrggbb}{FRAGMENT} byte-for-byte", () => {
    expect(emitMathHighlight("\\cos(4*1.190)", "#e0a000")).toBe(
      "\\textcolor{#e0a000}{\\cos(4*1.190)}",
    );
  });

  test("the contract example produces the contract's document", () => {
    const formula = "(2+5j)^4=(\\sqrt{24})^4(\\cos(4*1.190)+\\sin(4*1.190)j)";
    const sel = "\\cos(4*1.190)";
    const from = formula.indexOf(sel);
    const res = expandAndValidate(formula, from, from + sel.length, validateMath);
    expect(res.ok && !res.expanded).toBe(true);
    const doc = "$$" + formula + "$$";
    if (!res.ok) return;
    const written =
      doc.slice(0, 2 + res.from) + emitMathHighlight(sel, "#e0a000") + doc.slice(2 + res.to);
    expect(written).toBe(
      "$$(2+5j)^4=(\\sqrt{24})^4(\\textcolor{#e0a000}{\\cos(4*1.190)}+\\sin(4*1.190)j)$$",
    );
    // And the written formula still renders.
    const inner = written.slice(2, -2);
    expect(validateMath(inner)).toBe(true);
  });
});

describe("prose emitter", () => {
  test("a single-paragraph selection yields exactly the contract's span", () => {
    expect(emitProseHighlight("hello world", "#22863a")).toBe(
      '<span style="color:#22863a">hello world</span>',
    );
  });

  test("a multi-paragraph selection emits one span per paragraph", () => {
    const emitted = emitProseHighlight("one\n\ntwo\n\n\nthree", "#22863a");
    expect(emitted).toBe(
      '<span style="color:#22863a">one</span>\n\n' +
        '<span style="color:#22863a">two</span>\n\n\n' +
        '<span style="color:#22863a">three</span>',
    );
    // And to state the load-bearing part directly: no span straddles a
    // blank line, so the pairing scan can always match them (research R9).
    for (const m of emitted.matchAll(/<span style="color:#[0-9a-f]{6}">(.*?)<\/span>/gs)) {
      expect(m[1]).not.toMatch(/\n\s*\n/);
    }
  });

  test("a soft line break stays inside one span", () => {
    expect(emitProseHighlight("one\ntwo", "#22863a")).toBe(
      '<span style="color:#22863a">one\ntwo</span>',
    );
  });

  test("blank lines at the fragment's edges stay outside the spans", () => {
    expect(emitProseHighlight("\n\nmiddle\n\n", "#22863a")).toBe(
      '\n\n<span style="color:#22863a">middle</span>\n\n',
    );
  });

  test("the emitted spans read back through the detector", () => {
    const text = `pre ${emitProseHighlight("one\n\ntwo", "#22863a")} post`;
    const hits = detectHighlights(text);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.context === "prose")).toBe(true);
    expect(text.slice(hits[0].from, hits[0].to)).toBe("one");
    expect(text.slice(hits[1].from, hits[1].to)).toBe("two");
  });
});

describe("highlight bar keyboard and command palette (US4)", () => {
  function makeTestView(marked: string, readOnly = false) {
    const from = marked.indexOf("«");
    const to = marked.indexOf("»");
    const doc = marked.replace("«", "").replace("»", "");
    const state = parseState(
      doc,
      from >= 0 && to >= 0 ? { from, to: to - 1 } : undefined,
      readOnly,
    );
    const requestMeasure = vi.fn();
    const view = {
      state,
      requestMeasure,
    } as unknown as EditorView;
    return { view, requestMeasure };
  }

  test("openAndFocusHighlightBar is a no-op on empty selection", () => {
    resetHighlightBarStore();
    const { view, requestMeasure } = makeTestView("no selection anywhere");
    expect(openAndFocusHighlightBar(view)).toBe(false);
    expect(useHighlightBarStore.getState().focusRequests.has(view)).toBe(false);
    expect(requestMeasure).not.toHaveBeenCalled();
  });

  test("openAndFocusHighlightBar is a no-op on read-only surface", () => {
    resetHighlightBarStore();
    const { view, requestMeasure } = makeTestView("read «only» text", true);
    expect(openAndFocusHighlightBar(view)).toBe(false);
    expect(useHighlightBarStore.getState().focusRequests.has(view)).toBe(false);
    expect(requestMeasure).not.toHaveBeenCalled();
  });

  test("openAndFocusHighlightBar is a no-op inside code blocks", () => {
    resetHighlightBarStore();
    const { view, requestMeasure } = makeTestView("`«code»`");
    expect(openAndFocusHighlightBar(view)).toBe(false);
    expect(useHighlightBarStore.getState().focusRequests.has(view)).toBe(false);
    expect(requestMeasure).not.toHaveBeenCalled();
  });

  test("openAndFocusHighlightBar opens and schedules measure on valid prose selection", () => {
    resetHighlightBarStore();
    const { view, requestMeasure } = makeTestView("select «this word» here");
    expect(openAndFocusHighlightBar(view)).toBe(true);
    expect(useHighlightBarStore.getState().focusRequests.get(view)).toBe(1);
    expect(useHighlightBarStore.getState().dismissedViews.has(view)).toBe(false);
    expect(requestMeasure).toHaveBeenCalledTimes(1);
  });

  test("openAndFocusHighlightBar opens and schedules measure on valid math selection", () => {
    resetHighlightBarStore();
    const { view, requestMeasure } = makeTestView("$$«a+b»$$");
    expect(openAndFocusHighlightBar(view)).toBe(true);
    expect(useHighlightBarStore.getState().focusRequests.get(view)).toBe(1);
    expect(requestMeasure).toHaveBeenCalledTimes(1);
  });

  test("escape dismisses an open highlight bar and leaves closed bar untouched", () => {
    resetHighlightBarStore();
    const { view } = makeTestView("select «word» here");
    expect(isHighlightBarOpen(view)).toBe(false);
    expect(handleHighlightBarEscape(view)).toBe(false);

    useHighlightBarStore.setState({
      snapshots: new Map([[view, { left: 10, top: 20, activeHex: null }]]),
    });
    expect(isHighlightBarOpen(view)).toBe(true);

    expect(handleHighlightBarEscape(view)).toBe(true);
    expect(isHighlightBarOpen(view)).toBe(false);
    expect(useHighlightBarStore.getState().dismissedViews.has(view)).toBe(true);

    expect(handleHighlightBarEscape(view)).toBe(false);
  });

  test("openAndFocusHighlightBar re-opens a previously dismissed bar", () => {
    resetHighlightBarStore();
    const { view } = makeTestView("select «word» here");
    dismissHighlightBar(view);
    expect(useHighlightBarStore.getState().dismissedViews.has(view)).toBe(true);

    expect(openAndFocusHighlightBar(view)).toBe(true);
    expect(useHighlightBarStore.getState().dismissedViews.has(view)).toBe(false);
    expect(useHighlightBarStore.getState().focusRequests.get(view)).toBe(1);
  });

  test("the first palette entry is the default colour Amber", () => {
    expect(HIGHLIGHT_PALETTE[0].id).toBe("amber");
    expect(HIGHLIGHT_PALETTE[0].name).toBe("Amber");
    expect(HIGHLIGHT_PALETTE[0].hex).toBe("#e0a000");
  });
});
