import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { acquirePdf, pdfjsTextLayer, releasePdf, type PdfLoadError } from "@/lib/pdf";
import {
  compactPageText,
  normalizePageText,
  pageRectToView,
  parseAnchorFragment,
  rectToViewport,
  refindPassage,
  regionAnchor,
  textAnchor,
  viewRectToPage,
  type PdfRect,
} from "@/lib/pdf-anchor";
import { useEditorStore } from "@/stores/editor-store";
import { usePdfAnchorStore } from "@/stores/pdf-anchor-store";
import { showEditorNotice } from "./editor-notice-store";
import { PdfQuoteButton, type PdfQuoteCapture } from "./pdf-quote-button";
import type { PdfLocation } from "./page-kinds/pdf";
import { bindTextLayerSelection } from "./pdf-text-selection";
import { useEscKey } from "./use-esc-key";
import "./pdf-pane.css";

/**
 * The PDF reader. See SPECs/pdf-quote-links/.
 *
 * Continuous scroll over a virtualized page list: every page occupies its real
 * height in the scroll container, but only the pages near the viewport hold a
 * rasterized canvas (FR-009). That window is what keeps memory flat across a
 * full scroll of a long document (SC-003) — a canvas per page would not.
 */

/** Gap between pages, in CSS pixels at any zoom. */
const PAGE_GAP = 16;

/** Pages kept rasterized on each side of the viewport. One is enough to cover
 *  a fast flick without holding a canvas for everything scrolled past. */
const OVERSCAN = 1;

/** How long scrolling must be quiet before the page is written back to the
 *  location. Long enough that a scroll gesture writes once, short enough that
 *  quitting right after scrolling still records where you were. */
const PAGE_SETTLE_MS = 400;

/** Rejections that mean "you scrolled away", not "this page is broken". */
const CANCEL_ERRORS = new Set(["RenderingCancelledException", "AbortException"]);

/** How long a quote highlight holds before it fades out, leaving the page
 *  readable (FR-023). */
const HIGHLIGHT_LINGER_MS = 2600;

/** The fade itself. The CSS transition runs 600 ms; the state drops a beat
 *  after that so the element is still mounted while it animates. */
const HIGHLIGHT_FADE_MS = 700;

/** A drag shorter than this on either axis is a stray click-drag, not a
 *  region (FR-015) — the same guard the text path gets for free when a tiny
 *  drag collapses into no selection. In screen pixels, because it is about
 *  the gesture, not the document. */
const REGION_MIN_DRAG_PX = 4;

const ZOOM_STEP = 0.2;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;

/** Unscaled page dimensions, in PDF units, plus the viewport's rotation —
 *  needed to map stored region anchors back onto the rendered box. Pages in
 *  one document are usually but not always the same size, so each is refined
 *  once it has been read. */
type PageSize = { width: number; height: number; rotation: number };

/** What the pane is emphasising after a quote jump: a found text passage, or
 *  a stored region painted back onto the current page box. `fading` is the
 *  second half of FR-023 — the mark fades out, then the state drops. */
type PaneHighlight =
  | { kind: "text"; page: number; text: string; align: ScrollLogicalPosition; fading: boolean }
  | {
      kind: "region";
      page: number;
      rect: PdfRect;
      align: ScrollLogicalPosition;
      fading: boolean;
    };

type ViewerState =
  | { status: "loading" }
  | { status: "error"; error: PdfLoadError }
  | { status: "ready"; doc: PDFDocumentProxy; sizes: PageSize[] };

/**
 * Top of each page plus a final total, at the current zoom. Recomputed only
 * when a size or the zoom changes — not per scroll frame.
 */
function pageOffsets(sizes: PageSize[], scale: number): number[] {
  const offsets: number[] = new Array(sizes.length + 1);
  let y = 0;
  for (let i = 0; i < sizes.length; i++) {
    // Whole pixels, because these values are both written to and read back
    // from `scrollTop`, and the browser stores that as an integer. Scrolling to
    // a page top of 2899.2 reads back 2899, which lands one page *earlier* in
    // the lookup below — so zoom appeared to move the document even when it had
    // correctly re-anchored.
    offsets[i] = Math.round(y);
    y += sizes[i].height * scale + PAGE_GAP;
  }
  offsets[sizes.length] = Math.round(y);
  return offsets;
}

/** Index of the last page starting at or above `y`. Binary search, so a
 *  500-page document costs the same per scroll frame as a 5-page one. */
function pageAt(offsets: number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Read the live DOM selection as a quote capture, or `null` if there is
 * nothing quotable.
 *
 * The page comes from the selection's **start** container, not its anchor:
 * `anchorNode` is where the drag *began*, which on a backwards drag is the
 * later node. A selection running across a page boundary must be anchored at
 * the page it starts on (scenario 2.3), and only the range's start gives that
 * reliably in both drag directions.
 *
 * The text is whitespace-collapsed here so the blockquote and the link's
 * re-find hint are built from the same string, and so the hint stays a literal
 * prefix of what `refindPassage` will search for on the page.
 */
function captureSelection(content: HTMLElement): PdfQuoteCapture | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!content.contains(range.startContainer)) return null;

  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const pageElement = start?.closest("[data-pdf-page]");
  const pageNumber = Number(pageElement?.getAttribute("data-pdf-page"));
  if (!Number.isInteger(pageNumber)) return null;

  // A two-pixel drag collapses to nothing selectable, so this is also the
  // guard that keeps an accidental click from raising a button (FR-015).
  const body = normalizePageText(selection.toString());
  const anchor = textAnchor(pageNumber, body);
  if (!anchor) return null;

  const bounds = range.getBoundingClientRect();
  const origin = content.getBoundingClientRect();
  return {
    anchor,
    body,
    left: bounds.left - origin.left,
    top: bounds.top - origin.top,
    width: bounds.width,
    height: bounds.height,
  };
}

/**
 * The text layer spans a passage covers, or an empty array if it is not on
 * this page.
 *
 * Matching is at **span granularity**: the haystack is each span's text in
 * `compactPageText` form, and every span overlapping the match is marked whole.
 * That over-marks by at most a partial span at each end, and it avoids mapping
 * an offset back onto un-compacted DOM text — which is the part that would
 * silently go wrong.
 *
 * Compacted, not joined with spaces: these spans are exactly the items
 * `refindPassage` searched through `getTextContent`, but a span carries no
 * whitespace between it and the next one. Comparing with whitespace removed is
 * the only form in which the two readings of a page agree — see
 * `compactPageText`.
 *
 * `.markedContent` spans are containers (`display: contents`) holding the real
 * text spans, so including them would count their contents twice.
 */
function spansCovering(container: HTMLElement, needle: string): HTMLElement[] {
  const parts: { span: HTMLElement; start: number; end: number }[] = [];
  let haystack = "";
  for (const span of container.querySelectorAll<HTMLElement>("span:not(.markedContent)")) {
    const text = compactPageText(span.textContent ?? "");
    if (!text) continue;
    const start = haystack.length;
    haystack += text;
    parts.push({ span, start, end: haystack.length });
  }

  const at = haystack.indexOf(needle);
  if (at === -1) return [];
  const until = at + needle.length;
  return parts.filter((part) => part.start < until && part.end > at).map((part) => part.span);
}

/** A page's text, extracted in the pdf.js worker. The joiner is irrelevant:
 *  both this string and the spans it is compared against go through
 *  `compactPageText`, which is the only form the two readings agree in. */
async function pageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const content = await (await doc.getPage(pageNumber)).getTextContent();
  return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
}

/**
 * One rasterized page, with pdf.js's invisible text layer over it.
 *
 * Mounted only while inside the render window, so unmounting is what releases
 * both the canvas and the text spans. The render task and the text layer are
 * cancelled in cleanup rather than left racing: a cancelled render rejects with
 * `RenderingCancelledException`, which is the expected outcome of scrolling
 * away and must not reach the error UI.
 *
 * Text extraction (`getTextContent`) runs in the pdf.js worker — `TextLayer`
 * only positions the spans it is handed, so the main thread never parses
 * content streams (FR-013).
 */
function PdfPageCanvas({
  doc,
  pageNumber,
  scale,
  onMeasure,
  highlight,
  highlightAlign,
  onHighlightMissed,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onMeasure: (pageNumber: number, size: PageSize) => void;
  /** The passage to emphasise on this page, or null. */
  highlight: string | null;
  /** How to bring it into view once found. */
  highlightAlign: ScrollLogicalPosition;
  onHighlightMissed: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  // Bumped when the text layer finishes building. The highlight cannot be
  // applied before there are spans to apply it to, and a zoom rebuilds them.
  const [textVersion, setTextVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    let textLayer: { cancel: () => void } | null = null;
    let unbindSelection: (() => void) | null = null;
    const textContainer = textRef.current;

    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const unscaled = page.getViewport({ scale: 1 });
      onMeasure(pageNumber, {
        width: unscaled.width,
        height: unscaled.height,
        rotation: unscaled.rotation,
      });

      const canvas = canvasRef.current;
      if (!canvas) return;
      // Rasterize at device resolution and scale back down in CSS, so the page
      // is sharp on a Retina display instead of a blurry upscale.
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${unscaled.width * scale}px`;
      canvas.style.height = `${unscaled.height * scale}px`;

      task = page.render({ canvas, viewport });

      // The text layer is built at the *CSS* scale, not the device scale: it
      // overlays the canvas's laid-out box, which is `unscaled × scale`. Using
      // the dpr-multiplied viewport here puts the spans at twice the offset on
      // a Retina display and makes selection pick the wrong words.
      const text = textContainer ? await pdfjsTextLayer() : null;
      if (text && textContainer && !cancelled) {
        textContainer.style.setProperty("--total-scale-factor", String(scale));
        const layer = new text.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textContainer,
          viewport: page.getViewport({ scale }),
        });
        textLayer = layer;
        // A page with no text layer (a scan) yields zero items and an empty
        // container. That is the correct outcome, not a case to special-case.
        await layer.render();
        // Bound only after the spans exist: the sentinel it appends has to be
        // the last child of the layer to start parked below the page.
        if (!cancelled) {
          unbindSelection = bindTextLayerSelection(textContainer);
          setTextVersion((version) => version + 1);
        }
      }

      await task.promise;
    })().catch((error: unknown) => {
      // Scrolling away cancels both halves of the page, and pages unmount
      // mid-render constantly — so these two are the *expected* rejection, not
      // a failure, and must be swallowed here rather than surfaced. Routing
      // them into the error UI would make ordinary scrolling look like a
      // failed load. Names checked against pdfjs-dist 6.3.289: the canvas
      // rejects `RenderingCancelledException`, `TextLayer.cancel()` rejects
      // `AbortException`.
      if (error instanceof Error && CANCEL_ERRORS.has(error.name)) return;
      console.error(`Failed to render PDF page ${pageNumber}`, error);
    });

    return () => {
      cancelled = true;
      task?.cancel();
      unbindSelection?.();
      textLayer?.cancel();
      // `TextLayer` appends to the container and never clears it, so a scale
      // change would stack a second set of spans on top of the first —
      // duplicated, unselectable-looking text and two overlapping hit targets.
      textContainer?.replaceChildren();
    };
  }, [doc, pageNumber, scale, onMeasure]);

  // Emphasise the quoted passage once the spans exist (FR-022). Marking is a
  // class on existing spans rather than an overlay: the spans already sit
  // exactly over their glyphs at any zoom, so the highlight follows a zoom
  // change for free and there is no second geometry to keep in step.
  const missedRef = useRef<string | null>(null);
  useEffect(() => {
    const container = textRef.current;
    if (!container || !highlight || textVersion === 0) return;

    const hits = spansCovering(container, highlight);
    if (hits.length === 0) {
      // Report once per passage, not once per re-render: a zoom rebuilds the
      // layer and would otherwise re-announce the same failure.
      if (missedRef.current !== highlight) {
        missedRef.current = highlight;
        onHighlightMissed();
      }
      return;
    }
    missedRef.current = null;

    for (const span of hits) span.classList.add("pdf-hit");
    // The second half of the reveal, and the one that actually lands on the
    // quote: the pane can only scroll to a page, because it has no idea where
    // on that page the passage sits until the spans exist. `nearest` is the
    // FR-024 case — already in view, re-emphasised where it is.
    hits[0]?.scrollIntoView({ block: highlightAlign, inline: "nearest" });
    return () => {
      for (const span of hits) span.classList.remove("pdf-hit");
    };
  }, [highlight, highlightAlign, textVersion, onHighlightMissed]);

  return (
    <div className="relative">
      <canvas ref={canvasRef} className="block bg-white shadow-sm" />
      <div ref={textRef} className="pdf-text-layer" />
    </div>
  );
}

export function PdfPane({
  location,
  tabId,
  isVisible,
}: {
  location: PdfLocation;
  tabId: string;
  isVisible: boolean;
  isFocused: boolean;
}) {
  // `isFocused` is deliberately unused: a PDF viewer has no caret to place, so
  // a visible-but-unfocused pane must simply keep painting and take no focus.
  const setPdfPage = useEditorStore((state) => state.setPdfPage);
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [scale, setScale] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The container is `display: none` while the tab is in the background, which
  // zeroes its `scrollTop`. Keeping our own copy is what restores the reading
  // position when the tab comes back.
  const scrollTopRef = useRef(0);
  const restoredRef = useRef(false);
  // Which page zoom should keep under the viewport, and the scale the scroll
  // position currently belongs to.
  const zoomAnchorRef = useRef(1);
  const scaleRef = useRef(scale);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void acquirePdf(location.path).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setState({ status: "error", error: result.error });
        return;
      }
      // Page 1's size seeds every page's height estimate; each page refines its
      // own once rendered. Awaiting all N pages up front to build an exact
      // height map is what would break SC-001 on a long document.
      void result.doc.proxy.getPage(1).then((page) => {
        if (!active) return;
        const { width, height, rotation } = page.getViewport({ scale: 1 });
        setState({
          status: "ready",
          doc: result.doc.proxy,
          sizes: new Array(result.doc.pageCount).fill({ width, height, rotation }),
        });
      });
    });
    return () => {
      active = false;
      restoredRef.current = false;
      void releasePdf(location.path);
    };
  }, [location.path]);

  const onMeasure = useCallback((pageNumber: number, size: PageSize) => {
    setState((current) => {
      if (current.status !== "ready") return current;
      const existing = current.sizes[pageNumber - 1];
      if (
        existing &&
        existing.width === size.width &&
        existing.height === size.height &&
        existing.rotation === size.rotation
      ) {
        return current;
      }
      const sizes = current.sizes.slice();
      sizes[pageNumber - 1] = size;
      return { ...current, sizes };
    });
  }, []);

  const sizes = state.status === "ready" ? state.sizes : null;
  const offsets = useMemo(() => (sizes ? pageOffsets(sizes, scale) : null), [sizes, scale]);
  const pageCount = sizes?.length ?? 0;
  const widestPage = useMemo(
    () => (sizes ? sizes.reduce((widest, size) => Math.max(widest, size.width), 0) : 0),
    [sizes],
  );
  const contentWidth = Math.max(viewportWidth, widestPage * scale);

  const firstVisible = offsets ? pageAt(offsets, scrollTop) : 0;
  const lastVisible = offsets ? pageAt(offsets, scrollTop + viewportHeight) : 0;
  const renderFrom = Math.max(0, firstVisible - OVERSCAN);
  const renderTo = Math.min(pageCount - 1, lastVisible + OVERSCAN);
  const currentPage = firstVisible + 1;

  // Scroll state is read on an animation frame rather than on every event, so
  // a fast scroll re-renders at most once per frame.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    let frame = 0;
    const onScroll = () => {
      scrollTopRef.current = container.scrollTop;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(container.scrollTop);
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [state.status]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const measure = () => {
      setViewportHeight(container.clientHeight);
      setViewportWidth(container.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [state.status]);

  // Restore the tab's page once heights exist, before the first paint so the
  // view never flashes at page 1 first.
  useLayoutEffect(() => {
    if (!offsets || restoredRef.current) return;
    restoredRef.current = true;
    const container = scrollRef.current;
    if (!container) return;
    const target = offsets[Math.min(Math.max(location.page, 1), pageCount) - 1] ?? 0;
    container.scrollTop = target;
    scrollTopRef.current = target;
    setScrollTop(target);
  }, [offsets, location.page, pageCount]);

  // `display: none` drops the container's scroll position; put it back.
  useLayoutEffect(() => {
    if (!isVisible) return;
    const container = scrollRef.current;
    if (container) container.scrollTop = scrollTopRef.current;
  }, [isVisible]);

  // Zoom keeps the page you were reading. Changing the scale rescales every
  // offset, so leaving `scrollTop` alone silently moves the document: zooming
  // in from page 20 lands near page 10, and the settle timer then writes that
  // wrong page into the location — zoom would corrupt the restore value.
  useLayoutEffect(() => {
    if (scaleRef.current === scale) return;
    scaleRef.current = scale;
    const container = scrollRef.current;
    if (!container || !offsets) return;
    const target = offsets[Math.min(Math.max(zoomAnchorRef.current, 1), pageCount) - 1] ?? 0;
    container.scrollTop = target;
    scrollTopRef.current = target;
    setScrollTop(target);
  }, [scale, offsets, pageCount]);

  // Write the page back on settle, never per scroll event: `setPdfPage` clones
  // the tab list, which has no business running on a scroll frame. The store
  // drops an unchanged page, so a settle that lands on the same page is free.
  useEffect(() => {
    if (state.status !== "ready") return;
    const timer = setTimeout(() => setPdfPage(tabId, currentPage), PAGE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [currentPage, setPdfPage, tabId, state.status]);

  // T017 also asks for a write on tab close. The settle timer is cancelled by
  // the cleanup above, so without this a scroll in the last 400 ms before the
  // pane goes away is lost. The store drops the write if the tab is already
  // gone, so this is only ever a flush, never a resurrection.
  const pageRef = useRef(currentPage);
  pageRef.current = currentPage;
  useEffect(() => {
    return () => setPdfPage(tabId, pageRef.current);
  }, [setPdfPage, tabId]);

  // The quote capture. Recomputed from the live selection rather than kept in
  // sync with it, so there is one source of truth and no way for the button to
  // outlive the text it points at (scenario 2.6).
  const [capture, setCapture] = useState<PdfQuoteCapture | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (state.status !== "ready" || !isVisible) return;
    const onSelectionChange = () => {
      const content = contentRef.current;
      setCapture(content ? captureSelection(content) : null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      setCapture(null);
    };
  }, [state.status, isVisible]);

  // Escape dismisses the button (scenario 2.6) — but only while there *is* a
  // button. Gating on `capture` is load-bearing, not tidiness: Escape is heavily
  // trafficked in this app (Vim insert mode, the search overlay), and a listener
  // that ran whenever a PDF was merely visible would clear the *note's*
  // selection every time the user pressed it in the pane next door.
  useEscKey(capture !== null, () => {
    window.getSelection()?.removeAllRanges();
    setCapture(null);
  });

  // --- drawing a region (FR-014) -------------------------------------------

  /** The in-progress region drag, in fractions of the rendered page box —
   *  view space, so it paints with one multiply and converts to the stored
   *  unrotated form only at the moment it becomes an anchor. */
  const [regionDraft, setRegionDraft] = useState<{ page: number; rect: PdfRect } | null>(null);
  const cancelRegionDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRegionDragRef.current?.(), []);

  /** A region's rect — view-space fractions — in the scroll content's
   *  coordinates, which is where the quote button positions itself. Derived
   *  from the fractions rather than stored at capture time, so a zoom change
   *  keeps the button glued to the region instead of a stale pixel box. */
  const regionContentBounds = useCallback(
    (page: number, view: PdfRect) => {
      const pageW = (sizes?.[page - 1].width ?? 0) * scale;
      const pageH = (sizes?.[page - 1].height ?? 0) * scale;
      return {
        left: (contentWidth - pageW) / 2 + view.x * pageW,
        top: (offsets?.[page - 1] ?? 0) + view.y * pageH,
        width: view.w * pageW,
        height: view.h * pageH,
      };
    },
    [sizes, scale, offsets, contentWidth],
  );

  /**
   * The region gesture (FR-014): Alt+drag draws a rectangle on any page, and
   * on a page with no text layer at all a plain drag already *is* the region
   * gesture — the user is never left with a dead text-selection gesture
   * (scenario 4.4).
   *
   * Lives on the content div rather than per page, and tracks the page
   * element's live box rather than a snapshot, so a scroll mid-drag keeps the
   * fractions honest. If the page unmounts anyway (left the render window),
   * the last live box is kept — the gesture freezes rather than computing
   * NaN fractions off a detached element.
   */
  const onRegionMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Any real click dismisses a pending capture. A *text* capture would also
    // die to the next selectionchange, but a click on dead space fires none —
    // and a region capture has no DOM selection to notice it (scenario 2.6).
    // The quote button survives this because its own mousedown is prevented.
    if (!event.defaultPrevented) setCapture(null);
    if (!offsets || !sizes) return;
    const pageEl = event.target instanceof Element ? event.target.closest("[data-pdf-page]") : null;
    if (!(pageEl instanceof HTMLElement)) return;

    const pageNumber = Number(pageEl.getAttribute("data-pdf-page"));
    // `endOfContent` is a div, so "no span" is exactly "no text layer".
    const hasText = pageEl.querySelector(".pdf-text-layer span") !== null;
    if (!event.altKey && hasText) return;

    // preventDefault, not just listener ordering: this is what stops the drag
    // starting a text selection over the spans.
    event.preventDefault();
    window.getSelection()?.removeAllRanges();

    const rotation = sizes[pageNumber - 1].rotation;
    const startX = event.clientX;
    const startY = event.clientY;
    let box = pageEl.getBoundingClientRect();

    const fractions = (clientX: number, clientY: number): PdfRect => {
      if (pageEl.isConnected) box = pageEl.getBoundingClientRect();
      const fx = (v: number) =>
        box.width > 0 ? Math.min(1, Math.max(0, (v - box.left) / box.width)) : 0;
      const fy = (v: number) =>
        box.height > 0 ? Math.min(1, Math.max(0, (v - box.top) / box.height)) : 0;
      const x0 = fx(startX);
      const y0 = fy(startY);
      const x1 = fx(clientX);
      const y1 = fy(clientY);
      return {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
      };
    };

    const scrollEl = scrollRef.current;
    scrollEl?.classList.add("pdf-region-drag");

    const detach = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onCancel);
      scrollEl?.classList.remove("pdf-region-drag");
      cancelRegionDragRef.current = null;
    };
    const onMove = (e: MouseEvent) => {
      setRegionDraft({ page: pageNumber, rect: fractions(e.clientX, e.clientY) });
    };
    const onCancel = () => {
      detach();
      setRegionDraft(null);
    };
    const onUp = (e: MouseEvent) => {
      detach();
      setRegionDraft(null);
      // The same guard the text path gets from selection collapse: a stray
      // click-drag is an accident, not a region (FR-015, spec edge case).
      const deliberate =
        Math.abs(e.clientX - startX) >= REGION_MIN_DRAG_PX &&
        Math.abs(e.clientY - startY) >= REGION_MIN_DRAG_PX;
      const view = fractions(e.clientX, e.clientY);
      const anchor = deliberate ? regionAnchor(pageNumber, viewRectToPage(view, rotation)) : null;
      if (!anchor || anchor.kind !== "region") return;
      setCapture({
        anchor,
        // The editable placeholder caption (FR-016); the link's `rect`
        // parameter is what carries the real geometry.
        body: "Selected region",
        ...regionContentBounds(pageNumber, view),
      });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onCancel);
    cancelRegionDragRef.current = onCancel;
  };

  const goToPage = useCallback(
    (page: number) => {
      const container = scrollRef.current;
      if (!container || !offsets) return;
      const clamped = Math.min(Math.max(page, 1), pageCount);
      container.scrollTop = offsets[clamped - 1];
    },
    [offsets, pageCount],
  );

  // --- arriving from a quote link (FR-021–FR-026) --------------------------

  /** The passage or region this pane is emphasising, and the page it is on.
   *  Cleared by the fade timer below, so a highlight is a moment, not a state
   *  the document stays in. */
  const [highlight, setHighlight] = useState<PaneHighlight | null>(null);
  const pendingFragment = usePdfAnchorStore((store) => store.requests[tabId]);

  /**
   * Bring `page` into view, or leave the scroll alone if it is already
   * substantially on screen — FR-024's "re-emphasise without scrolling". The
   * test is overlap with the viewport rather than equality with the current
   * page, because an anchor near a page boundary is genuinely visible from
   * either side and jerking the document to a page top the user is already
   * reading is the thing the requirement rules out.
   *
   * Reports whether it moved, which decides how the passage itself is then
   * brought in: a page we jumped to centres on the quote, a page already under
   * the reader's eyes only nudges.
   */
  const revealPage = useCallback(
    (page: number) => {
      const container = scrollRef.current;
      if (!container || !offsets) return false;
      const clamped = Math.min(Math.max(page, 1), pageCount);
      const top = offsets[clamped - 1]!;
      const bottom = offsets[clamped]!;
      const viewTop = container.scrollTop;
      const onScreen = Math.min(bottom, viewTop + container.clientHeight) - Math.max(top, viewTop);
      if (onScreen >= Math.min(container.clientHeight, bottom - top) * 0.5) return false;
      container.scrollTop = top;
      return true;
    },
    [offsets, pageCount],
  );

  const reportHighlightMissed = useCallback(() => {
    // FR-025: say the passage was not found rather than highlighting something
    // near it. Reached when the re-find matched a page but the rendered spans
    // do not — a page whose text extraction and text layer disagree.
    showEditorNotice("The quoted passage could not be located on this page.", tabId);
  }, [tabId]);

  const doc = state.status === "ready" ? state.doc : null;
  useEffect(() => {
    if (pendingFragment === undefined || !doc || !offsets) return;
    // Consumed here, not in the store's selector: an anchor is honoured once,
    // and a later zoom or re-render must not replay the jump.
    const fragment = usePdfAnchorStore.getState().consumePdfAnchor(tabId);
    if (fragment === null) return;

    let cancelled = false;
    void (async () => {
      const parsed = parseAnchorFragment(fragment);
      const recorded = parsed.kind === "anchor" ? parsed.anchor.page : parsed.page;
      let page = recorded;
      if (recorded > pageCount) {
        // A PDF that lost pages since the quote was taken. Say so and open at
        // the last page rather than silently landing somewhere plausible.
        showEditorNotice(
          `This quote points at page ${recorded}, but the PDF now ends at page ${pageCount}.`,
          tabId,
        );
        page = pageCount;
      }

      if (parsed.kind === "unreadable") {
        // The grammar carries a reason precisely so this can be said out loud.
        // Landing on the page in silence is indistinguishable from a link that
        // did nothing at all.
        showEditorNotice(`This quote link's anchor could not be read (${parsed.reason}).`, tabId);
      }

      if (parsed.kind === "anchor" && parsed.anchor.kind === "text") {
        const found = await refindPassage(parsed.anchor.text, page, pageCount, (target) =>
          pageText(doc, target),
        );
        if (cancelled) return;
        if (found.kind === "found") {
          // Centre the passage when we had to travel to it — landing on the
          // page top and leaving the quote somewhere below the fold is the
          // "it didn't scroll to it" complaint. A page already in view is
          // nudged at most, per FR-024.
          const jumped = revealPage(found.page);
          setHighlight({
            kind: "text",
            page: found.page,
            text: found.text,
            align: jumped ? "center" : "nearest",
            fading: false,
          });
          return;
        }
        showEditorNotice("The quoted passage is no longer in this PDF.", tabId);
      }

      // A region anchor paints exactly what was recorded — there is no text
      // to re-find, and a changed PDF gets no claim of correctness (spec edge
      // case). Only while the recorded page exists, though: outlining the rect
      // on the last page of a shortened document is the guessed highlight
      // FR-025 forbids, so the clamped case falls through like any other.
      if (parsed.kind === "anchor" && parsed.anchor.kind === "region" && page === recorded) {
        if (cancelled) return;
        const jumped = revealPage(page);
        setHighlight({
          kind: "region",
          page,
          rect: parsed.anchor.rect,
          align: jumped ? "center" : "nearest",
          fading: false,
        });
        return;
      }

      // Everything else lands on the recorded page with nothing highlighted: a
      // plain page link, an unreadable fragment (reported above), a passage
      // that could not be re-found, and a region anchor whose page is gone.
      // Never a guessed highlight — FR-025.
      if (cancelled) return;
      revealPage(page);
      setHighlight(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [pendingFragment, doc, offsets, pageCount, revealPage, tabId]);

  // The highlight is temporary emphasis, not a mark on the document (FR-023).
  // Two steps because the fade is a CSS transition: `fading` starts the
  // animation while the mark is still mounted (for the text variant it is the
  // `pdf-hit` class coming off that fades), and the state drops a beat later.
  useEffect(() => {
    if (!highlight || highlight.fading) return;
    const timer = setTimeout(
      () => setHighlight((current) => (current ? { ...current, fading: true } : current)),
      HIGHLIGHT_LINGER_MS,
    );
    return () => clearTimeout(timer);
  }, [highlight]);

  useEffect(() => {
    if (!highlight?.fading) return;
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_FADE_MS);
    return () => clearTimeout(timer);
  }, [highlight?.fading]);

  return (
    // Matches `DrawingPane`: the tab is `keepAlive`, and `display: none` (not
    // `visibility`) is what stops a background viewer painting over the active
    // tab. The top offset clears the floating window chrome — without it the
    // toolbar draws under the drag region and every click on it is eaten as a
    // window drag.
    <div
      className={isVisible ? "absolute inset-0 z-10 flex flex-col" : "absolute inset-0 z-10 hidden"}
      style={{ top: "var(--chrome-drag-height)" }}
    >
      {state.status === "error" ? (
        <PdfLoadFailure path={location.path} error={state.error} />
      ) : (
        <>
          <PdfToolbar
            page={currentPage}
            pageCount={pageCount}
            scale={scale}
            disabled={state.status !== "ready"}
            onGoToPage={goToPage}
            onZoom={(next) => {
              zoomAnchorRef.current = currentPage;
              setScale(Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX));
            }}
          />
          <div ref={scrollRef} className="flex-1 overflow-auto bg-[var(--surface-subtle)]">
            {state.status === "ready" && offsets ? (
              // A page wider than the viewport must stay reachable. Centring
              // with `left: 50%` + a negative translate overflows to the left,
              // and browsers give no scrollbar for that: past fit-width the
              // left edge of the page becomes unreachable. Sizing the canvas
              // area to the widest page and centring with auto margins keeps
              // the overflow on the scrollable side.
              <div
                ref={contentRef}
                className="relative"
                onMouseDown={onRegionMouseDown}
                style={{
                  height: offsets[pageCount],
                  width: contentWidth,
                }}
              >
                {Array.from({ length: renderTo - renderFrom + 1 }, (_, i) => {
                  const index = renderFrom + i;
                  const size = state.sizes[index];
                  const pageBox = { width: size.width * scale, height: size.height * scale };
                  // The in-progress rubber band, or the settled region sitting
                  // behind the quote button — the same box at two moments.
                  const drawn =
                    regionDraft?.page === index + 1
                      ? regionDraft.rect
                      : capture?.anchor.kind === "region" && capture.anchor.page === index + 1
                        ? pageRectToView(capture.anchor.rect, size.rotation)
                        : null;
                  return (
                    <div
                      key={index}
                      // The page number a selection resolves to. Read off the
                      // DOM rather than tracked in state because the selection
                      // itself is a DOM fact, and the two must not disagree.
                      data-pdf-page={index + 1}
                      className="absolute right-0 left-0 mx-auto"
                      // The height is explicit rather than the canvas's, so a
                      // region box positioned from `sizes` is right before the
                      // canvas has sized itself.
                      style={{
                        top: offsets[index],
                        width: pageBox.width,
                        height: pageBox.height,
                      }}
                    >
                      <PdfPageCanvas
                        doc={state.doc}
                        pageNumber={index + 1}
                        scale={scale}
                        onMeasure={onMeasure}
                        highlight={
                          highlight?.kind === "text" &&
                          !highlight.fading &&
                          highlight.page === index + 1
                            ? highlight.text
                            : null
                        }
                        highlightAlign={highlight?.align ?? "nearest"}
                        onHighlightMissed={reportHighlightMissed}
                      />
                      {drawn ? (
                        <div className="pdf-region" style={rectToViewport(drawn, pageBox)} />
                      ) : null}
                      {highlight?.kind === "region" && highlight.page === index + 1 ? (
                        <PdfRegionHint
                          rect={pageRectToView(highlight.rect, size.rotation)}
                          box={pageBox}
                          align={highlight.align}
                          fading={highlight.fading}
                        />
                      ) : null}
                    </div>
                  );
                })}
                {capture ? (
                  <PdfQuoteButton
                    // A region's bounds are recomputed per render from its
                    // fractions, so the button stays glued through a zoom
                    // change. A text capture's bounds are a DOM fact and are
                    // kept as measured.
                    capture={
                      capture.anchor.kind === "region"
                        ? {
                            ...capture,
                            ...regionContentBounds(
                              capture.anchor.page,
                              pageRectToView(
                                capture.anchor.rect,
                                state.sizes[capture.anchor.page - 1].rotation,
                              ),
                            ),
                          }
                        : capture
                    }
                    pdfPath={location.path}
                    pdfTabId={tabId}
                    onQuoted={() => {
                      window.getSelection()?.removeAllRanges();
                      setCapture(null);
                    }}
                  />
                ) : null}
              </div>
            ) : (
              <div className="p-4 text-sm text-[var(--text-muted)]">Loading PDF…</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Toolbar chrome comes from the app's own tokens, so it follows a light/dark
 *  change with no reopen — the same accommodation the Excalidraw editor makes,
 *  with pdf.js still painting the page itself. */
function PdfToolbar({
  page,
  pageCount,
  scale,
  disabled,
  onGoToPage,
  onZoom,
}: {
  page: number;
  pageCount: number;
  scale: number;
  disabled: boolean;
  onGoToPage: (page: number) => void;
  onZoom: (scale: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)]">
      <ToolbarButton label="Previous page" disabled={disabled} onClick={() => onGoToPage(page - 1)}>
        ‹
      </ToolbarButton>
      <span className="px-1 tabular-nums">{pageCount ? `${page} / ${pageCount}` : "—"}</span>
      <ToolbarButton label="Next page" disabled={disabled} onClick={() => onGoToPage(page + 1)}>
        ›
      </ToolbarButton>
      <span className="mx-2 h-4 w-px bg-[var(--border-color)]" />
      <ToolbarButton label="Zoom out" disabled={disabled} onClick={() => onZoom(scale - ZOOM_STEP)}>
        −
      </ToolbarButton>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onZoom(1)}
        className="rounded-md px-2 py-0.5 tabular-nums hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] disabled:opacity-40"
      >
        {Math.round(scale * 100)}%
      </button>
      <ToolbarButton label="Zoom in" disabled={disabled} onClick={() => onZoom(scale + ZOOM_STEP)}>
        +
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-[var(--chrome-control-height)] w-7 items-center justify-center rounded-md text-base text-[var(--text-icon-muted)] transition-colors enabled:hover:bg-[var(--surface-subtle)] enabled:hover:text-[var(--text-secondary)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/**
 * The outline a resolved region quote leaves on the page (FR-022). The stored
 * fractions are mapped onto the *current* rendered box, so the same part of
 * the page is outlined after a zoom change rather than a rect scaled to the
 * wrong place (scenario 4.5).
 */
function PdfRegionHint({
  rect,
  box,
  align,
  fading,
}: {
  /** View-space fractions — the stored crop-box fractions already run through
   *  `pageRectToView`. */
  rect: PdfRect;
  box: { width: number; height: number };
  align: ScrollLogicalPosition;
  fading: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // The second half of the reveal, mirroring the text path: the pane can only
  // scroll to a *page* — where on that page the region sits is only known once
  // this box exists. `nearest` is the FR-024 case — already in view, nudge at
  // most.
  useLayoutEffect(() => {
    ref.current?.scrollIntoView({ block: align, inline: "nearest" });
  }, [align]);
  return (
    <div
      ref={ref}
      className={`pdf-region pdf-region-hint${fading ? " fading" : ""}`}
      style={rectToViewport(rect, box)}
    />
  );
}

/** A corrupt, encrypted or missing PDF says which it is and names the file.
 *  No empty view, no partial render, no retry loop, no hanging tab (FR-012). */
function PdfLoadFailure({ path, error }: { path: string; error: PdfLoadError }) {
  const reason = {
    missing: "This file is no longer where the link points.",
    corrupt: "The file is damaged or is not a PDF.",
    encrypted: "The file is password-protected, and Writer cannot unlock it.",
    unknown: "The file could not be read.",
  }[error.cause];

  return (
    <div className="p-6 text-sm text-[var(--text-secondary)]">
      <p>{reason}</p>
      <p className="mt-1 font-mono text-xs break-all text-[var(--text-muted)]">{path}</p>
      <p className="mt-2 font-mono text-xs break-all text-[var(--text-muted)]">{error.message}</p>
    </div>
  );
}
