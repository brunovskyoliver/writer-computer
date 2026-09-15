/**
 * The quote-link anchor grammar. See SPECs/pdf-quote-links/contracts/quote-link.md
 * — that contract lives in the user's Markdown forever, so this module is the
 * one place that reads or writes it.
 *
 * Anchors are immutable: there is no mutation API here, only construction from
 * a capture and parsing from a link fragment.
 */

/** Fractions of the page's unrotated crop box, so an anchor survives zoom and
 *  device-pixel-ratio changes (FR-020, research.md R7). */
export type PdfRect = { x: number; y: number; w: number; h: number };

export type PdfAnchor =
  | { kind: "text"; page: number; text: string }
  | { kind: "region"; page: number; rect: PdfRect };

/** The link carries a re-find *hint*, not the quote: the blockquote above it
 *  holds the full passage (FR-019). */
export const TEXT_HINT_MAX = 120;

/** How far either side of the recorded page a passage is looked for
 *  (research.md R6). Bounded on purpose — a full-document scan on every click
 *  would cost more than the rare case is worth. */
export const REFIND_PAGE_WINDOW = 2;

function isValidPage(page: unknown): page is number {
  return typeof page === "number" && Number.isInteger(page) && page >= 1;
}

function isFraction(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validate a rect as parsed off a link. Out-of-range components are
 * **rejected, not clamped**: a link saying `rect=1.4,...` is a link we cannot
 * read, and clamping it would paint a confidently wrong highlight — exactly
 * what FR-025 forbids. Clamping belongs at capture (`regionAnchor`), where the
 * out-of-range value is a drag running off the page edge and the user's intent
 * is unambiguous.
 */
function isValidRect(rect: PdfRect): boolean {
  return (
    isFraction(rect.x) &&
    isFraction(rect.y) &&
    isFraction(rect.w) &&
    isFraction(rect.h) &&
    rect.w > 0 &&
    rect.h > 0
  );
}

/** Build a text anchor from a capture. `null` for an empty selection. */
export function textAnchor(page: number, text: string): PdfAnchor | null {
  const trimmed = text.trim();
  if (!isValidPage(page) || trimmed.length === 0) return null;
  return { kind: "text", page, text: trimmed };
}

/**
 * Build a region anchor from a drag. Components are clamped into `[0,1]` — a
 * drag that ran off the edge of the page means the edge — and a zero-area
 * result is rejected, so an accidental click raises no button (FR-015).
 */
export function regionAnchor(page: number, rect: PdfRect): PdfAnchor | null {
  if (!isValidPage(page)) return null;
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : Number.NaN);
  const x = clamp(rect.x);
  const y = clamp(rect.y);
  const clamped: PdfRect = { x, y, w: clamp(rect.x + rect.w) - x, h: clamp(rect.y + rect.h) - y };
  return isValidRect(clamped) ? { kind: "region", page, rect: clamped } : null;
}

function sixSignificantDigits(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * Encode an anchor as the `#...` fragment of a wiki link.
 *
 * `text` is truncated **before** percent-encoding — truncating after would cut
 * a `%XX` escape in half and produce a fragment that will not decode.
 * Percent-encoding also takes care of the contract's `|` and `]` rules for this
 * parameter: `encodeURIComponent` escapes both, so neither can terminate the
 * link. The alias is the caller's problem (it needs `\|` escaping).
 */
export function encodeAnchorFragment(anchor: PdfAnchor): string {
  const page = `page=${anchor.page}`;
  if (anchor.kind === "text") {
    const hint = anchor.text.slice(0, TEXT_HINT_MAX);
    return `${page}&text=${encodeURIComponent(hint)}`;
  }
  const { x, y, w, h } = anchor.rect;
  const rect = [x, y, w, h].map(sixSignificantDigits).join(",");
  return `${page}&rect=${rect}`;
}

/** Fragment with no anchor parameters: open the page, highlight nothing. */
export type PdfAnchorParse =
  | { kind: "anchor"; anchor: PdfAnchor }
  | { kind: "page"; page: number }
  | { kind: "unreadable"; page: number; reason: string };

function parsePage(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(raw)) return null;
  const page = Number(raw);
  return isValidPage(page) ? page : null;
}

function parseRect(raw: string): PdfRect | null {
  const parts = raw.split(",");
  if (parts.length !== 4) return null;
  const [x, y, w, h] = parts.map(Number);
  const rect = { x, y, w, h };
  return isValidRect(rect) ? rect : null;
}

/**
 * Parse a link fragment into an anchor.
 *
 * Three outcomes, not two: a usable anchor, a plain page link (the contract's
 * "neither `text` nor `rect`" case), or a page we can still navigate to with a
 * report that the anchor itself was unreadable. The third is why this does not
 * return `PdfAnchor | null` — FR-025 requires going to the recorded page and
 * saying so, which needs the page even when the rest is garbage.
 *
 * **Unknown parameters are ignored, not failed.** The contract's compatibility
 * clause ("a note written by a later version still opens here at the right
 * page") is the stronger promise, so only a malformed *known* parameter makes a
 * fragment unreadable. Do not "fix" this into rejecting unknown keys.
 */
export function parseAnchorFragment(fragment: string | null | undefined): PdfAnchorParse {
  if (!fragment) return { kind: "page", page: 1 };

  const params = new Map<string, string>();
  for (const part of fragment.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const page = parsePage(params.get("page"));
  if (page === null) return { kind: "unreadable", page: 1, reason: "page is not a number" };

  const rawText = params.get("text");
  const rawRect = params.get("rect");

  if (rawText !== undefined && rawRect !== undefined) {
    return { kind: "unreadable", page, reason: "both text and rect are present" };
  }

  if (rawText !== undefined) {
    let text: string;
    try {
      text = decodeURIComponent(rawText);
    } catch {
      return { kind: "unreadable", page, reason: "text is not valid percent-encoding" };
    }
    const anchor = textAnchor(page, text);
    return anchor
      ? { kind: "anchor", anchor }
      : { kind: "unreadable", page, reason: "text is empty" };
  }

  if (rawRect !== undefined) {
    const rect = parseRect(rawRect);
    return rect
      ? { kind: "anchor", anchor: { kind: "region", page, rect } }
      : { kind: "unreadable", page, reason: "rect is malformed or out of range" };
  }

  return { kind: "page", page };
}

/** Where a region anchor lands on a page rendered at `viewport`, in CSS pixels
 *  relative to the page element. One multiply, done at paint time — which is
 *  what makes the same rect follow a zoom change (scenario 4.5). */
export function rectToViewport(
  rect: PdfRect,
  viewport: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.x * viewport.width,
    top: rect.y * viewport.height,
    width: rect.w * viewport.width,
    height: rect.h * viewport.height,
  };
}

/**
 * pdf.js text extraction splits a line into runs with inconsistent spacing, so
 * a passage copied out of one render will not match another character for
 * character. Collapsing runs of whitespace is the smallest normalization that
 * makes the comparison survive that without becoming fuzzy matching — the
 * match is still exact, just on whitespace-normalized text.
 */
export function normalizePageText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The form two readings of the same page can be compared in: all whitespace
 * removed.
 *
 * pdf.js hands the same page back with **different spacing depending on how it
 * is read**, and the difference is not noise we can collapse — it is missing
 * characters:
 *
 * - `getTextContent()` yields positioned items, which a caller joins with a
 *   space. A line made of three items reads `"the quoted passage"`.
 * - A DOM selection over the text layer concatenates those same items' spans
 *   with **nothing** between them, because they are inline elements with no
 *   whitespace in the markup. The same line reads `"thequotedpassage"`.
 *
 * Items split mid-line for ordinary reasons — a font change, a ligature, a
 * kerning jump — so any passage crossing an item boundary would never match
 * itself. Collapsing runs (`normalizePageText`) cannot fix that: there is no
 * whitespace on one side to collapse.
 *
 * Removing whitespace entirely is what makes the comparison *exact* on the
 * characters that carry meaning, rather than fuzzy. It is only ever the
 * comparison form — the quoted text stored in the note stays
 * `normalizePageText`'d and readable.
 */
export function compactPageText(text: string): string {
  return text.replace(/\s+/g, "");
}

export type RefindResult =
  /** `index` and `text` are in **compacted** space (`compactPageText`), which
   *  is the only space the two readings of a page agree in. A caller that
   *  highlights must compact its own haystack the same way. */
  { kind: "found"; page: number; index: number; text: string } | { kind: "not-located" };

/**
 * Look for `text` on the recorded page, then outward one page at a time to
 * `REFIND_PAGE_WINDOW`. Nearest-first, so a passage that shifted by one page
 * is found on the page it actually moved to rather than a coincidental match
 * further away.
 *
 * `getPageText` is injected rather than imported so this is testable without
 * pdf.js, matching `nextAvailableDrawingPath`'s `exists` parameter.
 */
export async function refindPassage(
  text: string,
  recordedPage: number,
  pageCount: number,
  getPageText: (page: number) => Promise<string>,
): Promise<RefindResult> {
  const needle = compactPageText(text);
  if (!needle) return { kind: "not-located" };

  const candidates: number[] = [recordedPage];
  for (let offset = 1; offset <= REFIND_PAGE_WINDOW; offset++) {
    candidates.push(recordedPage - offset, recordedPage + offset);
  }

  for (const page of candidates) {
    if (page < 1 || page > pageCount) continue;
    const haystack = compactPageText(await getPageText(page));
    const index = haystack.indexOf(needle);
    if (index !== -1) return { kind: "found", page, index, text: needle };
  }
  return { kind: "not-located" };
}

// --- quote insertion -------------------------------------------------------

/**
 * Escape the one character that can terminate a wiki link's alias early.
 * `lib/wiki-links.ts` unescapes `\|` on the way back in, so this is the
 * matching half of that pair.
 */
function escapeAlias(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * The Markdown a quote inserts: a blockquote, a blank line, and the link back.
 * The exact shape is `contracts/quote-link.md`, which lives in the user's notes
 * forever — change it here and nowhere else.
 *
 * `path` must already be **workspace-relative and `.pdf`-qualified**. Bare-stem
 * resolution cannot find a PDF, because the fuzzy index is Markdown-only
 * (research.md R3), so an unqualified path here is a permanently broken link on
 * disk rather than a bug that can be fixed later.
 *
 * `body` is the full passage (or, for a region, the placeholder caption the
 * user edits — FR-016). It is *not* the same string as the anchor's `text`:
 * the anchor carries a 120-character re-find hint, the blockquote carries
 * everything (FR-019).
 *
 * The alias is the filename plus the page, per both worked examples in the
 * contract. T021's wording says "stem"; the contract's examples say
 * `apology.pdf p.12`, and the contract is the artifact that outlives us.
 */
export function quoteMarkdown(path: string, anchor: PdfAnchor, body: string): string {
  // Every line gets its own `>`. A passage that already contains a newline
  // would otherwise leave the second line outside the quote, and the link with
  // it — which reads as a stray paragraph in any other editor (SC-007).
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  const alias = escapeAlias(`${path.slice(path.lastIndexOf("/") + 1)} p.${anchor.page}`);
  return `${quoted}\n\n[[${path}#${encodeAnchorFragment(anchor)}|${alias}]]`;
}
