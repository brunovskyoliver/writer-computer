# Quickstart: validating Vim Mode

Contracts: [contracts/vim-mode.md](./contracts/vim-mode.md). Entities:
[data-model.md](./data-model.md).

## Prerequisites

```sh
vp install                       # picks up @replit/codemirror-vim
vp check && vp test              # must be green before and after
cd apps/desktop && vp run dev    # or the apps/desktop:verify harness
```

Open any workspace with a note of a few hundred lines; for the performance checks use a
10,000-line note (generate one with `yes "lorem ipsum dolor sit amet" | head -10000 >
big.md` inside the workspace).

## Automated checks

| Test file                       | Proves                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tests/settings-schema.test.ts` | `editor.vim-mode` exists, is boolean, defaults to `false` (extend the existing schema assertions).                           |
| `tests/vim-store.test.ts`       | mode/subMode → label map; entries create/update/delete per tab; footer model is `null` when absent.                          |
| `tests/vim-ex-commands.test.ts` | `:q` refuses dirty, closes clean; `:q!` restores disk image then closes; `:wq` closes only on success; `:w` calls `saveNow`. |
| `tests/save.test.ts`            | `saveNow` bypasses the throttle and resolves `false` on write failure.                                                       |

Run: `vp test`.

## Manual scenarios (map to spec acceptance scenarios)

### Story 1 — toggle and modal loop

1. Settings → Editor → **Vim Mode** on. Footer shows `NORMAL`; caret becomes a block.
2. `j`, `k`, `w`, `b`, `0`, `$`, `gg`, `G` move without inserting. `5j` moves five lines.
3. `i`, type `hello`, `Esc`: text inserted; footer read `INSERT` while typing; caret ends
   one column left.
4. `dd` then `u` then `Ctrl+R`; `.` repeats the last change; tab dirty marker follows.
5. Cmd+P → **Toggle Vim Mode**: indicator disappears, `j` inserts `j`, caret and scroll
   unchanged. Toggle back on. Repeat ten times (SC-006).
6. Quit and relaunch: setting persists (Scenario 7).

### Story 2 — Ex commands

1. Edit, `:w` Enter → dirty marker clears immediately (not after the 1 s throttle);
   `cat` the file to confirm.
2. Edit, `:q` Enter → footer shows `E37: No write since last change`, tab stays.
3. `:q!` Enter → tab closes; file on disk unchanged from step 1.
4. Edit, `:wq` Enter → saved and tab closed. Same with `:x`.
5. `:` then `Esc` → prompt closes, mode `NORMAL`, nothing happened.
6. `:foo` Enter → `Not an editor command: foo`.
7. Make the file read-only (`chmod 444`), `:w` → existing save-error surface appears, tab
   stays dirty. `chmod 644` afterwards.

### Story 3 — search and substitute

1. `/word` Enter → jumps to next match, matches highlighted in the find colour; `n`/`N`;
   `?` backwards; `*` and `#` on a word.
2. `:%s/word/term/g` → all replaced, footer reports the count, single `u` reverts.
3. `V` `j` `j` `:` (prompt pre-fills `'<,'>`) `s/a/b/g` Enter → only those lines change.
4. `:%s/a/b/gc` → `y`/`n`/`a`/`q` honoured.
5. `:noh` → highlights gone; `n` still works.

### Story 4 — visual modes and scrolling

1. `V` `j` `d` → two lines deleted; footer read `V-LINE`.
2. `Ctrl+V` `j` `j` `I` `- ` `Esc` → three lines prefixed; footer read `V-BLOCK`.
3. `v` + motion shows the app's selection colour; `d`/`y`/`c` act on it; `o` swaps ends;
   `gv` reselects.
4. On `big.md`: `Ctrl+D`/`Ctrl+U`, `Ctrl+F`/`Ctrl+B`, `Ctrl+E`/`Ctrl+Y`, `zz`/`zt`/`zb`.

### Story 5 — macros, registers, marks, text objects

1. On line 1: `qa` `A` `.` `Esc` `j` `q`; footer shows `recording @a` while recording.
   `3@a` → lines 2–4 end with `.`. `@@` repeats once more.
2. `"ayy`, move, `"ap` — named register; `yy` elsewhere, `"ap` still pastes the old text.
3. `ma`, edit lines above, `` `a `` returns to the marked spot.
4. `ciw`, `dap`, `yi"`, `da(`, `dit` inside `<b>x</b>`.

### Coexistence and edge cases

- Cmd+B/I/K, Cmd+D, Cmd+F, Cmd+Z, Cmd+Enter, Alt+Arrow all work in every mode (FR-028).
- Insert mode: `Enter` continues a list, `Tab` indents it, autocomplete accepts on Tab;
  `Esc` with a completion open closes the completion first (FR-029).
- `Esc` in Normal mode closes nothing (sidebar, find overlay, section rail untouched).
- Yank `yy`, switch to another app, Cmd+V pastes it. Copy text in another app, come back,
  `p` pastes it (FR-024).
- Open the same note in two panes: `i` in one pane leaves the other in `NORMAL`; a `yy`
  in one pastes with `p` in the other (FR-008, FR-027).
- Click into a table cell or mermaid editor widget: keys behave as before (FR-004).
- Toggle Vim off while `:` prompt is open and while recording a macro: prompt disappears,
  indicator disappears, typing works.

### Performance (SC-003, SC-004, SC-005)

1. `big.md`, Vim on, Insert mode: hold a key for 3 s; no dropped frames in the WebKit
   timeline (or subjectively no lag vs. Vim off).
2. `:%s/lorem/LOREM/g` on `big.md` completes under 1 s; one `u` reverts.
3. Vim off: `vp build`, confirm `@replit/codemirror-vim` is in a separate chunk not loaded
   on startup (Network tab or `dist/assets` listing).

## Expected outcome

Every scenario above behaves as described, `vp check` and `vp test` are green, and the
docs/changelog entries listed in the contracts are present.
