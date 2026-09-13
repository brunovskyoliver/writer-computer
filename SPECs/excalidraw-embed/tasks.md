# Tasks: Excalidraw Embed + Edit

**Input**: [`spec.md`](./spec.md) (research status), [`plan.md`](./plan.md), `.specify/memory/constitution.md`

**Tests**: Logic only, per plan.md "Testing" and Constitution Principle VI — `locationForPath`
extension table, format detection, path derivation, collision suffix search. **No UI test
suite for the drawing tab**; it is verified at the review checkpoints below.

**Organization**: Grouped by user story. Stories derive from spec.md's Acceptance Criteria;
task bodies derive from plan.md's phases. This file is a checklist, not a second spec —
rationale stays in spec.md and plan.md (Principle III: two spec systems holding one truth is
the drift to avoid).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: `[US1]`/`[US2]`/`[US3]`; setup, foundational, and polish tasks carry none

## Path Conventions

Desktop app, existing layout. Frontend `apps/desktop/src/`, logic tests
`apps/desktop/tests/`, Rust `apps/desktop/src-tauri/src/`. Toolchain is `vp` — never npm.

---

## ⚠️ Gate: this breakdown is branch-conditional

spec.md is **research status, not approved for implementation**. Phase 2 (the spike) decides
the storage format. Phase 3 has a **Branch A** block and a **Branch B** block and **exactly
one of them is executed** — see plan.md "The branch gate". Every later phase is identical on
both branches. Do not start Phase 3 before T009 reports and the user picks a branch.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependency in place so the spike can run at all

- [x] T001 Run `vp install` from repo root, then `vp install @excalidraw/excalidraw@0.18.1` from `apps/desktop/` — this CLI has no `vp add` subcommand; `vp install <pkg>` acts as add. Pinned exactly, and pnpm routes the pin into the `pnpm-workspace.yaml` catalog. Peer-compatible with this repo's React 19
- [x] T002 Create `SPECs/Agent/worksheet-excalidraw-embed.md` following the shape of the existing worksheets in `SPECs/Agent/` (spec.md "Procedure in this repo", step 3)
- [x] T003 [P] Move the Excalidraw task in `TODOS.md` from **Up Next** to **In Progress**, linking `SPECs/excalidraw-embed/spec.md`

---

## Phase 2: Foundational — the spike (BLOCKING GATE)

**Purpose**: Answer plan.md Phase 0's four questions by experiment. Not a docs check.

**⚠️ CRITICAL**: No implementation task may begin until T009 has reported and a branch is chosen.

- [ ] T004 Add a throwaway spike module at `apps/desktop/src/lib/__spike-excalidraw.ts` that builds one scene containing **both a text element and an embedded image** (so `appState`, `elements`, and the `files` map are all exercised) and exports it via `exportToSvg({ appState: { exportEmbedScene: true } })`
- [ ] T005 In `apps/desktop/src/lib/__spike-excalidraw.ts`, run the **repeated** round-trip: export → `loadFromBlob` → diff element array against the original → edit → export → `loadFromBlob` again. At least two full cycles; record per-cycle diffs of `elements`, `appState`, and `files`
- [ ] T006 [P] In the spike, grep the exported SVG for the scene payload, for `@font-face`, and for `base64`; then load the exact file through `convertFileSrc` inside an `<img>` and record whether the hand-drawn glyphs render (a remote `@font-face` cannot be fetched from a sandboxed `<img>`)
- [ ] T007 [P] Add a module with `import("@excalidraw/excalidraw")` behind a dynamic import, run `vp build` from `apps/desktop/`, and record the real emitted chunk sizes from the build output (the 46 MB npm unpacked figure is tarball-with-sourcemaps and is not the number that matters)
- [ ] T008 [P] Verify offline behavior with `window.EXCALIDRAW_ASSET_PATH` unset vs. pointed at bundled assets, and record exactly what breaks (expected: fonts and workers)
- [ ] T009 Report all four spike results to the user and **stop for the branch decision** (Principle VI). Losing `elements`, `appState`, or `files` on cycle two is a spike **failure** → Branch B, not a caveat to accept
- [ ] T010 Delete `apps/desktop/src/lib/__spike-excalidraw.ts` and the throwaway dynamic-import module; nothing from the spike is committed
- [ ] T011 Rewrite `SPECs/excalidraw-embed/spec.md` from research into a real spec for the chosen branch, keeping the section shape of `SPECs/mermaid-canvas-widget-spec.md` (Summary / Goals / Non-Goals / UX Decisions / Implementation Notes / Files Expected To Change / Acceptance Criteria)

**Checkpoint**: Branch chosen and recorded in spec.md. Phase 3 can begin.

---

## Phase 3: Foundational — storage format and I/O (execute ONE branch)

**Purpose**: `lib/drawings.ts` — one module owning format detection, read, and write

### Branch A — round-trip holds (`.excalidraw.svg`, scene in SVG metadata)

- [ ] T012 Create `apps/desktop/src/lib/drawings.ts` with `isDrawingPath(path)` matching the **compound** extension `.excalidraw.svg` only — a plain `.svg` is an image, not a drawing
- [ ] T013 In `apps/desktop/src/lib/drawings.ts`, implement the save path via `exportToSvg` with `exportEmbedScene: true` and `exportBackground: false` (transparent background so the drawing sits on the note's own background and reads correctly in both themes; an `<img>`-hosted SVG is inert and cannot react to a theme change afterward)
- [ ] T014 In `apps/desktop/src/lib/drawings.ts`, implement the load path via `loadFromBlob`, returning a parse error rather than an empty scene on failure

### Branch B — round-trip fails (`.excalidraw` raw JSON)

- [ ] T015 Create `apps/desktop/src/lib/drawings.ts` with `isDrawingPath(path)` matching `.excalidraw`
- [ ] T016 In `apps/desktop/src/lib/drawings.ts`, implement the save path via the package's own `serializeAsJSON` — never a hand-rolled `JSON.stringify`. The on-disk envelope is `{ type, version, source, elements, appState, files }`; a bare scene object missing it is rejected by excalidraw.com and Obsidian, which destroys Branch B's only advantage (Principle VI)
- [ ] T017 In `apps/desktop/src/lib/drawings.ts`, implement the load path via `loadFromBlob`, returning a parse error rather than an empty scene on failure

### Both branches

- [ ] T018 Route every drawing write through the existing Rust path — `tauri.writeFile` (`apps/desktop/src/lib/tauri.ts:31` → `write_file` in `apps/desktop/src-tauri/src/commands/fs.rs:344`). Do **not** add a second write path: `watcher.rs` self-write detection keys off it, and a save that bypasses it reads back as an external change and can reload the tab under the user's cursor
- [ ] T019 [P] Add `apps/desktop/tests/drawings.test.ts` covering `isDrawingPath` over an extension table — must include `.excalidraw.svg`, plain `.svg`, `.excalidraw`, `.png`, `.md`, no extension, and uppercase variants

---

## Phase 4: Foundational — open routing consolidation (prerequisite, not cleanup)

**Purpose**: Make path → tab-location a single write path **before** adding drawing dispatch.
Principle III: adding the next case must touch one file; today it would touch six.

- [ ] T020 Add `locationForPath(path)` to `apps/desktop/src/stores/editor-store.ts` as the single constructor of a tab location from a path
- [ ] T021 Route all six existing construction sites in `apps/desktop/src/stores/editor-store.ts` through `locationForPath`: `createFileTab` (line 119) and its four callers (lines 370, 412, 450, 532), plus the inline `{ kind: "file", path }` in `navigateToFile` (line 660) that currently bypasses the factory
- [ ] T022 Add drawing dispatch **inside `locationForPath` only** — `isDrawingPath(path)` → `{ kind: "drawing", path }`, else `{ kind: "file", path }`. Do not branch in `openFile`: it delegates to `replaceTabWithFile` and `navigateToFile`, and `openFileInNewTab` is a separate entry, so drawings would still open as raw text from the sidebar and from wiki-link navigation
- [ ] T023 [P] Add `locationForPath` extension-table tests to `apps/desktop/tests/drawings.test.ts` — this is the piece that silently regresses
- [ ] T024 Confirm `open_target::classify` in `apps/desktop/src-tauri/src/` is left untouched; it gates startup/CLI/Finder opens only and is out of scope

**Checkpoint**: Foundation ready. Drawing paths resolve to a `drawing` location; nothing renders it yet.

---

## Phase 5: User Story 1 — Edit a drawing in its own tab (Priority: P1) 🎯 MVP

**Goal**: Double-clicking a drawing file in the sidebar opens a full Excalidraw editor tab;
edits save back to the same file; the tab survives session restore.

**Independent Test**: Place a drawing file (`.excalidraw.svg` or `.excalidraw`, per branch)
into the workspace **by hand** — there is no create flow until US3 — click it in the sidebar,
edit it, close the tab, quit and relaunch, and confirm the tab returns with the edit intact.

### Implementation for User Story 1

- [ ] T025 [US1] Create `apps/desktop/src/components/editor-area/page-kinds/drawing.ts` via `definePageKind`, implementing `kind: "drawing"`, `title` from the filename stem, `description` for the command palette, `paths`, `primaryPath`, `rewritePath`, `removePath`, `fromPayload`, and `serialize` (path in the payload, so tabs survive session restore)
- [ ] T026 [US1] Add `drawingKind` to the `kinds` tuple in `apps/desktop/src/components/editor-area/page-kinds/index.ts:13` — one entry, nothing else in the registry is touched
- [ ] T027 [US1] Create `apps/desktop/src/components/editor-area/drawing-pane.tsx` hosting `<Excalidraw>` behind `React.lazy`, keyed by `location.path`, importing the mandatory `@excalidraw/excalidraw/index.css`
- [ ] T028 [US1] Set `window.EXCALIDRAW_ASSET_PATH` to the bundled asset directory and bundle Excalidraw's fonts and workers — the app must work with no network reachable (Principle I, non-negotiable)
- [ ] T029 [US1] Mirror `appearance.theme` into Excalidraw's `theme` prop in `apps/desktop/src/components/editor-area/drawing-pane.tsx`. The editor otherwise keeps Excalidraw's own look; restyling it to match Writer is out of scope and would break on every upgrade
- [ ] T030 [US1] Debounce `onChange` → save in `apps/desktop/src/components/editor-area/drawing-pane.tsx` at 150ms, matching `SOURCE_CHANGE_DEBOUNCE_MS` in `apps/desktop/src/components/editor-area/mermaid-canvas.ts:31`. Excalidraw's `onChange` fires continuously; an undebounced write would hammer the disk and the watcher
- [ ] T031 [US1] On a file that fails to parse, render an explicit error in the tab and **suppress autosave for that tab**. It must not fall back to an empty canvas — the next autosave would overwrite the user's real drawing with nothing (Principle IV; the highest-consequence failure mode in the feature)
- [ ] T032 [US1] Register the drawing view in `apps/desktop/src/components/editor-area/page-kinds/views.tsx` — one `drawing` entry pointing at `drawing-pane.tsx`, no footer
- [ ] T033 [US1] Confirm the drawing tab's save round-trips through the watcher without a spurious external-change reload (self-write detection in `apps/desktop/src-tauri/src/watcher.rs`)

**⛔ User review checkpoint** (Principle VI): stop and have the user open, edit, close, reopen,
and session-restore a drawing before Phase 6.

---

## Phase 6: User Story 2 — Inline embed and double-click to edit (Priority: P1)

**Goal**: A note embedding a drawing renders it inline, and double-clicking the embed opens
the drawing tab.

**Independent Test**: Write `![[drawing.excalidraw.svg]]` in a note. The drawing renders
inline. On Branch A, confirm **no Excalidraw chunk appears in the module graph** while the
note is open. Double-click the rendered drawing → the editor tab opens on that file.
Scrolling a note with ten drawings is indistinguishable from ten PNGs.

### Implementation for User Story 2

- [ ] T034 [US2] **Branch A only** — verify zero render code is needed: `WIKI_IMAGE_EXTENSIONS` (`apps/desktop/src/lib/wiki-links.ts:124`) already contains `svg`, so `![[x.excalidraw.svg]]` renders through `parseWikiImageEmbedTarget` → `ImageEmbedWidget` (`apps/desktop/src/components/editor-area/wiki-link-extension.ts:141`), and `![](x.excalidraw.svg)` resolves through `image-src-resolver.ts`. Confirm by hand; write no code
- [ ] T035 [US2] **Branch B only** — add a `DrawingWidget` to a new CodeMirror decoration module that dynamically imports the bundle and calls `exportToSvg`, following the `MermaidWidget` shape in `apps/desktop/src/components/editor-area/mermaid-decorations.ts`: bounded LRU cache, stable `estimatedHeight`, synchronous `toDOM`
- [ ] T036 [US2] Add a `dblclick` handler to the embed widget in `apps/desktop/src/components/editor-area/wiki-link-extension.ts` that resolves the embed target to an absolute path and, when `isDrawingPath` matches, opens it through the editor store (Phase 4's `locationForPath`)
- [ ] T037 [US2] Confirm the `dblclick` handler does not interfere with the existing range-select-to-enter-edit-mode behavior on embeds (see `docs/editor.md` on block-widget patterns)

**Checkpoint**: Notes render drawings and route to the editor. Feature is usable on existing files.

---

## Phase 7: User Story 3 — Create a new drawing (Priority: P2)

**Goal**: A "New Drawing" command creates the file, inserts the embed into the current note,
and opens the drawing tab. Without this the feature is unusable — the user would otherwise
hand-author a drawing file and type the embed themselves.

**Independent Test**: From a note, run "New Drawing" from the command palette — the file
appears in the note's own directory, `![[drawing.excalidraw.svg]]` appears at the cursor, and
the drawing tab opens. Run it twice more and get `drawing-1`, `drawing-2`. Run it from the
launcher and get a file plus a tab with no insert and no error.

### Implementation for User Story 3

- [ ] T038 [P] [US3] Add `nextAvailableDrawingPath(dir)` to `apps/desktop/src/lib/drawings.ts`: base name `drawing`, and on collision `drawing-1`, `drawing-2`, … The suffix search is a loop over a file-existence check (`file_exists` in `apps/desktop/src-tauri/src/commands/fs.rs:677`)
- [ ] T039 [P] [US3] Add collision-suffix tests to `apps/desktop/tests/drawings.test.ts` with the existence check injected — cover no collision, one collision, a gap in the sequence, and a directory where `drawing-1` exists but `drawing` does not
- [ ] T040 [US3] Add a `new-drawing` command to the `Command` list in `apps/desktop/src/components/command-palette/index.tsx` (alongside `new-file` at line 140)
- [ ] T041 [US3] Implement the command in this **load-bearing order**: write the file, **then** insert `![[name.excalidraw.svg]]` into the source document at the cursor, **then** open the drawing tab. Opening the tab moves focus off the note, so an insert afterwards has no cursor to target
- [ ] T042 [US3] When invoked from anywhere that is not a file tab (launcher, settings, another drawing tab), create the file in the workspace root and open the tab, inserting nothing. No error
- [ ] T043 [US3] Place the new file in the **note's own directory**. Writer has no attachment-folder concept and this feature does not add one (Principle II — no config key for a value that never varies)
- [ ] T044 [US3] Add "New Drawing" to the sidebar's existing new-file context menus **only if it costs one registry entry**; skip it otherwise

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T045 [P] Add the `drawing` page kind to `docs/editor.md` — and, Branch B only, the widget notes (decoration shape, LRU cache, `estimatedHeight`)
- [ ] T046 [P] Add the user-visible entry to `CHANGELOG.md`
- [ ] T047 [P] Note in `docs/editor.md` that an already-open note's embed does **not** live-refresh after a drawing is saved — three layers cache it (`embedResolutionCache` at `apps/desktop/src/components/editor-area/wiki-link-extension.ts:116`, the per-URL measured-height cache behind `attachStableImageHeight`, and the webview's cache of the stable `convertFileSrc` URL). Reopening the note shows the new version. Deliberately out of scope, recorded so it is not filed as a bug
- [ ] T048 Run `vp check` and `vp test` from repo root, and `cargo test` / `cargo clippy` / `cargo fmt --check` from `apps/desktop/src-tauri/`
- [ ] T049 Move the task to **Done** in `TODOS.md`

---

## Dependencies

```text
Phase 1 (Setup: T001–T003)
   ↓
Phase 2 (Spike GATE: T004–T011) ── T009 is a hard stop for the branch decision
   ↓
Phase 3 (Format + I/O: Branch A T012–T014 XOR Branch B T015–T017, then T018–T019)
   ↓
Phase 4 (Open routing: T020–T024) ── needs isDrawingPath from Phase 3
   ↓
Phase 5 = US1 (T025–T033) ── needs the drawing location from Phase 4
   ↓  ⛔ user review checkpoint
Phase 6 = US2 (T034–T037) ── T036 needs Phase 4's helper; T035 needs Phase 3 Branch B
   ↓
Phase 7 = US3 (T038–T044) ── T041 needs Phase 5's tab and Phase 6's embed syntax
   ↓
Phase 8 (Polish: T045–T049)
```

Story order is genuinely sequential here, not a convention: US2's double-click has nothing to
open without US1's tab, and US3's create flow writes the embed US2 renders.

## Parallel Opportunities

- **Phase 2**: T006, T007, T008 are independent measurements on the same spike scene — one export run, three readings
- **Phase 3**: T019 (tests) alongside T018 (write path) — different files
- **Phase 4**: T023 alongside T024
- **Phase 7**: T038 and T039 together; both precede T040–T041
- **Phase 8**: T045, T046, T047 are three different files

## Implementation Strategy

**MVP = Phase 5 (US1)**, reached only after the spike gate. That delivers a working drawing
editor on files the user places by hand. US2 makes drawings visible in notes; US3 makes them
creatable. Each phase is one commit, per the constitution's Development Workflow.

Branch A and Branch B are **mutually exclusive** in Phase 3. Everything from Phase 4 onward
is identical on both, except T034/T035 in Phase 6.
