# Named course layouts in one vault

## Scope

Replace the Course Workspaces plugin's layout switching: several saved tab and pane arrangements inside one vault.
The plugin and SDU vault were read only.

## Design

- A layout is a session record in `sessions.json` under `<root>#layout:<name>`, reusing `save_session` and
  `load_session` validation and pruning. No Rust change.
- Names and the active name live in the `workspace:<root>:layouts` preference, so the active layout survives restart.
- These calls go straight to `tauri.*`: layouts are explicit user data and work with "restore open files" turned off.
- Opening freezes input, saves all buffers, stores the active layout, loads the target, and only then resets the
  window. A missing or unreadable target leaves the window alone and shows a notice.
- Names can't be empty or contain `/`, because `session_key` trims trailing slashes.

## Verification

Native audit build, disposable vault (`layouts-native.json`, `layout-math.png`, `layout-physics.png`,
`layout-palette.png` in `~/agent-runs/2026-10-29-writer-audit/`):

- Save two layouts from the palette and switch between them, using real Cmd+P and Cmd+T keystrokes.
- A tab added to the active layout is still there after switching away and back.
- Text typed just before a switch reaches disk.
- After quit and relaunch: same tabs, both names listed, Math marked current.
- A file deleted between runs is dropped from its layout on open.
- Delete removes the record from `sessions.json`.

`tests/workspace-layouts.test.ts` covers switching with restore off, a missing target, delete and bad names.
Totals: 1,826 frontend and 306 Rust tests, `vp check` 0 errors and 10 existing warnings.

## Limits

- Opening a layout while none is active replaces the current arrangement without saving it.
- Saved layouts aren't rewritten when files move, so a moved note drops out of inactive layouts on next open.
- Split panes in a layout use the session codec's existing coverage and weren't driven in this run.
- There is no rename, and delete doesn't ask for confirmation.
- Save Layout as appears only once text is typed, so typing "save layout" offers a layout with that name.
