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

import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { HIGHLIGHT_PALETTE, type PaletteColour } from "@/lib/highlight/palette";
import { applyHighlight } from "./highlight-command";
import { dismissHighlightBar, useHighlightBarStore } from "./highlight-bar-state";
import "./highlight.css";

export {
  type BarSnapshot,
  type HighlightBarState,
  useHighlightBarStore,
  resetHighlightBarStore,
  publishSnapshot,
  dismissHighlightBar,
  isHighlightBarOpen,
  measureHighlightBar,
  openAndFocusHighlightBar,
  handleHighlightBarEscape,
  highlightBarKeymap,
  highlightBarPlugin,
} from "./highlight-bar-state";

export function HighlightBar({ view, tabId }: { view: EditorView | null; tabId: string }) {
  const snapshot = useHighlightBarStore((s) =>
    view && !s.dismissedViews.has(view) ? s.snapshots.get(view) : undefined,
  );
  const focusRequest = useHighlightBarStore((s) => (view ? s.focusRequests.get(view) : undefined));

  const hasRemove = Boolean(snapshot?.activeHex);
  const totalItems = hasRemove ? HIGHLIGHT_PALETTE.length + 1 : HIGHLIGHT_PALETTE.length;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const safeFocusedIndex = Math.min(focusedIndex, Math.max(0, totalItems - 1));
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (focusRequest === undefined || !snapshot) return;
    const targetIndex = snapshot.activeHex
      ? HIGHLIGHT_PALETTE.findIndex((c) => c.hex === snapshot.activeHex)
      : 0;
    const index = targetIndex >= 0 ? targetIndex : 0;
    setFocusedIndex(index);
    buttonRefs.current[index]?.focus();
    const frame1 = requestAnimationFrame(() => {
      buttonRefs.current[index]?.focus();
      const frame2 = requestAnimationFrame(() => {
        buttonRefs.current[index]?.focus();
      });
      return () => cancelAnimationFrame(frame2);
    });
    return () => cancelAnimationFrame(frame1);
  }, [focusRequest, snapshot?.activeHex]);

  if (!view || !snapshot) return null;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissHighlightBar(view);
      view.focus();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = (safeFocusedIndex + 1) % totalItems;
      setFocusedIndex(next);
      buttonRefs.current[next]?.focus();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (safeFocusedIndex - 1 + totalItems) % totalItems;
      setFocusedIndex(next);
      buttonRefs.current[next]?.focus();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setFocusedIndex(0);
      buttonRefs.current[0]?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const last = totalItems - 1;
      setFocusedIndex(last);
      buttonRefs.current[last]?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (safeFocusedIndex < HIGHLIGHT_PALETTE.length) {
        const colour = HIGHLIGHT_PALETTE[safeFocusedIndex];
        if (applyHighlight(view, colour, tabId) === "invalid") {
          dismissHighlightBar(view);
        }
      } else if (hasRemove) {
        if (applyHighlight(view, null, tabId) === "invalid") {
          dismissHighlightBar(view);
        }
      }
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Highlight colour"
      className="highlight-bar"
      style={{ left: snapshot.left, top: snapshot.top }}
      onKeyDown={handleKeyDown}
    >
      {HIGHLIGHT_PALETTE.map((colour: PaletteColour, i: number) => (
        <button
          key={colour.id}
          ref={(el) => {
            buttonRefs.current[i] = el;
          }}
          type="button"
          tabIndex={safeFocusedIndex === i ? 0 : -1}
          className="highlight-swatch"
          style={{ backgroundColor: colour.hex }}
          title={colour.name}
          aria-label={`Highlight ${colour.name}`}
          aria-pressed={snapshot.activeHex === colour.hex}
          onFocus={() => setFocusedIndex(i)}
          // Keep the press from collapsing the selection before onClick can
          // re-resolve it — the same pattern the PDF block quote button uses.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            // Apply resolves the selection and context at press time; an
            // external change since the bar appeared writes nothing.
            if (applyHighlight(view, colour, tabId) === "invalid") {
              dismissHighlightBar(view);
            }
          }}
        />
      ))}
      <button
        ref={(el) => {
          buttonRefs.current[HIGHLIGHT_PALETTE.length] = el;
        }}
        type="button"
        tabIndex={safeFocusedIndex === HIGHLIGHT_PALETTE.length ? 0 : -1}
        className="highlight-remove"
        title="Remove highlight"
        aria-label="Remove highlight"
        disabled={snapshot.activeHex === null}
        onFocus={() => setFocusedIndex(HIGHLIGHT_PALETTE.length)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (applyHighlight(view, null, tabId) === "invalid") {
            dismissHighlightBar(view);
          }
        }}
      />
    </div>
  );
}
