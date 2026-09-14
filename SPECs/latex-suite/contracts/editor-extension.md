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
dispatch(insert())                                   // keystroke lands as its own "input.type"
ctx = mathContext(state, caret)                      // post-insert, after ensureSyntaxTree(lineEnd, 20ms)
if ctx.kind ∈ {code, text}                           → true (done)
if snippets-enabled:
  m = match(lineBefore, ctx, set, "auto", selection-before-insert)
  if m → dispatch(expansion(m)) ; return true
if auto-fraction enabled and typed text === "/" and ctx is math:
  spec = autoFraction(state, caret) ; if spec → dispatch(spec) ; return true
return true
```

The expansion transaction: `{ changes, selection, effects: [pushFrame], userEvent: "input.snippet", annotations: isolateHistory.of("full") }`. Visual snippets replace the selection instead of the trigger; the selection captured _before_ the insert is used because the insert already replaced it.

## Tab / Shift-Tab / Escape / Backspace (Prec.highest keymap)

| Key         | Order of attempts (first `true` wins)                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Tab`       | 1. active tabstop frame → advance to next group (pop exhausted frames, continue in outer) · 2. non-automatic snippet whose trigger ends at the caret (snippets enabled) · 3. tab-out if `latex.tab-out` and ctx is math · 4. `false` |
| `Shift-Tab` | 1. active frame → previous group · 2. `false`                                                                                                                                                                                        |
| `Escape`    | 1. frames present → clear all, `false` (let others also see Escape)                                                                                                                                                                  |
| `Backspace` | 1. `lastExpansionAt === current doc-change counter` and history has an undo → `undo`, `true` · 2. `false`                                                                                                                            |

All four return `false` in vim Normal/Visual modes. Tab-to-next-stop dispatches a selection-only transaction (`userEvent: "select"`), so it adds no undo step.

## Tabstop state field

- `pushFrame(frame)` effect: stack push; the first group is selected in the same transaction.
- Mapping: each frame's `DecorationSet.map(tr.changes)`; frames whose set becomes empty are dropped.
- Cleared on: `Escape`, transaction with `isUserEvent("writer")` (swap/reload), vim mode leaving insert (a `ViewPlugin` watching `vim-store` for the tab), `clearFrames` effect.
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

From the caret to the end of the line: the first of `}`, `)`, `]`, `|` → move caret just past it; otherwise if the enclosing `Math` closes on this line → move past its closing delimiter; otherwise `false`.

## Highlighting

- `latexMathNesting` = `MarkdownConfig { wrap: parseMixed(n => n.name === "MathFormula" ? { parser: latexSourceLanguage.parser } : null) }`.
- `latexAwareCodeLanguages(info)`: `latex` | `tex` (case-insensitive) → `latexSourceLanguage`; else `LanguageDescription.matchLanguageName(languages, info, true)`.
- Token → tag → CSS variable (coloured style): keyword → `--pm-syntax-keyword`; bracket → `--pm-syntax-atom`; operator → `--pm-syntax-special-variable-macro`; number → `--pm-syntax-literal`; lineComment → `--pm-syntax-comment`; processingInstruction (`$`) → `--pm-muted-color`; latexText → no colour. `all` → code font + editor font size. Plain style: `all` only.
- Bracket marks: `.cm-matchingBracket` (outline in `--accent` at reduced alpha) and `.cm-nonmatchingBracket` (`--pm-syntax-invalid`), only rendered inside math / latex fences.
- Folded (rendered) math is untouched: the widget replaces the node, so no token spans are visible (FR-024).

## Settings read at runtime (no reconfigure)

`latex.snippets-enabled`, `latex.tab-out`, `latex.auto-fraction` are read from `useSettingsStore.getState()` on each keystroke/Tab. `latex.highlight-source` drives the highlight compartment through a subscription (one `reconfigure` per change, no document change).
