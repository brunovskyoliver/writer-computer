import { create } from "zustand";

/**
 * Pending quote-link anchors, keyed by the PDF tab that should honour them
 * (SPECs/pdf-quote-links/, T026). The value is the raw link fragment —
 * `page=12&text=…` — parsed by `lib/pdf-anchor.ts` at the consuming end, so
 * this module stays ignorant of the grammar.
 *
 * **Why this is not `lib/pending-anchor.ts`.** data-model.md specifies a
 * consumed-exactly-once handoff, and that module already is one — but its
 * contract is "read at the next *mount*", which is all a heading anchor ever
 * needs, because following a heading link always swaps the editor's document.
 * A PDF resolution has a third case that module cannot serve: FR-021(a), a
 * pane already *showing* the target PDF. Nothing remounts there, so a
 * mount-time read never fires. Adding a subscription to `pending-anchor.ts`
 * would turn a handoff into a pub/sub channel for one consumer and leave the
 * markdown side carrying a notify path it ignores; a store the pane can select
 * from is the same one-shot semantics with the one property that case needs.
 * (Divergence from data-model.md's `PdfView.pendingAnchor`, recorded per T026
 * in `SPECs/pdf-quote-links/tasks.md`.)
 *
 * Consumption clears the entry, so an anchor is honoured once and a later
 * scroll, zoom or re-render never re-plays it.
 */
interface PdfAnchorState {
  /** tabId → link fragment. */
  requests: Record<string, string>;
  requestPdfAnchor: (tabId: string, fragment: string) => void;
  consumePdfAnchor: (tabId: string) => string | null;
}

export const usePdfAnchorStore = create<PdfAnchorState>((set, get) => ({
  requests: {},
  requestPdfAnchor: (tabId, fragment) => {
    set((state) => ({ requests: { ...state.requests, [tabId]: fragment } }));
  },
  consumePdfAnchor: (tabId) => {
    const fragment = get().requests[tabId];
    if (fragment === undefined) return null;
    set((state) => {
      const { [tabId]: _consumed, ...rest } = state.requests;
      return { requests: rest };
    });
    return fragment;
  },
}));

/** Queue an anchor for a tab that may not be mounted yet. Written before the
 *  layout mutation that creates or reveals the tab, so a pane mounting in the
 *  same commit already sees it. */
export function requestPdfAnchor(tabId: string, fragment: string): void {
  usePdfAnchorStore.getState().requestPdfAnchor(tabId, fragment);
}
