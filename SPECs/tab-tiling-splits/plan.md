# Implementation plan: Tab tiling and split panes

**Feature**: 002, `tab-tiling-splits`

**Branch**: `excalidraw-embed` at planning time; intended implementation branch `tab-tiling-splits`

**Date**: 2026-09-13

**Spec**: [spec.md](spec.md)

## Summary

Let each workspace window hold a nested tree of resizable panes, each with its own tabs. A single pointer-drag coordinator resolves sidebar moves, tab insertion, centre drops, and edge splits. One resolved operation drives both the orange preview and the committed layout.

Keep document buffers and saves shared by path. Move cursor, scroll, editor registration, and navigation ownership to tab IDs. Keep tab bodies mounted at a stable React parent while pane geometry changes, so moving a tab preserves CodeMirror and Excalidraw state without an unmount-triggered save.

Planning is complete through Spec Kit Phase 1. Implementation and `tasks.md` are separate work.

## Technical context

- Language: TypeScript ~5.8.3, React ^19.1.0; Rust edition 2021, Tauri v2. No new minimum Rust version is proposed.
- Dependencies: Zustand ^5.0.12, CodeMirror 6, Prosemark, existing Excalidraw. Add the already catalogued `react-resizable-panels` ^4.7.4 to the desktop package using `catalog:`. Use its v4 `Group`, `Panel`, and `Separator` API.
- Storage: Markdown and drawing SVG files stay on disk; versioned layout metadata extends the existing app-data `sessions.json` path. No browser storage or network dependency.
- Testing: Vite+ unit/integration tests, Rust tests, existing macOS WebdriverIO harness, focused manual pointer checks.
- Platform: Tauri desktop, macOS as the primary interaction-validation target. Standalone compact windows retain their existing single-view flow.
- Performance: retain responsive editing with four visible typical notes. Pointer geometry work runs at most once per animation frame; layout subscriptions must not fire for text/cursor updates. Serialize each document edit once and save once per document.
- Scope: arbitrarily nested binary splits, constrained by available size; no fixed pane-count cap, cross-window drag, tear-off, presets, or new split/focus shortcuts.

## Constitution check

| Principle                            | Before research                               | After design                                                                                                         |
| ------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| I. Local-first plain text            | Pass: session-only metadata                   | Pass: existing disk writes and offline operation retained                                                            |
| II. Smallest correct change          | Pass: extend existing editor ownership        | Pass: binary layout, one drag resolver, existing libraries; no generic docking framework                             |
| III. One place per concern           | Pass: shared document owner and page registry | Pass: one layout transition path, one document write path per format, session wire shape enforced by shared fixtures |
| IV. Explicit failure and owned state | Pass: require versioned async operations      | Pass: source revalidation, workspace generations, save revisions, explicit restore diagnostics                       |
| V. Specs/docs with code              | Pass: existing spec and TODO                  | Pass: artifacts linked; implementation must update editor, shortcuts, and changelog docs                             |
| VI. Reuse libraries, bounded tests   | Pass: investigate resize dependency           | Pass: v4 resize library; targeted checks plus human interaction review                                               |
| VII. User scope                      | Pass                                          | Pass: local study and reference notes side by side                                                                   |

No unresolved design clarifications or new exceptions. The spec's inherited claim that session writes race is stale: `save_session` already holds `AppState.sessions_file_lock` through read/modify/write. Preserve that lock. Same-workspace windows retain the existing workspace-keyed last-snapshot policy; separate per-window session identities are outside this feature.

## Project structure

```text
SPECs/tab-tiling-splits/
  spec.md
  plan.md
  research.md
  data-model.md
  quickstart.md
  contracts/ui.md
  contracts/session.md
  checklists/requirements.md

apps/desktop/src/
  stores/editor-store.ts                 # tab/pane mutations and document ownership
  stores/workspace-store.ts              # restore lifecycle and existing session calls
  hooks/use-tabs.ts, editor-api.ts        # pane-aware selectors and tab view registry
  hooks/use-editor-layout.ts             # new narrow layout API
  lib/editor-layout.ts                   # new pure tree/drop transitions and invariants
  lib/session.ts, tauri.ts               # session codec and IPC
  lib/save.ts                            # shared Markdown save scheduler
  lib/drawing-sessions.ts                 # consolidate concurrent drawing work to one owner/path
  components/app-layout.tsx              # window chrome and pane-strip integration
  components/editor-area/
    index.tsx                           # stable tab body host list
    pane-layout.tsx                     # new recursive resize tree and pane chrome
    editor-tabs.tsx                     # pane-owned strips and insertion targets
    use-prosemark-editor.ts             # transaction sync and tab-local state
    drawing-editor.tsx                 # attach to shared drawing session
    page-kinds/                         # generic tab/view context via existing registry
  # Existing sidebar tree drag hook becomes an adapter to one shared pointer coordinator.
apps/desktop/src-tauri/src/commands/workspace.rs
apps/desktop/tests/
apps/desktop/e2e/specs/tab-tiling.spec.js  # future focused desktop coverage
```

Keep pure layout operations separate from store I/O. Do not create an independently writable layout store beside the tab store: moves, deduplication, focus, and collapse must commit atomically. Concrete new filenames may follow the nearest existing hook layout during implementation.

## Phase 0: Research decisions

See [research.md](research.md). The important findings are existing path-shared Markdown content but path-owned cursor state, a single-view-per-path editor registry, drawing sessions that still have one instance per view, a globally active tab assumption, and pointer cancellation currently sharing the sidebar's release handler.

## Phase 1: Design

See [data-model.md](data-model.md), [UI contract](contracts/ui.md), and [session contract](contracts/session.md).

Implementation order for the later task breakdown:

1. Introduce pane/tree identities and pure transitions. Wrap the current tab list in one pane; derive global active-file selectors from the focused pane. Keep one-pane behavior working throughout.
2. Separate tab view state from document state. Replace the path-keyed editor registry; synchronize Markdown transactions and share drawing scene/save ownership. Prove duplicate-view editing and moving a mounted tab before adding drag UI.
3. Move the global strip out of `app-layout.tsx` into pane chrome, retaining a dedicated window drag surface and macOS traffic-light clearance. Scope strip scrolling and close-other/close-all menus to their pane. Render nested resize groups and pane chrome around stable tab hosts. Separate visible-active tabs from the one keyboard-focused tab. Route editor commands, search, notices, navigation, and async completions to their captured tab/pane.
4. Extract the shared pointer coordinator and connect sidebar and tab sources. Resolve the final candidate layout before painting preview, including source-pane collapse. Commit only that valid candidate after source/workspace/layout revalidation.
5. Extend session serialization, migration, bundled startup prefetch, and prune/restore. Persist committed layout changes and focus through the owning action pipeline; preserve the backend file lock and restore setting.
6. Run the bounded validation matrix in [quickstart.md](quickstart.md). Update owning docs and record actual shipped behavior in `CHANGELOG.md` during implementation.

These are dependency stages, not an implementation task list. Run `speckit-tasks` next to turn them into concrete tasks.

## Risks and validation gates

- Moving a keyed child between recursive React parents remounts it. Keep editor bodies under one stable parent and measure pane body rectangles; verify editor instance identity, undo, cursor, and zero move-induced writes.
- An edge drop can remove its source pane. Simulate removal, collapse, split, ratios, and final bounds before drawing the overlay. The inserted target's final rectangle is the preview authority.
- Duplicate drawing tabs must not run independent SVG export queues. Scene synchronization and single-save ownership are a prerequisite for offering those drops.
- Delayed file loads, navigation, exports, and restore can complete after a pane/workspace changes. Capture workspace generation, target identity, and document revision before awaiting; reject stale results.
- Minimum sizes may exceed a smaller restored window. Keep the tree and use a scrollable minimum-sized editor layout instead of deleting panes or silently shrinking them below minimum.
- The plan defines acceptance checks; no application behavior has been implemented or runtime-validated in this planning change.

## Complexity tracking

No new constitution violations. Stable tab hosts add geometry wiring because recursive reparenting would violate the spec's preserved view state and no-save-on-move requirements.
