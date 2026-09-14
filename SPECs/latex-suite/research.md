# Research: LaTeX Suite

All "NEEDS CLARIFICATION" items from the Technical Context were resolvable from the codebase and the reference file; none remain. Each entry records the decision, why, and what else was considered.

## R1. Snippet file parsing without executing code

**Decision**: Parse `latex-snippets.js` with `acorn` (`sourceType: "module"`, `ecmaVersion: 2022`) and walk the AST. Accept either `export default [...]` or a bare `[...]` expression statement. Supported node kinds: `ArrayExpression` → entries; `ObjectExpression` with `Identifier`/string keys; `Literal` string, `Literal` regex (`node.regex.pattern` + `flags`), `Literal` number; `TemplateLiteral` with no `${}` expressions (treated as a string). Anything else in a `replacement` (functions, calls, template expressions) → entry error `function-replacement` / `unsupported-value` reported with the entry index, the trigger when it is a string, and `loc.start.line`. Unknown object keys (e.g. `excludedMacros`) are ignored. `acorn` is loaded with a dynamic `import()` at first load so it is not on the startup path when snippets are disabled.

**Rationale**: FR-002a requires the Obsidian syntax (regex literals, `//` and `/* */` comments) and forbids evaluation. `acorn` gives positions for FR-017's "line of the offending entry" for free and is ~100 KB, MIT, zero dependencies.

**Alternatives considered**: `json5` — rejects regex literals, comments are fine but the whole file would fail. `@babel/parser` — present only transitively and ~4× larger. Hand-written parser — reinvents a JS tokenizer; constitution VI. `new Function`/`eval` — forbidden by spec.

**Reference-file audit**: the file has **four** function-replacement entries, not two as the spec assumed: (1) "insert space after Greek letters and symbols" (priority 2), (2) "disable snippets while typing macros" (priority 3), (3) `iden(\d)` identity matrix, (4) list-aware `dm`. See R4 for what the default set does with each. SC-006 stays satisfiable: all four are reported by index and skipped, every other entry loads.

## R2. Tabstop engine: own state field instead of `@codemirror/autocomplete`'s `snippet()`

**Decision**: A `StateField<TabstopFrame[]>` (stack). Each frame holds a `DecorationSet` of zero-width-or-ranged marks tagged with a group index, plus `currentGroup`. The field maps every frame through `tr.changes` (`RangeSet.map`), so stops track edits with no bookkeeping. `Tab` selects the next group's ranges as a multi-range selection (repeated stops → several ranges; placeholders → the placeholder text selected). When a frame is exhausted it is popped and the next `Tab` continues in the frame below (FR-008). `Escape`, leaving vim Insert mode, a "writer" (swap/reload) transaction, or a doc change that leaves a frame with no ranges clears the frame(s). Marks also render as a subtle `cm-latex-tabstop` background so the user sees where Tab will go.

**Rationale**: `snippet()` from `@codemirror/autocomplete` replaces the active snippet when a new one starts and has no API to re-activate an outer snippet's remaining fields; the state field is not exported. FR-008 cannot be met with it. The Obsidian plugin uses the same DecorationSet-as-storage trick, which is the least code that stays correct under edits.

**Alternatives considered**: `snippet()` + a wrapper that re-applies the outer snippet as a new template — cannot restore ranges that already contain user text. Storing plain positions and mapping them by hand — more code, easier to get wrong.

Requires `EditorState.allowMultipleSelections.of(true)` (not currently enabled; see R7).

## R3. Where expansion runs and how undo behaves

**Decision**: `EditorView.inputHandler` at `Prec.high` (runs before `closeBrackets`' handler). Flow: skip if `view.composing`, if the selection has more than one range, or if vim is on and the tab is not in Insert/Replace mode (read from `vim-store`). Otherwise: dispatch the default insert transaction, then evaluate the **post-insert** state (`ensureSyntaxTree(state, lineEnd, 20)` so the current paragraph is parsed), and if a snippet matches dispatch a second transaction with the expansion, `userEvent: "input.snippet"`, `annotations: isolateHistory.of("full")`. Return `true` in both cases (we dispatched). Tab-triggered snippets, tab-out and tabstop navigation run from a `Prec.highest` keymap on `Tab`/`Shift-Tab`, in this order: next/previous tabstop → non-auto snippet ending at the caret → tab-out (math only) → `false` (falls through to list indent / `indentWithTab`).

**Why two transactions**: acceptance scenario 7 wants undo to restore the trigger text (`mk`), so the expansion must be its own undo step separate from the keystroke that completed the trigger. Evaluating the post-insert state also solves a real problem: after `mk` → `$|$` the tree has no `Math` node (inline math needs non-empty content), so the first character typed inside is only recognised as math _after_ it lands. The same holds for `dm`'s empty middle line.

**Backspace nicety** (spec edge case): a `Prec.highest` `Backspace` binding runs `undo` when the view's last doc-changing transaction was an `input.snippet` expansion (tracked in the same state field). One key removes an unwanted expansion; documented in `docs/latex-suite.md`.

**Alternatives considered**: keydown DOM handler (Obsidian's approach) — misses non-keyboard input paths and fights IME; `updateListener` + microtask dispatch — works but adds a deferred dispatch and complicates ordering with vim; single transaction (replace trigger-minus-last-char + key) — undo would restore `m`, not `mk`.

## R4. The four function entries in the reference file

| Entry (index in reference)                        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insert space after Greek/symbol + letter (prio 2) | **Declarative equivalent shipped**: trigger `\\(?!(?:${GREEK}\|${SYMBOL}\|${MORE_SYMBOLS})$)(${GREEK}\|${SYMBOL}\|${MORE_SYMBOLS})([A-Za-z])`, replacement `\\[[0]] [[1]]`, `rmA`, priority 2. Because triggers are anchored at the caret, the negative lookahead means "the letters typed so far are not themselves a complete symbol" — exactly what the function tested (`\in`+`t` stays `\int`; `\alpha`+`x` → `\alpha x`). |
| Disable snippets while typing macros (prio 3)     | **Engine rule, not a snippet**: an automatic snippet does not fire when its match starts strictly inside a control-sequence word (`\[A-Za-z]+`) that ends at the caret. A match that _starts at_ the backslash (the space rule above, `\\(GREEK),\.`) still fires; auto-subscript `\alpha3` still fires because the digit ends the word. Covers raw `\text`, `\arcsin`, `\alpha`.                                               |
| `iden(\d)` identity matrix                        | Dropped from the default set (needs computation). Reported by index if a user pastes the reference file.                                                                                                                                                                                                                                                                                                                        |
| List-aware `dm`                                   | Dropped from the default set. Plain `dm` (`tAw`) and `/(\S\s*)dm/` remain, so `dm` inside a list item still opens display math, just without list-aware indentation.                                                                                                                                                                                                                                                            |

The spec's assumption "minus its two function-replacement entries" is superseded by this table; the user should confirm in review (called out in the completion report).

## R5. Source highlighting: one small stream tokenizer, nested with `parseMixed`

**Decision**: `latexSourceLanguage = StreamLanguage.define({...})` with these token classes (lezer tags in brackets): control sequence `\name` or `\<symbol>` [`tags.keyword`], grouping `{ } [ ] ( )` [`tags.bracket`], operators `^ _ & \\` [`tags.operator`], numbers [`tags.number`], `%` comment to end of line [`tags.lineComment`], `$`/`$$` [`tags.processingInstruction`], everything else — letters, punctuation **and whitespace** — [`latexTextTag`, a `Tag.define()`]. Every character is covered by exactly one token so a scoped `HighlightStyle` with `all: { fontFamily: codeFont, fontSize: editorFontSize }` re-applies the code font that the nested tree otherwise loses (see below).

Nesting: a `MarkdownConfig` with `wrap: parseMixed(node => node.name === "MathFormula" ? { parser: latexSourceLanguage.parser } : null)` added to the `markdown({ extensions })` list. Fences: `codeLanguages` becomes a function: `info` `latex`/`tex` → `latexSourceLanguage`, otherwise `LanguageDescription.matchLanguageName(languages, info, true)` (today's behaviour).

Two `HighlightStyle`s scoped to `latexSourceLanguage` live in a `Compartment`: the coloured one (tags → existing `--pm-syntax-*` variables: keyword, atom for brackets, literal for numbers, comment, plus `--pm-syntax-invalid` reserved for bracket errors) and a plain one (only `all` with the code font) swapped in when `latex.highlight-source` is off. The compartment is driven by a settings subscription exactly like `vim-mode.ts`. Parsing stays on either way — its cost is negligible and keeps the tree shape stable.

**Why not stex**: verified in `@codemirror/legacy-modes/mode/stex.js` — outside `$…$` it styles `_` as part of identifiers and `&` as text; inside `$…$` it styles commands and `^ _ &` both as `tag` and `\\` as `error`; numbers are `atom` outside and `number` inside. Five distinct classes (SC-007) are not reachable.

**Why the code font needs `all`**: `@lezer/highlight` resets the inherited class when entering a mounted tree (`if (mounted) inheritedClass = ""`), so `mathFormulaTag`'s font no longer reaches the nested tokens. Keep the `mathFormulaTag` rule (it still styles formulas that are not mounted, e.g. blank content) and add the scoped `all` rule.

**Bracket matching (FR-022)**: `bracketMatching({ renderMatch })` from `@codemirror/language`; `renderMatch` returns `[]` unless the match start lies inside a `MathFormula` or a `latex`/`tex` `FencedCode` node, otherwise the same two marks the default renderer produces (`cm-matchingBracket` / `cm-nonmatchingBracket`). Colours come from theme variables in `latex-snippets.css`. `matchBrackets` falls back to textual matching restricted to the same token type, which is what we want inside math.

**Alternatives considered**: a ViewPlugin that tokenises `MathFormula` ranges and emits decorations — more code, duplicate of what `parseMixed` gives; rendering the whole `Math` node (with `$`) through stex — still fails the class split.

## R6. Global file location, watcher, and multi-window propagation

**Decision**: Path `app_data_dir()/latex-snippets.js`. Rust `latex_snippets_path` creates it from `include_str!("../../../shared/latex-snippets.default.js")` when missing and returns the path; `reset_latex_snippets` overwrites it with the same bytes. One process-wide `notify` watcher on `app_data_dir()` (non-recursive) started in `setup`, using the existing debounce loop shape. For `latex-snippets.js` events it emits `fs:file-changed { path, kind, workspace: null }` to **all** windows. For `config` events it re-reads the global layer in every window's `Settings` (new `Settings::reload_global()`, under `global_settings_file_lock`) and emits `settings:changed` with payload `null` to all windows; `use-file-watcher`'s handler already treats a `null` workspace as current (`isWorkspaceEventCurrent`).

Frontend: `latex-snippet-store` listens to `fs:file-changed`, filters on its own path, reads the file with the existing `readFile`, parses and compiles. The already-open snippet tab, if any, is reloaded by the existing handler in `use-file-watcher` (diskContent comparison protects in-flight edits, so the app's own save is a no-op reload). This gives "save from either window reloads once" and "edited outside the app" the same path.

**Rationale**: reuses the watcher, event and reload plumbing that exists; fixes FR-026 (global setting changes reaching other windows) with the same watcher instead of a second mechanism. No self-write suppression is needed: a reload after our own save is idempotent for both the store and the tab.

**Alternatives considered**: per-window standalone-file watcher on the snippet file — duplicated per window and tied to workspace epochs; frontend polling — no; storing snippets in `config` — not the Obsidian format and not editable as a tab.

## R7. Opening the snippet file as code, not prose

**Decision**: `editorFlavorForPath(path)` in `src/lib/editor-flavor.ts`: if `LanguageDescription.matchFilename(languages, path)` finds a language whose name is not `Markdown`, the flavor is `{ kind: "code", language }`; otherwise `"markdown"`. `createEditorExtensions` takes the flavor and, for code, builds: vim compartment, `history` compartment, `prosemarkBasicSetup`'s CodeMirror half (`dropCursor`, `closeBrackets`, keymaps, line wrapping), `drawSelection`, the language, `generalSyntaxHighlights` + base theme, `editorSearchExtensions`, `storeSyncExtension`, clipboard, focus-on-reveal. Markdown-only extensions (fold/hide/list/prosemark syntax, decorations, wiki links, formatting, snippets, math highlighting) are not included. Opening goes through `editorApi.openFileInNewTab(path)` from the Settings action (focuses the existing tab when already open; opens in the focused pane otherwise).

**Rationale**: `.txt` and unknown extensions keep today's behaviour (Markdown flavor), `.md`/`.markdown` unchanged, and `latex-snippets.js` gets JavaScript highlighting for free from `@codemirror/language-data` (already a dependency). No page kind, no special-casing of one path.

**Behaviour change to record**: the snippet engine enables `EditorState.allowMultipleSelections`. `Mod-d` (`selectNextOccurrence`) is already bound in `prosemarkBasicSetup` but was silently collapsed to one range; after this change it creates real multi-cursors in Markdown tabs. Goes in CHANGELOG.

## R8. Snippet variables as a setting

**Decision**: one setting `latex.snippet-variables`, type `list`, category `LaTeX Suite`, items formatted `NAME=alternation` (e.g. `GREEK=alpha|beta|…`). Default carries the reference file's `GREEK`, `SYMBOL`, `MORE_SYMBOLS`, `ACCENT` (plus `SYMBOLS`, which the reference file references but never defines — shipped as an alias of `SYMBOL` so that entry stops being dead). The compiler substitutes `${NAME}` in triggers and replacements at load; an unknown `${NAME}` is an entry error `unknown-variable`. Changing the setting recompiles the set (store subscribes to the settings store for this key).

**Rationale**: the existing `list` control and Ghostty config serialisation (repeated `key = value` lines; `split_once('=')` keeps the item's own `=`) support this with no new setting type. FR-019 wants "user-editable in Settings"; a dedicated key/value editor is a later polish.

**Alternatives considered**: dynamic keys `latex.var.<NAME>` — not representable in the typed schema registry; variables at the top of the snippet file — breaks Obsidian paste-in compatibility.

## R9. Match semantics pinned down (Obsidian parity where it matters)

- Triggers compile to `new RegExp("(?:" + source + ")$")`; string triggers without `r` are regex-escaped first; `w` adds a leading `(?<![\\p{L}\\p{N}_])` (character before only, per spec assumption). Flags: `u`; a `v` flag from a regex literal is rejected (`invalid-pattern`).
- The subject is the current line's text up to the caret (post-insert). Multi-line lookbehinds (`[^\\]` matching `\n` in Obsidian) therefore do not match at line start — documented difference, matches "evaluated only against the current line" in the spec.
- Replaced range = `[caret − match[0].length, caret)`; `[[n]]` = capture group `n + 1`; a `[[n]]` beyond the group count is `missing-capture`.
- Candidate order: priority descending, then file order; first match wins (FR-006). The set is pre-sorted and pre-bucketed by mode at compile time so the per-keystroke loop is a straight scan.
- Visual snippets (`${VISUAL}` in replacement) are checked only when the selection is non-empty and the typed text equals the trigger string exactly; non-visual snippets are skipped whenever the selection is non-empty (FR-010).
- Time budget: each regex `exec` is wrapped; > 20 ms or a thrown error disables that snippet for the session and records `pattern-timeout` / `pattern-threw` in the store's error list (surfaced in Settings).
- Auto-fraction (`/`) runs after snippet matching and only if no snippet fired; `//` is a snippet so it takes precedence. Operand: preceding balanced `{…}`/`(…)`/`[…]` group (with a leading control sequence if present, e.g. `\sqrt{x}`), else the run of non-space characters back to the previous unbalanced opener, space, or one of `+ - = < > ,`. Empty operand → literal `/`.
- Tab-out targets on the current line: `}`, `)`, `]`, `|`, then the closing `$`/`$$` of the enclosing `Math` node.
- Math context: `syntaxTree.resolveInner(pos, -1)` walked upward — `InlineCode`/`FencedCode`/`CodeBlock` → `code`; `Math` → `inline` or `display` by the node's first two characters; inside math, an unclosed `\text{` before the caret in the formula prefix → `text`; else `prose`.

## R10. Test strategy given a node-only test runner

All engine modules take `EditorState` (or plain strings) and return `TransactionSpec`-shaped data; the `inputHandler`, keymap and `ViewPlugin` glue are thin and verified by hand via [quickstart.md](./quickstart.md). SC-001 is a test that parses `shared/latex-snippets.default.js`, and for each entry with a string trigger and no captures, builds a document in the entry's mode, applies `expand` and asserts the resulting text equals the replacement with tabstop syntax stripped and the caret at the first stop. SC-004 is measured by hand (Performance panel) and recorded in the quickstart; a unit micro-benchmark asserts the full default set matches a 200-char line in < 1 ms on the CI machine as a regression tripwire.
