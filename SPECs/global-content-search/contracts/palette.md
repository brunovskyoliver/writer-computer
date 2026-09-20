# Contract: Content-Search Palette

The user-facing surface for `global-content-search`. Structure mirrors the
`Cmd+P` palette (cmdk `CommandDialog`, `shouldFilter={false}`, controlled
`value`); behavior below is the contract, layout is the design.

## Opening and closing

- `Cmd+Shift+F` (global `useKeyboardShortcuts`) →
  `openCommandPalette("content-search")`. Requires a workspace root: in
  compact standalone windows the shortcut is a no-op (spec clarification).
- Closes via the shared `closeCommandPalette` — Esc, overlay click, or
  successful activation. Closing mid-scan drops the seq (frontend) and lets the
  next invoke's flag flip kill the walk (Rust).

## Layout

- Search input at top (placeholder communicates content search, e.g.
  "Search in files...").
- Results list below: one `CommandItem` per `SearchMatch`. Row shows file
  identity, the matched line with `match_ranges` highlighted, and location —
  `L<n>` for text, `Page <n>` for PDFs.
- Preview pane beside the list: renders the highlighted item's `context`
  (~5 lines) with the match marked; PDFs show the page excerpt plus the page
  number. No rendered PDF page image (FR-004).
- The preview tracks cmdk `value`, which updates on arrow keys **and** pointer
  hover (cmdk default pointer selection) — FR-006 covers both without extra
  wiring.

## States

| Condition                | Surface                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| Empty query              | Hint state explaining content search; no scan, no results                       |
| Scanning, results so far | Results + a scanning indicator distinguishable from the finished state (FR-015) |
| Scanning, no results yet | Scanning indicator — **not** the no-results state                               |
| Done, zero matches       | Clear no-results state                                                          |
| Done, `truncated`        | Results + a "results truncated" indicator (FR-010)                              |
| Query superseded         | Stale events dropped by seq; UI shows only the live scan (FR-012)               |

## Ordering and caps

- List order: containing file's `modified_at` desc; matches within a file in
  document order. Maintained as batches arrive — the list grows and re-sorts
  while scanning.
- Display cap ~200 matches; per-file cap ~20 (enforced in Rust). Overflow →
  `truncated` indicator.

## Activation

Enter or click on a `SearchMatch`:

| `kind` | Route                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text` | `PendingTarget.line` set for the resolving tab → `navigateToFile` (reuses an open tab per existing rules) → editor scrolls the line into view and selects the re-found needle |
| `pdf`  | `openFile(path)` (reuse-or-open in the pane) → `requestPdfAnchor(tabId, "page=N&text=<hint>")` → pdf-pane reveals the page and emphasises the re-found passage                |

The `text` hint on the PDF fragment is the matched line's text (≤
`TEXT_HINT_MAX` chars, same truncation the grammar already applies) so the pane
can re-find and highlight the passage in its own coordinates. A PDF whose file
changed enough to defeat the re-find degrades to the page, which is still the
spec's landing guarantee.

## Non-goals carried from the spec

- No filename matching — `Cmd+P` owns it (FR-013).
- No rendered-page-image preview, no regex, no replace, no search history.
- No sidebar button in v1 — `Cmd+Shift+F` is the entry point.
