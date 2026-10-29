# AUD-07: usable small split panes

## Evidence and acceptance

At the supported 240×160 minimum, fixed tabs/history controls can leave less than
one 184px tab visible. Text chrome reserves 56px for tabs, 40px for the path and
44px for stats. A conflict notice then fills the remaining height. Existing
120px fades and 140px scroll margins compound the loss of usable text space.
AUD-01's native mounted-pane probe confirms zero editor height. No original vault
files are involved. Previous ticket/report: AUD-01, commit 2a71ac0.

Keep the current visual language and roomy-pane layout. A minimum pane must have
a visible, operable active tab, accessible navigation/new-tab actions, readable
text and conflict recovery. Preserve stable editor instances, typing, undo,
scrolling, drag/drop, keyboard navigation and layout persistence.

## Plan

1. Capture a real restored split layout with a 240×160 leaf in the isolated
   native audit app, plus normal 800/1200 windows and collapsed-sidebar geometry.
2. Derive shared short/narrow presentation attributes and width tokens from the
   existing pane rectangle on both chrome slots and stable tab hosts. Keep the
   measured full-pane boundary unchanged. pane-chrome.ts owns thresholds; shared
   CSS owns responsive styles. No new layout state or resize observer. Width and
   height respond independently. This uses existing geometry instead of duplicating
   CSS query thresholds in JavaScript for dialog lifecycle.
3. Narrow panes hide the separate history buttons, fit tab slots to the available
   strip width, and expose New tab, available history actions and full tab names
   through an accessible overflow control. Keep active tabs draggable and close
   controls reachable. Respect the top-left native controls' 132px reserved inset.
4. Short text panes hide the path row and secondary statistics, retain compact
   Vim/LaTeX status when needed, and use actual content space below tabs/above that
   status. Reduce body padding and disable the large fades in this mode. Share
   measured safe scroll insets between caret, heading/search and Vim scrolling so
   a fixed 140px margin cannot place text outside a short viewport.
5. A short pane shows a one-line conflict status with Review changes. Open its
   existing wording/actions in a bounded, keyboard-accessible dialog outside pane
   clipping. Keep one conflict action implementation and preserve pending-read,
   focus and discard guards. Escape/Close dismisses review without resolving the
   conflict. Roomy panes keep inline recovery.
6. Update editor docs and changelog. Record remaining unrelated findings.

## Validation

- Real native split minima at 240×160, short-wide and narrow-tall, with the sidebar
  open/collapsed; normal 800/1200 windows; dark and light themes.
- Every active tab fits its strip; close/menu/new/history remain reachable, with
  native control clearance. Drag/drop and keyboard separator resizing still work.
- Text has positive usable height, first/last lines and caret can be reached;
  heading/search/Vim navigation use that same visible area. Long-note switching
  preserves cursor/scroll and undo remains intact.
- Conflict review fits the window, preserves both texts until a choice, restores
  focus correctly, and closes safely on navigation/resize/unmount. Both resolutions,
  external deletion, pending read and error states remain usable.
- Focused meaningful scroll geometry regressions and native layout assertions;
  vp check/test, native build, implementation reviews, screenshot comparison.

## Status

Completed locally; commit recorded in TODOS.md. Baseline: 1,720 frontend and 292 Rust tests passed at
2a71ac0. Pre-existing math/Mermaid/dependency work remains untouched. Evidence:
~/agent-runs/2026-10-29-writer-audit/. Previous turn made verified progress.

## Plan review and implementation notes

Frontend, UX, Editor and QA plans approved with P2 refinements. Compact tabs use
6px side padding, a 28px close region and a 28px overflow control; available slot
width subtracts the native inset and controls. Narrow/tall footers retain the first
chosen metric; essential Vim/LaTeX status takes precedence. Close focus targets the
visible new/overflow control. At minimum height require a fully visible line, not
merely positive editor height. Check dirty-tab moves and breakpoint transitions.
Dialog starts on neutral Close; native dialog semantics trap focus. Hidden tabs,
path changes and leaving short mode dismiss it. Guard async focus by live pane focus.

Native restored baseline: three panes at 800×800 CSS pixels with a real 240×160
leaf (small-pane-session.json). Its 184px tab has only 106px visible; no document
text is visible. The initial scroll geometry red3/green3 pass verifies
short heading placement, border/top inset alignment and Vim coordinate reversibility.
Native validation and implementation review results follow.

## Implementation review and native findings

Frontend, UX, Editor and QA reviewed implementation. Fixed their findings:
responsive tab widths no longer animate behind resizing; successful conflict
resolution clears the armed review path; Find leaves short-pane text uncovered;
active headings refresh after separator commits; essential footer status truncates
safely; narrow property rows stack instead of giving values zero width.

Native testing found two further issues. Tables created a horizontal scrollbar
on the whole editor, taking 17px from its height; narrow tables now own horizontal
scrolling. Modal cleanup ran before parent compact attributes changed, leaving
focus on body after resize; cleanup now checks after the React commit. Final
native conflict checks confirm dismissal and editor focus restoration.

A rapid Vim G/zz sequence exposed a stale coordinate origin in the upstream
adapter. Runtime logging recorded content top changing from -368 to -1097 while
charCoords measured its cursor. The adapter override measures the cursor first,
then the content origin. A regression using the real CodeMirror adapter failed
before this change and passes after it. The final rebuilt app also passes rapid G/zz cursor visibility. A fresh Editor
review approved this change. The Vim prompt now constrains its nested flex items
and input to the footer; the visible input is 154px wide at the minimum pane.

## Final verification and limits

- `vp check`: passes with 0 errors and 10 existing warnings. `vp test`: 1,726 tests
  pass across 114 files. Six scroll regressions cover safe heading/caret geometry,
  Vim viewport conversion and the stale-origin race. The initial geometry and Vim race
  regressions were observed failing before their fixes. No Rust source changed in this task; prior 292 Rust
  tests, clippy and fmt results remain the backend baseline.
- Final Tauri release e2e app built successfully with isolated bundle identifier
  `com.writer-computer.audit`. No production install or deployment.
- Native minimum pane is 240×160. Representative prose has a 72px scroller client
  height; an unresolved conflict leaves 40px, with a complete caret/text line
  visible. Before, conflict chrome left no editor space. Property value inputs
  are 146px wide and edits persist to the synthetic fixture.
- Keyboard separator resizing crosses both presentation modes without replacing
  the EditorView or losing undo. A synthetic pointer drag moved a dirty tab into
  another pane, preserving its view, text and undo. This is not hardware mouse
  acceptance; the environment's W3C pointer events remain ineffective.
- Find/Replace expands to a 536px card outside the short pane, with a 339px search
  input and visible selected match. Closing restores editor focus. Native tab
  overflow menu keyboard selection creates a tab in its pane; close works.
- At collapsed-sidebar 240px width, the 64px tab fits between the native 132px
  inset and overflow control. Native light/dark screenshots cover 800/1200 windows,
  short/narrow panes, Find, Vim prompt, conflicts and review dialog.
- Conflict tests use actual fixture deletion/replacement to establish a stable
  external conflict. Both buffers survive; Escape dismisses without resolving;
  local/disk choices and recreation succeed; editor focus returns. Resizing an
  open review dismisses safely, and a later conflict does not reopen it unasked.
- AeroSpace opening and reopening use TilingContainer automatically; neighboring
  T3 Code width changes from 1790 to 890px. The test window is temporarily floated
  for geometry checks, then closed after validation.
- Evidence: `small-pane-native-results.json`, `small-pane-conflict-results.json`,
  `small-pane-mode-results.json`, `small-pane-native-menu.json`,
  `small-pane-drag-results.json`, build/check/test logs and before/after screenshots
  under `~/agent-runs/2026-10-29-writer-audit/`. Source scripts record harness
  corrections; failed timing/selector probes are not counted as passing checks.

The broader audit is still active. This task does not claim exhaustive screen
reader testing, hardware dragging, every LaTeX/error state, or a performance gain.
Table source editing can still require horizontal scrolling. Hidden-tab dialog
cleanup is guarded in code; native tab-navigation/unmount and pending-read/error
matrices remain part of the broader UI/reliability pass. Original SDU files and
pre-existing math/Mermaid work were not changed. Next: SDU drawing compatibility,
wiki fragments and academic organization, with performance profiling still open.
