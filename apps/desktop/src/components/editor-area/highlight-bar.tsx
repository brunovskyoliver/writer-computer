/**
 * The colour bar: a small palette anchored above the active selection —
 * the one affordance for colour, recolour and remove in US1. Like the PDF
 * block quote button it is React-owned and anchored in scroll-container
 * space; like it, a miss on `coordsAtPos` means "hidden", never a guess.
 *
 * The swatch fill is the literal `colour.hex` the document stores — never a
 * theme variable. Unlike the quote button there is no viewport loop: an
 * edit that carries the selection into the viewport fires `viewportChanged`
 * and the plugin republishes, so the bar re-anchors on its own.
 */

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { findHighlightCoveringRange, highlightContext } from "@/lib/highlight/emit";
import { HIGHLIGHT_PALETTE, type PaletteColour } from "@/lib/highlight/palette";
import { treeChanged } from "@/lib/prosemark-core/utils";
import { findOuterScroller } from "./editor-scroll";
import { applyHighlight } from "./highlight-command";
import "./highlight.css";

interface BarSnapshot {
  left: number;
  top: number;
  activeHex: string | null;
}

/** Per-view anchor positions; the component subscribes only to its own view's
 *  entry. Positions live in the scroller's content space so they survive
 *  scroll without republishing. */
const useHighlightBarStore = create<{ snapshots: Map<EditorView, BarSnapshot> }>(() => ({
  snapshots: new Map(),
}));

function publishSnapshot(view: EditorView, snap: BarSnapshot | null) {
  useHighlightBarStore.setState((s) => {
    const had = s.snapshots.get(view);
    if (snap === null) {
      if (!had) return s;
      const next = new Map(s.snapshots);
      next.delete(view);
      return { snapshots: next };
    }
    if (had && had.left === snap.left && had.top === snap.top && had.activeHex === snap.activeHex) {
      return s;
    }
    const next = new Map(s.snapshots);
    next.set(view, snap);
    return { snapshots: next };
  });
}

const BAR_HEIGHT = 30;
const BAR_OFFSET = 8;

export const highlightBarPlugin = ViewPlugin.define((view) => ({
  update(update: ViewUpdate) {
    if (
      !update.docChanged &&
      !update.selectionSet &&
      !update.viewportChanged &&
      !treeChanged(update)
    ) {
      return;
    }
    const sel = update.state.selection.main;
    // Empty selection, read-only surface, code, or a selection whose ends
    // disagree (math into prose): the bar is hidden, never guessed. The
    // context probe runs here so a doc change that moves the selection into
    // code hides it without waiting for a press.
    if (
      sel.empty ||
      update.state.readOnly ||
      highlightContext(update.state, sel.from, sel.to) === null
    ) {
      publishSnapshot(view, null);
      return;
    }
    // Layout reads go through requestMeasure, never inside the update
    // handler itself (docs/editor.md). The measure re-resolves the live
    // selection — a transaction landing between the update and the measure
    // must not anchor the bar to a range that no longer exists (FR-017).
    const recomputeActive = update.docChanged || update.selectionSet;
    view.requestMeasure({
      read() {
        const live = view.state.selection.main;
        const context = live.empty ? null : highlightContext(view.state, live.from, live.to);
        if (live.empty || view.state.readOnly || context === null) {
          return null;
        }
        const activeHex = recomputeActive
          ? (findHighlightCoveringRange(
              view.state.doc.toString(),
              live.from,
              live.to,
              context.kind === "math" ? "math" : "prose",
            )?.hex ?? null)
          : (useHighlightBarStore.getState().snapshots.get(view)?.activeHex ?? null);
        const scroller = findOuterScroller(view.dom);
        const head = view.coordsAtPos(live.from);
        const tail = view.coordsAtPos(live.to);
        if (!scroller || !head) return null;
        const rect = scroller.getBoundingClientRect();
        // Content-space origin: the padding box, so the bar's absolute
        // position tracks the text through scroll (editor-scroll.ts does the
        // same clientTop dance for the safe zone).
        const originTop = rect.top + scroller.clientTop;
        const originLeft = rect.left + scroller.clientLeft;
        const left = head.left - originLeft + scroller.scrollLeft;
        const above = head.top - originTop + scroller.scrollTop - BAR_HEIGHT - BAR_OFFSET;
        const top =
          above >= 0
            ? above
            : (tail?.bottom ?? head.bottom) - originTop + scroller.scrollTop + BAR_OFFSET;
        return { left, top, activeHex };
      },
      write(snap) {
        publishSnapshot(view, snap);
      },
    });
  },
  destroy() {
    publishSnapshot(view, null);
  },
}));

export function HighlightBar({ view, tabId }: { view: EditorView | null; tabId: string }) {
  const snapshot = useHighlightBarStore((s) => (view ? s.snapshots.get(view) : undefined));
  if (!view || !snapshot) return null;
  return (
    <div
      role="toolbar"
      aria-label="Highlight colour"
      className="highlight-bar"
      style={{ left: snapshot.left, top: snapshot.top }}
    >
      {HIGHLIGHT_PALETTE.map((colour: PaletteColour) => (
        <button
          key={colour.id}
          type="button"
          className="highlight-swatch"
          style={{ backgroundColor: colour.hex }}
          title={colour.name}
          aria-label={`Highlight ${colour.name}`}
          aria-pressed={snapshot.activeHex === colour.hex}
          // Keep the press from collapsing the selection before onClick can
          // re-resolve it — the same pattern the PDF block quote button uses.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            // Apply resolves the selection and context at press time; an
            // external change since the bar appeared writes nothing.
            if (applyHighlight(view, colour, tabId) === "invalid") {
              publishSnapshot(view, null);
            }
          }}
        />
      ))}
      <button
        type="button"
        className="highlight-remove"
        title="Remove highlight"
        aria-label="Remove highlight"
        disabled={snapshot.activeHex === null}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (applyHighlight(view, null, tabId) === "invalid") {
            publishSnapshot(view, null);
          }
        }}
      />
    </div>
  );
}
