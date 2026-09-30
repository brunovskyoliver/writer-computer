# Contract: Editor Extension Behaviour

Applies to Markdown-flavor views only (`editorFlavorForPath(path) === "markdown"`). Code-flavor views (the snippet file itself) never load the snippet engine or math highlighting.

## Extension placement (`createEditorExtensions`)

Order matters for keymaps. Additions, relative to today's list:

1. `vimModeExtension` (unchanged, first)
2. `markdown({ codeLanguages: latexAwareCodeLanguages, extensions: [GFM, prosemarkMarkdownSyntaxExtensions, htmlBlockParserExtension, latexMathNesting] })`
3. … existing …
4. `latexHighlighting()` — the highlight-style compartment + scoped `bracketMatching` (after `prosemarkBaseThemeSetup` so its scoped style wins on nested tokens)
5. `latexSnippetsExtension(getTabId)` — `Prec.high` inputHandler, `Prec.highest` keymap, tabstop state field + decorations, `allowMultipleSelections`

## Per-keystroke decision (inputHandler)

```
if view.composing                                   → false (default insert)
if selection.ranges.length > 1                       → false
if vim on and tab mode ∉ {insert, replace}           → false
if !settings["latex.snippets-enabled"] and !settings["latex.auto-fraction"] → false
ctx = mathContext(state, from)                       // pre-insert, after ensureSyntaxTree(lineEnd, 20ms)
if ctx.kind ∈ {code, text}                           → false
lineBefore = text of [line.from, from) + typed text  // the document as it will read
m       = snippets-enabled ? match(lineBefore, ctx, set, "auto") : null
frac    = !m and typed === "/" and auto-fraction on and ctx is math ? autoFraction(lineBefore) : null
if !m and !frac                                      → false (default insert; other handlers still run)
dispatch(insert())                                   // keystroke lands as its own "input.type"
dispatch(expansion(m ?? frac)) ; return true
```

Nothing is dispatched on a miss. Returning `true` from an `inputHandler` suppresses every lower-precedence one — `closeBrackets()` among them — so the decision is made against the _pre-insert_ document (where the trigger already is) and the insert only happens once the expansion is certain.

The expansion transaction: `{ changes, selection, effects: [setFrames], userEvent: "input.snippet", annotations: isolateHistory.of("full") }`. Visual snippets replace the selection instead of the trigger; the selection captured _before_ the insert is used because the insert already replaced it.

## Tab / Shift-Tab / Escape / Backspace (Prec.highest keymap)

| Key         | Order of attempts (first `true` wins)                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tab`       | 1. active tabstop frame → advance to next group (pop exhausted frames, continue in outer) · 2. non-automatic snippet whose trigger ends at the caret (snippets enabled) · 3. tab-out if `latex.tab-out` and ctx is math · 4. `false`              |
| `Shift-Tab` | 1. active frame → previous group · 2. `false`                                                                                                                                                                                                     |
| `Escape`    | 1. frames present → clear all, `false` (let others also see Escape)                                                                                                                                                                               |
| `Backspace` | 1. `lastExpansionAt === current doc-change counter` and history has an undo → `undo`, `true` · 2. `false`                                                                                                                                         |
| `Enter`     | 1. `latex.matrix-rows` on and caret inside an unclosed matrix-like env in display math with a non-blank row → insert `\\` + newline, `true` · 1b. same, on the blank last row → delete it and its `\\`, caret past `\end{…}`, `true` · 2. `false` |

All five return `false` in vim Normal/Visual modes. Tab-to-next-stop dispatches a selection-only transaction (`userEvent: "select"`), so it adds no undo step.

## Tabstop state field

- One `setFrames(frames)` effect carries the whole stack: push, advance and clear are all "here is the new stack", so the pop-and-advance rule lives in a single pure helper instead of three effects. The expansion transaction pushes a frame and selects its first group together.
- A frame holds `RangeSet<TabstopRange>` (plain range values, not decorations): a `Decoration.mark` may not be empty and most stops are.
- Mapping: each frame's `marks.map(tr.changes)`; frames whose set becomes empty are dropped.
- Cleared on: `Escape`, transaction with `isUserEvent("writer")` (swap/reload), vim mode leaving insert (a `ViewPlugin` watching `vim-store` for the tab), `setFrames([])`.
- Left behind: after any selection or document change, frames are popped from the top while the main caret lies outside the frame's span (first stop's start to last stop's end). Moving or typing out of a snippet abandons it, so Tab never jumps back to a stale stop.
- Decorations: `Decoration.mark({ class: "cm-latex-tabstop" })` for non-empty ranges; zero-width stops are not drawn.

## Math context rules

| Caret position                                                         | Context   |
| ---------------------------------------------------------------------- | --------- |
| inside `InlineCode`, `FencedCode`, `CodeBlock`, `HTMLBlock`            | `code`    |
| inside `Math` whose source starts with `$$`                            | `display` |
| inside any other `Math`                                                | `inline`  |
| inside math and an unclosed `\text{` precedes the caret in the formula | `text`    |
| anywhere else                                                          | `prose`   |

Caret exactly on a `$` delimiter counts as _outside_ the node on the left delimiter and _inside_ on the right (so tab-out past the closing `$` works).

## Auto-fraction (`/` in math, no snippet fired)

Operand search backwards from the caret on the current line: skip nothing; if the previous character is a closing bracket, take the balanced group and any control sequence immediately before it (`\sqrt{x}` → whole); otherwise take the maximal run of characters that are not whitespace and not `+ - = < > , ( [ {`; if that run is empty → insert literal `/`. Result: replace `operand` with `\frac{operand}{}` and push a frame with `$0` inside the denominator and `$1` after the closing brace.

## Tab-out (Tab in math, no frame, no Tab-snippet)

From the caret to the end of the line: the first of `}`, `)`, `]`, `|`, `&` (matrix/align cell separator) or `\\` (row break — moves past both characters) → move caret just past it; otherwise if the enclosing `Math` closes on this line → move past its closing delimiter; otherwise `false`. A lone `\` is a macro start, never a target.

## Enter in a matrix row (`latex.matrix-rows`)

In display math with the caret inside an unclosed `\begin{env}` where `env` is matrix-like (`*matrix*`, `array`, `subarray`, `cases`/`dcases`/`rcases`, `aligned`, `alignedat`, `gathered`, `split`) and the current row — text since the environment's opening group (skipping a `{…}` colspec) or the last `\\` — is non-blank, Enter dispatches `\\` + newline as `input.type` and returns `true`. When the row is blank, follows a `\\`, and is the environment's last row (only whitespace before `\end{env}`), Enter deletes the `\\` and the blank row and puts the caret just past `\end{env}` — Enter twice leaves the matrix. Everywhere else it returns `false`.

## Highlighting

- `latexMathNesting` = `MarkdownConfig { wrap: parseMixed(n => n.name === "MathFormula" ? { parser: latexSourceLanguage.parser } : null) }`.
- `latexAwareCodeLanguages(info)`: `latex` | `tex` (case-insensitive) → `latexSourceLanguage`; else `LanguageDescription.matchLanguageName(languages, info, true)`.
- Token → tag → CSS variable (coloured style): keyword → `--pm-syntax-keyword`; bracket → `--pm-syntax-atom`; operator → `--pm-syntax-special-variable-macro`; number → `--pm-syntax-literal`; lineComment → `--pm-syntax-comment`; processingInstruction (`$`) → `--pm-muted-color`; latexText → no colour. `all` → code font + editor font size. Plain style: `all` only.
- Bracket marks: `.cm-matchingBracket` (outline in `--accent` at reduced alpha) and `.cm-nonmatchingBracket` (`--pm-syntax-invalid`), only rendered inside math / latex fences.
- Folded (rendered) math is untouched: the widget replaces the node, so no token spans are visible (FR-024).

## Settings read at runtime (no reconfigure)

`latex.snippets-enabled`, `latex.tab-out`, `latex.auto-fraction`, `latex.matrix-rows` are read from `useSettingsStore.getState()` on each keystroke/Tab. `latex.highlight-source` drives the highlight compartment through a subscription (one `reconfigure` per change, no document change).
