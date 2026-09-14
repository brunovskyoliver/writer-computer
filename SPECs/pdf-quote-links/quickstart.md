# Quickstart: Validating PDF Viewing, Highlighting and Quote Links

How to prove the feature works end to end. Scenarios map to the spec's acceptance criteria.
Details of shapes and syntax live in [data-model.md](./data-model.md) and
[contracts/](./contracts/).

## Prerequisites

- A workspace containing: a note, a text-layer PDF (a paper), a scanned PDF with no text
  layer, and a large PDF (500+ pages) for the performance checks.
- `vp install` run after pulling.

## Gates

Run from the repo root unless noted. A change is not complete until all pass
(Constitution, Technology and Quality Constraints).

```bash
vp check        # format, lint, TypeScript
vp test         # JS/TS tests
```

```bash
cd apps/desktop/src-tauri
cargo test && cargo clippy && cargo fmt --check
```

## Automated checks to expect

Pure logic only — UI is not over-tested (Constitution VI).

| Module                   | What is checked                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/pdf-anchor.ts`      | Anchor round-trips through the link grammar; out-of-range and malformed fragments are rejected rather than clamped into a wrong highlight; rect fractions survive a zoom change         |
| `lib/wiki-links.ts`      | A `.pdf` target resolves with its extension intact; a bare stem does not silently resolve to a note                                                                                     |
| `stores/editor-store.ts` | The standalone-surface predicate: a PDF path and a drawing path both dispatch correctly, and `navigateToFile` reuses an open tab of the same kind and path rather than opening a second |
| `commands/fs.rs`         | `is_sidebar_file` accepts `.pdf`, still rejects a bare `.svg`, and `is_markdown` stays false for a PDF                                                                                  |

## Manual scenarios

Run the app with `vp run dev` (or `pnpm tauri dev` from `apps/desktop`).

### 1 — Read a PDF beside a note (US1)

1. Open the sidebar. The PDF is listed beside notes and drawings. → 1.1
2. Open it. It takes its own tab; the focused note is not replaced. → 1.2, FR-003
3. Drag the tab to the edge of the note's pane. Both are visible. → 1.3
4. Type in the note while scrolling the PDF. No delay. → 1.4, SC-002
5. Toggle light/dark. Toolbar, page framing and scrollbars follow the app theme with no
   reopen. → 1.5, FR-008
6. Quit and relaunch. The tab returns at the page it was left on. → 1.6, FR-005
7. Right-click the PDF in the sidebar: no note-only actions offered. → FR-002

### 2 — Quote a text selection (US2)

1. Select a sentence in the PDF. The button appears beside it; nothing in the layout
   moves. → 2.1, FR-015
2. Press it. The note gains a blockquote of that sentence plus a link naming the PDF and
   page. → 2.2, FR-016
3. Press undo once. The whole insertion reverts as one step. → 2.4, FR-017
4. Select across a page boundary and quote. One quote, anchored at the starting page,
   carrying the full text. → 2.3
5. Close every note pane, then select PDF text. The button says there is no note to quote
   into. → 2.5, FR-018
6. Press Escape. The button disappears. → 2.6
7. Click-drag two pixels. No button appears. → edge case

### 3 — Jump from a quote back to the PDF (US3)

1. With the PDF closed, click a quote link. It opens in a split beside the note, at the
   anchored place, highlighted. → 3.1
2. With the PDF already visible in another pane, click the link. That pane is reused — no
   new tab, no new split — and scrolls. → 3.2, FR-021a, SC-006
3. With the PDF in a background tab, click the link. That tab comes forward and
   scrolls. → 3.3, FR-021b
4. Click a link whose anchor already fills the view. The highlight re-emphasises and the
   page does not jump. → 3.4, FR-024
5. Wait a few seconds, or scroll. The emphasis fades and the page is readable. → 3.5,
   FR-023
6. Rename the PDF outside the app, then click the link. The app names the missing path. No
   blank viewer. → 3.6, FR-026

### 4 — Quote a region (US4)

1. Hold the region modifier and drag a rectangle. It is drawn; the button appears. → 4.1
2. Quote it. The note gains an editable caption plus a link anchored to that page and
   rectangle. → 4.2, FR-016
3. Click that link. The same rectangle is outlined. → 4.3
4. Change zoom, then click again. The same part of the page is outlined, not a rectangle
   scaled wrong. → 4.5, FR-020
5. On the scanned PDF, drag across a page. It is a region gesture by default, with visible
   feedback — not a dead text selection. → 4.4

### 5 — Failure cases (SC-009, FR-012)

Each must name its cause; none may fail silently.

- A corrupt/truncated PDF: opening fails with a message naming the file; the tab does not
  hang.
- An encrypted PDF: reported as unopenable, with no loop and no partial render.
- An anchored page past the end of a shortened PDF: the user is told; the viewer opens at
  the last page.
- A quoted passage no longer findable: the viewer goes to the recorded page and says the
  passage was not located — it does not highlight something else. → FR-025

### 6 — Performance (SC-001 … SC-004)

- Open the 500-page PDF: first page visible within 1 second. → SC-001
- Scroll it end to end and back beside a note you are typing in: typing stays smooth and
  memory returns to roughly where it started. → SC-002, SC-003
- Confirm PDFs do not appear in workspace search or quick-open, and sidebar listing speed
  is unchanged. → SC-004, FR-006

### 7 — Portability (SC-007)

Open the note in another Markdown editor. The quoted text and the source PDF's name are
readable.

## Known gaps to confirm, not to file as bugs

- Reopening a PDF directly shows **no** prior highlights. Highlights appear only when
  arriving from a quote (spec Non-Goals).
- Renaming a PDF inside the workspace does **not** rewrite quote links in note bodies.
  Links report the missing path. See research.md R5 — the app has no note-body link
  rewriting for any link type today; this is deferred to its own spec.
