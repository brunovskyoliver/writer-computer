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
- [x] T010 Add `apps/desktop/tests/editor-store-standalone-surface.test.ts`: a drawing path and (once T012 lands) a PDF path each dispatch to the right location, and `navigateToFile` reuses an open tab of the same kind and path rather than opening a second. Assert existing drawing behavior is unchanged — that is the acceptance bar for T009.

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

- [x] T011 [US1] Extend `is_sidebar_file` in `apps/desktop/src-tauri/src/commands/fs.rs:128` to accept `.pdf`, mirroring the `DRAWING_EXTENSION` comment convention already there (FR-001). Leave `is_markdown` alone — a PDF must stay out of the Markdown path and out of the `.md`-filtered fuzzy index in `commands/search.rs:194` (FR-006).
- [x] T012 [US1] Create `apps/desktop/src/components/editor-area/page-kinds/pdf.ts` implementing the behavior table in `contracts/page-kind.md`: `kind: "pdf"`; `title` = filename stem (FR-002, no title extraction from contents); `description: "Open PDF"`; `keepAlive: true`; `supportsFileContextMenu: false`; `paths: [path]`; `rewritePath` on path match; `removePath` → `null`; `serialize` → `{ path, page }`. `primaryPath` stays at the default `null` — load-bearing: publishing it would hand the PDF to the markdown editor mount, the save scheduler and the statusbar. `fromPayload` returns `null` unless `path` is a string; a missing or non-numeric `page` restores as `1` rather than failing the tab.
- [x] T013 [US1] Register the kind: add `pdfKind` to the `kinds` tuple and `PdfLocation` to the `Location` union in `apps/desktop/src/components/editor-area/page-kinds/index.ts`, and add the `pdf` view entry `{ Component: PdfPane }` (no `renderFooter` — a PDF has no word count, frontmatter or document date) in `apps/desktop/src/components/editor-area/page-kinds/views.tsx`.
- [x] T014 [US1] Create `apps/desktop/src/components/editor-area/pdf-pane.tsx`: continuous-scroll virtualized page list rendering only the pages needed for the current view (FR-009), with page navigation and zoom (FR-007). Render tasks are cancelled on scroll-away rather than left racing. The component takes `isVisible` and `isFocused` separately and must respect the difference — a visible but unfocused viewer must not steal the caret or run focus effects.
- [x] T015 [US1] Style the viewer chrome in `apps/desktop/src/components/editor-area/pdf-pane.tsx` from the app's existing theme tokens and control styling — toolbar, page background framing, scrollbars — following light/dark changes with no reopen (FR-008). Take chrome from the app theme while keeping pdf.js page rendering, the same accommodation made for the Excalidraw editor.
- [x] T016 [US1] Surface load failure in `apps/desktop/src/components/editor-area/pdf-pane.tsx`: a corrupt, encrypted or missing PDF shows an explicit message naming the file, from the T004 result variants. No empty view, no partial render, no retry loop, no hanging tab (FR-012).
- [x] T017 [US1] Implement the `page` write-back from `PdfView` into `PdfLocation.page` in `apps/desktop/src/stores/editor-store.ts` under the two rules in data-model.md, both of which are correctness rules, not tuning: (1) a page change is **not a navigation** — it updates the tab's location in place and must never push onto `back`/`forward`, or scrolling would fill the history and break Back; (2) the write is **coalesced on settle** (and on tab close / session save), never per scroll event, because an un-debounced write clones the tab map on an interactive path. FR-005.
- [x] T018 [US1] Add a `#[test]` in the test module of `apps/desktop/src-tauri/src/commands/fs.rs`: `is_sidebar_file` accepts `.pdf`, still rejects a bare `.svg`, and `is_markdown` stays false for a PDF.

**Phase 3 implementation notes** (landed):

- **The CSP gap Phase 2 flagged was real, and the runtime named it.** The first
  `getDocument` produced `connect-src blocked asset://localhost/...` — pdf.js fetches the
  asset URL itself, so it is governed by `connect-src`, which did not exist and fell back to
  `default-src 'self'`. The fix in `src-tauri/tauri.conf.json` is one directive:
  `connect-src 'self' ipc: http://ipc.localhost asset: https://asset.localhost`. `'self'` and
  the `ipc:` entries are load-bearing, not decoration: IPC worked before only under the
  `default-src` fallback, so introducing `connect-src` without them would have broken every
  `invoke`. No `worker-src` was needed — the pdf.js worker is a Vite-emitted same-origin
  asset and passes under `'self'`, and no violation named it.
- `locationForPath` gained the `.pdf` branch. T009 shipped the predicate refactor but not the
  dispatch; without this line T012/T013 are dead code and a PDF opens in the markdown editor.
- `isPdfPath` / `pdfName` live in `lib/pdf.ts` beside the lazy pdf.js boundary, mirroring
  `isDrawingPath` in `lib/drawings.ts`: the store calls the predicate from the main module
  graph, and everything pdf.js stays behind `await import()`.
- Page heights are seeded from page 1 and refined per page as each renders. Awaiting all N
  `getPage` calls to build an exact height map up front is what would break SC-001 on a long
  document.
- A cancelled render rejects with `RenderingCancelledException`. That is the expected result
  of scrolling away and is swallowed deliberately — routing it into T016's error UI would
  make normal scrolling look like a failed load.
- `display: none` (copied from `DrawingPane`, and required for the same reason) zeroes the
  container's `scrollTop`, so the pane keeps its own copy and restores it when the tab comes
  back. `keepAlive` alone does not preserve scroll.
- `isFocused` is unused on purpose: a PDF viewer has no caret, so a visible-but-unfocused
  pane must keep painting and take no focus.
- **Zoom anchors on the page you were reading.** Changing the scale rescales every offset, so
  leaving `scrollTop` alone moves the document — and the settle timer then writes that wrong
  page into the location, meaning zoom would corrupt the FR-005 restore value. The pane stashes
  the current page before the scale change and re-anchors in a layout effect.
- **Page offsets are rounded to whole pixels.** They are both written to and read back from
  `scrollTop`, which the browser stores as an integer: a page top of 2899.2 reads back 2899 and
  lands one page earlier in the lookup. This was observed, not predicted — zoom re-anchored
  correctly and the page counter still went 4 → 3 → 2, and the fix came from the instrumented
  numbers rather than a second guess.
- **Wide pages stay reachable.** Centring with `left: 50%` plus a negative translate overflows
  to the left, which browsers give no scrollbar for, so past fit-width the left edge of the page
  was unreachable. The canvas area is sized to the widest page and centred with auto margins.
- T017's "on tab close" clause is implemented as a flush on pane unmount. There is no flush on
  _session save_ specifically: the pane is still mounted then, so a scroll in the last 400 ms
  before a quit is lost. Recorded rather than fixed — a settle window that small is not worth a
  second write path, and the page is only ever one off.
- `commands/fs.rs` needed no change for FR-002 beyond the filter — title extraction is
  already gated on `is_markdown`, so a PDF is never read for a title.

**Checkpoint**: A themed, responsive PDF reader that splits beside a note and restores its page. Shippable on its own.

---

## Phase 4: User Story 2 - Quote a text selection into the note (Priority: P1)

**Goal**: Selecting PDF text raises one button that inserts a Markdown blockquote plus an anchored link into the visible note.

**Independent Test**: Open a text-layer PDF beside a note, select a sentence, press the button, confirm the note gained a blockquote containing that sentence and a link naming the PDF and page.

**Depends on**: US1 (there must be a viewer to select in).

- [x] T019 [US2] Add the pdf.js text layer to `apps/desktop/src/components/editor-area/pdf-pane.tsx` so text is selectable on pages that have one (FR-013). Text extraction runs in the pdf.js worker, never on the main thread.
- [x] T020 [US2] Create `apps/desktop/src/components/editor-area/pdf-quote-button.tsx`: a floating action that appears adjacent to a live selection, positioned so it does not cover the selection, following the app's existing floating-control conventions and shifting no layout. It disappears when the selection is cleared by click-elsewhere or Escape. A zero-width or few-pixel drag raises no button (FR-015).
- [x] T021 [US2] In `apps/desktop/src/lib/pdf-anchor.ts`, add the quote-text builder producing exactly the `contracts/quote-link.md` shape: a Markdown blockquote of the selected text, a blank line, then `[[<workspace-relative path with .pdf retained>#page=..&text=..|<stem> p.N]]`. The path is **always workspace-relative and extension-qualified** — bare-stem resolution cannot find PDFs because the fuzzy index is Markdown-only (research.md R3). The link's `text` is the truncated re-find hint; the blockquote holds the full passage (FR-019).
- [x] T022 [US2] Wire the button's action in `apps/desktop/src/components/editor-area/pdf-quote-button.tsx` to insert at the cursor of the visible note pane as a **single undoable CodeMirror transaction** (FR-017, scenario 2.4). A selection spanning a page boundary produces one quote anchored at the page where the selection _starts_, carrying the full selected text (scenario 2.3).
- [x] T023 [US2] Handle the no-target case: when no note pane is visible in the window, the button states there is no note to quote into rather than inserting anywhere or failing silently (FR-018, scenario 2.5). This includes the case where the note pane is closed between selection and press.

**Phase 4 implementation notes** (landed):

- **The text layer is positioned by a CSS custom property the host sets, not by the
  viewport it was built with.** pdf.js v6 reads `--total-scale-factor` off the container;
  earlier majors called it `--scale-factor`. It has to be kept in step with the render scale
  or the invisible spans drift off the glyphs and selection picks the wrong words. Name
  confirmed against `pdfjs-dist@6.3.289/web/pdf_viewer.css`, not from memory.
- The layer is built at the **CSS** scale, not the device scale. The canvas rasterizes at
  `scale × devicePixelRatio` and is scaled back down in CSS; handing that dpr-multiplied
  viewport to `TextLayer` would place every span at twice the offset on a Retina display.
- `pdf-pane.css` transcribes only the `.textLayer` rules from `pdfjs-dist/web/pdf_viewer.css`
  rather than importing it. That stylesheet also carries the annotation layer, toolbar,
  sidebar and find bar — a whole viewer UI this app does not mount. Precedent:
  `mermaid-canvas.css`.
- `TextLayer` **appends** to its container and never clears it, so a zoom change stacked a
  second set of spans on the first. Cleanup calls `cancel()` _and_ `replaceChildren()`; the
  cancel alone is not enough.
- Text extraction is `page.streamTextContent()`, which runs in the worker — `TextLayer` only
  positions what it is handed, so the main thread never parses a content stream (FR-013). A
  scanned page yields zero items and an empty container, which is the correct outcome and
  not a case to special-case.
- **The page comes from the range's `startContainer`, never `anchorNode`.** `anchorNode` is
  where the drag _began_, which on a backwards drag is the later node. Scenario 2.3 requires
  a cross-page selection to anchor at the page it starts on, and only the range start gives
  that in both drag directions.
- The selection text is whitespace-collapsed with `normalizePageText` before both the
  blockquote and the anchor are built, so the link's `text=` hint stays a literal prefix of
  what `refindPassage` will search for. Two different normalizations would make the re-find
  miss on exactly the passages it exists for.
- **The insert reuses `editorApi.insertAtCursor`** instead of dispatching a transaction here.
  It is the app's one API-level insert path and is a single `view.dispatch`, which is what
  makes one undo revert the whole insertion (FR-017). It carries no `syncTransaction`
  annotation and no `writer` user event, so `publishEditorUpdate` treats it exactly like
  typing: store, save scheduler and sibling views all see it. A quote that reached the
  visible buffer but not disk is the failure that would have looked like success.
- Block padding is applied _before_ that call: `insertAtCursor`'s own clean-line rule only
  fires for headings, and a `>` landing mid-line is the same bug for a blockquote.
- **"Visible note pane" means the active tab of a pane**, not any open note tab — a note
  sitting behind the PDF in the same pane is not visible. Resolved via the T009
  `primaryPath === null` predicate, so a future standalone kind needs no change here.
  Resolved at _press_ time, not capture time, which is what covers a note pane closed
  between the selection and the press (scenario 2.5).
- `onMouseDown` is prevented on the button. Without it the mousedown clears the selection,
  which unmounts the button, and the click never lands — the control looks dead.
- The button is absolutely positioned in the scroll container's **content** coordinates, so
  it tracks the selection through a scroll with no scroll handler at all, and shifts nothing
  else in the layout (scenario 2.1).
- T021's wording says the alias is `<stem> p.N`; both worked examples in
  `contracts/quote-link.md` say `apology.pdf p.12`. The contract wins — it is the artifact
  that outlives the task list.
- **Two guards beyond the task text, both because a bad link is permanent on disk**: no
  workspace root, and a PDF that resolves outside the root (`getRelativePath` hands back the
  absolute path unchanged in that case). Both report through `showEditorNotice` rather than
  writing a link that only resolves on this machine.
- **Escape is gated on there being a button**, via the existing `useEscKey` hook rather than a
  raw `document` listener. A listener live whenever a PDF was merely _visible_ would clear the
  **note's** selection every time Escape was pressed in the pane next door — Vim insert mode,
  the search overlay. Do not widen the gate.
- Both halves of a page render are wrapped in one `.catch`. `TextLayer.cancel()` rejects with
  `AbortException` (name confirmed in `pdfjs-dist@6.3.289/build/pdf.mjs`), the canvas with
  `RenderingCancelledException`; pages unmount mid-render on every scroll, so leaving the text
  layer's rejection unhandled produced a steady stream of unhandled rejections.
- **Focus follows the quote into the note.** The insertion is one transaction either way, but
  undo is a keystroke and a keystroke goes where focus is — leaving focus in the PDF would make
  the promised single-step undo appear not to work (quickstart §2 step 3).
- **Contract gap for US3 to know about**: `contracts/quote-link.md` constrains `]` and `|` in a
  link but says nothing about `#`, and `splitFragment` splits on the _first_ `#`. A PDF whose
  filename contains `#` therefore produces a link that parses to the wrong path. Not introduced
  here and not fixed here — it needs a contract change, not a code change.
- No Rust changed in this phase, so the `cargo` gates were not re-run. `vp check`, `tsc` and
  `vp test` (1031 passing) all clean.
- **Not verified at runtime**: the manual scenarios in quickstart §2 need a real text-layer
  PDF and were not exercised here.

**Checkpoint**: Read → select → capture works end to end. Combined with US1 this is the workflow the feature was asked for, minus the return trip.

---

## Phase 5: User Story 3 - Jump from a quote back to the PDF (Priority: P1)

**Goal**: Clicking a quote link reveals the PDF at the anchored place with a fading highlight, reusing an already-open view.

**Independent Test**: Hand-write a quote link in a note (no US2 needed), click it, confirm the PDF ends up visible, on the right page, with the region marked.

**Depends on**: US1. Independent of US2 via a hand-written link.

- [x] T024 [US3] Add extension-preserving PDF target resolution to `apps/desktop/src/lib/wiki-links.ts`, following the `resolveWikiImage` precedent (line 154) rather than widening `resolveWikiLink`'s Markdown contract: a `.pdf` target resolves with its extension intact via a `fileExists` probe, and no `.md`/`.markdown` probing or `normalizeWikiTarget` stem-stripping is applied to it (research.md R3).
- [x] T025 [US3] Route `.pdf` link targets to PDF resolution in `apps/desktop/src/components/editor-area/wiki-link-extension.ts`, using the existing `parseWikiLink` alias/fragment split unchanged and handing the fragment to `lib/pdf-anchor.ts` for parsing.
- [x] T026 [US3] Decide and implement the pending-anchor handoff. `apps/desktop/src/lib/pending-anchor.ts` already implements a `(tabId, path) → string`, consumed-exactly-once handoff — the same shape data-model.md specifies for `PdfView.pendingAnchor`, and an encoded anchor fragment is a string. **Reuse it** rather than adding a second one-shot mechanism (Principle III, `docs/consolidation.md`); only if its key or consumption semantics genuinely do not fit should a separate store be added, and then the divergence from data-model.md must be recorded in this spec. Resolution writes the anchor; the pane consumes and clears it on mount or scroll, so resolution never needs an imperative handle on a component that may not be mounted yet.
- [x] T027 [US3] Implement the FR-021 resolution order in `apps/desktop/src/stores/editor-store.ts`, scoped to the current window only (FR-028). The path-existence check runs **first**, so a stale link never creates an empty viewer: if the path does not exist, report the missing path and stop (FR-026). Otherwise, in order: (a) a pane already _showing_ that PDF → reuse it, no new tab, no new split; (b) a _background tab_ in some pane holding it → activate that tab; (c) not open → open in a split beside the note using the existing `splitPaneWithTab` path in `apps/desktop/src/lib/editor-layout.ts:388`. Each case sets the pending anchor.
- [x] T028 [US3] Implement scroll-to-anchor and the highlight flash in `apps/desktop/src/components/editor-area/pdf-pane.tsx`: on consuming a pending anchor, scroll to the anchored page and visibly highlight the text range or region (FR-022). The highlight is temporary emphasis that fades, leaving the page readable (FR-023). When the anchor already fills the view, re-emphasise **without scrolling** (FR-024, scenario 3.4).
- [x] T029 [US3] Implement the anchor-failure reports in `apps/desktop/src/components/editor-area/pdf-pane.tsx` using T008's re-find: when the quoted passage cannot be located, navigate to the recorded page and report that the exact passage was not found — never highlight an arbitrary region (FR-025). When the anchored page is past the end of a shortened PDF, tell the user and open at the last page. An unreadable fragment goes to the recorded page with no highlight.
- [x] T030 [P] [US3] Add `apps/desktop/tests/pdf-anchor.test.ts`: anchors round-trip through the link grammar; out-of-range and malformed fragments are rejected rather than clamped into a wrong highlight; rect fractions produce the same page location across two different zoom levels.
- [x] T031 [P] [US3] Add `apps/desktop/tests/wiki-links-pdf.test.ts`: a `.pdf` target resolves with its extension intact, and a bare stem does not silently resolve to a note.

**Phase 5 implementation notes** (landed):

- **T026 resolved against the task's escape hatch: a separate store, not
  `lib/pending-anchor.ts`.** That module is a consumed-once handoff keyed
  `(tabId, path)` — the right _shape_ — but its consumption semantics are "read
  at the next mount", which is all a heading anchor ever needs because following
  one always swaps the editor's document. FR-021(a) has a case that cannot
  reach: a pane **already showing** the target PDF never remounts, so a
  mount-time read never fires. Bolting a subscriber set onto that module would
  turn a handoff into a pub/sub channel for one consumer and leave the markdown
  side carrying a notify path it ignores. `stores/pdf-anchor-store.ts` is the
  same one-shot semantics with the one property the case needs, and the pane
  handles mount-arrival and live-arrival through a single selector.
  **Divergence from data-model.md's `PdfView.pendingAnchor` recorded here, as
  T026 requires.**
- The anchor is queued **before** the layout mutation in every branch of
  `revealPdfAnchor`. `createFileTab` mints the id synchronously and touches no
  store, so a pane mounting in the same commit already finds its anchor; writing
  after the `set` would make a first arrival at a freshly opened PDF silently
  never scroll.
- **Case (a) takes no focus.** Reveal is not focus: the pane is already visible,
  so anchoring it is the whole job, and moving focus out of the note would cost
  the caret for nothing.
- Case (c) is `insertTab` then `splitPaneWithTab`, because that transition moves
  a tab the layout already owns. The note pane id is re-resolved _inside_ the
  `set` with the same findPane-else-focused fallback `appendTab` uses — an
  unknown pane makes `insertTab` a no-op, and `publish` would then drop the new
  tab entirely rather than misplace it.
- **T027's path-existence check is the resolution itself.** `resolveWikiPdf`
  returns a path only for a file that is there, so the store needs no second
  `fileExists`; a stale link reports the target it could not find and opens
  nothing (FR-026).
- T024 delegates to `resolveWikiImage` rather than restating its candidate
  order: the probing rule for an attachment (workspace-relative first for a
  path; note-dir, then root, then a basename search for a bare filename) is
  identical, and `resolveWikiLink` cannot be widened to cover it — it gets to a
  note by _stripping_ the extension and then probing `.md` or hitting the
  Markdown-only fuzzy index (research.md R3).
- **The highlight is a class on the text-layer spans, not an overlay.** The
  spans already sit exactly over their glyphs at every scale, so the emphasis
  follows a zoom change for free and there is no second geometry to keep in step
  with `--total-scale-factor`.
- **Two searches, one joining rule.** `refindPassage` searches
  `getTextContent().items.map(str).join(" ")`; the highlight searches the
  rendered spans' normalized text joined with `" "`. The agreement rests on
  `refindPassage` normalizing its whole haystack (an empty `hasEOL` item joins
  in a double space that only the collapse removes) — if anyone later
  pre-normalizes `getPageText` and drops that call, the two diverge. They must
  agree
  or a passage can be reported found on a page where the highlight then finds
  nothing — a silent failure. Both go through `normalizePageText`. If the span
  scan misses anyway, that is reported rather than swallowed: FR-025 forbids
  highlighting an arbitrary region, so nothing is marked and the user is told.
- The miss is reported **once per passage**, guarded by a ref: a zoom rebuilds
  the text layer and would otherwise re-announce the same failure.
- FR-024 is implemented twice, at two grains: the pane skips its scroll when the
  anchored page already overlaps at least half the viewport, and the first hit
  span uses `scrollIntoView({ block: "nearest" })`, which moves the page only if
  the passage is actually off-screen.
- Matching is **span-granular** — every span overlapping the match is marked
  whole. That over-marks by at most a partial span at each end and avoids
  mapping a whitespace-normalized offset back onto un-normalized DOM text, which
  is the part that would go quietly wrong.
- **The whole FR-021 decision runs inside one `set`, against the current state.**
  A snapshot taken before it can be stale — the resolver awaits a filesystem
  probe first — and a tab found in a stale snapshot may no longer be in the
  tree, so the activation would no-op while the anchor stayed queued for a tab
  that never appears, to be replayed the next time that id mounts. The anchor is
  queued from inside the updater, on the branch actually taken.
- An unreadable fragment is **reported, not just navigated past**:
  `parseAnchorFragment` carries a `reason` for exactly that, and landing on the
  page in silence is indistinguishable from a link that did nothing.
- **Region anchors navigate to the recorded page and highlight nothing here.**
  T035 (US4) owns region painting and specifies behaviour this phase would have
  had to guess at ("multiplied by the _current_ viewport", no re-find, no claim
  of correctness). Half-implementing it now would leave Phase 6 re-doing it.
- Still open in the contract, unchanged from Phase 4: `splitFragment` splits on
  the first `#`, so a PDF whose filename contains `#` parses to the wrong path.
  It needs a contract change, not a code change, and was deliberately not
  widened into T024's scope.
- No Rust changed, so the `cargo` gates were not re-run. `vp check` (0 errors)
  and `vp test` (1038 passing, +7) are clean.
- **Not verified at runtime**: quickstart §3's manual scenarios need a real
  text-layer PDF and a hand-written link, and were not exercised here.

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
