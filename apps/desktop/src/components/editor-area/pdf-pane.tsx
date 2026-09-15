import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { acquirePdf, pdfjsTextLayer, releasePdf, type PdfLoadError } from "@/lib/pdf";
import { normalizePageText, textAnchor } from "@/lib/pdf-anchor";
import { useEditorStore } from "@/stores/editor-store";
import { PdfQuoteButton, type PdfQuoteCapture } from "./pdf-quote-button";
import type { PdfLocation } from "./page-kinds/pdf";
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

const ZOOM_STEP = 0.2;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;

/** Unscaled page dimensions, in PDF units. Pages in one document are usually
 *  but not always the same size, so each is refined once it has been read. */
type PageSize = { width: number; height: number };

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
  const pageNumber = Number(start?.closest("[data-pdf-page]")?.getAttribute("data-pdf-page"));
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
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onMeasure: (pageNumber: number, size: PageSize) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    let textLayer: { cancel: () => void } | null = null;
    const textContainer = textRef.current;

    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const unscaled = page.getViewport({ scale: 1 });
      onMeasure(pageNumber, { width: unscaled.width, height: unscaled.height });

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
      textLayer?.cancel();
      // `TextLayer` appends to the container and never clears it, so a scale
      // change would stack a second set of spans on top of the first —
      // duplicated, unselectable-looking text and two overlapping hit targets.
      textContainer?.replaceChildren();
    };
  }, [doc, pageNumber, scale, onMeasure]);

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
        const { width, height } = page.getViewport({ scale: 1 });
        setState({
          status: "ready",
          doc: result.doc.proxy,
          sizes: new Array(result.doc.pageCount).fill({ width, height }),
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
      if (existing && existing.width === size.width && existing.height === size.height) {
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

  const goToPage = useCallback(
    (page: number) => {
      const container = scrollRef.current;
      if (!container || !offsets) return;
      const clamped = Math.min(Math.max(page, 1), pageCount);
      container.scrollTop = offsets[clamped - 1];
    },
    [offsets, pageCount],
  );

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
                style={{
                  height: offsets[pageCount],
                  width: Math.max(viewportWidth, widestPage * scale),
                }}
              >
                {Array.from({ length: renderTo - renderFrom + 1 }, (_, i) => {
                  const index = renderFrom + i;
                  const size = state.sizes[index];
                  return (
                    <div
                      key={index}
                      // The page number a selection resolves to. Read off the
                      // DOM rather than tracked in state because the selection
                      // itself is a DOM fact, and the two must not disagree.
                      data-pdf-page={index + 1}
                      className="absolute right-0 left-0 mx-auto"
                      style={{ top: offsets[index], width: size.width * scale }}
                    >
                      <PdfPageCanvas
                        doc={state.doc}
                        pageNumber={index + 1}
                        scale={scale}
                        onMeasure={onMeasure}
                      />
                    </div>
                  );
                })}
                {capture ? (
                  <PdfQuoteButton
                    capture={capture}
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
