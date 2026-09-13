# Feature Specification: Vim Mode

**Feature Branch**: `vim-mode` (intended; not yet created — work is currently on `excalidraw-embed`)

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "i would like to add vim support and toggle in the settings.. support commands like :w, :wq, substitute, search, macros, shift+v, ctrl+v, ctrl+u, ctrl+d, gg, G and basically all the stuff.. please use... match the styling and feel of the app.. performance is important also.. you can use some third party dependancy for this if you can find one.. do not reinvent the wheel.."

## Overview

Writer's editor today is a conventional modeless text editor: every key inserts text, and
navigation and editing use Cmd/Alt chords. This feature adds an optional Vim editing mode.
When a user turns it on in Settings, every markdown editor in the app becomes modal: it
starts in Normal mode, `i`/`a`/`o` enter Insert mode, `Esc` returns to Normal, and the
familiar Vim vocabulary — motions, operators, counts, text objects, Visual/Visual-Line/
Visual-Block selection, search, substitute, registers, macros, marks, dot-repeat and Ex
commands such as `:w` and `:wq` — works the way a Vim user expects.

The mode is off by default, so users who never asked for Vim see no change. When it is on,
the current mode is shown in the document footer in the app's own visual language, and Vim's
command line (`:`, `/`, `?`) appears in that same footer rather than as a foreign overlay.

The goal is breadth of Vim coverage with no perceptible cost to typing or scrolling. The
user has explicitly asked that this be built on an existing, maintained Vim emulation rather
than a hand-written one; the spec therefore describes the expected behaviour and leaves the
choice of that dependency to planning.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Turn Vim mode on and edit modally (Priority: P1)

A Vim user opens Settings, switches "Vim mode" on, and returns to their note. The editor is
now in Normal mode: `hjkl` and `w`/`b`/`e`/`0`/`$`/`gg`/`G` move the caret, `i` starts
inserting, `Esc` stops, `dd` deletes a line, `yy`/`p` copies and pastes it, `u` undoes and
`Ctrl+R` redoes, `.` repeats the last change. The footer says which mode they are in. They
switch the setting off again and the editor is back to normal behaviour with nothing lost.

**Why this priority**: The toggle plus the core modal loop (Normal/Insert, basic motions,
operators, undo) is the smallest thing that is a usable Vim editor. Everything else layers
on top of it.

**Independent Test**: Enable the setting, open a note, perform `i`, type text, `Esc`, `dd`,
`u`, `.`, `gg`, `G`; each has its Vim effect and the footer shows the current mode. Disable
the setting; the same keys insert text as before.

**Acceptance Scenarios**:

1. **Given** Vim mode is off, **When** the user presses `j` in a note, **Then** the letter
   `j` is inserted and no mode indicator is shown.
2. **Given** Vim mode is on and the editor is in Normal mode, **When** the user presses `j`,
   **Then** the caret moves down one line and no text is inserted.
3. **Given** Vim mode is on, **When** the user presses `i`, types `hello`, presses `Esc`,
   **Then** `hello` is inserted, the footer shows Insert while typing and Normal after
   `Esc`, and the caret is one column to the left of where it was when `Esc` was pressed.
4. **Given** Vim mode is on and the caret is on a non-empty line, **When** the user presses
   `dd` then `u`, **Then** the line is deleted and then restored, and the document's dirty
   state reflects the net change.
5. **Given** Vim mode is on with a 3-line note, **When** the user presses `G` then `gg`,
   **Then** the caret moves to the last line, then to the first line.
6. **Given** Vim mode is on, **When** the user turns the setting off, **Then** every open
   editor in every pane and window returns to modeless behaviour immediately, the mode
   indicator disappears, and any text or caret position is unchanged.
7. **Given** the user enabled Vim mode and quits Writer, **When** they relaunch it, **Then**
   Vim mode is still on.

---

### User Story 2 - Save and close with Ex commands (Priority: P1)

The user finishes editing, presses `:`, sees a command line in the footer, types `w` and
presses Enter. The note is saved exactly as if they had pressed Cmd+S. Later they type `:wq`
and the note saves and its tab closes. `:q` closes a clean tab, refuses a dirty one with a
message, and `:q!` closes it discarding changes.

**Why this priority**: `:w`/`:wq` were named first by the user and are the muscle-memory
commands a Vim user reaches for dozens of times a session. Without them the mode feels
broken even if every motion works.

**Independent Test**: Make an edit, `:w`, confirm the file on disk changed and the tab is
no longer dirty. `:wq` on another dirty tab saves and closes it. `:q` on a dirty tab shows a
refusal; `:q!` closes it without saving.

**Acceptance Scenarios**:

1. **Given** a dirty note in Vim Normal mode, **When** the user types `:w` and Enter,
   **Then** the note is written to disk through the app's normal save path, the tab's dirty
   marker clears, and the command line closes.
2. **Given** a dirty note, **When** the user types `:wq` (or `:x`) and Enter, **Then** the
   note is saved and its tab closes.
3. **Given** a dirty note, **When** the user types `:q` and Enter, **Then** the tab stays
   open and the footer shows a short message that there are unsaved changes.
4. **Given** a clean note, **When** the user types `:q` and Enter, **Then** the tab closes.
5. **Given** a dirty note, **When** the user types `:q!` and Enter, **Then** the tab closes
   and the on-disk file is unchanged.
6. **Given** the command line is open, **When** the user presses `Esc`, **Then** the command
   line closes with no action taken and the editor is back in Normal mode.
7. **Given** the command line is open, **When** the user types an unknown command and Enter,
   **Then** the footer shows a "not an editor command" style message and nothing else
   changes.

---

### User Story 3 - Search and substitute (Priority: P2)

The user presses `/`, types a word, presses Enter; the caret jumps to the next match and
`n`/`N` step through matches. `*` and `#` search for the word under the caret. `:%s/old/new/g`
replaces every occurrence in the note; `:s/old/new/` replaces on the current line; with a
Visual selection, `:'<,'>s/…` applies only to the selected lines; the `c` flag asks before
each replacement. `:noh` clears highlights.

**Why this priority**: Search and substitute are the second thing the user listed and the
main way Vim users navigate and bulk-edit prose. They depend on Story 1 being in place.

**Independent Test**: In a note with three occurrences of a word, `/word` + Enter lands on
the first after the caret, `n` twice visits the others, `:%s/word/term/g` replaces all three.

**Acceptance Scenarios**:

1. **Given** Vim mode is on, **When** the user presses `/`, types a pattern and Enter,
   **Then** the caret moves to the next match after the caret position, wrapping to the top
   if needed, and matches are highlighted.
2. **Given** a completed search, **When** the user presses `n` / `N`, **Then** the caret moves
   to the next / previous match; `?` searches backward with the same behaviour.
3. **Given** the caret is on a word, **When** the user presses `*`, **Then** the caret moves
   to the next whole-word occurrence of that word.
4. **Given** a note with several matches, **When** the user runs `:%s/old/new/g`, **Then**
   every match is replaced in a single undoable step and the footer reports how many
   substitutions were made.
5. **Given** a Visual-Line selection of three lines, **When** the user presses `:` and
   completes `s/old/new/g`, **Then** only those three lines are affected.
6. **Given** `:%s/old/new/gc`, **When** the user answers `y`, `n`, `a`, `q` at each prompt,
   **Then** each answer is honoured as in Vim.
7. **Given** search highlights are visible, **When** the user runs `:noh`, **Then** the
   highlights are removed and the search pattern is retained for `n`.

---

### User Story 4 - Visual modes and scrolling (Priority: P2)

The user presses `Shift+V` to select whole lines, extends the selection with `j`, and presses
`d` or `y`. They press `Ctrl+V` to select a rectangular block and `I`/`A`/`c` to edit every
line of the block at once. `v` selects by character. `Ctrl+D`/`Ctrl+U` scroll half a screen,
`Ctrl+F`/`Ctrl+B` a full screen, `Ctrl+E`/`Ctrl+Y` one line, `zz`/`zt`/`zb` reposition the
current line. The selection highlight uses the app's existing selection colour.

**Why this priority**: The user named `Shift+V`, `Ctrl+V`, `Ctrl+U`, `Ctrl+D` explicitly.
These are daily-use commands but are meaningful only once Story 1 exists.

**Independent Test**: `Shift+V` `j` `j` `d` deletes three lines; `Ctrl+V` `j` `j` `I` `- `
`Esc` prefixes three lines with `- `; `Ctrl+D` moves the viewport about half a screen.

**Acceptance Scenarios**:

1. **Given** Normal mode, **When** the user presses `Shift+V` then `j` then `d`, **Then**
   two whole lines are deleted and the footer showed "V-LINE" while selecting.
2. **Given** Normal mode, **When** the user presses `Ctrl+V`, moves down two lines, presses
   `I`, types `- ` and `Esc`, **Then** all three lines gain the `- ` prefix at that column.
3. **Given** Normal mode, **When** the user presses `v` and a motion, **Then** a character-
   wise selection is shown using the app's selection colour and an operator acts on it.
4. **Given** a note longer than the viewport, **When** the user presses `Ctrl+D`, **Then**
   the caret and viewport move down about half a viewport; `Ctrl+U` moves them back up.
5. **Given** a note longer than the viewport, **When** the user presses `zz`, **Then** the
   caret's line is vertically centred in the viewport.
6. **Given** any Visual mode, **When** the user presses `Esc`, **Then** the selection is
   dropped and the editor returns to Normal mode.

---

### User Story 5 - Macros, registers, marks, repeat (Priority: P3)

The user presses `qa`, performs a sequence of edits, presses `q`, and then `@a` replays it;
`5@a` replays it five times and `@@` repeats the last macro. `"ayy` yanks into register `a`
and `"ap` pastes it. `ma` sets a mark and `` `a ``/`'a` jumps back. Counts work everywhere:
`3dd`, `2w`, `d3w`. Text objects work: `ciw`, `dap`, `yi"`, `da(`.

**Why this priority**: The user asked for macros by name and "basically all the stuff".
These complete the Vim vocabulary but are used less often than the stories above.

**Independent Test**: Record `qa` `A` `.` `Esc` `j` `q` on line 1 and run `3@a`; lines 1–4
each end with a period.

**Acceptance Scenarios**:

1. **Given** Normal mode, **When** the user records a macro with `q<letter>` … `q` and
   replays it with `@<letter>`, **Then** the same edits are applied from the current caret
   position; the footer shows a "recording" indicator while recording.
2. **Given** a recorded macro, **When** the user presses `<count>@<letter>`, **Then** it is
   replayed that many times, and replay stops early if a motion fails as in Vim.
3. **Given** Normal mode, **When** the user yanks with `"<letter>y…` and pastes with
   `"<letter>p`, **Then** the named register is used and the default register is untouched.
4. **Given** a mark set with `m<letter>`, **When** the user presses `` `<letter> ``, **Then**
   the caret returns to the marked position even after the mark's line has moved.
5. **Given** a count before an operator or motion, **When** it is executed, **Then** it
   repeats that many times (`3dd`, `2w`, `d3w`, `5j`).
6. **Given** the caret inside a word, quoted string, parentheses or paragraph, **When** the
   user uses the corresponding text object with an operator, **Then** exactly that object
   is affected.

---

### Edge Cases

- Vim mode is on and the caret is inside an embedded widget (table cell, diagram, drawing
  page): the widget keeps its own interaction; Vim keys apply only when the plain markdown
  text editor has focus.
- A document is open in two panes or two windows at once: each pane has its own mode and
  its own pending keys; entering Insert in one pane does not change the other's mode.
  Registers, macros and the last search pattern are shared app-wide, as in one Vim session.
- The user presses `Esc` in Normal mode: nothing changes (it must not close the tab, the
  find panel, or the sidebar).
- The user opens the app's own Find (Cmd+F) while Vim mode is on: the app's find panel
  works as today; Vim's `/` search is separate and neither breaks the other.
- Existing Cmd shortcuts (Cmd+S, Cmd+Z, Cmd+D, Cmd+P, Cmd+F, Cmd+Enter, Alt+Arrow…) keep
  working in every Vim mode; Vim only claims keys that the modeless editor treated as text
  input or that are listed in this spec (`Ctrl+D/U/F/B/E/Y/R/V/W` and friends).
- A macro or `:%s` runs on a very large note: the edit is one undo step and the UI does not
  freeze for more than a moment.
- `:w` on a note that fails to save (permission denied, disk gone): the same error surface
  the app already uses for Cmd+S is shown; the tab stays dirty.
- `:wq` while the file has been changed on disk by another program: the existing reload/
  conflict flow runs first, exactly as for Cmd+S followed by closing the tab.
- The user toggles the setting while the command line is open or a macro is recording: the
  pending state is discarded and the editor returns to modeless input cleanly.
- Insert mode with the app's autocomplete or list-continuation active: `Enter` and `Tab`
  behave as they do today (list continuation, indent, completion accept); `Esc` in Insert
  first dismisses an open completion and a second `Esc` returns to Normal.
- Soft-wrapped long paragraphs: `j`/`k` move by logical line, so one press skips a whole
  wrapped paragraph; `gj`/`gk` move by screen row (standard Vim).
- Mode indicator in compact mode / when the footer is hidden by a setting: the indicator
  is shown wherever the footer would be, and the command line still has somewhere to
  render; it must never be invisible while Vim mode is on.

## Clarifications

### Session 2026-09-13

- Q: On soft-wrapped paragraphs, should `j`/`k` move by logical line (standard Vim) or by screen row? → A: Standard Vim — `j`/`k` move by logical line; `gj`/`gk` move by screen row.

## Requirements _(mandatory)_

### Functional Requirements

**Setting and lifecycle**

- **FR-001**: The Settings panel MUST offer a "Vim mode" on/off control, off by default,
  styled like the existing boolean settings.
- **FR-002**: The setting MUST persist across restarts and apply to every window and pane.
- **FR-003**: Changing the setting MUST take effect immediately in all open editors without
  reopening documents, losing text, or resetting caret/scroll position.
- **FR-004**: Vim mode MUST apply only to the plain markdown text editor; embedded widgets
  (tables, diagrams, drawings) keep their current interaction.
- **FR-005**: The command palette MUST expose "Toggle Vim mode".

**Modes and indicator**

- **FR-006**: With Vim mode on, editors MUST start in Normal mode and support Normal,
  Insert, Replace, Visual, Visual-Line and Visual-Block modes with standard Vim transitions
  (`i a I A o O R v V Ctrl+V Esc`).
- **FR-007**: The document footer MUST show the current mode (`NORMAL`, `INSERT`, `VISUAL`,
  `V-LINE`, `V-BLOCK`, `REPLACE`), pending operator/count keys, and a recording indicator
  while a macro is being recorded, using the app's existing footer typography and colours.
- **FR-008**: Mode per editor pane MUST be independent; the indicator reflects the focused
  pane.
- **FR-009**: The caret MUST be visually distinct between Normal (block) and Insert (bar)
  modes, using the app's caret colour.

**Motions, operators, counts, text objects**

- **FR-010**: The system MUST support standard motions: `h j k l w W b B e E ge 0 ^ $ gg G
{ } ( ) % f F t F ; , H M L`, with counts, plus `gj`/`gk`/`g0`/`g$` for screen rows.
- **FR-011**: The system MUST support operators `d c y > < = gu gU g~ ~ J` combined with
  any motion or text object, with counts, plus line forms `dd cc yy >> <<` and shortcuts
  `x X s S D C Y r p P`.
- **FR-012**: The system MUST support text objects `iw aw iW aW is as ip ap i( a( i[ a[
i{ a{ i< a< i" a" i' a' i\` a\``and`it at`.
- **FR-013**: `u` MUST undo, `Ctrl+R` redo, and `.` repeat the last change; undo steps MUST
  match Vim's granularity (one Insert session is one step).

**Visual and scrolling**

- **FR-014**: Visual selections MUST use the app's selection colour; `o` swaps ends,
  operators act on the selection, `gv` reselects.
- **FR-015**: Visual-Block MUST support `I`, `A`, `c`, `d`, `y`, `r`, `$` across the block.
- **FR-016**: `Ctrl+D`/`Ctrl+U` MUST scroll half a viewport, `Ctrl+F`/`Ctrl+B` a full
  viewport, `Ctrl+E`/`Ctrl+Y` one line, and `zz`/`zt`/`zb` reposition the caret line.

**Search and substitute**

- **FR-017**: `/` and `?` MUST open a search prompt in the footer, search forward/backward
  with wrap-around, highlight matches, and support `n`, `N`, `*`, `#`.
- **FR-018**: `:s`, `:%s` and ranged forms (including `'<,'>`) MUST perform substitution
  with flags `g`, `i`, `c`; the whole substitute MUST be one undo step and the footer MUST
  report the substitution count.
- **FR-019**: `:noh` MUST clear search highlights without clearing the pattern.

**Ex commands**

- **FR-020**: `:` MUST open a command line in the footer. Supported commands: `w`, `q`,
  `q!`, `wq`, `x`, `s`, `noh`, `<number>` (go to line), `nohlsearch`. `w` MUST use the
  app's normal save path (same result as Cmd+S); `q` MUST close the current tab, refusing
  with a message if the note is dirty; `q!` MUST close discarding changes; `wq`/`x` MUST
  save then close.
- **FR-021**: Unknown commands MUST show a message in the footer and do nothing else.
- **FR-022**: `Esc` MUST cancel the command line or search prompt.

**Registers, macros, marks**

- **FR-023**: Named registers `a`–`z` (and appending `A`–`Z`), the default register, and
  the black-hole register `_` MUST work with `"` for yank/delete/paste.
- **FR-024**: Yank and paste with the default register MUST go through the system clipboard
  so Vim yanks and Cmd+C/Cmd+V interoperate.
- **FR-025**: Macros MUST be recorded with `q<letter>`, stopped with `q`, replayed with
  `@<letter>`, `<count>@<letter>` and `@@`.
- **FR-026**: Marks MUST be set with `m<letter>` and jumped to with `` ` `` and `'`,
  surviving edits above the mark.
- **FR-027**: Registers, macros, marks and the last search pattern MUST be shared across all
  panes and windows of the app for the session.

**Coexistence**

- **FR-028**: All shortcuts in `docs/keyboard-shortcuts.md` that use Cmd MUST keep working
  in every Vim mode.
- **FR-029**: In Insert mode, `Enter`, `Tab`, `Shift+Tab` and autocomplete MUST behave as
  they do with Vim mode off (list continuation, indent, accept completion).
- **FR-030**: `Esc` in Normal mode MUST be a no-op with respect to app UI (no closing tabs,
  panels, or dialogs).

**Performance**

- **FR-031**: Enabling Vim mode MUST NOT add perceptible latency to typing in Insert mode,
  scrolling, or opening documents.
- **FR-032**: When Vim mode is off, no Vim-related work MUST run on the typing or rendering
  path.

**Documentation**

- **FR-033**: `docs/keyboard-shortcuts.md` MUST gain a Vim mode section, and `CHANGELOG.md`
  MUST record the feature.

### Key Entities

- **Vim mode setting**: a persisted boolean, global to the app.
- **Editor mode state**: per pane — current mode, pending keys, count, recording flag,
  command-line text. Drives the footer indicator.
- **Session Vim state**: app-wide — registers, macros, marks, last search pattern and
  direction, last substitute. Discarded on quit.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A user can enable Vim mode from Settings and perform their first modal edit
  within 30 seconds, without documentation.
- **SC-002**: Every key sequence listed in the acceptance scenarios and in FR-010 through
  FR-027 produces the same result as it would in stock Vim on the same text.
- **SC-003**: With Vim mode on, keystroke-to-screen latency in Insert mode on a 10,000-line
  note is indistinguishable from Vim mode off (within measurement noise, and never above
  16 ms at the 95th percentile on the reference machine).
- **SC-004**: With Vim mode off, the app's behaviour, bundle startup time and typing latency
  are unchanged from before the feature.
- **SC-005**: `:%s` over a 10,000-line note with 1,000 matches completes in under one second
  and is reversible with a single `u`.
- **SC-006**: Toggling the setting on and off ten times in a session leaves every open
  editor's text, caret and scroll position intact and never leaves a stale mode indicator.
- **SC-007**: The mode indicator and command line are visually consistent with the existing
  footer: same font, size, colours and spacing; a reviewer cannot tell they were added
  later.

## Assumptions

- The Vim emulation itself is provided by an existing, maintained third-party library that
  targets the app's editor engine, per the user's instruction and constitution principle VI.
  Writer contributes the setting, the footer UI, Ex-command wiring into its own save/close
  paths, and coexistence with its shortcuts and widgets. Which library is decided in
  planning.
- "Basically all the stuff" is bounded to what a mature emulation library ships; features
  outside it (Vimscript, plugins, `:e`/`:sp`/`:vs`, folds, spell commands, custom key
  mappings such as `jk` → `Esc`, relative line numbers) are out of scope for this
  iteration and can be filed separately.
- `:q` acts on the current tab, not the window, because tabs are Writer's unit of "open
  document".
- The default register maps to the system clipboard; users who want Vim-private yanks use
  named registers.
- Search highlight colour reuses the app's existing find-match colour.
- The footer is the home for the mode indicator and command line because it already hosts
  per-document status; no new floating overlay is introduced.
- Vim mode is a global preference, not per-document or per-workspace.
- Registers, marks and macros are session-only; there is no requirement to persist them.
- Depends on the existing settings persistence, the existing save and tab-close paths, and
  the document footer. No backend (Rust) changes are expected.
