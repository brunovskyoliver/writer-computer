/**
 * The content-search `Scan` lifecycle (SPECs/global-content-search).
 *
 * Debounced (~150ms), progressively updating. Each dispatch gets a fresh
 * `Channel` and seq; a superseded dispatch's events — channel messages and
 * in-flight PDF resolutions alike — are dropped (FR-012). The Rust-side walk
 * is killed by the next invoke's flag installation, not here (research R2).
 * The merge/order/truncate rules live in `lib/content-search.ts`.
 */
import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import * as tauri from "@/lib/tauri";
import { pdfSearchLines } from "@/lib/pdf";
import { matchPdfPages } from "@/lib/pdf-search";
import { ContentScan, createSeqGuard, type ContentScanState } from "@/lib/content-search";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { ContentSearchEvent, PdfCandidate, SearchMatch } from "@/types/fs";

const DEBOUNCE_MS = 150;
/** pdf.js extractions in flight at once — enough to keep results flowing
 *  without stampeding the worker on a PDF-heavy workspace. */
const PDF_CONCURRENCY = 2;

const IDLE: ContentScanState = { state: "idle", matches: [], truncated: false };

export function useContentSearch(query: string): ContentScanState {
  const [scan, setScan] = useState<ContentScanState>(IDLE);
  const guardRef = useRef(createSeqGuard());

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const guard = guardRef.current;
    const seq = guard.next();
    const timer = setTimeout(() => {
      const acc = new ContentScan();
      const publish = () => {
        if (guard.isCurrent(seq)) setScan(acc.snapshot());
      };
      // Clear the superseded scan's rows at dispatch — the list only ever
      // shows the live query's results.
      publish();

      const root = useWorkspaceStore.getState().root;
      const channel = new Channel<ContentSearchEvent>();
      const pdfQueue: PdfCandidate[] = [];
      let pdfInFlight = 0;

      const pumpPdfs = () => {
        while (pdfInFlight < PDF_CONCURRENCY && pdfQueue.length > 0) {
          const candidate = pdfQueue.shift()!;
          pdfInFlight++;
          void (async () => {
            let found: SearchMatch[] = [];
            let overflowed = false;
            try {
              const pages = await pdfSearchLines(candidate.path);
              if (pages) {
                const relativePath =
                  root && candidate.path.startsWith(`${root}/`)
                    ? candidate.path.slice(root.length + 1)
                    : candidate.path;
                const result = matchPdfPages(pages, trimmed, {
                  path: candidate.path,
                  relativePath,
                  modifiedAt: candidate.modified_at,
                });
                found = result.matches;
                overflowed = result.truncated;
              }
            } finally {
              pdfInFlight--;
              if (guard.isCurrent(seq)) {
                acc.resolvePdfCandidate(found, overflowed);
                publish();
                pumpPdfs();
              }
            }
          })();
        }
      };

      channel.onmessage = (event) => {
        if (!guard.isCurrent(seq)) return;
        if (event.type === "pdf") {
          if (acc.applyEvent(event) === "extract") {
            pdfQueue.push(event.candidate);
            pumpPdfs();
          }
        } else {
          acc.applyEvent(event);
        }
        publish();
      };

      void tauri.contentSearch(trimmed, channel).catch(() => {
        // AppError path — e.g. the workspace closed mid-call. The scan is
        // over either way: no more events will arrive on this channel.
        if (guard.isCurrent(seq)) {
          acc.fail();
          publish();
        }
      });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Supersede the dispatch: its channel events and in-flight PDF
      // resolutions stop applying. The walk itself dies on the next invoke.
      guard.next();
    };
  }, [query]);

  // An empty query is the hint state — never a scan, never stale rows.
  return query.trim() ? scan : IDLE;
}
