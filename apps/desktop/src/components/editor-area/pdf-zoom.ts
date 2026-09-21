/**
 * Zoom anchoring for the PDF pane (SPECs/pdf-pinch-zoom-spec.md).
 *
 * A zoom needs to know which part of the document to keep in place. The
 * toolbar keeps the current page's top at the viewport top; a trackpad pinch
 * keeps the content point under the cursor under the cursor. Both reduce to
 * the same question — where the anchor lands in the *new* layout — so the
 * geometry lives here, pure, and the pane only wires it to the DOM.
 */

/** Index of the last page starting at or above `y`. Binary search, so a
 *  500-page document costs the same per scroll frame as a 5-page one. */
export function pageAt(offsets: number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** WebKit reports trackpad pinch as a synthetic Ctrl-wheel event with small
 *  deltas — the same channel `mermaid-canvas.ts` consumes. */
const PINCH_ZOOM_SENSITIVITY = 0.01;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** Zoom factor for one wheel event. Ctrl-without-Cmd is the synthetic pinch;
 *  Cmd-scroll is a deliberate wheel zoom. Line/page delta modes are coarsened
 *  to pixels — a trackpad pinch always arrives as pixel deltas, so this only
 *  matters for a real wheel mouse held with a modifier. */
export function wheelZoomFactor(event: {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}): number {
  const delta = event.deltaMode === 0 ? event.deltaY : event.deltaY * 32;
  const sensitivity =
    event.ctrlKey && !event.metaKey ? PINCH_ZOOM_SENSITIVITY : WHEEL_ZOOM_SENSITIVITY;
  return Math.exp(-delta * sensitivity);
}

export type ZoomAnchor =
  | { kind: "page-top"; page: number }
  | {
      kind: "point";
      /** 1-based page the point lands on. */
      page: number;
      /** Fractions into the page's rendered box, 0..1 (a point in the gap or
       *  beside a narrow page clamps to the nearest page edge). */
      fracX: number;
      fracY: number;
      /** The point's offset within the viewport when captured. */
      relX: number;
      relY: number;
    };

export interface ZoomGeometry {
  /** Page tops at `scale`, as `pageOffsets` returns them. */
  offsets: number[];
  /** Unscaled page sizes, in layout order. */
  sizes: { width: number; height: number }[];
  scale: number;
  /** The content div's laid-out width — pages centre inside it. */
  contentWidth: number;
  pageCount: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The anchor's content-space coordinates — where the point sits in the
 *  content div at this geometry. */
export function anchorContentPoint(
  anchor: Extract<ZoomAnchor, { kind: "point" }>,
  geometry: ZoomGeometry,
): { x: number; y: number } {
  const page = Math.min(Math.max(anchor.page, 1), geometry.pageCount);
  const size = geometry.sizes[page - 1] ?? { width: 0, height: 0 };
  const pageW = size.width * geometry.scale;
  const pageH = size.height * geometry.scale;
  // Pages centre inside the content width — the same `mx-auto` rule the page
  // elements use — so the left edge is half the slack.
  const pageLeft = (geometry.contentWidth - pageW) / 2;
  return {
    x: pageLeft + anchor.fracX * pageW,
    y: (geometry.offsets[page - 1] ?? 0) + anchor.fracY * pageH,
  };
}

/** The scroll position that keeps the anchor where it belongs at this
 *  geometry. `left` is null for a page-top anchor: toolbar zooms never move
 *  the horizontal scroll. */
export function scrollForAnchor(
  anchor: ZoomAnchor,
  geometry: ZoomGeometry,
): { top: number; left: number | null } {
  if (anchor.kind === "page-top") {
    const page = Math.min(Math.max(anchor.page, 1), geometry.pageCount);
    return { top: geometry.offsets[page - 1] ?? 0, left: null };
  }
  const point = anchorContentPoint(anchor, geometry);
  return { top: point.y - anchor.relY, left: point.x - anchor.relX };
}

/** The content point under the cursor as a zoom anchor. `offsets`/`sizes` are
 *  the *committed* geometry — during a pinch preview the DOM is transformed,
 *  so reading element boxes would double-count the scale. */
export function capturePointAnchor(args: {
  clientX: number;
  clientY: number;
  containerLeft: number;
  containerTop: number;
  scrollLeft: number;
  scrollTop: number;
  geometry: ZoomGeometry;
}): ZoomAnchor {
  const relX = args.clientX - args.containerLeft;
  const relY = args.clientY - args.containerTop;
  const contentX = args.scrollLeft + relX;
  const contentY = args.scrollTop + relY;
  const index = pageAt(args.geometry.offsets, contentY);
  const size = args.geometry.sizes[index] ?? { width: 0, height: 0 };
  const pageW = size.width * args.geometry.scale;
  const pageH = size.height * args.geometry.scale;
  const pageLeft = (args.geometry.contentWidth - pageW) / 2;
  const pageTop = args.geometry.offsets[index] ?? 0;
  return {
    kind: "point",
    page: index + 1,
    fracX: pageW > 0 ? clamp01((contentX - pageLeft) / pageW) : 0.5,
    fracY: pageH > 0 ? clamp01((contentY - pageTop) / pageH) : 0,
    relX,
    relY,
  };
}
