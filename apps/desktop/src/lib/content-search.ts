/**
 * The `Scan` accumulator behind the content-search palette
 * (SPECs/global-content-search/data-model.md).
 *
 * Pure module — no Tauri, no React — so the merge/order/truncate rules and
 * the staleness guard run in the node test runner. The hook in
 * `components/content-search/use-content-search.ts` wires it to the channel.
 */
import type { ContentSearchEvent, SearchMatch } from "@/types/fs";

/** The ~200-result display cap (FR-010). Rust self-caps text emission at the
 *  same number; PDF matches are produced on the frontend and count toward it. */
export const CONTENT_SEARCH_CAP = 200;

export interface ContentScanState {
  state: "idle" | "scanning" | "done";
  matches: SearchMatch[];
  truncated: boolean;
}

/** FR-012's staleness guard: a monotonically increasing sequence — a dispatch
 *  owns the number it was dealt and only applies events while it is current. */
export function createSeqGuard() {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (seq: number) => seq === current,
  };
}

/**
 * One dispatched query's accumulation. Result ordering lives here, not on the
 * wire (research R5): batches merge sorted by file `modified_at` descending
 * with document order within a file — a stable sort keeps a file's matches
 * contiguous in scan order because each file contributes one contiguous batch.
 */
export class ContentScan {
  private rustDone = false;
  private pdfPending = 0;
  state: "scanning" | "done" = "scanning";
  matches: SearchMatch[] = [];
  truncated = false;

  /** Merge a batch into the sorted, capped result list. */
  addMatches(batch: SearchMatch[]): void {
    if (batch.length === 0) return;
    const merged = [...this.matches, ...batch].sort((a, b) => b.modified_at - a.modified_at);
    if (merged.length > CONTENT_SEARCH_CAP) this.truncated = true;
    this.matches = merged.slice(0, CONTENT_SEARCH_CAP);
  }

  /** A `.pdf` arrived in the corpus. True when extraction is still worth
   *  running; false when the display cap already makes its matches
   *  undisplayable — the "unprocessed PDF candidates" truncation source. */
  addPdfCandidate(): boolean {
    if (this.matches.length >= CONTENT_SEARCH_CAP) {
      this.truncated = true;
      return false;
    }
    this.pdfPending++;
    return true;
  }

  /** A queued candidate finished extracting (empty `found` when it failed or
   *  matched nothing — both are the spec's "simply doesn't match"). */
  resolvePdfCandidate(found: SearchMatch[], overflowed: boolean): void {
    this.pdfPending--;
    if (overflowed) this.truncated = true;
    this.addMatches(found);
    this.checkDone();
  }

  /** One channel event. Returns `"extract"` when the event queued a PDF
   *  candidate for extraction, so the caller can schedule the work. */
  applyEvent(event: ContentSearchEvent): "extract" | undefined {
    switch (event.type) {
      case "matches":
        this.addMatches(event.matches);
        return;
      case "pdf":
        return this.addPdfCandidate() ? "extract" : undefined;
      case "done":
        this.rustDone = true;
        if (event.truncated) this.truncated = true;
        this.checkDone();
        return;
    }
  }

  /** The invoke failed — no further events will arrive. */
  fail(): void {
    this.state = "done";
  }

  private checkDone(): void {
    // FR-015: `done` only once the Rust scan finished *and* the PDF candidate
    // queue drained — before that the empty list means "still searching".
    if (this.rustDone && this.pdfPending === 0) this.state = "done";
  }

  snapshot(): ContentScanState {
    return { state: this.state, matches: this.matches, truncated: this.truncated };
  }
}
