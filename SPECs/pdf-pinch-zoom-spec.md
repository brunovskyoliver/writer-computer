# PDF Pinch Zoom Spec

## Summary

Trackpad pinch gestures do nothing inside the PDF pane, and — because the
gesture goes unhandled — WebKit's default handling sometimes magnifies the
whole webview, which reads as "the neighbouring Markdown pane zoomed". The
pane gains its own pinch/Cmd-scroll zoom that stays inside its scroll
container.

## Problem

- `PdfPane` has a toolbar zoom (`setScale`) but no wheel or gesture handler.
- On macOS WKWebView a trackpad pinch surfaces as a synthetic `wheel` event
  with `ctrlKey` set (the same channel `mermaid-canvas.ts` already consumes)
  plus `gesturestart`/`gesturechange`/`gestureend` events whose default action
  is whole-page magnification.
- Unhandled, the synthetic pinch falls through to the webview default, which
  zooms the entire window — perceived as the adjacent editor zooming.

## Behaviour

- Trackpad pinch over the PDF zooms the PDF around the cursor position.
- Cmd/Ctrl + scroll over the PDF zooms it too (same affordance as the Mermaid
  canvas).
- Plain wheel/trackpad scrolling is untouched.
- The gesture never reaches neighbouring panes or the webview default zoom:
  pinch wheel events are `preventDefault`ed on the PDF scroll container, and
  `gesture*` events are `preventDefault`ed so native magnification cannot run.
- Zoom stays clamped to the existing `ZOOM_MIN`/`ZOOM_MAX` bounds.
- After a zoom the document is re-anchored so the point under the cursor stays
  under the cursor; the toolbar's zoom keeps its existing "first visible page
  top stays at the viewport top" anchoring.

## Implementation Notes

- A wheel listener on the scroll container, registered non-passive, checks
  `ctrlKey || metaKey`, prevents default, and stops propagation.
- Re-rasterizing pages on every wheel tick is too heavy for a pinch stream, so
  the gesture previews with a CSS `transform: scale()` on the content div
  (origin = the content-space point under the cursor) and commits `setScale`
  only after ~120 ms of wheel silence. The commit goes through the existing
  scale layout effect, which re-anchors the scroll and clears the preview in
  the same paint.
- `zoomAnchorRef` widens from a page number to a point anchor:
  page index, fractional position inside that page's rendered box, and the
  anchor's offset within the viewport. The toolbar writes a page-top anchor;
  the pinch writes a cursor anchor.
- `gesturestart`/`gesturechange`/`gestureend` are suppressed, not used for
  zoom — the ctrl+wheel channel is the one this webview reports pinch deltas
  on (verified by `mermaid-canvas.ts`), and driving both would double-apply.

## Files Expected To Change

- `apps/desktop/src/components/editor-area/pdf-pane.tsx`
- `apps/desktop/src/components/editor-area/pdf-zoom.ts` (new — pure math:
  wheel zoom factor, anchor capture, anchor → scroll offsets)
- `apps/desktop/tests/pdf-zoom.test.ts` (new)

## Acceptance Criteria

- Pinching on a PDF zooms that PDF only; the neighbouring pane never zooms.
- Zoom centres on the cursor and stays within bounds.
- Regular scrolling, region drag, text selection, and quote flows unaffected.
