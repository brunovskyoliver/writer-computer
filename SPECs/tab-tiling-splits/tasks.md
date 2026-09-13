---
description: "Dependency-ordered implementation tasks for tab tiling and split panes"
---

# Tasks: Tab tiling and split panes

**Input**: Design documents from `SPECs/tab-tiling-splits/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [UI contract](contracts/ui.md), [session contract](contracts/session.md), [quickstart.md](quickstart.md)

**Tests**: Focused automated checks are required by the feature plan and project constitution. Write each test task before its paired implementation task and confirm that it fails for the missing behavior.

**Organization**: Tasks are grouped by user story. Phase 2 holds the shared model, view ownership, and rendering work that must be safe before any drag gesture can mutate the layout.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with adjacent tasks after its stated dependencies are complete because it changes different files
- **[Story]**: User story from [spec.md](spec.md)
- Every checklist item names the files it changes

## Phase 1: Setup

**Purpose**: Add the one planned runtime dependency.

- [x] T001 Add `react-resizable-panels` via the existing `catalog:` entry in `apps/desktop/package.json` and refresh `pnpm-lock.yaml` with `vp install`

---

## Phase 2: Foundational layout and view ownership

**Purpose**: Establish the atomic layout owner, tab-local editor state, shared document state, and stable rendering needed by every story.

**Critical**: No user-story implementation starts until this phase passes its focused tests and preserves the current one-pane behavior.

- [x] T002 Add failing pure tests for unique pane/split/tab IDs, exactly-two-child splits, active/focused membership, finite `ratio` in `(0, 1)`, empty-pane collapse, launcher fallback, traversal, recursive minima, and predicted target bounds in `apps/desktop/tests/editor-layout.test.ts`
- [x] T003 Implement the `Layout`, `Pane`, `Split`, drop-candidate types and pure create, normalize, validate, collapse, split, move, reorder, and bounds transitions in `apps/desktop/src/lib/editor-layout.ts`; preserve these data-model constraints verbatim: Layout has "`root: LayoutNode`, `focusedPaneId`, monotonic `revision`", Pane has "`kind: pane`, stable `id`, ordered `tabIds`, `activeTabId`", and Split has "`kind: split`, stable `id`, `axis: x | y`, exactly two child nodes, `ratio` for first child in `(0, 1)`"; keep pane minimum `240 x 160` CSS px, separator `4` CSS px, and increment layout revision only for layout changes
- [x] T004 Add failing store tests for one-pane initialization, focused-pane-derived active selectors, pane-scoped open/dedup, atomic focus/move/close/path-rewrite mutations, stale async open rejection, and no document/layout subscription crossover in `apps/desktop/tests/stores.test.ts`
- [x] T005 Integrate the layout tree and focused pane into the single writable tab owner in `apps/desktop/src/stores/editor-store.ts`, derive compatibility `activeTabId` and `activeFilePath` from the focused pane, capture pane/workspace/navigation generations before awaits, and route restore/reset through the same normalization path
- [x] T006 [P] Expose narrow pane-aware selectors and explicit-pane actions without duplicating writable state in `apps/desktop/src/hooks/use-editor-layout.ts` and `apps/desktop/src/hooks/use-tabs.ts`
- [x] T007 Add failing registration tests for two editor views on one path, tab-ID lookup, path membership, generation-safe unregister, tab moves without unregister, and rename/delete reindexing in `apps/desktop/tests/editor-api.test.ts`
- [x] T008 Replace the path-keyed single-view registry with tab-ID registrations plus derived path indexes in `apps/desktop/src/hooks/editor-api.ts`; preserve these data-model fields verbatim: Tab has "Existing `id`, `location`, `back`, `forward`; view state keyed by tab and location; navigation generation stays keyed by tab", View state has "Selection ranges, scroll anchor/offset; drawing viewport/selection for drawing tabs", Document has "Existing canonical path, content/frontmatter, disk content, dirty/loading/error state, reload revision, derived stats/title; no cursor/scroll fields", and Editor registration has "Tab ID, current document path, editor instance, mount generation; path indexes derive from registrations"; keep runtime view state owned by tab and document/save state owned by canonical path in `apps/desktop/src/stores/editor-store.ts`
- [x] T009 Add failing mounted-editor tests for synchronous sibling ChangeSet propagation, mapped independent selections, tab-local undo, scroll independence, frontmatter edits, insert-at-cursor, external reload, one save schedule, and surviving registration after one view closes in `apps/desktop/tests/editor-shared-buffer.test.ts`
- [x] T010 Synchronize every Markdown mutation entry point once through the path-owned buffer while excluding sibling sync transactions from undo history in `apps/desktop/src/components/editor-area/use-prosemark-editor.ts`, `apps/desktop/src/hooks/editor-api.ts`, and `apps/desktop/src/lib/save.ts`
- [x] T011 Add failing drawing-session tests for two views sharing scene/assets/dirty state, one export queue, revision-safe completion, loop-free sibling sync, independent viewport state, and move/unregister without a spurious save in `apps/desktop/tests/drawing-sessions.test.ts`
- [x] T012 Consolidate drawing scene and save ownership per canonical path, attach view IDs, and broadcast sibling scene/assets with origin and revision guards in `apps/desktop/src/lib/drawing-sessions.ts` and `apps/desktop/src/components/editor-area/drawing-editor.tsx`; preserve the model fields "Path, scene elements/assets, content revision, saved revision, queued/in-flight export, error, attached view IDs; one writer per path"
- [ ] T013 Add failing component tests proving a tab body keeps the same mounted editor instance, cursor, scroll, and undo state when its pane assignment changes in `apps/desktop/tests/editor-pane-layout.test.tsx`
  - **Blocked, not done.** `apps/desktop/vite.config.ts` runs tests with `environment: "node"` and `include: ["tests/**/*.test.ts"]`, and the workspace catalog has neither jsdom nor `@testing-library/react`. No test in this repo mounts a React component or an `EditorView`. Standing this up is a test-infrastructure task that no task in this plan owns; adding it silently would be scope the plan did not ask for. The invariant it guards — a moved tab keeps its editor instance, cursor, scroll, and undo — is instead covered by the design in T014 (one stable React parent per tab id) and must be checked by hand until the harness exists. T039 and T041 are the right homes for it.
- [x] T014 Render all tab bodies once under a stable tab-ID parent, expose pane body measurement slots, distinguish `isVisible` from global `isFocused`, and keep inactive bodies mounted in `apps/desktop/src/components/editor-area/index.tsx`, `apps/desktop/src/components/editor-area/pane-layout.tsx`, and `apps/desktop/src/components/editor-area/page-kinds/types.ts`

**Checkpoint**: The app still behaves as one pane, while layout transitions, duplicate live views, and tab moves are safe to build on.

---

## Phase 3: User Story 1 - Split a pane from the sidebar (Priority: P1) MVP

**Goal**: Drag one or more files from Everything onto a pane edge to create an equal split, or onto its centre to open them in that pane, without breaking move-on-disk inside the tree.

**Independent test**: Open note A, drag note B from Everything to the right and bottom edges and then the centre. Edge drops create the expected focused pane, centre keeps one pane, both documents edit normally, and tree drops still perform exactly one disk move.

### Tests for User Story 1

- [x] T015 [US1] Add failing store/integration tests for ordered multi-file centre and edge drops, equal split allocation, first-file activation, duplicate-file centre reuse, deliberate duplicate-file edge split, all-or-nothing async preflight, invalid folder selections, source revalidation, and no disk move on editor drop in `apps/desktop/tests/stores.test.ts` and `apps/desktop/tests/sidebar-editor-drag.test.ts`

### Implementation for User Story 1

- [x] T016 [US1] Add the window-local pointer coordinator in `apps/desktop/src/hooks/use-editor-drag.ts` with the shipped sidebar activation threshold, pointer capture, one animation-frame geometry pass, and unified pointerup/Escape/pointercancel/lost-capture/blur cleanup; preserve the drag-session fields "Pointer ID, source tab or selected file snapshot, workspace generation, initial source identities, current candidate; transient only" and the drop-candidate fields "Target pane/strip, region or insertion index, expected layout revision, validated resulting layout and focus, final preview rectangle"
- [x] T017 [US1] Resolve centre and four edge targets through the pure candidate builder, reject candidates that violate recursive minima, and commit the exact validated candidate atomically in `apps/desktop/src/lib/editor-layout.ts` and `apps/desktop/src/stores/editor-store.ts`
- [x] T018 [US1] Adapt Everything-tree file selections to the shared coordinator while preserving autoscroll only inside tree bounds and keeping `use-move-entry.ts` as the sole disk-move path in `apps/desktop/src/components/sidebar/use-tree-drag.ts`, `apps/desktop/src/components/sidebar/file-tree.tsx`, and `apps/desktop/src/components/sidebar/use-move-entry.ts`
- [x] T019 [US1] Register pane body geometry and centre/edge drop surfaces, load a sidebar selection under its captured workspace generation, and focus the new or destination pane after commit in `apps/desktop/src/components/editor-area/pane-layout.tsx` and `apps/desktop/src/hooks/use-editor-layout.ts`
  - Landed mostly in the coordinator and `pane-bounds.ts` rather than the two named files: drop surfaces are geometric (`getEditorAreaGeometry` hit-tests the measured slots; the dragged source holds pointer capture so the slots need no listeners), the workspace identity is captured at arm time and rechecked by `openFilesFromDrop`, and focus travels inside the candidate layout. `use-editor-layout.ts` needed no change. The test file for this story, `tests/sidebar-editor-drag.test.ts`, drives the coordinator through an injected environment and a plain `EventTarget`; it mounts no components and no editor views, per the no-UI-tests rule.

**Checkpoint**: User Story 1 is a usable two-document split-pane MVP with existing sidebar disk moves intact.

> Status: the store, pure candidate, coordinator, and sidebar adapter are in place and covered by 749 passing tests. There is no drop preview yet (Phase 5), so the gesture runs blind until then, and none of it has been exercised in the running app — the checkpoint's hand test (drag B to the right edge, bottom edge, centre; release over the tree; release outside) is still owed.

---

## Phase 4: User Story 2 - Move and reorder tabs (Priority: P1)

**Goal**: Drag tabs within or between strips and onto pane centres or edges without saving, reloading, remounting, losing history, or moving the OS window.

**Independent test**: With two panes, reorder a tab, move it to the other strip, split a pane with it, and move a pane's last tab away. The same tab/editor instance and its dirty content, cursor, scroll, and navigation history survive; the empty source pane collapses.

### Tests for User Story 2

- [x] T020 [US2] Add failing transition/store tests for within-strip index correction, cross-strip insertion, centre moves, edge splits after source collapse, destination duplicate replacement, no-op drops, sole-tab self-edge rejection, source deletion/rename cancellation, and empty-source collapse in `apps/desktop/tests/editor-layout.test.ts` and `apps/desktop/tests/stores.test.ts`
- [x] T021 [US2] Add failing interaction tests for click suppression after drag activation, tab pointerdown excluding Tauri window drag, empty strip retaining window drag, and all cancellation paths clearing the drag without mutations in `apps/desktop/tests/editor-tabs-drag.test.tsx`
  - Landed as `tests/editor-tabs-drag.test.ts`, driving the coordinator through the injected environment (same reason as T013: the runner is node-only and mounts nothing). Covered there: click suppression after activation (and none for a plain press), strip precedence, within-strip index correction, no-op drops, post-collapse preview, duplicate replacement, sole-tab self-edge, every cancel path, and rename/delete of the source. The window-drag rule is structural rather than tested: tabs carry no `data-tauri-drag-region` and Tauri only starts a window drag from the pressed element itself, so it belongs to the hand test.

### Implementation for User Story 2

- [x] T022 [US2] Add tab-ID drag sources and strip insertion targets, suppress the synthesized click after activation, and restrict `data-tauri-drag-region` to empty strip/titlebar space in `apps/desktop/src/components/editor-area/editor-tabs.tsx` and `apps/desktop/src/components/app-layout.tsx`
- [x] T023 [US2] Implement one atomic tab move/reorder/split action that preserves tab identity/history/registration, removes a same-document destination tab without invoking close/save, collapses empty source ancestors, and focuses the destination in `apps/desktop/src/lib/editor-layout.ts` and `apps/desktop/src/stores/editor-store.ts`
- [x] T024 [US2] Scope tab-strip scrolling and close/close-others/close-all context actions to the owning pane while keeping existing open/replace policy in `apps/desktop/src/components/editor-area/editor-tabs.tsx` and `apps/desktop/src/components/editor-area/editor-context-menu.ts`

**Checkpoint**: Tabs can be rearranged safely across the layout, including the source-collapse cases that change final geometry.

> Status: done in code, 793 tests passing, `vp check`, `tsc`, and `vp build` clean. The global strip moved out of `app-layout.tsx` into `pane-layout.tsx`, one strip per pane, floating over the top of its body so existing headroom and the drawing chrome offset stay as they were. Strips are measured on demand (`registerPaneStrip` / `getEditorAreaGeometry().strips`) because their tab boxes shift with strip scrolling. Not done: strip autoscroll while a drag hovers its edge (the contract allows it; nothing needs it yet). Not runtime-verified — the checkpoint's hand test is owed together with Phase 3's.

---

## Phase 5: User Story 3 - Show the exact drop preview (Priority: P1)

**Goal**: Paint one translucent orange preview for the exact candidate that would commit, including post-collapse geometry and strip insertion gaps.

**Independent test**: Move a file or tab across all pane edges, centres, strip gaps, and invalid regions. The overlay tracks the pointer, matches the released result, uses the existing accent in light and dark themes, and disappears on every end/cancel path.

### Tests for User Story 3

- [x] T025 [US3] Add failing geometry tests for edge bands capped at `min(25%, 80px)`, reachable centres, normalized corner distance with left/right/top/bottom tie order, strip precedence, invalid-target absence, post-source-collapse bounds, stale-candidate recomputation, and preview/result equality in `apps/desktop/tests/editor-layout.test.ts`

### Implementation for User Story 3

- [x] T026 [US3] Make the pointer coordinator retain one resolved candidate containing expected layout revision, geometry revision, validated resulting layout/focus, and final preview rectangle; recompute before release or cancel if revalidation fails in `apps/desktop/src/hooks/use-editor-drag.ts` and `apps/desktop/src/lib/editor-layout.ts`
  - No separate geometry revision: release always re-resolves against the live layout and freshly measured geometry, which subsumes "recompute if either changed" and is the smaller rule. The retained candidate is what the preview paints between frames; the store still refuses a candidate whose `expectedRevision` is stale.
- [x] T027 [US3] Render the candidate rectangle or insertion gap with the existing accent at 18% opacity, clip it to editor bounds, set `pointer-events: none`, and clear it synchronously on completion/cancellation in `apps/desktop/src/components/editor-area/drop-preview.tsx`, `apps/desktop/src/components/editor-area/pane-layout.tsx`, and `apps/desktop/src/App.css`

**Checkpoint**: All P1 drag gestures have an unambiguous preview backed by the same candidate they commit.

> Status: done in code. `DropPreview` mounts only while a candidate exists and paints `candidate.previewRect` (18% accent for bodies, a denser 4 px bar for strip gaps, `pointer-events: none`, clipped by the editor area's `overflow-hidden`). Light/dark legibility is a hand check.

---

## Phase 6: User Story 4 - Work across panes (Priority: P2)

**Goal**: Focus, edit, open, resize, close, and restore panes as ordinary editor surfaces while keeping each window's live layout independent.

**Independent test**: Build a nested layout, use each open route after changing focus, edit one document in two panes with independent cursors, resize and close panes, restart, and confirm the same valid layout returns. Legacy and damaged sessions recover according to the session contract.

### Tests for User Story 4

- [x] T028 [US4] Add failing routing tests that capture the intended pane/tab before async sidebar, palette, recents, search, wiki-link, drawing-embed, Finder-open, and pending-anchor work; reject stale workspace/navigation completions in `apps/desktop/tests/stores.test.ts`, `apps/desktop/tests/command-palette.test.ts`, and `apps/desktop/tests/wiki-links.test.ts`
  - The palette's two disk-first routes and the editor's wiki-link/drawing-embed routes were extracted into plain async functions (`command-palette/open-routes.ts`, `followWikiLink` / `openDrawingEmbed`) so the tests can drive them through the real store with a deferred IPC and move focus mid-flight. Sidebar clicks, recents, and search hand the path to the store synchronously, so the store-level tests cover them.
- [ ] T029 [P] [US4] Add valid v1/v2 and malformed shared JSON fixtures covering missing-before-active migration, duplicate-document history, nested round-trip, missing-file prune/collapse/focus repair, unsupported versions, duplicate/dangling IDs, bad nodes/axes/ratios, cycles, and focused-file prefetch in `SPECs/tab-tiling-splits/fixtures/sessions/`
- [ ] T030 [US4] Add failing TypeScript codec/persistence tests for all shared fixtures, ratio-only and focus persistence, 500 ms coalescing, close flush, restore-disabled behavior, stale workspace callbacks, compact-mode exclusion, diagnostics, and preservation of malformed records in `apps/desktop/tests/session.test.ts` and `apps/desktop/tests/tauri-ipc.test.ts`
- [ ] T031 [P] [US4] Add failing Rust tests that consume the shared fixtures and require the same validation, migration, pruning, focused-file extraction, null snapshot removal, and locked read/modify/write behavior in `apps/desktop/src-tauri/src/commands/workspace.rs`
- [ ] T032 [P] [US4] Add failing pane component tests for focus by body/tab interaction, one globally focused editor among several visible editors, nested resize minima, overflow when viewport is too small, separator keyboard resizing, and pane-last close/launcher fallback in `apps/desktop/tests/editor-pane-layout.test.tsx`

### Implementation for User Story 4

- [x] T033 [US4] Route global commands, formatting, find, navigation, title/status metrics, paste/link notices, and programmatic insertion to an explicit originating tab or the focused pane, closing the previous pane's find overlay on focus change, in `apps/desktop/src/hooks/use-keyboard-shortcuts.ts`, `apps/desktop/src/hooks/editor-api.ts`, `apps/desktop/src/components/editor-area/editor-search-store.ts`, `apps/desktop/src/components/editor-area/editor-notice-store.ts`, and `apps/desktop/src/components/window-title/use-window-title.ts`
  - Most of this was already structural after T005/T014: `activeTabId` derives from the focused pane, so title, footer metrics, close, back/forward, formatting, and `insertAtCursor` already followed focus, and `useCloseEditorSearchWhenInactive(isFocused)` already closed the previous pane's find. Landed here: Ctrl+Tab and Cmd+1-9 cycle the focused pane's strip rather than the window-wide list; `insertAtCursor` takes an originating tab; notices carry their tab and the banner and find overlay sit over that tab's pane via `PaneSurface`. `use-window-title.ts` needed no change.
- [x] T034 [US4] Capture pane targets before every async open route and funnel existing replace/new-tab policy through the pane-aware editor action in `apps/desktop/src/components/command-palette/index.tsx`, `apps/desktop/src/hooks/use-tabs.ts`, `apps/desktop/src/components/editor-area/link-navigation.ts`, `apps/desktop/src/components/editor-area/drawing-pane.tsx`, and `apps/desktop/src/hooks/use-open-drop.ts`
  - The store's `openFile` / `navigateToFile` / `openFileInNewTab` take an explicit `OpenTarget` (tab, then pane, then focus) and resolve it before their first await; a `resetEditorState` action replaces the layout tree on workspace switch/close so a pane captured before the reset can never be found again. The drawing-embed route lives in `wiki-link-extension.ts`, not `drawing-pane.tsx`, which needed no change. Pending anchors are keyed by tab and path so only the tab that followed the link scrolls.
- [x] T035 [US4] Render nested `Group`, `Panel`, and `Separator` nodes from `react-resizable-panels`, map `axis: x` to horizontal and `axis: y` to vertical, enforce recursive pixel minima, commit only completed normalized ratios, and keep undersized restored trees reachable via overflow in `apps/desktop/src/components/editor-area/pane-layout.tsx`
  - Each split is a `Group` keyed by its id and both child ids (a child that becomes a split changes the panel ids the default layout is written against, so the group re-mounts; slots only, bodies live elsewhere). `minSize` is the child subtree's recursive minimum; `onLayoutChanged` commits `a / (a + b)` only when `isUserInteraction`. The editor area gained an outer `overflow-auto` scroller around a sheet sized to `minimumSize(root)`, which is also the positioning context for slots, bodies, and preview so they scroll together. Separators are invisible until hovered, dragged, or keyboard-focused. Not runtime-verified yet; the divider drag, keyboard resize, and shrink-the-window checks are hand tests.
- [ ] T036 [US4] Implement session v2 codecs, v1 migration, page-kind deserialization, prune/normalize diagnostics, collision-free restored IDs, focused-tab prefetch, and one validated payload API in `apps/desktop/src/lib/session.ts`, `apps/desktop/src/lib/tauri.ts`, and `apps/desktop/src/stores/workspace-store.ts`
- [ ] T037 [US4] Update `save_session`, `load_session`, and bundled `restore_workspace` to accept/return the versioned payload or null, consume the shared fixtures, preserve `sessions_file_lock`, expose malformed-session diagnostics, and avoid overwriting malformed records before a valid mutation in `apps/desktop/src-tauri/src/commands/workspace.rs`
- [ ] T038 [US4] Persist committed layout/navigation/focus/ratio changes from the editor mutation owner after state publication, serialize writes per window, cancel stale callbacks on reset, flush the captured snapshot on explicit close, retain workspace-keyed last-writer-wins behavior, and skip compact windows in `apps/desktop/src/stores/workspace-store.ts` and `apps/desktop/src/lib/session.ts`

**Checkpoint**: Nested panes act like normal editor surfaces and survive restart without changing compact-window behavior.

---

## Phase 7: Polish and cross-cutting validation

**Purpose**: Prove the full gesture and persistence contract, check performance, and update the owning documentation.

- [ ] T039 Add the focused macOS desktop journey for sidebar split, tab move/reorder, post-collapse preview agreement, cancellation, focus routing, resize, and restart restore in `apps/desktop/e2e/specs/tab-tiling.spec.js`
- [ ] T040 Run `vp check`, `vp test`, `vp run desktop#build`, `cargo test`, `cargo clippy`, and `cargo fmt --check`; record any required test-environment notes in `SPECs/tab-tiling-splits/quickstart.md`
- [ ] T041 Follow the bounded manual matrix in `SPECs/tab-tiling-splits/quickstart.md` for light/dark preview legibility, sidebar move isolation, duplicate Markdown/drawing views, malformed restore diagnostics, compact/Finder regression, and four-note typing/drag/resize traces; record measured document sizes and trace results in that file
- [ ] T042 Update the shipped pane, focus, drag, save/reload, and shortcut ownership rules in `docs/editor.md` and `docs/keyboard-shortcuts.md`, then add the user-visible tiling entry to `CHANGELOG.md`

---

## Dependencies and execution order

### Phase dependencies

- **Phase 1, setup**: Starts immediately.
- **Phase 2, foundation**: Depends on T001. Complete T002-T014 in order where a failing test precedes its paired implementation; tasks marked `[P]` may overlap only after their inputs exist.
- **User Story 1**: Depends on Phase 2 and delivers the MVP.
- **User Story 2**: Depends on User Story 1's coordinator and pane surfaces. It reuses the foundation's stable tab identity.
- **User Story 3**: Depends on the sidebar and tab candidate types from User Stories 1 and 2 so preview and commit share one representation.
- **User Story 4**: Depends on the complete P1 gesture set. Its fixture authoring and component tests marked `[P]` can proceed while routing tests are written.
- **Polish**: Depends on every story included in the release.

### User story dependency graph

```text
Setup -> Foundation -> US1 (sidebar split MVP) -> US2 (tab moves) -> US3 (preview)
                               |                       |                |
                               +-----------------------+----------------+-> US4 (daily pane work + restore) -> Polish
```

The stories remain independently testable at their checkpoints, but the implementation order is intentionally sequential because US2 and US3 reuse US1's pointer coordinator, and US4 persists the layout produced by all P1 gestures.

### Within each story

- Write and run the story's failing tests before its implementation tasks.
- Pure transitions produce and validate candidates before store actions expose them.
- Store actions land before UI adapters call them.
- Preview paints the candidate already accepted by validation; it never rebuilds intent separately.
- Persistence serializes only normalized committed state.

### Parallel opportunities

- After T005, T006 can proceed alongside the registration test work in T007.
- After T010, drawing tests and ownership work in T011-T012 are isolated from the stable-host component work in T013-T014.
- In User Story 4, T029, T031, and T032 touch independent fixture, Rust, and component-test files; T029 must finish before the fixture-consuming assertions in T030-T031 are finalized.
- T039 can be drafted while T040's non-e2e quality gates run, then executed after the desktop build is available.

## Parallel examples

### Foundation

```text
Task A: T011-T012 drawing-session tests and implementation
Task B: T013-T014 stable tab-host component tests and implementation
```

### User Story 4

```text
Task A: T029 create shared session fixtures
Task B: T032 write pane focus/resize component tests
Task C: T028 write focused-pane routing tests
```

## Implementation strategy

### MVP first

1. Complete setup and foundation.
2. Complete User Story 1.
3. Stop at its checkpoint and have the user test sidebar-to-edge, sidebar-to-centre, cancellation, and ordinary sidebar move-on-disk behavior.

This MVP already provides the core outcome: two editable documents side by side in one gesture. Do not claim the whole feature is shipped until tab moves, preview, daily pane behavior, and session restore also pass.

### Incremental delivery

1. **Foundation**: One-pane compatibility plus safe pane/document/view ownership.
2. **US1**: Create splits from Everything.
3. **US2**: Rearrange tabs without losing live state.
4. **US3**: Make every drop result visible before commit.
5. **US4**: Route normal work through pane focus, add resizing, and persist the layout.
6. **Polish**: Run the full quality, interaction, recovery, and performance checks before updating the changelog.

## Notes

- A `[P]` marker only applies after the task's declared prerequisites are complete; never edit the same file concurrently.
- A move changes view ownership and must bypass close/navigation save boundaries. True close, location replacement, and shutdown keep those boundaries.
- Editing changes document revision, not layout revision. Cursor and scroll changes must not serialize the layout.
- Unsupported or malformed v2 sessions are errors, not legacy v1 data. Preserve the bad record until a deliberate valid layout mutation replaces it.
- Commit after each task or one tightly coupled test/implementation pair, then stop at story checkpoints for user interaction review.
