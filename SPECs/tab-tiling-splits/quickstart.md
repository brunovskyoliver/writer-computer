# Validation guide

This guide is for the implementation produced from this plan. The tiling UI is built; what remains is the runtime acceptance pass recorded at the bottom of this file.

## Setup and commands

Use a throwaway workspace with `a.md`, `b.md`, `c.md`, a folder, and an `.excalidraw.svg` drawing. Include a longer note with headings/frontmatter and an inline drawing. Enable restore-open-files. Use the existing isolated e2e app-data setup for session fixtures.

From repository root:

```sh
vp install
vp check
vp test
vp run desktop#build
vp run desktop#dev
```

From `apps/desktop/src-tauri/`:

```sh
cargo test
cargo clippy
cargo fmt --check
```

For macOS automated interaction checks, follow `apps/desktop/e2e/README.md` prerequisites. From `apps/desktop/e2e/`, use `vp run build:app`, then `vp run test:wdio -- --spec ./specs/tab-tiling.spec.js` once the planned spec exists. Do not use the current wrapper script that invokes pnpm internally.

## Automated checks to add or extend

- Pure tree/drop tests: all edges, mixed nested axes, source collapse changing destination bounds, reorder index correction, duplicate destination, sole-source self-edge, minimum rejection, empty-root launcher. Assert predicted rectangle equals committed target bounds.
- Existing store/editor API tests: pane-scoped open/dedup and focus; delayed open after focus/workspace change; tab move preserves ID/history/view registration; path rename/delete updates all references and invalidates drag.
- Mounted Markdown integration: edit A while B shares the path; B receives changes, retains mapped selection and scroll, local undo does not erase unrelated sibling edits; one save schedule; removing A leaves B registered. Include frontmatter, insert-at-cursor, and external reload.
- Drawing integration: two views share scene/assets and dirty state, one export/write queue, stale exports cannot mark newer edits clean, sibling sync does not loop, tab moves do not flush or remount.
- Session fixture checks in TS/Rust: v1 migration with a missing tab before the old active index, legacy duplicate-document tabs with separate histories, nested v2 round-trip, pruning/collapse/focus repair, malformed v2 diagnostics, focused startup prefetch, ratio-only persistence, restore disabled, stale workspace callbacks.

Prefer extending `apps/desktop/tests/stores.test.ts`, `editor-api.test.ts`, and drawing tests. Add small focused layout tests and one desktop gesture spec. Do not build a large UI snapshot suite.

## Manual acceptance pass

1. Open A, drag B from Everything to right, then C to bottom of B. Check equal initial split space, correct orange previews, editable notes and per-pane strips. Repeat left/top and centre. Centre preserves the tree. A file selection opens in selection order with its first file active; a folder selection has no editor target.
2. Move/reorder tabs within/across strips, then move a source pane's last tab to another edge. Hold before release and compare the preview with final geometry after collapse. Move a tab into a pane already showing its file; the moved tab's history/cursor survives without duplicate document tabs.
3. Drag over the tree and release: disk move only. Drag the same source into the editor: open only. Cancel with Escape, outside-window release, pointer interruption, and blur. Rename/delete the dragged source externally. No cancelled gesture mutates layout or files; no overlay remains. Empty strip still drags the OS window, tabs never do.
4. Open A in two panes via an edge drop. Edit, undo, scroll, select, edit frontmatter, save, and trigger external disk change. Both views share content/errors/reload decisions and retain independent cursors/scroll. Repeat with the drawing; check scene assets and revisit each tab. Moving either view must not cause disk read/write or remount.
5. Focus each pane and open from sidebar, palette, recents, search, wiki link and drawing embed. Check replace/new-tab policy, back/forward, find, formatting, footer/title and originating-tab insertion. Focus another pane while an open is delayed: completion belongs to the captured target.
6. Resize nested splits to their minimum, try an invalid extra split, shrink the window and restore it. The tree survives and remains reachable through overflow. Close pane-last tabs until launcher returns.
7. Resize/focus/select tabs, quit and reopen. Verify ratios, nesting, active tabs and focus. Restore a legacy fixture and a missing-file fixture, then corrupt a v2 fixture in the isolated test profile and verify visible recovery diagnostics without silent overwrite. Open two workspace windows and confirm their live layouts are independent. Check standalone compact and Finder-drop behavior still work.
8. Use four notes of roughly 20 KB each, including headings/tables. Compare typing and drag/resize traces against one pane on the same machine. Record document sizes and traces; investigate visible stalls, extra full-document passes or unrelated layout renders. Do one light/dark visual pass and return to the user for interaction review.

## Planning validation record

Spec Kit setup resolved the intended feature directory. Existing source and local dependency definitions were inspected, along with the resize library's published v4 declarations. `vp install` succeeded using the repo-local binary because `vp` was absent from the shell PATH. Planning artifacts require link/placeholder/diff checks only; application tests and runtime acceptance remain implementation gates.

## Recorded validation run (T040)

Run from the repository root on macOS 15 (Darwin 25.6.0), 2026-09-14.

| Check                        | Result                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp check`                   | pass — 0 errors, 4 pre-existing warnings (`drawing-sessions.test.ts` unused binding, `drawing-sessions.ts` useless spread, `editor-api.test.ts` unbound method, `wdio.conf.js` redundant `any` in a JSDoc type). None are in tiling code. |
| `vp test`                    | pass — 869 tests in 57 files                                                                                                                                                                                                              |
| `vp run desktop#build`       | pass                                                                                                                                                                                                                                      |
| `cargo test`                 | pass — 179 tests, including `session::tests::shared_fixtures_agree_with_the_frontend_codec`                                                                                                                                               |
| `cargo clippy --all-targets` | pass — 0 errors, 9 pre-existing warnings (dead `workspace_path`, `items_after_test_module` in `shutdown.rs`)                                                                                                                              |
| `cargo fmt --check`          | pass                                                                                                                                                                                                                                      |

### Test-environment notes

- **`vp` is not on the shell PATH here.** Every command above was run through the
  repo-local binary at `./node_modules/.bin/vp`. Substitute that for a bare `vp`
  if the global CLI is missing.
- **`vp check` stops at the first failing stage.** A formatting problem in an
  unrelated file (here, `TODOS.md`) masks the lint and type results entirely. Run
  `vp check --fix` and then re-read the output before concluding anything about
  types.
- **`specs/tab-tiling.spec.js` has not been executed.** It requires
  `cargo install tauri-webdriver --locked`, which is not installed on this
  machine, plus a full `cargo tauri build --features e2e` (`pnpm run build:app`).
  The spec is written against the shipped selectors (`[data-pane-id]`,
  `[data-pane-focused]`, `[data-pane-strip]`, `[data-tab-id]`,
  `[data-drop-preview]`, `[data-pane-separator]`) but its first green run is
  still owed. Run it with, from `apps/desktop/e2e/`:

  ```sh
  pnpm run build:app
  pnpm run test:wdio -- --spec ./specs/tab-tiling.spec.js
  ```

  It self-skips on the welcome screen, so it needs a restorable workspace in the
  isolated `com.writer-computer.e2e` profile.

## What is still owed to a human (T041)

Everything below needs eyes on a running window and is deliberately not
automated. Record results here as they are done.

- [ ] Light and dark pass over the drop preview: the 18% accent body fill and the
      denser 4 px strip bar must both read clearly against each theme's editor
      background, at the window's edges as well as its middle.
- [ ] Sidebar move isolation: a drag released over the file tree moves on disk
      only, and the same drag released over the editor opens only. Neither
      crosses over.
- [ ] Duplicate Markdown and drawing views: the same note and the same
      `.excalidraw.svg` open in two panes, edited, undone, saved, and changed
      externally; independent cursors and scroll, one save/export queue, no
      remount on a tab move.
- [ ] Malformed restore diagnostics: corrupt a v2 record in the isolated test
      profile, confirm the visible report and that the file is left untouched
      until the layout changes.
- [ ] Compact-window and Finder-drop regression pass.
- [ ] Performance: four notes of roughly 20 KB with headings and tables, typing
      and drag/resize traces compared against a single pane on the same machine.
      Record the measured document sizes and the trace results here.
- [ ] A true quit-and-relaunch restore. The automated spec reloads the webview,
      which exercises the same startup read but not process teardown.
