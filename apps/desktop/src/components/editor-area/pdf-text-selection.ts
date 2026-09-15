/**
 * Makes dragging across a PDF's text layer behave like dragging across
 * ordinary prose.
 *
 * The problem this solves: a text layer is a pile of absolutely positioned
 * spans whose DOM order is reading order but whose geometry is arbitrary. A
 * native selection extends from anchor to focus **in DOM order**, so the moment
 * the pointer leaves a span — a few pixels between lines, the margin beside a
 * column — the browser picks whatever node it can hit next and selects
 * everything between. A one-line drag becomes a whole-section drag.
 *
 * The fix, ported from `TextLayerBuilder` in `pdfjs-dist/web/pdf_viewer.mjs`
 * (v6.3.289): keep a full-page, invisible, selectable block — `endOfContent` —
 * parked immediately after the span the selection currently ends at. Empty
 * space near the focus is then covered by a node that is *adjacent in DOM
 * order*, so extending into it selects nothing extra, and the selection stays
 * on the lines the pointer actually crossed.
 *
 * Only the legacy branch of upstream's logic is ported. Upstream skips all of
 * this on Firefox and Chromium ≥ 148, which fixed the underlying selection
 * behaviour; this app runs on macOS WKWebView, which has not, so the branch
 * that runs here is the one implemented below.
 */

/** Every bound text layer, mapped to its own `endOfContent` block. */
const layers = new Map<HTMLElement, HTMLElement>();

/** Torn down when the last layer unbinds, so a window with no PDF open holds
 *  no document-level listeners. */
let globalListeners: AbortController | null = null;

/** The previous selection, used only to work out which end of it is moving. */
let previousRange: Range | null = null;

/** Park the block back below the page and stop treating the layer as active. */
function reset(end: HTMLElement, layer: HTMLElement) {
  layer.append(end);
  end.style.width = "";
  end.style.height = "";
  end.style.userSelect = "";
  layer.classList.remove("selecting");
}

function resetAll() {
  layers.forEach(reset);
}

/**
 * Walk back to the previous node that has children.
 *
 * When a selection ends exactly at offset 0 of a node, the node the user is
 * actually on is the previous one — parking the block after the *next* span
 * would leave the gap uncovered. Upstream walks this unguarded; the null checks
 * here stop a selection that starts outside the layer from walking off the top
 * of the document.
 */
function previousPopulatedNode(from: Node): Node | null {
  let node: Node | null = from;
  do {
    while (node && !node.previousSibling) node = node.parentNode;
    if (!node) return null;
    node = node.previousSibling;
  } while (node && node.childNodes.length === 0);
  return node;
}

function onSelectionChange() {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    resetAll();
    return;
  }

  // A layer the selection does not touch must be parked: otherwise its block
  // stays expanded over the page and quietly eats pointer events.
  const active = new Set<HTMLElement>();
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    for (const layer of layers.keys()) {
      if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
    }
  }
  for (const [layer, end] of layers) {
    if (active.has(layer)) layer.classList.add("selecting");
    else reset(end, layer);
  }
  if (active.size === 0) return;

  const range = selection.getRangeAt(0);
  // Which end of the selection is moving. Dragging upwards holds the *end*
  // fixed and moves the start, so the block has to be parked before the focus
  // rather than after it, or a backwards drag covers the wrong side of the gap.
  const modifyStart =
    previousRange !== null &&
    (range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0);

  let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
  if (!modifyStart && range.endOffset === 0) anchor = previousPopulatedNode(anchor as Node);

  const parent = anchor instanceof Element ? anchor.parentElement : anchor?.parentElement;
  const layer = parent?.closest<HTMLElement>(".pdf-text-layer");
  const end = layer ? layers.get(layer) : undefined;
  if (end && layer && parent && anchor) {
    // Sized from the laid-out box rather than inline styles: upstream's text
    // layer carries an inline width/height and this one is sized by CSS
    // (`inset: 0`), so reading `style.width` here would yield an empty string
    // and leave the block with no area to absorb the drag.
    end.style.width = `${layer.clientWidth}px`;
    end.style.height = `${layer.clientHeight}px`;
    // Inline, so it beats App.css's blanket `user-select: none` without
    // needing `!important` — and reverts cleanly on reset.
    end.style.userSelect = "text";
    parent.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
  }

  previousRange = range.cloneRange();
}

function installGlobalListeners() {
  if (globalListeners) return;
  globalListeners = new AbortController();
  const { signal } = globalListeners;

  // A key-driven selection change (shift+arrow) should park the block as soon
  // as the key is released; a pointer drag should not, because the pointer is
  // still down and the drag is still going.
  let pointerDown = false;
  document.addEventListener("pointerdown", () => (pointerDown = true), { signal });
  document.addEventListener(
    "pointerup",
    () => {
      pointerDown = false;
      resetAll();
    },
    { signal },
  );
  document.addEventListener("keyup", () => !pointerDown && resetAll(), { signal });
  // A drag interrupted by the window losing focus never gets its pointerup.
  window.addEventListener(
    "blur",
    () => {
      pointerDown = false;
      resetAll();
    },
    { signal },
  );
  document.addEventListener("selectionchange", onSelectionChange, { signal });
}

/**
 * Give `layer` the drag behaviour above. Returns the unbind, to be called from
 * the same effect cleanup that tears the text layer down.
 */
export function bindTextLayerSelection(layer: HTMLElement): () => void {
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.append(end);
  layers.set(layer, end);

  const onMouseDown = () => layer.classList.add("selecting");
  layer.addEventListener("mousedown", onMouseDown);
  installGlobalListeners();

  return () => {
    layer.removeEventListener("mousedown", onMouseDown);
    layers.delete(layer);
    end.remove();
    if (layers.size === 0) {
      globalListeners?.abort();
      globalListeners = null;
      previousRange = null;
    }
  };
}
