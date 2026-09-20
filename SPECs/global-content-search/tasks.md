---
description: "Task list for Global Content Search implementation"
---

# Tasks: Global Content Search

**Input**: Design documents from `/SPECs/global-content-search/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks ARE included — the plan's Testing section and quickstart.md "Automated coverage" explicitly name the seams (Rust matcher/walk/caps via `cargo test`; merge/truncate/preview reducers and PDF line splitting via `vp test`), and the constitution requires a runnable check for non-trivial logic.

**Organization**: Tasks are grouped by user story (US1: search inside every file, US2: context preview, US3: jump to match) so each story can be implemented, tested, and delivered independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- All paths are relative to the repository root

## Path Conventions

- Rust backend: `apps/desktop/src-tauri/src/` (tests inline in `#[cfg(test)]` modules)
- React frontend: `apps/desktop/src/`
- Frontend tests: `apps/desktop/tests/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline verification — this feature adds no dependencies (plan.md Technical Context).

- [x] T001 Run `vp install` at the repo root and `cargo check` in `apps/desktop/src-tauri/` to confirm a clean baseline before changes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types and state slots that every user story's code depends on. These are the IPC contract surfaces — the frontend hook, the palette, the preview pane, and activation all consume `SearchMatch`/`ContentSearchEvent`.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T002 [P] Add a `cancel_search` flag slot (`RwLock<Arc<AtomicBool>>`) to `WorkspaceState` in `apps/desktop/src-tauri/src/state.rs`, mirroring the existing `cancel_index` slot — one active scan per window (research R2)
- [x] T003 [P] Define `SearchMatch`, `ContextLine`, `PdfCandidate`, and the serde-tagged `ContentSearchEvent` enum (`matches` / `pdf` / `done{truncated}`) in `apps/desktop/src-tauri/src/commands/search.rs` with the exact fields and rules in `SPECs/global-content-search/data-model.md` (`line_number`/`page` u32 ≥ 1 and mutually exclusive by `kind`; `match_ranges` char-offset `[u32,u32]` pairs; `context` = matched line + up to ~2 lines each side)
- [x] T004 [P] Replace the dead `ContentSearchResult` stub in `apps/desktop/src/types/fs.ts` with `SearchMatch`, `ContextLine`, `PdfCandidate`, and `ContentSearchEvent` interfaces mirroring `SPECs/global-content-search/contracts/content-search-ipc.md` (`{ "type": "matches" | "pdf" | "done" }` tagged union)
- [x] T005 [P] Add `"content-search"` to the `CommandPaletteIntent` union in `apps/desktop/src/stores/ui-store.ts` — the shared open flag + intent is the single open/close path (research R6)

**Checkpoint**: Contract types exist on both sides of IPC — user story implementation can now begin.

---

## Phase 3: User Story 1 - Search Inside Every File (Priority: P1) 🎯 MVP

**Goal**: `Cmd+Shift+F` opens a content-search palette; typing a string progressively lists every workspace file — markdown, other text-decodable files, and PDFs — whose content contains it, with the matched text, query highlighted, and location (`L<n>` / `Page <n>`).

**Independent Test**: In a workspace containing markdown, text, and PDF files (see `quickstart.md` fixture), type a string known to appear in each type; confirm all three surface as results with matched text visible, ignored files absent, and filename-only matches producing no results (spec.md acceptance 1–5).

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T006 [P] [US1] Write Rust unit tests for the smart-case line matcher in the `#[cfg(test)]` module of `apps/desktop/src-tauri/src/commands/search.rs`: case-insensitive by default, query containing an uppercase char → case-sensitive, multiple `match_ranges` per line emitted in document order and non-overlapping, offsets in char units not bytes
- [x] T007 [P] [US1] Write Rust tests for the corpus walk, caps, and cancellation in the same `#[cfg(test)]` module (tempdir style matching the file's existing tests): `.gitignore`/hidden/`node_modules` entries skipped; a `.pdf` file yields a `PdfCandidate` event, not a text match; files over ~4 MiB skipped; non-UTF-8 bytes skipped; at most ~20 matches per file; the ~200 total text self-cap sets `done.truncated`; flipping the installed `cancel_search` flag terminates the walk without a `done` event
- [x] T008 [P] [US1] Write vp tests for the merge/sort/truncate reducer and seq guard in `apps/desktop/tests/content-search.test.ts`: arriving batches merge sorted by `modified_at` desc with document order within a file; the ~200-result display cap sets `truncated`; events carrying a stale seq are dropped (FR-012); `state` stays `"scanning"` until the `done` event _and_ the PDF candidate queue drains (FR-015); `truncated` is set when the Rust `done.truncated` flag, unprocessed PDF candidates, or merged-list overflow applies
- [x] T009 [P] [US1] Write vp tests for PDF page-line splitting and matching in `apps/desktop/tests/pdf-search.test.ts`: `getTextContent` items join into lines split on `hasEOL`; matches produce `SearchMatch{kind:"pdf", page}` with 1-based page numbers and char-offset `match_ranges`; `context` is built from the same extracted page lines (~5 lines, fewer at page boundaries); the smart-case rule matches the Rust side

### Implementation for User Story 1

- [x] T010 [US1] Implement the smart-case line matcher and `context` extraction (matched line plus up to ~2 lines before and after) as a pure function in `apps/desktop/src-tauri/src/commands/search.rs` (depends on T003)
- [x] T011 [US1] Implement the `content_search` Tauri command in `apps/desktop/src-tauri/src/commands/search.rs`: `spawn_blocking` walk using `index_workspace_impl`'s exact `WalkBuilder` filters (hidden, gitignore local/global/exclude, `node_modules` net, ≤8 threads); entry installs a fresh `Arc<AtomicBool>` in `state.cancel_search` after flipping the outgoing flag; per-file corpus = `.pdf` extension → `PdfCandidate` event, else skip when metadata size > ~4 MiB or bytes fail strict `std::str::from_utf8`; stream `matches` batches and `pdf` candidates on the `Channel<ContentSearchEvent>`; enforce ~20/file and ~200 total text caps; send terminal `done{truncated}`; return `AppError` on empty query and `AppError::NoWorkspace` with no workspace (depends on T002, T003, T010)
- [x] T012 [US1] Register `content_search` in the command registry in `apps/desktop/src-tauri/src/lib.rs`
- [x] T013 [P] [US1] Add a `contentSearch` invoke binding accepting `query` and an `onEvent: Channel<ContentSearchEvent>` in `apps/desktop/src/lib/tauri.ts`, matching the existing named-export invoke style
- [x] T014 [P] [US1] Add a `pdfSearchLines(path)` export in `apps/desktop/src/lib/pdf.ts` returning per-page arrays of extracted lines via pdf.js `getTextContent` (items joined, lines split on `hasEOL`), staying behind the module's existing lazy pdf.js boundary
- [x] T015 [US1] Create `apps/desktop/src/lib/pdf-search.ts` with the TS smart-case line matcher that maps extracted page lines to `SearchMatch{kind:"pdf", page, line_text, match_ranges, context}` (the acknowledged ~10-line duplication of the Rust matcher — research R3; depends on T004, T014)
- [x] T016 [US1] Create `apps/desktop/src/components/content-search/use-content-search.ts` implementing the `Scan` lifecycle from `data-model.md`: ~150ms input debounce; monotonic `seq` bumped per dispatch and invalidated on cleanup; a fresh `Channel` per invoke applying events only while seq is current; merge batches sorted by `modified_at` desc (document order within a file); display cap ~200 with `truncated` aggregation (Rust `done.truncated`, unprocessed PDF candidates, merged overflow); `idle | scanning | done` state reaching `done` only when the `done` event arrives _and_ the PDF candidate queue has drained; empty query → hint state with no invoke; bounded concurrency and its own staleness guard for PDF extraction (depends on T004, T013, T015)
- [x] T017 [US1] Create `apps/desktop/src/components/content-search/index.tsx` — a cmdk `CommandDialog` palette with `shouldFilter={false}` and controlled `value`, matching the `Cmd+P` palette's structure: content-search input placeholder; one `CommandItem` per `SearchMatch` showing file identity, the matched line with `match_ranges` highlighted, and `L<n>` for text / `Page <n>` for PDFs; the state table from `contracts/palette.md` (empty→hint, scanning indicator distinct from no-results, done-empty→no-results, `truncated`→truncation indicator); mounted in `App.tsx` rendering only when `commandPaletteIntent === "content-search"`, closed through the shared `closeCommandPalette` (depends on T005, T016)
- [x] T018 [US1] Add the `Cmd+Shift+F` handler in `apps/desktop/src/hooks/use-keyboard-shortcuts.ts` calling `openCommandPalette("content-search")` gated on `root` — a no-op in compact standalone windows, matching the `Cmd+W`/`Cmd+N` gating pattern
- [x] T019 [P] [US1] Add the `Cmd+Shift+F` row to `docs/keyboard-shortcuts.md` in the same change (constitution V)

**Checkpoint**: US1 is fully functional — `Cmd+Shift+F` → type → progressive, ordered, capped results across text files and PDFs, with ignore rules honored. Validate against `quickstart.md` US1 scenarios before proceeding.

---

## Phase 4: User Story 2 - Context Preview on the Highlighted Result (Priority: P2)

**Goal**: Whichever result is highlighted — by arrow keys or pointer hover — shows ~5 lines of surrounding context in a preview pane beside the list; PDF results show the page's text excerpt plus the page number.

**Independent Test**: With search results displayed, move the highlight across rows (keyboard and hover); confirm the preview updates to ~5 lines centered on the match for text files and the page excerpt + page number for PDFs, including fewer-lines boundary cases (spec.md acceptance 1–4).

### Tests for User Story 2

- [x] T020 [P] [US2] Write vp tests in `apps/desktop/tests/content-search.test.ts` covering preview-source selection: the highlighted value's `context` is what the preview renders, the matched line within it is marked via `match_ranges`, and contexts with fewer than 5 lines (file/page boundaries) render as-is without error

### Implementation for User Story 2

- [x] T021 [US2] Add the preview pane to `apps/desktop/src/components/content-search/index.tsx` rendering the highlighted item's `context` verbatim (~5 lines) with the match marked on the matched line; PDF results render the page excerpt plus `Page <n>`; bind the pane to the cmdk `value` so arrow-key and pointer-hover selection both update it with no extra wiring (cmdk pointer selection — research R6); no rendered PDF page image (FR-004)

**Checkpoint**: US2 independently testable — preview tracks the highlighted result for both navigation modes.

---

## Phase 5: User Story 3 - Jump to the Match (Priority: P3)

**Goal**: Activating a result (Enter or click) opens the file positioned at the match — the matched line for text files (re-found defensively and selected), the containing page for PDFs (passage re-found and emphasized) — reusing an already-open tab.

**Independent Test**: Activate a text-file result and a PDF result; confirm each opens the file at the match location, and activating a result for an already-open file reuses its tab (spec.md acceptance 1–3).

### Implementation for User Story 3

- [x] T022 [US3] Generalize `apps/desktop/src/lib/pending-anchor.ts` to a `PendingTarget` union — `{ kind: "anchor"; slug: string }` (existing heading links) or `{ kind: "line"; line: number; offset: number; length: number; needle: string }` — adding `setPendingLineTarget` while keeping `setPendingAnchor` callers working unchanged through the `anchor` variant; the map stores `PendingTarget`, still keyed by `(tabId, path)` and consumed exactly once per `contracts/line-target.md`
- [x] T023 [US3] Update the `consumePendingAnchor` site in `apps/desktop/src/components/editor-area/use-prosemark-editor.ts` to handle the union: `anchor` keeps the existing `findHeadingBySlug` → `scrollPosToSafeTop` path; `line` clamps `line` to `doc.lines`, resolves `doc.line(n)`, re-finds `needle` on that line (first occurrence at or after `offset`, else the first occurrence on the line), selects that range and scrolls it into view; needle not found → scroll the line into view with no selection — never a wrong-range selection, never an error for a file that moved on
- [x] T024 [US3] Add the `openSearchMatch` route in `apps/desktop/src/hooks/editor-api.ts`: `kind:"text"` → `setPendingLineTarget` before `navigateToFile` (handoff must exist before the layout mutation); `kind:"pdf"` → `openFile(path)` (existing reuse-or-open) then `requestPdfAnchor(tabId, "page=N&text=<hint>")` with the hint truncated to `TEXT_HINT_MAX` per `contracts/line-target.md`
- [x] T025 [US3] Wire result activation in `apps/desktop/src/components/content-search/index.tsx` — `CommandItem` `onSelect` (Enter and click) calls `openSearchMatch` then `closeCommandPalette`; a vanished file falls through the normal open-failure path

**Checkpoint**: All three user stories independently functional end-to-end.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Docs, validation, and quality gates affecting the whole feature.

- [x] T026 [P] Add the user-visible feature entry to `CHANGELOG.md`
- [x] T027 Move the feature's entry in `TODOS.md` to Done, linking `SPECs/global-content-search/`
- [x] T028 Run the full quality gate: `vp check` and `vp test` at the repo root; `cargo test`, `cargo clippy`, `cargo fmt --check` in `apps/desktop/src-tauri/`
- [x] T029 Validate `SPECs/global-content-search/quickstart.md` scenarios end-to-end against the fixture workspace — including the edge checks (empty query hint, rapid-typing staleness, truncation indicator, scanned-PDF skip, compact-window no-op, smart-case)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational — the MVP increment
- **US2 (Phase 4)**: Depends on US1's `SearchMatch.context` data and palette shell (T016, T017), but its test is independently verifiable once results exist
- **US3 (Phase 5)**: Depends on US1's palette (T017) for the activation call site; T022/T023 (pending-target seam) only depend on Phase 2 and can run in parallel with US1/US2 work
- **Polish (Phase 6)**: Depends on all completed stories

### User Story Dependencies

- **US1 (P1)**: No dependencies on other stories — standalone MVP
- **US2 (P2)**: Needs US1's results to exist; adds only the preview pane — tested independently once results render
- **US3 (P3)**: Needs US1's palette for activation wiring; the `PendingTarget` producer/consumer pair is a self-contained seam (T022→T023) that does not depend on the palette

### Within Each User Story

- Tests (T006–T009, T020) MUST be written first and FAIL before implementation
- Pure matcher (T010) before the command (T011); types (T003/T004) before everything consuming them
- `pdfSearchLines` (T014) before the PDF matcher (T015) before the hook (T016)
- Hook (T016) before the palette component (T017)
- `PendingTarget` union (T022) before its consumer (T023) before the `openSearchMatch` route (T024) before palette wiring (T025)

### Parallel Opportunities

- All Foundational tasks (T002–T005) touch different files — run in parallel
- All US1 test tasks (T006–T009) touch different files — run in parallel
- T013 (`lib/tauri.ts`) and T014 (`lib/pdf.ts`) are independent of the Rust command — parallel with T010–T012
- US3's producer/consumer seam (T022→T023) can proceed in parallel with US1/US2 UI work — only T024–T025 need the palette
- T026 can run alongside T028/T029

---

## Parallel Example: User Story 1

```bash
# Write all four test files together (T006–T009):
Task: "Rust unit tests for the smart-case line matcher in commands/search.rs #[cfg(test)]"
Task: "Rust tests for walk, caps, and cancellation in commands/search.rs #[cfg(test)]"
Task: "vp tests for merge/sort/truncate + seq guard in apps/desktop/tests/content-search.test.ts"
Task: "vp tests for PDF page-line splitting in apps/desktop/tests/pdf-search.test.ts"

# While the Rust command is implemented (T010–T012), run the independent frontend bindings:
Task: "contentSearch invoke binding in apps/desktop/src/lib/tauri.ts"
Task: "pdfSearchLines(path) export in apps/desktop/src/lib/pdf.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002–T005)
3. Complete Phase 3: User Story 1 (T006–T019)
4. **STOP and VALIDATE**: run `quickstart.md` US1 scenarios + the new tests
5. Demo-able MVP: full progressive content search across text files and PDFs

### Incremental Delivery

1. Setup + Foundational → contract and state seams ready
2. US1 → progressive search palette (MVP!)
3. US2 → context preview pane on the highlighted result
4. US3 → jump-to-match activation for text files and PDFs
5. Polish → docs, gates, quickstart validation

### Parallel Team Strategy

1. Team completes Setup + Foundational together
2. Then: Developer A takes US1 UI (T016–T017), Developer B takes the US3 seam (T022–T023), both in parallel once types land
3. US2 and the rest of US3 follow when US1's palette exists

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps each task to its spec.md user story for traceability
- The smart-case matcher intentionally exists twice (Rust + TS) — research R3's acknowledged duplication, pinned by T006/T009 on each side
- `cancel_search` is the cancellation mechanism, not channel-drop (research R2: `Channel::send` does not reliably fail when JS stops listening)
- Result ordering is a property of the frontend store, not the wire (research R5)
- Commit after each task or logical group; stop at any checkpoint to validate the story independently
