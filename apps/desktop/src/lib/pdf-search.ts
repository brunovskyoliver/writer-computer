/**
 * Content-search matching for PDF page text (SPECs/global-content-search).
 *
 * Pure module — no pdf.js import — so the line splitter and the matcher run in
 * the node test runner. `lib/pdf.ts` feeds it `getTextContent` items behind
 * the lazy pdf.js boundary.
 *
 * The smart-case matcher is the acknowledged ~10-line duplication of the Rust
 * matcher in `commands/search.rs` (research R3): pdf.js cannot run in Rust, so
 * the same rule lives once on each side, pinned by tests on both.
 */
import type { ContextLine, SearchMatch } from "@/types/fs";

/** ~20 matches per file — the same bound the Rust walker enforces (FR-010). */
export const MAX_MATCHES_PER_FILE = 20;
/** Lines either side of a match (~5 total with the matched line). */
const CONTEXT_RADIUS = 2;

/** The shape of one `getTextContent` item — structural so `TextItem` and
 *  `TextMarkedContent` both fit without importing pdf.js types. */
export interface PdfTextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/** Reconstruct a page's lines: items concatenate, and a line ends wherever an
 *  item marks `hasEOL`. A trailing fragment with no EOL is still a line. */
export function pdfTextItemsToLines(items: readonly PdfTextItemLike[]): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    current += item.str;
    if (item.hasEOL) {
      lines.push(current);
      current = "";
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Smart case (FR-011): a query containing an uppercase character matches
 *  case-sensitively; anything else is case-insensitive. */
export function isCaseSensitiveQuery(query: string): boolean {
  return Array.from(query).some((char) => char !== char.toLowerCase());
}

/** Literal substring matches on one line — `[char_start, len]` pairs in
 *  document order, non-overlapping. Char units (code points), not UTF-16
 *  units, matching the Rust side so both producers feed one contract. */
export function findMatchRanges(
  line: string,
  needle: string,
  caseSensitive: boolean,
): [number, number][] {
  const n = Array.from(needle);
  if (n.length === 0) return [];
  const haystack = Array.from(line);
  if (haystack.length < n.length) return [];

  const equals = caseSensitive
    ? (a: string, b: string) => a === b
    : (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const ranges: [number, number][] = [];
  let i = 0;
  while (i + n.length <= haystack.length) {
    let hit = true;
    for (let j = 0; j < n.length; j++) {
      if (!equals(haystack[i + j]!, n[j]!)) {
        hit = false;
        break;
      }
    }
    if (hit) {
      ranges.push([i, n.length]);
      i += n.length;
    } else {
      i += 1;
    }
  }
  return ranges;
}

/** Match `query` against the extracted lines of every page. `pages[0]` is
 *  page 1 — matching is per line, so a result always reports the page its
 *  matched line lives on. `context` is built from the same extracted lines
 *  the matcher searched, so the preview can never disagree with the match. */
export function matchPdfPages(
  pages: string[][],
  query: string,
  base: { path: string; relativePath: string; modifiedAt: number },
): { matches: SearchMatch[]; truncated: boolean } {
  const caseSensitive = isCaseSensitiveQuery(query);
  const matches: SearchMatch[] = [];
  let truncated = false;

  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p]!;
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES_PER_FILE) {
        truncated = true;
        break;
      }
      const ranges = findMatchRanges(lines[i]!, query, caseSensitive);
      if (ranges.length === 0) continue;

      const start = Math.max(0, i - CONTEXT_RADIUS);
      const end = Math.min(lines.length, i + CONTEXT_RADIUS + 1);
      const context: ContextLine[] = [];
      for (let k = start; k < end; k++) {
        context.push({ line_number: k + 1, text: lines[k]! });
      }

      matches.push({
        path: base.path,
        relative_path: base.relativePath,
        modified_at: base.modifiedAt,
        kind: "pdf",
        line_number: null,
        page: p + 1,
        line_text: lines[i]!,
        match_ranges: ranges,
        context,
      });
    }
    if (matches.length >= MAX_MATCHES_PER_FILE) {
      truncated = true;
      break;
    }
  }

  return { matches, truncated };
}
