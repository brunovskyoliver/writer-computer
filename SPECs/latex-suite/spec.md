# Feature Specification: LaTeX Suite — Math Snippets and Source Highlighting

**Feature Branch**: `latex-suite`

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "i would like to introduce another spec, which would do latex syntax highlighting as well as provide latex suite similarly to the obsidian's plugin.. it would allow me to create shortcuts like dm, mk, cases, cos, sin, /, theta, and other and allow me to customically add new ones.. i have saved the structure for inspo in SPECs/obsidian-latex-suite... make sure this would be customizable in settings / opening new tab with the snippets file so i can edit it directly in the app and it would auto reload without UI change..."

**Reference material**: [`SPECs/obsidian-latex-suite`](../obsidian-latex-suite) — the user's Obsidian Latex Suite snippet file, kept as the model for the snippet format and as the seed for the default snippet set.

**Builds on**: [`SPECs/latex-math-spec.md`](../latex-math-spec.md) — `$...$` and `$$...$$` are already parsed and KaTeX-rendered; this feature adds authoring speed on top of that rendering.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Type math faster with built-in snippets (Priority: P1)

A student taking lecture notes types `mk` in a paragraph and is immediately inside an inline math region with the caret between the delimiters. They type `//` and get a fraction with the caret in the numerator; they press Tab to jump to the denominator, and Tab again to leave the fraction. They type `sin`, `cos`, `theta`, `->`, `RR` and each becomes the correct LaTeX command (`\sin`, `\cos`, `\theta`, `\to`, `\mathbb{R}`) without typing a backslash. Typing `dm` on its own line opens a display-math block with the caret on its own line between the `$$` fences; typing `cases` inside math produces a `\begin{cases} … \end{cases}` environment with the caret inside.

**Why this priority**: This is the whole reason the feature exists. Without it there is nothing to customize and nothing to highlight beyond what already renders. It also delivers value on day one with the shipped default set, before the user edits anything.

**Independent Test**: Open a fresh note, type the sequence above, and compare the resulting Markdown source against the expected LaTeX. Every default snippet in the shipped set can be exercised the same way: type trigger → observe replacement → press Tab through its stops.

**Acceptance Scenarios**:

1. **Given** the caret is in ordinary prose, **When** the user types `mk`, **Then** the text becomes `$|$` (caret at `|`) and the region is now inline math.
2. **Given** the caret is inside inline math, **When** the user types `//`, **Then** the text becomes `\frac{|}{}` with the caret in the first braces, and pressing Tab moves the caret into the second braces, and pressing Tab again moves it past the closing brace.
3. **Given** the caret is inside math, **When** the user types `sin`, `cos`, `theta`, `->`, `RR` or `ooo`, **Then** each expands to `\sin`, `\cos`, `\theta`, `\to`, `\mathbb{R}`, `\infty` respectively as soon as the last character of the trigger is typed.
4. **Given** the caret is in prose, **When** the user types `dm`, **Then** a display-math block `$$`/blank line/`$$` is inserted with the caret on the blank line.
5. **Given** the caret is inside math, **When** the user types `cases` (or `pmat`, `bmat`, `align`, `matrix`), **Then** the matching `\begin{…}` / `\end{…}` pair is inserted with the caret inside.
6. **Given** the caret is in ordinary prose (not math), **When** the user types `sin` or `theta` as part of a sentence, **Then** nothing expands — math-mode snippets never fire in prose.
7. **Given** a snippet has just expanded, **When** the user presses the platform undo shortcut once, **Then** the document returns to the state immediately before the expansion (trigger text restored) — an expansion is one undo step.
8. **Given** a snippet has just expanded and the caret is at a tabstop, **When** the user types a character that would complete another trigger, **Then** the nested snippet expands and its tabstops take precedence; after the nested stops are exhausted, Tab resumes the outer snippet's remaining stops.
9. **Given** the user selects `a+b` inside math, **When** they type `S`, **Then** the selection is wrapped as `\sqrt{ a+b }` (visual snippet); with no selection, `S` does not expand.
10. **Given** the caret is inside math after `(a+b)`, **When** the user types `/`, **Then** the text becomes `\frac{a+b}{|}` with the caret in the denominator (auto-fraction); after `x^2` it becomes `\frac{x^2}{|}`.
11. **Given** the caret is inside `\sqrt{x|}` with no active tabstop, **When** the user presses Tab, **Then** the caret moves past the `}` (tab-out); pressing Tab again at the end of the math content moves past the closing `$`.

---

### User Story 2 - Edit the snippet file in-app and see changes live (Priority: P1)

The user opens Settings, finds a "LaTeX Suite" section, and clicks "Edit snippets". The snippet file opens in a new editor tab as plain text. They add `{trigger: "lap", replacement: "\\mathcal{L}", options: "mA"}`, save, switch back to their note and type `lap` inside math — it expands immediately. No dialog, no toast, no editor flicker or reload happened in between. If they introduce a syntax error, the previously working snippet set keeps working, and the Settings section (and the snippet-file tab) shows a clear message naming the problem and line.

**Why this priority**: The user explicitly asked for in-app editing with silent hot reload. A snippet system whose defaults cannot be changed without leaving the app or restarting it would not replace the Obsidian workflow.

**Independent Test**: With a note open, open the snippet file via Settings, add a trigger, save, type the trigger in the note. Then break the file deliberately, save, confirm old snippets still work and an error is shown in Settings; fix it, save, confirm the error clears and the new snippet works.

**Acceptance Scenarios**:

1. **Given** Settings is open, **When** the user activates "Edit snippets" in the LaTeX Suite section, **Then** the snippet file opens in a new tab in the current pane; if it is already open, that tab is focused instead of a second one opening.
2. **Given** the snippet file is open in a tab, **When** the user edits it and saves, **Then** within one second typing the new trigger in any open note expands it, and no visible UI change other than the saved-state indicator on the snippet tab occurs.
3. **Given** the file is edited outside the app (another editor, git checkout, sync), **When** the file changes on disk, **Then** the active snippet set updates the same way as an in-app save.
4. **Given** the file contains an error (unparseable content, a trigger that is not a string or pattern, an invalid option letter, an invalid pattern), **When** it is saved, **Then** the last valid snippet set remains active, the LaTeX Suite settings section shows the error with the offending entry's position, and the error clears on the next successful load.
5. **Given** the snippet file does not yet exist (first run, or deleted), **When** the app starts or the user activates "Edit snippets", **Then** it is created from the shipped default set so the user always edits a real, populated file.
6. **Given** the user has customized the file, **When** they activate "Reset to defaults" in Settings, **Then** they are asked to confirm, and on confirmation the file is overwritten with the shipped defaults (and the tab, if open, shows the new content).

---

### User Story 3 - Read raw math source with highlighting (Priority: P2)

When the caret enters a math region and the rendered formula unfolds into its source, the source is highlighted: commands like `\frac` and `\alpha` in one colour, braces and brackets in another (with the matching pair emphasized when the caret is beside one), `^`/`_`/`&`/`\\` operators in a third, and comments dimmed. The same highlighting applies inside fenced code blocks tagged `latex` or `tex`. Highlighting follows the active theme and matches the weight of the existing Markdown source styling.

**Why this priority**: The user asked for it by name, and it makes editing longer formulas (matrices, cases, aligned equations) far less error-prone. It is independent of snippets and useful on its own, but the snippets deliver more per keystroke.

**Independent Test**: Place the caret inside a display-math block containing a `cases` environment with a `\frac` and a comment; confirm each token class is visibly distinct and that placing the caret next to `{` emphasizes its `}`.

**Acceptance Scenarios**:

1. **Given** a math region is unfolded to source, **When** the user looks at it, **Then** commands, grouping symbols, operators (`^`, `_`, `&`, `\\`), numbers and `%` comments are each visually distinct from plain math text.
2. **Given** the caret is immediately beside a `{`, `[`, `(` or its closer inside math source, **When** the region is unfolded, **Then** the matching partner is emphasized; an unmatched opener/closer is marked as an error.
3. **Given** a fenced code block with the info string `latex` or `tex`, **When** it is displayed, **Then** its body has the same token highlighting as math source.
4. **Given** a math region is folded (rendered), **When** the caret is outside it, **Then** the rendering is unchanged by this feature.
5. **Given** the user switches theme (light/dark or custom), **When** math source is visible, **Then** the highlight colours change with the theme.

---

### User Story 4 - Tune behaviour in Settings (Priority: P3)

In the LaTeX Suite settings section the user can turn the whole feature off, toggle snippet expansion separately from source highlighting, and edit the snippet variables (`GREEK`, `SYMBOL`, `MORE_SYMBOLS`, `ACCENT`, …) that triggers refer to. Changes take effect immediately in every open window.

**Why this priority**: Off-switches and variables are the safety valve and the last piece of parity with the Obsidian plugin. They are low effort once P1/P2 exist, but not required to get value.

**Independent Test**: Toggle snippets off, type `sin` in math, confirm nothing expands; toggle on, confirm it expands. Add `phi` to `GREEK`, confirm a trigger that uses `${GREEK}` now matches `phi`.

**Acceptance Scenarios**:

1. **Given** snippets are disabled in Settings, **When** the user types any trigger, **Then** the text stays literal and Tab behaves as it does today.
2. **Given** highlighting is disabled, **When** math source is unfolded, **Then** it is styled as it is today (delimiters muted, formula in code font, nothing more).
3. **Given** the user edits the `GREEK` variable to add a letter name, **When** they save, **Then** triggers that expand `${GREEK}` accept the new name without further changes.
4. **Given** two windows are open, **When** a setting or the snippet file changes, **Then** both windows reflect it.

---

### Edge Cases

- **Prefix triggers**: `dot` and `ddot`, `sin` and `arcsin`, `int` and `dint`/`iint`/`oint`. Priority decides; among equal priority the entry earlier in the file wins; regex triggers can look back at the preceding text so the longer form wins when it is intended (the reference file models this with `priority` and lookbehind captures).
- **Text-mode triggers in prose**: `mk`/`dm` are word-boundary triggers so `dm` inside `admin` does not fire. Non-word-boundary text-mode triggers must be explicitly opted into.
- **Nested math**: a `\text{…}` inside math is treated as text for snippet purposes when the reference file's `text` snippet is used; snippets that require math mode do not fire inside `\text{}`.
- **Fenced code blocks and inline code**: no snippet fires inside `` `code` `` or fenced blocks, regardless of `$` characters inside them.
- **Currency and false positives**: the existing inline-`$` guards continue to apply; a `$5` in prose is not math, so math-mode snippets do not fire after it.
- **Tab with no active tabstop**: inside math, tab-out (FR-012a) runs first; if nothing to tab past, and everywhere outside math, Tab falls through to whatever it does today (list indent etc.).
- **Auto-fraction vs. the `//` snippet**: both exist in the default set; `a/` yields `\frac{a}{}` via auto-fraction, `//` with nothing before it yields the empty `\frac{}{}` snippet. A URL-like `http://` inside math is not a realistic input; outside math `/` is never touched.
- **Vim mode**: snippets fire only in Insert mode; Tab/tabstop navigation applies in Insert mode; leaving Insert mode clears active tabstops.
- **Multiple carets**: expansion applies to the primary caret only; other carets are unaffected, or expansion is suppressed entirely when more than one caret exists (implementation picks the simpler correct behaviour and documents it).
- **Composition / IME input**: no snippet fires mid-composition; the trigger is evaluated once the composed text is committed.
- **Very long or pathological regex triggers**: a trigger is evaluated only against the current line's text up to the caret; a snippet whose pattern throws or exceeds a small time budget is disabled with an error shown in Settings, not allowed to freeze typing.
- **Snippet file open in two windows**: both are the same file; save from either reloads once.
- **Snippet file removed while the app runs**: the last valid set stays active; opening from Settings recreates it from defaults.
- **Undo after Tab**: Tab-to-next-stop is not an edit and adds no undo step.
- **Auto-expanded snippet immediately followed by Backspace**: one Backspace removes the whole expansion and restores the trigger text (so an unwanted expansion costs one key). If not implemented, this is documented as a known difference from the Obsidian plugin.

## Requirements _(mandatory)_

### Functional Requirements

**Snippet engine**

- **FR-001**: The editor MUST expand snippets from a user-editable snippet set while typing in Markdown documents, evaluating candidate triggers against the text on the current line up to the caret after each inserted character.
- **FR-002**: A snippet MUST consist of a trigger (literal string or regular-expression pattern), a replacement, a set of option flags, an optional numeric priority, and an optional description, matching the vocabulary of the reference file: `t` text mode, `m` math mode (inline or display), `n` inline math only, `M` display math only, `A` automatic expansion, `r` regex trigger, `w` word boundary.
- **FR-002a**: The snippet file MUST be written in the same object-list syntax as the reference file — a list of `{trigger, replacement, options, priority?, description?}` entries where `trigger` is a quoted string or a `/…/` pattern literal, `replacement` is a quoted string, and `//` / `/* */` comments are permitted — so an existing Obsidian Latex Suite file loads unchanged. Entries whose `replacement` is not a string (e.g. a function) MUST be reported by index and skipped per FR-018. The app MUST NOT execute any code contained in the file.
- **FR-003**: Replacement text MUST support tabstops `$0`…`$9`, tabstops with placeholder text `${0:default}`, repeated tabstops (the same index appearing more than once updates all instances as the user types at one), `[[n]]` for the n-th regex capture group, `${VISUAL}` for the selected text, and named snippet variables such as `${GREEK}` expanded before the trigger is compiled.
- **FR-004**: Automatic snippets (`A`) MUST expand the moment the last trigger character is typed; non-automatic snippets MUST expand when the user presses Tab with the caret directly after the trigger.
- **FR-005**: Mode flags MUST be honoured: `m`/`n`/`M` snippets fire only when the caret is inside the matching math region; `t` snippets fire only outside math; no snippet fires inside inline or fenced code.
- **FR-006**: When several snippets match, the one with the highest priority MUST win; ties MUST resolve to file order.
- **FR-007**: After expansion the caret MUST land on the first tabstop; Tab MUST move to the next tabstop and Shift+Tab to the previous one; when the last stop is passed the snippet becomes inactive and Tab returns to its ordinary behaviour.
- **FR-008**: Snippets expanded while another snippet's tabstops are active MUST nest: the inner snippet's stops are visited first, then the outer snippet's remaining stops.
- **FR-009**: A snippet expansion MUST be a single undo step that restores the exact pre-expansion text and caret.
- **FR-010**: Visual snippets (replacement containing `${VISUAL}`) MUST fire only when there is a non-empty selection and MUST wrap that selection; all other snippets MUST fire only when there is no selection.
- **FR-011**: Snippet expansion MUST be inert inside vim Normal/Visual modes and inside IME composition.
- **FR-012**: Snippet evaluation MUST not measurably delay typing: on a document of typical size the per-keystroke cost of matching the full default set stays below the threshold where a user perceives lag (see SC-004).

**Tab-out and auto-fraction**

- **FR-012a**: Inside a math region with no active tabstop, Tab MUST move the caret past the next closing `}`, `)`, `]`, `|` or the region's closing `$`/`$$` on the same line when one lies ahead of the caret; otherwise Tab keeps its ordinary behaviour.
- **FR-012b**: Inside a math region, typing `/` directly after an operand MUST convert the operand into a fraction: the operand is the preceding bracketed group, or the preceding run of non-space characters, or the whole content back to the previous unbalanced opener/operator; result is `\frac{operand}{|}` with the caret in the denominator and a tabstop after the closing brace. Typing `/` after a space or at the start of the region inserts a literal `/`.
- **FR-012c**: Tab-out and auto-fraction MUST each be individually switchable in Settings and MUST be inert outside math regions and outside vim Insert mode.

**Snippet file and reload**

- **FR-013**: The snippet set MUST be stored as a single plain-text file on disk in the app's global configuration location, so it applies to every workspace and survives reinstalling the app.
- **FR-014**: On first use, or whenever the file is missing, the app MUST create the file from a shipped default set derived from the reference file (Greek letters, trig and log functions with automatic backslash and spacing, fractions, sub/superscripts, roots, sums/products/integrals/limits, arrows and relations, set symbols, blackboard/calligraphic letters, environments incl. `cases` and matrices, brackets incl. `\left … \right`, the visual-wrapping snippets, `mk`/`dm` math-entry snippets, and the auto-subscript rules).
- **FR-015**: The app MUST watch the snippet file and apply changes to the active snippet set within one second of the file being written, whether the write came from the app or from outside it, without any modal, toast, editor re-mount, or scroll/caret change in open documents.
- **FR-016**: Settings MUST provide an action that opens the snippet file in an editor tab (focusing the existing tab if already open) and an action that resets it to the shipped defaults after confirmation.
- **FR-017**: If the file fails to load, the previous valid set MUST remain active and the failure MUST be shown in the LaTeX Suite settings section with the error message and, where known, the position of the offending entry; the message MUST clear on the next successful load. Failures MUST never be silently ignored.
- **FR-018**: Individual invalid entries (bad option letter, malformed pattern, replacement referencing a capture group the trigger does not have) MUST be reported by index/trigger and skipped, while the remaining valid entries still load.
- **FR-019**: Snippet variables (`GREEK`, `SYMBOL`, `MORE_SYMBOLS`, `ACCENT`, and any user-added name) MUST be user-editable in Settings and MUST be substituted into triggers and replacements at load time.

**Source highlighting**

- **FR-020**: When a math region is shown as source (caret inside it), the source MUST be token-highlighted: control sequences (`\name`), grouping symbols (`{}`, `[]`, `()`), operators (`^`, `_`, `&`, `\\`), numbers, and `%` comments each styled distinctly from plain math text.
- **FR-021**: Fenced code blocks whose info string is `latex` or `tex` MUST receive the same token highlighting.
- **FR-022**: With the caret adjacent to a grouping symbol inside math source, its matching partner MUST be emphasized and unmatched symbols marked as errors.
- **FR-023**: Highlight colours MUST derive from the active theme so custom themes and light/dark switching apply without further configuration.
- **FR-024**: Rendered (folded) math MUST be unaffected by this feature.

**Settings**

- **FR-025**: A LaTeX Suite section in Settings MUST offer: enable snippets, enable tab-out, enable auto-fraction, enable source highlighting, the snippet-variables editor, "Edit snippets", "Reset to defaults", and the load-error display from FR-017/FR-018.
- **FR-026**: Setting changes MUST take effect immediately in all open windows without restart.

### Key Entities

- **Snippet**: one expansion rule — trigger (string or pattern), replacement (text with tabstops/captures/variables), options (mode, auto, regex, word-boundary flags), priority, description. Ordered within the snippet set.
- **Snippet set**: the ordered list of snippets currently active in the editor, produced by loading the snippet file and substituting snippet variables. Has a load status: valid, valid-with-skipped-entries (list of entry errors), or failed (single error, previous set retained).
- **Snippet file**: the plain-text file on disk that the user edits; the single source of truth for the snippet set. Created from shipped defaults when absent.
- **Snippet variable**: a named alternation (e.g. `GREEK` → `alpha|beta|…`) referenced as `${NAME}` inside triggers/replacements; stored in settings.
- **Active expansion**: the runtime state of a snippet that has fired and still has unvisited tabstops — its stops, current index, and any enclosing expansion (nesting).
- **Math context**: for a caret position, whether it is in prose, inline math, display math, `\text{}` inside math, or code; drives FR-005.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Every snippet in the shipped default set, typed at a caret in the correct context, produces exactly the expected replacement and caret position; a scripted run over the full set passes 100%.
- **SC-002**: Writing a representative formula (e.g. the quadratic formula in display math, or a 2×2 `pmatrix`) takes at least 40% fewer keystrokes with snippets than typing the raw LaTeX.
- **SC-003**: A change saved to the snippet file is usable in an open note within 1 second, with zero visible changes to the note's scroll position, caret, selection, or rendered widgets.
- **SC-004**: With the full default set loaded, snippet matching adds no perceptible latency: the 95th-percentile keystroke-to-paint time in a 5,000-line document stays within 2 ms of the same measurement with snippets disabled.
- **SC-005**: A deliberately broken snippet file never disables math typing: 100% of previously working snippets keep working, and the error is visible in Settings within 1 second of the save.
- **SC-006**: A user who has used Obsidian Latex Suite can paste their existing snippet file and have all declarative entries (string/regex triggers with string replacements) load without edits; the two function-replacement entries in the reference file are listed by index rather than failing the whole file.
- **SC-007**: In unfolded math source, five token classes (command, grouping, operator, number, comment) are visually distinguishable in both the default light and dark themes.

## Clarifications

### Session 2026-09-13

- Q: Snippet file format and Obsidian compatibility level? → A: Same JavaScript object syntax as the Obsidian file (regex literals, string triggers with `r`, `[[n]]` captures, `${VAR}` variables, comments allowed) so the reference file pastes in as-is. Only string/pattern triggers and string replacements are supported; entries whose replacement is a function are reported by index and skipped. The app never evaluates user code.
- Q: Which non-snippet Latex Suite behaviours are in scope? → A: Snippets and tabstops, plus tab-out and auto-fraction. Matrix Tab/Enter shortcuts and automatic `\left … \right` enlargement are out of scope.

## Assumptions

- The snippet file is global (one per user, in the app's configuration directory), not per workspace. Vaults for different subjects share one snippet set, matching how the Obsidian plugin behaves.
- The snippet file opens in the app's editor as plain text with no Markdown rendering behaviour applied — it is not a Markdown document. Saving it uses the same save path and saved/unsaved indicator as other tabs.
- The shipped default set is the reference file minus its two function-replacement entries (`iden3`, list-aware `dm`), and minus entries that would surprise a Markdown author (the commented-out "convert standalone letters to math" rules stay off).
- "Auto reload without UI change" means: no confirmation, no notification, no editor remount, no change to any open document's view; the only visible effect is that typing now uses the new set. Load errors are shown passively in Settings and never as a dialog.
- Source highlighting applies to the existing math regions (`$…$`, `$$…$$`) and to `latex`/`tex` fenced blocks; `\(…\)`/`\[…\]` delimiters remain out of scope, as in the LaTeX math spec.
- Word-boundary (`w`) checks use the character before the trigger only, as in the Obsidian plugin.
- Nothing in this feature requires a network connection or leaves the machine; the snippet file is user data and is never sent anywhere.
- Multi-caret behaviour and the Backspace-undoes-expansion nicety are implementation choices to be recorded in the plan, not user-facing commitments in this spec.
