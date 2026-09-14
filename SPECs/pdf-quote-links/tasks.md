---
description: "Task list for PDF Viewing, Highlighting and Quote Links"
---

# Tasks: PDF Viewing, Highlighting and Quote Links

**Input**: Design documents from `SPECs/pdf-quote-links/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included, but only the four rows quickstart.md lists. Pure logic is unit-tested;
rendering is not (Constitution VI — UI is not over-tested). Do not add UI tests.

**Organization**: Grouped by user story. Note that the three P1 stories are _not_ mutually
independent — see Dependencies.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4, on Phase 3+ tasks only
- Exact file paths are in every description

## Path Conventions

Desktop app — React frontend + Rust backend.

- Frontend: `apps/desktop/src/`
- Rust: `apps/desktop/src-tauri/src/`
- Frontend tests: `apps/desktop/tests/*.test.ts` (flat directory; there is no `__tests__/`)

---

## Phase 1: Setup

**Purpose**: Bring in the one new dependency. The project already exists; nothing is scaffolded.

- [x] T001 Add `pdfjs-dist` to the `catalog:` block in `pnpm-workspace.yaml` and reference it as `"pdfjs-dist": "catalog:"` under `dependencies` in `apps/desktop/package.json`
- [x] T002 Run `vp install` from the repo root and confirm `vp check` still passes with the new dependency present but unimported

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The renderer boundary, the anchor grammar, and the registry refactor that must land
before the `pdf` kind is added.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T003 Create `apps/desktop/src/lib/pdf.ts`: lazy `await import("pdfjs-dist")` boundary mirroring `apps/desktop/src/lib/drawings.ts`, set `GlobalWorkerOptions.workerSrc` from `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` inside that same lazy module (research.md R2). Per research.md R2's flagged risk and the project's debugging rule: if worker resolution fails once under Vite+, add a debug log before changing approach — do not guess at worker paths twice.
- [x] T004 In `apps/desktop/src/lib/pdf.ts`, add the explicit load result `{ ok: true, doc } | { ok: false, error }` mirroring `DrawingLoadResult` in `apps/desktop/src/lib/drawings.ts`, where `error` distinguishes _corrupt_, _encrypted_ and _missing_ so FR-012 and FR-026 can name the cause. Never throw-or-return-empty. Expose `PdfDocument` as `{ path, proxy, pageCount }` — runtime only, never serialized.
- [x] T005 In `apps/desktop/src/lib/pdf.ts`, add the per-path document cache: a document is cached while at least one PDF tab references it and is destroyed when the last tab closes. Rendered page canvases are retained only for a window around the viewport, not for every page scrolled past (SC-003).
- [x] T006 [P] Create `apps/desktop/src/lib/pdf-anchor.ts` with the `PdfAnchor` tagged union from data-model.md: text variant `{ kind: "text", page, text }` and region variant `{ kind: "region", page, rect: { x, y, w, h } }`. Validation, stated verbatim: `page >= 1`; every rect component finite and within `[0,1]` after clamping; `w > 0 && h > 0`. A zero-area rect is rejected on parse. An anchor is immutable once written — no state transitions.
- [x] T007 [P] In `apps/desktop/src/lib/pdf-anchor.ts`, implement encode/parse against the grammar in `contracts/quote-link.md`: `page` is 1-based and always present; **exactly one** of `text` or `rect` is present, and neither means a plain page link with no highlight; `text` is percent-encoded and **truncated to 120 characters**; `rect` is `x,y,w,h` fractions of the page's unrotated crop box, **each in `[0,1]`, at most 6 significant digits**; `|` inside `text` or the alias is escaped `\|` matching `apps/desktop/src/lib/wiki-links.ts`; `]` may not appear unescaped. A fragment that does not parse (unknown key, bad number, out-of-range rect) yields the recorded page with **no highlight** and an "anchor unreadable" report — it must never paint a guessed region. Unknown future parameters are ignored, not failed.
- [x] T008 [P] In `apps/desktop/src/lib/pdf-anchor.ts`, implement the rect ↔ viewport mapping (fractions × current viewport at paint time, per research.md R7) and the bounded passage re-find from research.md R6: search the recorded page first, then ±2 pages; if not found, return "not located" so the caller navigates to the recorded page and reports it. No full-document scan, no fuzzy matching.
- [x] T009 Refactor `apps/desktop/src/stores/editor-store.ts` to replace the four `isDrawingPath` checks (lines 187, 420, 516, 886) with the registry-derived standalone-surface predicate `primaryPath(location) === null`, per research.md R4 and `contracts/page-kind.md`. Required behavior **per site** — a blanket boolean swap reproduces two known bugs:
  - `locationForPath` (187): dispatch on extension; this is the only site a future kind should have to touch.
  - `ensureFileLoaded` (420): drop any location whose `primaryPath` is `null` from `openFiles`.
  - `openFile` (516): `activeTab?.location.kind === "file" || isDrawingPath(path)` — the **left half stays unchanged**; only the right half becomes the predicate.
  - `navigateToFile` (886): match on **the location built from the path** — same `kind` _and_ same `path` — **not** on a boolean. Matching on a boolean is the specific bug that would keep drawings working while letting PDFs open twice.
  - **Branch ordering is load-bearing**: the standalone-surface branch stays _above_ `navigateToFile`'s `if (!activeTab) { openFile(...); return; }` guard, exactly where the drawing branch sits today. Reordering produces an infinite bounce when a standalone surface is opened into an empty window.
- [~] T010 (partial — PDF half deferred to T012) Add `apps/desktop/tests/editor-store-standalone-surface.test.ts`: a drawing path and (once T012 lands) a PDF path each dispatch to the right location, and `navigateToFile` reuses an open tab of the same kind and path rather than opening a second. Assert existing drawing behavior is unchanged — that is the acceptance bar for T009.

**Phase 2 implementation notes** (landed):

- `lib/pdf.ts` loads bytes over the Tauri asset protocol (`convertFileSrc`), the path
  `image-src-resolver.ts` already uses for binary attachments, so pdf.js streams and
  range-requests instead of holding a whole document in a `Uint8Array`.
- **T014 prerequisite, deliberately not done here**: the CSP in `src-tauri/tauri.conf.json`
  has no `connect-src`, so fetches fall back to `default-src 'self'` and the asset read may be
  blocked. The fix is to add `asset: https://asset.localhost` (plus whatever Tauri v2 already
  injects for IPC) to a `connect-src` directive. It is left out of Phase 2 on purpose: a CSP
  edit has app-wide blast radius, no test in this repo reads that string, and nothing imports
  `lib/pdf.ts` yet — so there is no way to observe whether the directive is right, too narrow,
  or breaking every `invoke`. The first real `getDocument` in T014 either works or throws a
  named CSP violation in the console, which is exactly the observation R2 asks for before
  changing approach.
- Load errors are discriminated on `error.name`, not `instanceof`: pdf.js exceptions are
  reconstructed across the worker boundary. v6.3.289 has no `MissingPDFException` — a missing
  file arrives as `ResponseException` with `missing: true`.
- Teardown is `PDFDocumentLoadingTask.destroy()`, not `PDFDocumentProxy.destroy()` — the proxy
  has no public destroy, and dropping the task is what aborts in-flight requests.
- T005's rendered-page-canvas window is **not** in `lib/pdf.ts`: it is a property of the
  virtualized page list and lands with T014. What shipped here is the refcounted per-path
  document cache (`acquirePdf` / `releasePdf`), which is the part with no consumer-side
  alternative.
- T007's "unknown key is a parse failure" contradicts the same task's and the contract's
  compatibility clause. The compatibility guarantee wins: unrecognized parameters are ignored,
  only a malformed _known_ parameter makes a fragment unreadable. Recorded in a comment in
  `lib/pdf-anchor.ts` so it is not "fixed" back.
- `parseAnchorFragment` returns three outcomes (`anchor` / `page` / `unreadable`), not
  `PdfAnchor | null`, because T029 must navigate to the recorded page when the anchor is
  unreadable.
- Clamp and reject are separate entry points: `regionAnchor` clamps at capture (a drag off the
  page edge means the edge); `parseAnchorFragment` rejects out-of-range rects outright.
- `apps/desktop/tests/pdf-document-cache.test.ts` is outside the four intended feature test
  tasks: it is the self-check on the refcount, which is the one branch in `lib/pdf.ts` an
  unbalanced caller can break invisibly (a live tab left holding a destroyed document).
- T030 was written early — it covers Phase 2 code, and the parser had no check otherwise.
- **Unverified until Phase 3**: nothing imports `lib/pdf.ts` yet, so it is tree-shaken out of
  the build and the R2 worker-resolution risk has not actually been exercised. First real load
  is T014.

**Checkpoint**: The registry can absorb a new kind at one site; anchor logic and the renderer boundary exist and are tested.

---

## Phase 3: User Story 1 - Read a PDF beside a note (Priority: P1) 🎯 First shippable increment

**Goal**: A PDF is listed in the sidebar, opens in its own tab, splits beside a note, follows the app theme, and restores at its page.

**Independent Test**: Put a PDF in the workspace, open it from the sidebar, split it beside a note, scroll both, toggle the theme, quit and relaunch. No quoting involved.

- [ ] T011 [US1] Extend `is_sidebar_file` in `apps/desktop/src-tauri/src/commands/fs.rs:128` to accept `.pdf`, mirroring the `DRAWING_EXTENSION` comment convention already there (FR-001). Leave `is_markdown` alone — a PDF must stay out of the Markdown path and out of the `.md`-filtered fuzzy index in `commands/search.rs:194` (FR-006).
- [ ] T012 [US1] Create `apps/desktop/src/components/editor-area/page-kinds/pdf.ts` implementing the behavior table in `contracts/page-kind.md`: `kind: "pdf"`; `title` = filename stem (FR-002, no title extraction from contents); `description: "Open PDF"`; `keepAlive: true`; `supportsFileContextMenu: false`; `paths: [path]`; `rewritePath` on path match; `removePath` → `null`; `serialize` → `{ path, page }`. `primaryPath` stays at the default `null` — load-bearing: publishing it would hand the PDF to the markdown editor mount, the save scheduler and the statusbar. `fromPayload` returns `null` unless `path` is a string; a missing or non-numeric `page` restores as `1` rather than failing the tab.
- [ ] T013 [US1] Register the kind: add `pdfKind` to the `kinds` tuple and `PdfLocation` to the `Location` union in `apps/desktop/src/components/editor-area/page-kinds/index.ts`, and add the `pdf` view entry `{ Component: PdfPane }` (no `renderFooter` — a PDF has no word count, frontmatter or document date) in `apps/desktop/src/components/editor-area/page-kinds/views.tsx`.
- [ ] T014 [US1] Create `apps/desktop/src/components/editor-area/pdf-pane.tsx`: continuous-scroll virtualized page list rendering only the pages needed for the current view (FR-009), with page navigation and zoom (FR-007). Render tasks are cancelled on scroll-away rather than left racing. The component takes `isVisible` and `isFocused` separately and must respect the difference — a visible but unfocused viewer must not steal the caret or run focus effects.
- [ ] T015 [US1] Style the viewer chrome in `apps/desktop/src/components/editor-area/pdf-pane.tsx` from the app's existing theme tokens and control styling — toolbar, page background framing, scrollbars — following light/dark changes with no reopen (FR-008). Take chrome from the app theme while keeping pdf.js page rendering, the same accommodation made for the Excalidraw editor.
- [ ] T016 [US1] Surface load failure in `apps/desktop/src/components/editor-area/pdf-pane.tsx`: a corrupt, encrypted or missing PDF shows an explicit message naming the file, from the T004 result variants. No empty view, no partial render, no retry loop, no hanging tab (FR-012).
- [ ] T017 [US1] Implement the `page` write-back from `PdfView` into `PdfLocation.page` in `apps/desktop/src/stores/editor-store.ts` under the two rules in data-model.md, both of which are correctness rules, not tuning: (1) a page change is **not a navigation** — it updates the tab's location in place and must never push onto `back`/`forward`, or scrolling would fill the history and break Back; (2) the write is **coalesced on settle** (and on tab close / session save), never per scroll event, because an un-debounced write clones the tab map on an interactive path. FR-005.
- [ ] T018 [US1] Add a `#[test]` in the test module of `apps/desktop/src-tauri/src/commands/fs.rs`: `is_sidebar_file` accepts `.pdf`, still rejects a bare `.svg`, and `is_markdown` stays false for a PDF.

**Checkpoint**: A themed, responsive PDF reader that splits beside a note and restores its page. Shippable on its own.

---

## Phase 4: User Story 2 - Quote a text selection into the note (Priority: P1)

**Goal**: Selecting PDF text raises one button that inserts a Markdown blockquote plus an anchored link into the visible note.

**Independent Test**: Open a text-layer PDF beside a note, select a sentence, press the button, confirm the note gained a blockquote containing that sentence and a link naming the PDF and page.

**Depends on**: US1 (there must be a viewer to select in).

- [ ] T019 [US2] Add the pdf.js text layer to `apps/desktop/src/components/editor-area/pdf-pane.tsx` so text is selectable on pages that have one (FR-013). Text extraction runs in the pdf.js worker, never on the main thread.
- [ ] T020 [US2] Create `apps/desktop/src/components/editor-area/pdf-quote-button.tsx`: a floating action that appears adjacent to a live selection, positioned so it does not cover the selection, following the app's existing floating-control conventions and shifting no layout. It disappears when the selection is cleared by click-elsewhere or Escape. A zero-width or few-pixel drag raises no button (FR-015).
- [ ] T021 [US2] In `apps/desktop/src/lib/pdf-anchor.ts`, add the quote-text builder producing exactly the `contracts/quote-link.md` shape: a Markdown blockquote of the selected text, a blank line, then `[[<workspace-relative path with .pdf retained>#page=..&text=..|<stem> p.N]]`. The path is **always workspace-relative and extension-qualified** — bare-stem resolution cannot find PDFs because the fuzzy index is Markdown-only (research.md R3). The link's `text` is the truncated re-find hint; the blockquote holds the full passage (FR-019).
- [ ] T022 [US2] Wire the button's action in `apps/desktop/src/components/editor-area/pdf-quote-button.tsx` to insert at the cursor of the visible note pane as a **single undoable CodeMirror transaction** (FR-017, scenario 2.4). A selection spanning a page boundary produces one quote anchored at the page where the selection _starts_, carrying the full selected text (scenario 2.3).
- [ ] T023 [US2] Handle the no-target case: when no note pane is visible in the window, the button states there is no note to quote into rather than inserting anywhere or failing silently (FR-018, scenario 2.5). This includes the case where the note pane is closed between selection and press.

**Checkpoint**: Read → select → capture works end to end. Combined with US1 this is the workflow the feature was asked for, minus the return trip.

---

## Phase 5: User Story 3 - Jump from a quote back to the PDF (Priority: P1)

**Goal**: Clicking a quote link reveals the PDF at the anchored place with a fading highlight, reusing an already-open view.

**Independent Test**: Hand-write a quote link in a note (no US2 needed), click it, confirm the PDF ends up visible, on the right page, with the region marked.

**Depends on**: US1. Independent of US2 via a hand-written link.

- [ ] T024 [US3] Add extension-preserving PDF target resolution to `apps/desktop/src/lib/wiki-links.ts`, following the `resolveWikiImage` precedent (line 154) rather than widening `resolveWikiLink`'s Markdown contract: a `.pdf` target resolves with its extension intact via a `fileExists` probe, and no `.md`/`.markdown` probing or `normalizeWikiTarget` stem-stripping is applied to it (research.md R3).
- [ ] T025 [US3] Route `.pdf` link targets to PDF resolution in `apps/desktop/src/components/editor-area/wiki-link-extension.ts`, using the existing `parseWikiLink` alias/fragment split unchanged and handing the fragment to `lib/pdf-anchor.ts` for parsing.
- [ ] T026 [US3] Decide and implement the pending-anchor handoff. `apps/desktop/src/lib/pending-anchor.ts` already implements a `(tabId, path) → string`, consumed-exactly-once handoff — the same shape data-model.md specifies for `PdfView.pendingAnchor`, and an encoded anchor fragment is a string. **Reuse it** rather than adding a second one-shot mechanism (Principle III, `docs/consolidation.md`); only if its key or consumption semantics genuinely do not fit should a separate store be added, and then the divergence from data-model.md must be recorded in this spec. Resolution writes the anchor; the pane consumes and clears it on mount or scroll, so resolution never needs an imperative handle on a component that may not be mounted yet.
- [ ] T027 [US3] Implement the FR-021 resolution order in `apps/desktop/src/stores/editor-store.ts`, scoped to the current window only (FR-028). The path-existence check runs **first**, so a stale link never creates an empty viewer: if the path does not exist, report the missing path and stop (FR-026). Otherwise, in order: (a) a pane already _showing_ that PDF → reuse it, no new tab, no new split; (b) a _background tab_ in some pane holding it → activate that tab; (c) not open → open in a split beside the note using the existing `splitPaneWithTab` path in `apps/desktop/src/lib/editor-layout.ts:388`. Each case sets the pending anchor.
- [ ] T028 [US3] Implement scroll-to-anchor and the highlight flash in `apps/desktop/src/components/editor-area/pdf-pane.tsx`: on consuming a pending anchor, scroll to the anchored page and visibly highlight the text range or region (FR-022). The highlight is temporary emphasis that fades, leaving the page readable (FR-023). When the anchor already fills the view, re-emphasise **without scrolling** (FR-024, scenario 3.4).
- [ ] T029 [US3] Implement the anchor-failure reports in `apps/desktop/src/components/editor-area/pdf-pane.tsx` using T008's re-find: when the quoted passage cannot be located, navigate to the recorded page and report that the exact passage was not found — never highlight an arbitrary region (FR-025). When the anchored page is past the end of a shortened PDF, tell the user and open at the last page. An unreadable fragment goes to the recorded page with no highlight.
- [x] T030 [P] [US3] Add `apps/desktop/tests/pdf-anchor.test.ts`: anchors round-trip through the link grammar; out-of-range and malformed fragments are rejected rather than clamped into a wrong highlight; rect fractions produce the same page location across two different zoom levels.
- [ ] T031 [P] [US3] Add `apps/desktop/tests/wiki-links-pdf.test.ts`: a `.pdf` target resolves with its extension intact, and a bare stem does not silently resolve to a note.

**Checkpoint**: The round trip is closed. US1 + US2 + US3 is the feature as the user described it.

---

## Phase 6: User Story 4 - Quote a region where there is no text (Priority: P2)

**Goal**: A dragged rectangle over a figure, equation or scanned page can be quoted and jumped back to at any zoom.

**Independent Test**: Open a scanned PDF with no text layer, drag a rectangle, quote it, click the resulting link, confirm the same rectangle is highlighted.

**Depends on**: US2 (the button and insert path) and US3 (the jump path).

- [ ] T032 [US4] Add the region overlay and drag gesture to `apps/desktop/src/components/editor-area/pdf-pane.tsx` (FR-014): a modifier-held drag draws a rectangle on any page, and the drawn rectangle is shown while dragging. On a page with **no text layer at all**, a plain drag is a region gesture by default with visible feedback — the user is never left with a dead text-selection gesture (scenario 4.4).
- [ ] T033 [US4] Convert the drawn rectangle to a region anchor via `apps/desktop/src/lib/pdf-anchor.ts`: page-relative fractions `x,y,w,h` in `[0,1]` of the page's unrotated crop box, zoom- and DPR-independent (FR-020). A zero-area rect raises no button and is never encoded.
- [ ] T034 [US4] Extend `apps/desktop/src/components/editor-area/pdf-quote-button.tsx` to appear beside a drawn region and insert a region quote: an editable placeholder caption as the blockquote plus a `#page=..&rect=x,y,w,h` link (FR-016, scenario 4.2). Same single-undo insertion and same no-target-note handling as T022/T023.
- [ ] T035 [US4] Render the region highlight on resolution in `apps/desktop/src/components/editor-area/pdf-pane.tsx`: outline the stored fractions multiplied by the _current_ viewport, so the same part of the page is outlined after a zoom change rather than a rectangle scaled to the wrong place (scenario 4.5). A region anchor in a changed PDF uses the recorded page and rect as-is, with no claim of correctness and no re-find attempt.

**Checkpoint**: All four stories functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T036 [P] Add the R4 predicate case to `docs/consolidation.md` — plan.md's Constitution Check (Principle V) promises this in the shipping change.
- [ ] T037 [P] Document the region-drag modifier in `docs/keyboard-shortcuts.md` if it binds a key combination; skip only if the gesture introduces no shortcut.
- [ ] T038 [P] Add the user-visible entry to `CHANGELOG.md` and move the task from In Progress to Done in `TODOS.md`.
- [ ] T039 Run the gates from the repo root: `vp check` and `vp test`; then from `apps/desktop/src-tauri`, `cargo test && cargo clippy && cargo fmt --check`.
- [ ] T040 Walk the manual scenarios in [quickstart.md](./quickstart.md) sections 1–7, including the performance checks (SC-001 first page < 1 s; SC-002 typing stays smooth beside a scrolling 500-page PDF; SC-003 memory returns to roughly its starting point after a full scroll; SC-004 sidebar and search unaffected) and the failure cases in section 5.

---

## Deliberately Not Built

Not defects, not missing tasks. Recorded so a later sweep does not file them as bugs.

- **FR-027 — rename rewrites quote links in note bodies.** The requirement's premise is false: the app has no note-body link rewriting for any link type today (research.md R5). Renaming a PDF still retargets its _open tab_ via the page kind's `rewritePath`; a quote link to a renamed PDF fails explicitly per FR-026. Recommend a follow-up spec for workspace-wide link rewriting.
- **Painting every prior highlight when a PDF is reopened.** A documented spec Non-Goal. Highlights appear only when arriving from a quote.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: needs Setup. Blocks every user story.
- **US1 (Phase 3)**: needs Foundational.
- **US2 (Phase 4)** and **US3 (Phase 5)**: need US1. Independent of each other.
- **US4 (Phase 6)**: needs US2 and US3.
- **Polish (Phase 7)**: needs the stories being shipped.

### User Story Dependencies — read this, it differs from the usual pattern

The three P1 stories are **not** mutually independent. The spec says it directly: "Nothing
else in this feature is reachable until a PDF can be seen at all."

```text
Foundational → US1 ─┬→ US2 ─┐
                    └→ US3 ─┴→ US4
```

US3 is independently testable without US2 by hand-writing a quote link into a note.

### Within Each Story

- Logic modules before the components that consume them.
- Registry entry (T012, T013) before the pane (T014) — the view cannot mount unregistered.
- Selection (T019) before the button (T020) before insertion (T022).
- Resolution (T027) before the pane consumes the anchor (T028).

### Parallel Opportunities

- T006, T007, T008 — all in `lib/pdf-anchor.ts`; sequential within the file, but the whole
  module runs parallel to T003–T005 in `lib/pdf.ts`.
- T011 (Rust, `fs.rs`) is fully independent of every frontend task in US1.
- T030 and T031 — different test files, no shared state.
- T036, T037, T038 — three different docs.
- US2 and US3 can be built concurrently by two people once US1 lands.

---

## Parallel Example: Foundational

```bash
# lib/pdf.ts and lib/pdf-anchor.ts touch no shared file:
Task: "Create lib/pdf.ts lazy pdfjs import and worker setup"   # T003
Task: "Create lib/pdf-anchor.ts anchor union and validation"   # T006
```

## Parallel Example: User Story 3 tests

```bash
Task: "Add apps/desktop/tests/pdf-anchor.test.ts"      # T030
Task: "Add apps/desktop/tests/wiki-links-pdf.test.ts"  # T031
```

---

## Implementation Strategy

### First shippable increment (US1)

1. Phase 1 Setup → Phase 2 Foundational → Phase 3 US1.
2. **STOP and VALIDATE**: quickstart section 1. A themed PDF reader that splits beside a note
   and restores its page has standalone value.

### The feature as asked for (US1 + US2 + US3)

The user's request is the _round trip_ — quote out, click back. US1 alone is a useful
checkpoint but is not what was asked for. Treat US1+US2+US3 as the real delivery target and
US1 as the first place it is safe to stop.

### Incremental delivery

1. Setup + Foundational → registry absorbs a new kind at one site.
2. US1 → validate → a working reader.
3. US2 → validate → capture works.
4. US3 → validate → the round trip closes. **This is the feature.**
5. US4 → validate → figures and scanned pages covered.
6. Polish.

---

## Notes

- [P] = different files, no dependencies.
- The R4 refactor (T009) is a prerequisite, not cleanup. Its acceptance bar is that every
  existing drawing behavior is unchanged and a future kind touches `locationForPath` only.
- Constraint values quoted in task descriptions (120 characters, `[0,1]`, 6 significant
  digits, `page >= 1`, `w > 0 && h > 0`) come from `data-model.md` and
  `contracts/quote-link.md` and are not implementation-time judgment calls.
- Commit after each task or logical group — one commit per completed task, per the repo's
  agent loop.
- Do not add UI rendering tests. The four test tasks here are the complete intended set.
