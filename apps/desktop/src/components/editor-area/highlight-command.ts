/**
 * The one write path for colour, recolour and remove (FR-003, FR-011–FR-013).
 * Every action is normalise-then-re-emit (research R8): strip each Writer
 * wrapper intersecting the union of the selection and the highlights it
 * touches, then emit up to three regions over the resulting plain text — the
 * old colour on the leading remainder, the new colour on the selection, the
 * old colour on the trailing remainder. Nesting is unrepresentable because
 * wrappers are only ever emitted over text that carries none.
 *
 * Each action is exactly one `view.dispatch`, so CodeMirror's history groups
 * it into one undo step. Recolour is never remove-then-apply.
 *
 * `planHighlightRegions` is the pure half — it computes the stripped text and
 * the regions without touching a view, which is what lets the overlap and
 * round-trip tests exercise the write path in the node-only runner.
 */

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  PROSE_SPAN_CLOSE,
  detectHighlights,
  emitMathHighlight,
  highlightContext,
  proseParagraphRanges,
  proseSpanOpen,
  type DetectedHighlight,
} from "@/lib/highlight/emit";
import { expandAndValidate } from "@/lib/highlight/math-range";
import type { PaletteColour } from "@/lib/highlight/palette";
import type { MathNode } from "@/lib/latex-snippets/math-context";
import { showEditorNotice } from "./editor-notice-store";
import { validateMath } from "./math-renderer";

export type ApplyHighlightResult = "applied" | "invalid" | "refused";

/** One range of stripped text that gets one wrapper. `isSelection` marks the
 *  region the user's selection became — it carries the new colour; remainder
 *  regions carry the colour their highlight already had. */
export interface HighlightRegion {
  from: number;
  to: number;
  hex: string;
  isSelection: boolean;
}

export interface HighlightPlan {
  /** `text` with every absorbed wrapper's markup removed. */
  stripped: string;
  /** Ranges of `stripped` to wrap, in order. */
  regions: HighlightRegion[];
  /** The selection mapped into `stripped` coordinates. */
  selection: { from: number; to: number };
  /** Maps a position in the original `text` to its `stripped` coordinate. */
  map: (pos: number) => number;
  /** The normalised range, in original coordinates. */
  union: { from: number; to: number };
  /** The wrappers the union absorbed (original coordinates). */
  absorbed: DetectedHighlight[];
}

const WRAPPER_OVERHEAD = "\\textcolor{#000000}{".length + "}".length;

/**
 * Strip the markup of every Writer wrapper intersecting the union of the
 * selection and the wrappers it touches (fixpoint: absorbing one can reach
 * another), then compute the regions to re-emit. `newHex === null` is the
 * removal case — the selection emits nothing and the remainders keep their
 * colours. `seed` widens the starting union: the math path re-plans when a
 * validated expansion reaches a wrapper the union left alone. `context`
 * restricts absorption to one wrapper form — a math write must never strip a
 * `<span>` inside the formula, a prose write never a `\textcolor` literal.
 */
export function planHighlightRegions(
  text: string,
  selFrom: number,
  selTo: number,
  newHex: string | null,
  seed?: { from: number; to: number },
  context?: "math" | "prose",
): HighlightPlan {
  const all = detectHighlights(text).filter((h) => context === undefined || h.context === context);
  let uFrom = seed?.from ?? selFrom;
  let uTo = seed?.to ?? selTo;
  let absorbed: DetectedHighlight[] = [];
  for (;;) {
    absorbed = all.filter((h) => h.wrapperFrom < uTo && h.wrapperTo > uFrom);
    const nFrom = Math.min(uFrom, ...absorbed.map((h) => h.wrapperFrom));
    const nTo = Math.max(uTo, ...absorbed.map((h) => h.wrapperTo));
    if (nFrom === uFrom && nTo === uTo) break;
    uFrom = nFrom;
    uTo = nTo;
  }

  // Each absorbed wrapper contributes two markup ranges: its prefix and its
  // suffix. The inner text survives untouched — byte-exact removal (FR-012)
  // is a property of the additive format, not of this code.
  const markup = absorbed
    .flatMap((h) => [
      { from: h.wrapperFrom, to: h.from },
      { from: h.to, to: h.wrapperTo },
    ])
    .sort((a, b) => a.from - b.from);

  let stripped = "";
  let cursor = 0;
  for (const m of markup) {
    if (m.to <= cursor) continue; // a nested wrapper's markup already removed
    stripped += text.slice(cursor, Math.max(cursor, m.from));
    cursor = m.to;
  }
  stripped += text.slice(cursor);

  const map = (pos: number) => {
    let removed = 0;
    for (const m of markup) {
      if (pos <= m.from) break;
      removed += Math.min(pos, m.to) - m.from;
    }
    return pos - removed;
  };

  const selection = { from: map(selFrom), to: map(selTo) };
  const claims = absorbed.map((h) => ({ from: map(h.from), to: map(h.to), hex: h.hex }));

  const cuts = new Set<number>([selection.from, selection.to]);
  for (const c of claims) {
    cuts.add(c.from);
    cuts.add(c.to);
  }
  const sortedCuts = [...cuts].sort((a, b) => a - b);

  const regions: HighlightRegion[] = [];
  const push = (from: number, to: number, hex: string, isSelection: boolean) => {
    const last = regions[regions.length - 1];
    if (last && last.hex === hex && last.to === from && last.isSelection === isSelection) {
      last.to = to;
      return;
    }
    regions.push({ from, to, hex, isSelection });
  };

  for (let i = 0; i + 1 < sortedCuts.length; i++) {
    const a = sortedCuts[i];
    const b = sortedCuts[i + 1];
    if (a >= b) continue;
    if (selection.from <= a && b <= selection.to) {
      if (newHex !== null) push(a, b, newHex, true);
      continue;
    }
    // The selection overrides an old claim where they overlap — that is the
    // FR-013 recolour, not a special case.
    const claim = claims.find((c) => c.from <= a && b <= c.to);
    if (claim) push(a, b, claim.hex, false);
  }

  return {
    stripped,
    regions,
    selection,
    map,
    union: { from: uFrom, to: uTo },
    absorbed,
  };
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) =>
  a.from < b.to && b.from < a.to;

/** The math branch: each region walks `expandAndValidate` on the stripped
 *  formula, and a remainder that cannot be re-wrapped safely fails the whole
 *  action rather than writing a partial result (research R8). An expansion
 *  that reaches a wrapper the union left behind absorbs it and re-plans. */
function applyMathHighlight(
  view: EditorView,
  node: MathNode,
  sel: { from: number; to: number },
  colour: PaletteColour | null,
  tabId: string | null,
): ApplyHighlightResult {
  const formula = view.state.doc.sliceString(node.formulaFrom, node.formulaTo);
  // Clamp to the formula span — the `$`/`$$` delimiters never enter a
  // highlight, even when the selection runs onto them.
  const selFrom = Math.max(sel.from, node.formulaFrom) - node.formulaFrom;
  const selTo = Math.min(sel.to, node.formulaTo) - node.formulaFrom;
  if (selFrom >= selTo) return "invalid";

  const hex = colour?.hex ?? null;
  const allHits = detectHighlights(formula).filter((h) => h.context === "math");
  let seed: { from: number; to: number } | undefined;

  for (let attempt = 0; attempt <= allHits.length; attempt++) {
    const plan = planHighlightRegions(formula, selFrom, selTo, hex, seed, "math");

    const expanded: HighlightRegion[] = [];
    for (const region of plan.regions) {
      const res = expandAndValidate(plan.stripped, region.from, region.to, validateMath);
      if (!res.ok) {
        showEditorNotice(res.reason, tabId);
        return "refused";
      }
      expanded.push({ ...region, from: res.from, to: res.to });
    }
    expanded.sort((a, b) => a.from - b.from);
    if (expanded.some((r, i) => i > 0 && overlaps(expanded[i - 1], r))) {
      showEditorNotice(
        "That selection can't be coloured cleanly — it overlaps another highlight.",
        tabId,
      );
      return "refused";
    }

    // A validated region that reaches into a wrapper the union left behind
    // pulls that wrapper into the union and re-plans — it never gets nested
    // inside or split across untouched markup.
    const crossing = allHits.find(
      (h) =>
        (h.wrapperFrom < plan.union.from || h.wrapperTo > plan.union.to) &&
        expanded.some((r) =>
          overlaps(r, { from: plan.map(h.wrapperFrom), to: plan.map(h.wrapperTo) }),
        ),
    );
    if (crossing) {
      seed = {
        from: Math.min(plan.union.from, crossing.wrapperFrom),
        to: Math.max(plan.union.to, crossing.wrapperTo),
      };
      continue;
    }

    let out = "";
    let cursor = 0;
    let appliedInner: { from: number; to: number } | null = null;
    for (const region of expanded) {
      const prefix = `\\textcolor{${region.hex}}{`;
      const innerStart = out.length + (region.from - cursor) + prefix.length;
      out +=
        plan.stripped.slice(cursor, region.from) +
        emitMathHighlight(plan.stripped.slice(region.from, region.to), region.hex);
      if (region.isSelection) {
        appliedInner = { from: innerStart, to: innerStart + (region.to - region.from) };
      }
      cursor = region.to;
    }
    out += plan.stripped.slice(cursor);

    // Backstop: per-region validation is the rule, but the emitted formula is
    // cheap to re-check and "never write what won't render" has no recovery.
    if (out !== formula && !validateMath(out)) {
      showEditorNotice(
        "That selection can't be coloured — the formula would stop rendering.",
        tabId,
      );
      return "refused";
    }
    if (out === formula) return "applied";

    // The selection lands on the applied range — when the write expanded
    // past what the user selected, the grown range is what they see (FR-008).
    // For a removal it lands on the text the wrapper used to hold.
    const shift = (pos: number) => {
      let moved = pos;
      for (const region of expanded) {
        if (region.from <= pos) moved += WRAPPER_OVERHEAD - 1;
        if (region.to <= pos) moved += 1;
      }
      return moved;
    };
    const next = appliedInner ?? {
      from: shift(plan.selection.from),
      to: shift(plan.selection.to),
    };
    view.dispatch({
      changes: { from: node.formulaFrom, to: node.formulaTo, insert: out },
      selection: EditorSelection.range(node.formulaFrom + next.from, node.formulaFrom + next.to),
    });
    // Focus follows the write so a single undo keystroke reaches this
    // history — the same rule the PDF quote button documents.
    view.focus();
    return "applied";
  }
  // Unreachable in practice — each re-plan strictly grows the union — but a
  // refusal must never be silent (FR-009).
  showEditorNotice(
    "That selection can't be coloured — it isn't a whole fragment of the formula.",
    tabId,
  );
  return "refused";
}

/**
 * The prose branch: the same normalise-then-re-emit, with the `<span>`
 * emitter as the only difference (FR-007). There is no ladder — the span
 * form has no renderability constraint to validate against — but each region
 * still splits at blank lines so no span straddles a block boundary
 * (research R9).
 */
function applyProseHighlight(
  view: EditorView,
  sel: { from: number; to: number },
  colour: PaletteColour | null,
): ApplyHighlightResult {
  const text = view.state.doc.toString();
  const plan = planHighlightRegions(
    text,
    sel.from,
    sel.to,
    colour?.hex ?? null,
    undefined,
    "prose",
  );

  // Emit each region as one span per paragraph, tracking every emitted
  // span's inner range in stripped coordinates so the selection can be
  // mapped onto the written text.
  const spans: { from: number; to: number; openLen: number }[] = [];
  let out = "";
  let cursor = plan.union.from;
  let appliedInner: { from: number; to: number } | null = null;
  for (const region of plan.regions) {
    out += plan.stripped.slice(cursor, region.from);
    const regionText = plan.stripped.slice(region.from, region.to);
    const open = proseSpanOpen(region.hex);
    let inner = 0;
    for (const p of proseParagraphRanges(regionText)) {
      out += regionText.slice(inner, p.from) + open;
      const innerStart = plan.union.from + out.length;
      out += regionText.slice(p.from, p.to);
      const innerEnd = plan.union.from + out.length;
      out += PROSE_SPAN_CLOSE;
      spans.push({ from: region.from + p.from, to: region.from + p.to, openLen: open.length });
      // `out` starts at the union, so `union.from + out.length` is a doc
      // position. The applied range runs from the first emitted span's inner
      // start to the last's inner end — markup and separators between them
      // stay inside what the user sees selected.
      if (region.isSelection) {
        appliedInner = appliedInner
          ? { from: appliedInner.from, to: innerEnd }
          : { from: innerStart, to: innerEnd };
      }
      inner = p.to;
    }
    out += regionText.slice(inner);
    cursor = region.to;
  }
  out += plan.stripped.slice(cursor, plan.map(plan.union.to));

  if (out === text.slice(plan.union.from, plan.union.to)) return "applied";

  // A position in the stripped text maps to the document by adding the
  // markup emitted at or before it: each span contributes its open tag once
  // the position reaches its inner start and its close tag once it reaches
  // its inner end. Positions before the union are unchanged and
  // `map(union.from) === union.from`, so the shifted position is the doc
  // position directly.
  const shift = (pos: number) => {
    let moved = pos;
    for (const s of spans) {
      if (s.from <= pos) moved += s.openLen;
      if (s.to <= pos) moved += PROSE_SPAN_CLOSE.length;
    }
    return moved;
  };
  const next = appliedInner ?? {
    from: shift(plan.selection.from),
    to: shift(plan.selection.to),
  };
  view.dispatch({
    changes: { from: plan.union.from, to: plan.union.to, insert: out },
    selection: EditorSelection.range(next.from, next.to),
  });
  // Same rule as the math path: focus follows the write so a single undo
  // keystroke reaches this history.
  view.focus();
  return "applied";
}

/**
 * Apply `colour` to the current selection, or remove the highlight covering
 * it when `colour` is null. The target range and its context are resolved at
 * press time, never captured when the selection was made (FR-017): if the
 * document changed such that the position is no longer valid, the caller
 * closes the bar and nothing is written — never a write to a mapped guess.
 */
export function applyHighlight(
  view: EditorView,
  colour: PaletteColour | null,
  tabId: string | null,
): ApplyHighlightResult {
  const sel = view.state.selection.main;
  if (sel.empty) return "invalid";
  const ctx = highlightContext(view.state, sel.from, sel.to);
  if (!ctx) return "invalid";
  if (ctx.kind === "prose") {
    return applyProseHighlight(view, sel, colour);
  }
  return applyMathHighlight(view, ctx.node, sel, colour, tabId);
}
