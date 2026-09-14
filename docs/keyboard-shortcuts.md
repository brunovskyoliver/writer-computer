# Keyboard Shortcuts

Canonical shortcut reference for Writer.

## Global

These shortcuts are handled by the global `useKeyboardShortcuts` hook and work regardless of editor focus.

| Shortcut        | Action                              |
| --------------- | ----------------------------------- |
| Cmd+P           | File search (command palette)       |
| Cmd+O           | Go to file                          |
| Cmd+N           | Create new note                     |
| Cmd+T           | New tab                             |
| Cmd+S           | Save the focused drawing            |
| Cmd+W           | Close current tab                   |
| Cmd+\\          | Toggle sidebar                      |
| Ctrl+Tab        | Next tab in the focused pane        |
| Ctrl+Shift+Tab  | Previous tab in the focused pane    |
| Cmd+1 ... Cmd+9 | Jump to Nth tab of the focused pane |
| Alt+ArrowLeft   | Navigate back                       |
| Alt+ArrowRight  | Navigate forward                    |

With the editor split into panes, tab shortcuts act on the focused pane's
strip. Focus follows the last pane clicked or typed in; there is no shortcut
to move focus between panes or to split one. Dividers between panes can be
dragged, and a focused divider (Tab to reach it) resizes with the arrow keys.

In compact single-file windows, sidebar and tab-management shortcuts do not
create hidden UI state: Cmd+\\, Cmd+T, Ctrl+Tab, Ctrl+Shift+Tab, and Cmd+1 ...
Cmd+9 are ignored. Cmd+P, Cmd+O, Cmd+N, and history navigation still work.

## Menu Accelerators

These shortcuts are bound to the native app menu (Tauri menu accelerators) rather than the global JS handler.

| Shortcut | Action                                                |
| -------- | ----------------------------------------------------- |
| Cmd+,    | Open Preferences (Settings tab) in the focused window |

## Editor Formatting

These shortcuts are handled by the `markdownFormatting` CodeMirror extension and only apply when the editor is focused.

| Shortcut                | Action                    |
| ----------------------- | ------------------------- |
| Cmd+B                   | Bold                      |
| Cmd+I                   | Italic                    |
| Cmd+K                   | Insert link               |
| Cmd+E                   | Inline code               |
| Cmd+Shift+X             | Strikethrough             |
| Cmd+Shift+8             | Bullet list               |
| Cmd+Shift+7             | Numbered list             |
| Cmd+Shift+.             | Blockquote                |
| Cmd+Shift+Enter         | Task list                 |
| Cmd+Alt+1 ... Cmd+Alt+6 | Heading 1-6               |
| Cmd+Alt+0               | Paragraph (strip heading) |

## Editor (inherited from CodeMirror)

Standard editing shortcuts provided by CodeMirror's basic setup.

| Shortcut             | Action                         |
| -------------------- | ------------------------------ |
| Cmd+Z                | Undo                           |
| Cmd+Shift+Z          | Redo                           |
| Cmd+A                | Select all                     |
| Cmd+D                | Select next occurrence         |
| Alt+ArrowUp          | Move line up                   |
| Alt+ArrowDown        | Move line down                 |
| Alt+Shift+ArrowUp    | Copy line up                   |
| Alt+Shift+ArrowDown  | Copy line down                 |
| Cmd+Shift+K          | Delete line                    |
| Cmd+Enter            | Insert line below              |
| Cmd+Shift+Enter      | Insert line above              |
| Tab                  | Indent / accept completion     |
| Shift+Tab            | Dedent                         |
| Cmd+]                | Indent more                    |
| Cmd+[                | Indent less                    |
| Cmd+F                | Find                           |
| Cmd+H                | Find and replace               |
| Cmd+G                | Find next                      |
| Cmd+Shift+G          | Find previous                  |
| Escape               | Close find                     |
| Alt+Shift+ArrowLeft  | Extend selection by word left  |
| Alt+Shift+ArrowRight | Extend selection by word right |

## Vim Mode

Off by default. Turn it on under Settings → Editor → Vim Mode, or run "Toggle Vim Mode"
from the command palette. The change applies to every open editor at once and keeps the
caret, scroll position, and undo history. Emulation comes from `@replit/codemirror-vim`;
Writer adds the setting, the footer indicator and command line, the `:w`/`:q` family, and
the clipboard bridge (`SPECs/vim-mode/spec.md`).

### Footer indicator

The document footer shows the current mode (`NORMAL`, `INSERT`, `REPLACE`, `VISUAL`,
`V-LINE`, `V-BLOCK`), any pending count or operator keys (`2d`, `"a`), and `recording @x`
while a macro records. Each pane has its own mode; the indicator follows the focused pane.
The `:` and `/` prompts open in the same footer strip. Compact windows, which normally have
no footer, get a footer strip with just the indicator and prompt while Vim mode is on.

### Vocabulary

Everything the library ships works. The groups below are what the feature is validated
against; anything outside them (Vimscript, `:map`ping `jk` to `Esc`, folds, `:e`/`:sp`)
is not supported.

| Group            | Keys                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Mode transitions | `i a I A o O R v V Ctrl+V Esc`                                                                                                       |
| Motions          | `h j k l w W b B e E ge 0 ^ $ gg G { } ( ) % f F t T ; , H M L`, with counts; `gj gk g0 g$` move by screen row in wrapped paragraphs |
| Operators        | `d c y > < = gu gU g~ ~ J` with any motion or text object; line forms `dd cc yy >> <<`; shortcuts `x X s S D C Y r p P`              |
| Text objects     | `iw aw iW aW is as ip ap`, bracket pairs `i( a( i[ a[ i{ a{ i< a<`, quotes `i" a" i' a'` and ``i` a` ``, tags `it at`                |
| Undo / repeat    | `u`, `Ctrl+R`, `.` — one Insert session is one undo step                                                                             |
| Visual           | `o` swaps ends, operators act on the selection, `gv` reselects; Visual-Block supports `I A c d y r $`                                |
| Scrolling        | `Ctrl+D Ctrl+U` half page, `Ctrl+F Ctrl+B` full page, `Ctrl+E Ctrl+Y` one line, `zz zt zb` reposition the caret line                 |
| Search           | `/` and `?` with wrap-around, `n N * #`; highlights clear on the first edit or click (`:noh` still works)                            |
| Registers        | `"a`–`"z` (append with `"A`–`"Z`), the black-hole register `"_`; the unnamed register is the system clipboard                        |
| Macros           | `q<letter>` … `q`, replay with `@<letter>`, `<count>@<letter>`, `@@`                                                                 |
| Marks            | `m<letter>`, jump with `` ` `` and `'`                                                                                               |

Registers, macros, marks, and the last search pattern are shared by every pane and window
for the session; none of them persist across restarts.

### Ex commands

`:` opens the command line in the footer; `Esc` cancels it. Unknown commands show
`Not an editor command: <name>` and do nothing else.

| Command         | Effect                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `:w`            | Save now through the app's save path (same result as Cmd+S). A failed write shows the usual save error. |
| `:q`            | Close the tab if it is clean; otherwise `E37: No write since last change (add ! to override)`.          |
| `:q!`           | Discard changes (restore the on-disk content) and close the tab.                                        |
| `:wq`, `:x`     | Save, then close the tab if the write succeeded; on failure the tab stays open.                         |
| `:s`, `:%s`     | Substitute with `g`, `i`, `c` flags and ranges including `'<,'>`; one undo step. No count is reported.  |
| `:noh`          | Clear search highlights, keep the pattern.                                                              |
| `:<n>`          | Go to line `n`.                                                                                         |
| everything else | Library-provided: `:g`, `:sort`, `:normal`, `:reg`, `:map`, `:set`, …                                   |

### Coexistence

- Every Cmd shortcut in this document keeps working in every Vim mode: the library binds
  nothing on Meta, so Cmd+B/I/K, Cmd+D, Cmd+F, Cmd+Z, Cmd+Enter, and the global hook see the
  key as before. Alt+Arrow line moves and history navigation are likewise untouched.
- Insert mode leaves `Enter`, `Tab`, `Shift+Tab`, `Backspace`, and autocomplete to the
  editor: list continuation, indent, bracket closing, and Tab-to-accept behave as with Vim
  off. `Esc` with a completion open closes the completion first.
- `Esc` in Normal mode is consumed by Vim and reaches no app UI: the sidebar, find overlay,
  section rail, and compact-window dismiss are untouched.
- Table cells, mermaid editors, and drawing widgets keep their own keys; Vim applies only
  to the markdown text.
- Prosemark hides markup (`**`, `#`, link URLs) but the document still contains it, so
  `h`/`l`/`w` and the operators step over the hidden characters, as in Obsidian's Vim mode.
