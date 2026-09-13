# Research: Vim Mode

All "NEEDS CLARIFICATION" items from the Technical Context are resolved below. Facts about
the library were read from the published package (`@replit/codemirror-vim@6.4.0`,
`@replit/codemirror-vim-core@0.1.0`), not from memory.

## R1. Which Vim emulation library

**Decision**: `@replit/codemirror-vim` 6.4.0.

**Rationale**: it is the only maintained Vim emulation for CodeMirror 6, it is the CM5
Vim keymap ported (so it carries fifteen years of coverage: motions, operators, counts,
text objects incl. `it`/`at`/`ip`/`is`, Visual/Visual-Line/Visual-Block with `I`/`A`/`c`,
`Ctrl+D/U/F/B/E/Y`, `zz`/`zt`/`zb`, `gj`/`gk`, search with `*`/`#`/`n`/`N`, `:s` with
`g`/`i`/`c` flags and `'<,'>` ranges, `:noh`, `:g`, `:sort`, `:normal`, registers a–z /
A–Z / `_` / `+`, macros `q`/`@`/`@@`, marks, `.`, `gv`, `Ctrl+R`). Its peer deps are the
five `@codemirror/*` packages Writer already ships. It is used in production by Replit and
Obsidian-adjacent CM6 editors. Every FR-010 – FR-027 item was checked against the keymap
table in `vim-core/vim.js` and is present.

**Alternatives considered**:

- Hand-written modal layer — rejected per constitution VI and the user's instruction.
- `codemirror-vim` forks on npm — unmaintained or pinned to CM 6.0 betas.
- Monaco-vim / vim-monaco — wrong editor engine.

## R2. Turning the mode on and off live, per view, with zero cost when off

**Decision**: a `Compartment` per `EditorView`, placed **first** in the extension list
(the README requires `vim()` before all other keymaps). A `ViewPlugin` created alongside
it subscribes to `useSettingsStore` on construction, reconfigures its own compartment when
`editor.vim-mode` changes, and unsubscribes on destroy. The library is loaded with a
dynamic `import()` on the first enable; the reconfigure runs after the import resolves and
re-reads the setting so a fast on→off flip cannot leave a stale enable.

**Rationale**: one write path per view, no global registry to keep in sync, and nothing
runs on the typing path when the compartment is empty. Reconfiguring a compartment keeps
document, selection, scroll and the other state fields intact (FR-003, SC-006) — the
history compartment already proves this works here. Lazy import keeps the ~300 KB engine
out of startup for users who never enable it (SC-004).

**Alternatives considered**:

- Module-level subscription iterating `editor-views.ts` registrations — a second place
  that needs to know about every view; the per-view plugin is smaller and cannot miss a
  view mounted between subscribe and reconfigure.
- Static import — simpler, but SC-004 asks that the off path is unchanged, bundle included.

## R3. Rendering the mode indicator and the `:` / `/` prompt in the footer

**Findings**: the library offers two panel modes. `vim({ status: true })` mounts its own
CodeMirror bottom panel and writes `--NORMAL--` plus the dialog into `cm.state.statusbar`,
overwriting that element's children on every keypress. `vim()` (default) mounts a panel
only while a dialog is open, appending `cm.state.dialog` to it. Either way the UI lives
inside the editor, not in Writer's footer. Prompts (`:`, `/`, `?`, `:s///c`) and
notifications ("Not an editor command", substitution counts, "recording @a") are all DOM
nodes created by the library and announced through a `dialog` event on the CM5 adapter;
`openDialog` calls `input.focus()` synchronously right after that signal.

**Decision**:

- Use `vim()` (no built-in status) and hide its transient panel with an
  `EditorView.theme` rule `.cm-vim-panel { display: none }` at high precedence.
- Register a `dialog` handler on the adapter after the plugin's own. When
  `cm.state.dialog` is non-null, `appendChild` it into the **dialog host** — a `div` the
  mounted `DocumentFooter` registers in `vim-store` via a layout effect. `appendChild`
  moves the node, so it leaves the hidden panel and lands in the footer before the
  library's `focus()` runs (event handlers fire synchronously in registration order).
- Mirror mode into `vim-store` from `vim-mode-change` (`{mode, subMode}`), pending keys
  from `vim-keypress` (read `cm.state.vim.status`, which the plugin accumulates and clears
  on `vim-command-done`), and recording state from
  `Vim.getVimGlobalState_().macroModeState.isRecording` on `vim-command-done`.
- The footer renders the label from a single map:
  `normal→NORMAL, insert→INSERT, replace→REPLACE, visual→VISUAL, visual linewise→V-LINE,
visual blockwise→V-BLOCK`, in the footer's existing `text-[13px] text-[var(--text-muted)]`
  style. Library-generated nodes get `[data-vim-dialog-host] .cm-vim-message { color:
inherit }` and `input { font: inherit; background: transparent; outline: none }` so the
  inline `color: red` the library sets on error messages is overridden (SC-007).

**Rationale**: full control of typography with zero reimplementation of prompt input
handling (history, `Esc`, `Enter`, `c`-flag confirm loop stay the library's).

**Alternatives considered**:

- `status: true` with CSS restyling — `updateStatus` rewrites the container on every key,
  so the mode label would be the library's `--NORMAL--` span; clashing with SC-007.
- Overriding `cm.openDialog`/`cm.openNotification` on the adapter instance — would force
  a reimplementation of the prompt's key handling.
- Rendering a React `<input>` and forwarding to `Vim.handleKey` — same problem.

## R4. `:w`, `:q`, `:q!`, `:wq`, `:x` against an autosaving app

**Findings**: Writer has no Cmd+S. Edits mark the file dirty and `scheduleSave` writes
within a 1 s throttle; `closeTab` keeps a dirty file in `openFiles` until the pending save
lands, so closing never loses data. `reloadFromDisk(path, rawContent)` cancels a pending
save and replaces the buffer with a given disk image. The library's built-in `:write`
calls `CodeMirror.commands.save` if defined (it is not); `:q` is not defined at all.

**Decision** (registered once, at module init of `vim-ex-commands.ts`, via `Vim.defineEx`):

| Command   | Behaviour                                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `w`       | `saveNow(path)` — new export on `lib/save.ts` that runs `performSave` immediately, bypassing the throttle. Errors go through the existing `setSaveError` path. |
| `q`       | If `file.isDirty` and the buffer differs from `diskContent` → notification `E37: No write since last change (add ! to override)`. Else `closeTab(tabId)`.      |
| `q!`      | `reloadFromDisk(path, file.diskContent)` (cancels the pending save, restores the disk image) then `closeTab(tabId)`.                                           |
| `wq`, `x` | `await saveNow(path)`; on success `closeTab(tabId)`; on failure leave the tab open (the save error is already surfaced).                                       |

`cm.cm6` is the `EditorView`; a new `getEditorRegistrationForView(view)` on
`lib/editor-views.ts` resolves `tabId` and `path`. `Vim.defineEx('write','w', …)` replaces
the library's default entry, so `:w` also lands here.

**Rationale**: honours the spec's Vim semantics (spec §User Story 2) without inventing a
second save engine; `:q!` is the only path that discards, and it reuses an existing store
action.

**Alternatives considered**: making `:q` always close (autosave makes "dirty" nearly
transient) — rejected because the spec pins the refusal, and the window where an
`:q` would otherwise race a pending write is real.

## R5. Clipboard ↔ unnamed register

**Findings**: the engine only touches the system clipboard for the explicit `"+` register
(`navigator.clipboard.writeText/readText`). The unnamed register is in-memory. `p` is
synchronous, so it cannot await a clipboard read.

**Decision** (in `vim-mode.ts`, one bridge shared by all views):

- After every `vim-command-done`, compare `Vim.getRegisterController().unnamedRegister
.toString()` with the last mirrored value; if changed, `writeText` it via
  `@tauri-apps/plugin-clipboard-manager` (already a dependency; the app never uses
  `navigator.clipboard` on WKWebView).
- Before `p`/`P` can run, the register must already hold the system text. Refresh it on
  `window` `focus` (returning from another app) and on the editor's DOM `copy`/`cut`
  events (Cmd+C/X inside Writer) by `readText()` → `unnamedRegister.setText(text)`,
  guarded by the same last-mirrored value so a Vim yank does not get overwritten by its own
  echo.

**Rationale**: gives FR-024 interop for the common cases (yank then Cmd+V elsewhere; copy
elsewhere then `p`) without patching the engine. The read is async but happens on events
that precede any `p` by human-scale time.

**Alternatives considered**: mapping `p`→`"+p` and `y`→`"+y` with `Vim.map` — breaks
operators (`dd`, `x`, `ciw` would no longer feed the register the user pastes from) and
`"+p` is itself async in the engine.

## R6. Coexistence with Writer's keymaps and hidden markup

**Findings**: `vimKeyFromEvent` prefixes Meta as `<M-…>`; no default binding uses it, so
`handleKey` returns false and Cmd chords fall through to the app (`markdownFormatting`,
Cmd+D, Cmd+F, the global hook) — FR-028 holds without work. In Insert mode the plugin
consumes only mapped keys; `Enter`/`Tab`/`Shift+Tab`/`Backspace` reach prosemark's
`listExtension` and `closeBrackets` as today (FR-029). When Vim handles a key it calls
`stopPropagation`, so `Esc` in Normal mode never reaches `window` listeners
(`useEscKey`, compact-mode dismiss) — FR-030 holds. The search overlay's own `Escape`
keymap sits after `vim()` and is reached only when Vim declines the key (Insert mode
without pending state), matching the spec's "first Esc dismisses completion" case.

Prosemark hides syntax (`**`, `#`, link URLs) but the document still contains it; Vim's
`h`/`l`/`w` step over hidden characters exactly as Obsidian's Vim mode does. The
`headingSelectionGuard` transaction filter still clamps every Vim-dispatched selection.

**Decision**: no key remapping. Accept the hidden-markup stepping as standard behaviour
for a CM-based Vim; document it in `docs/keyboard-shortcuts.md`.

## R7. Caret, selection and search-match styling

**Findings**: the plugin draws a `.cm-fat-cursor` block in Normal/Visual and hides the
native `.cm-cursorLayer` under `.cm-vimMode`. Visual selections use CM's normal
`.cm-selectionBackground` (already themed to `--editor-selection-bg`). Vim search reuses
`@codemirror/search`'s `setSearchQuery` with a `forVim` flag and decorates with
`.cm-searchMatch`, the same class Writer's find uses.

**Decision**: add `.cm-fat-cursor { background: var(--accent); color: var(--background) }`
to `prosemark-theme.css` next to the existing caret rule; nothing else. FR-009, FR-014 and
the search-colour assumption are satisfied by existing theme variables.

## R8. Per-pane mode vs. app-wide session state

**Findings**: `cm.state.vim` (mode, pending keys, marks) is per adapter, i.e. per
`EditorView`; `vimGlobalState` (registers, macros, last search, last substitute, jump
list) is a module singleton shared by every view. That is exactly the split FR-008 /
FR-027 ask for.

**Decision**: `vim-store` is keyed by `tabId`; entries are created on plugin construction
and deleted on destroy. No session-state store is needed — the engine owns it.

## R9. Testing without a DOM

**Findings**: Vitest runs in `environment: "node"`. Mounting the vim plugin needs a real
`EditorView`; the library's own suite covers that.

**Decision**: test what Writer owns with injected dependencies:

- `vim-store`: label mapping, set/clear per tab, dialog host registration.
- `vim-ex-commands`: each command against a fake `{ getOpenFile, saveNow, closeTab,
reloadFromDisk, notify }` — dirty/clean × `q`/`q!`/`wq`, save failure keeps tab open.
- `lib/save.ts` `saveNow`: writes immediately and clears the dirty flag (extends
  `tests/save.test.ts`).

End-to-end key behaviour is verified manually per `quickstart.md` (and with the
`apps/desktop:verify` harness where practical), not re-tested in unit tests (constitution
VI: do not over-test UI).
