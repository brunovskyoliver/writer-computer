import { useDropCandidate } from "@/hooks/use-editor-drag";

/**
 * The translucent accent overlay painted over the exact region a drag would
 * land in: a pane's final allocation for a split, the whole body for a
 * centre drop, the gap bar for a strip insertion.
 *
 * It paints `candidate.previewRect` and nothing else — the same value the
 * store commits on release — so what the user sees is what they get, source
 * collapse included. It is `pointer-events: none` and mounts nothing while
 * there is no candidate, so cancellation clears it in the same render the
 * coordinator tears down.
 */
export function DropPreview() {
  const candidate = useDropCandidate();
  if (!candidate) return null;
  const { x, y, width, height } = candidate.previewRect;
  return (
    <div
      aria-hidden
      data-drop-preview={candidate.insertionIndex !== null ? "strip" : "body"}
      className="drop-preview"
      style={{ left: x, top: y, width, height }}
    />
  );
}
