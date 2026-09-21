# Feature Specification: Matrix entry aids and brace annotations

**Created**: 2026-09-21

**Status**: Implemented

**Input**: User description: "introduce matrices and their shortcuts into the LaTeX suite … a shortcut which renders a curly bracket above or below the selected text — it can be LaTeX, a text, or just regular text — so I can highlight something and there is a curly bracket around it, above or below, and I can put a comment in there. The text above and below should adjust to the text around it."

**Builds on**: [`SPECs/latex-suite/spec.md`](../latex-suite/spec.md) — the snippet engine, tab-out, and math context; [`SPECs/latex-math-spec.md`](../latex-math-spec.md) — KaTeX rendering of `$…$`/`$$…$$`.

## User Scenarios

### US1 — Fill a matrix without leaving the keyboard (P1)

The user types `pmat` inside `$$…$$`, gets `\begin{pmatrix}`/`\end{pmatrix}` with the caret inside, types `1 & 2`, presses Enter for a new row (`\\` + newline inserted), fills `3 & 4`, and Tabs out past `\end{pmatrix}`. `bmat`, `Bmat`, `vmat`, `Vmat`, `matrix`, `smallmatrix`, `cases`, `dcases`, `rcases`, `gathered`, `split`, and `array` (with a `{cc}` column-spec tabstop) work the same way.

**Acceptance**:

1. Typing `array` in math produces `\begin{array}{cc}` with the caret on the column spec — previously it emitted `\begin{array}` with no colspec, which does not render.
2. Typing `smallmatrix` produces `\begin{smallmatrix}…\end{smallmatrix}` — not `small\begin{matrix}` (the bare `matrix` trigger is a suffix of `smallmatrix`; the alternation lists the longer name so the leftmost match covers the whole word).
3. Tab inside a matrix row moves past the next `&` or `\\` on the line, then past `}`, then past `$$`.
4. Enter inside a matrix-like environment (`*matrix*`, `array`, `cases`/`dcases`/`rcases`, `aligned`, `gathered`, `split`, `subarray`) in display math inserts `\\` and a newline when the current row has content; on an empty row or outside such an environment Enter behaves as before.
5. The behaviour is switchable per `latex.matrix-rows` in Settings → LaTeX Suite; default on.

### US2 — Annotate a selection with a brace (P1)

With text selected, `Cmd+Alt+U` wraps it in `\underbrace{…}_{}` and `Cmd+Alt+O` in `\overbrace{…}^{}`, with the caret inside the annotation group so the note is typed next. Inside math the selection wraps in place; in prose the command emits `$\underbrace{\text{…}}_{\text{…}}$` so the bracket renders in either context. The annotation group is raw math for math selections (type `text` or `"` for a prose note — the suite's own snippets) and `\text{}` for prose selections. KaTeX sizes the brace and the note to the content, so the annotation adapts to whatever is typed.

**Acceptance**:

1. Selecting `x^2 + 2x` inside math and pressing `Cmd+Alt+U` yields `\underbrace{x^2 + 2x}_{}` with the caret between `_{` and `}`; `Cmd+Alt+O` yields the `^{}` form.
2. Selecting prose yields `$\underbrace{\text{…}}_{\text{}}$` with the caret inside the annotation's `\text{}`.
3. An empty selection, a selection spanning math and prose, code, or a selection whose wrap would not parse (a raw `{`, `$`, or newline inside `\text{}`) writes nothing and shows a notice — never a broken document.
4. One command press is one undo step.
5. Both commands are in the command palette and the editor context menu (Format submenu).

## Requirements

- **FR-1**: Tab-out targets gain `&` (cell separator) and `\\` (row break), jumping just past them. This extends the latex-suite rule in `contracts/editor-extension.md` and FR-012a of that spec.
- **FR-2**: `matrixRowBreak(formula, caret)` is a pure function: the caret is inside an unclosed `\begin{env}` of a matrix-like env and the current row (text since the env's opening group — skipping an `{…}` colspec — or the last `\\`) is non-blank.
- **FR-3**: The Enter handler runs only on the primary caret with an empty selection, only in display math, only when `latex.matrix-rows` is on, and returns `false` otherwise so list continuation and plain newlines are untouched.
- **FR-4**: `emitBraceWrap(fragment, side, math)` is pure: it returns the insert text and the caret offset inside the annotation group.
- **FR-5**: The write is validated with `validateMath` before dispatch (the same "never write what won't render" rule as highlights); failures show an `editor-notice` and leave the document unchanged.
- **FR-6**: Commands are `insert.underbrace` / `insert.overbrace` in the `editorCommands` registry — one entry gives keymap, context-menu, and palette access per the registry contract.
- **FR-7**: A successful wrap puts Vim into insert mode (via `Vim.handleKey(cm, "i")` on the view's adapter), so the annotation can be typed immediately. No-op when Vim is off or already inserting.

## Non-goals

- A matrix-size picker or grid editor — `beg` plus the env triggers cover arbitrary environments.
- Annotation rendering outside math (HTML/CSS braces over prose) — the portable LaTeX form is what Obsidian and other readers understand.
- Editing/removing an existing brace annotation — plain text edits already do that.
