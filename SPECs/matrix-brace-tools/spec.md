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
3. Tab inside a matrix row moves past the next `&` or `\\` on the line, then past `}`, then past `$$`. Inside a cell-capable environment Tab instead walks elements in the same row — past `&` or a thin-space separator (`\;`, `\,`, `\:`) — and at the row's last element it appends a separator in the env's existing style so a fresh element opens; the caret never crosses `\\` (Enter owns rows).
4. Enter inside a matrix-like environment (`*matrix*`, `array`, `cases`/`dcases`/`rcases`, `aligned`, `gathered`, `split`, `subarray`) in display math inserts `\\` and a newline when the current row has content; on an empty row or outside such an environment Enter behaves as before.
5. The behaviours are switchable per `latex.matrix-rows` and `latex.matrix-cells` in Settings → LaTeX Suite; default on.

### US2 — Annotate a selection with a brace (P1)

With text selected, `Cmd+Alt+U` wraps it in `\underbrace{…}_{}` and `Cmd+Alt+O` in `\overbrace{…}^{}`, with the caret inside the annotation group so the note is typed next. Inside math the selection wraps in place; in prose the command emits `$\underbrace{\text{…}}_{\text{…}}$` so the bracket renders in either context. The annotation group is raw math for math selections (type `text` or `"` for a prose note — the suite's own snippets) and `\text{}` for prose selections. KaTeX sizes the brace and the note to the content, so the annotation adapts to whatever is typed.

**Acceptance**:

1. Selecting `x^2 + 2x` inside math and pressing `Cmd+Alt+U` yields `\underbrace{x^2 + 2x}_{}` with the caret between `_{` and `}`; `Cmd+Alt+O` yields the `^{}` form.
2. Selecting prose yields `$\underbrace{\text{…}}_{\text{}}$` with the caret inside the annotation's `\text{}`; complete `$…$`/`$$…$$` islands inside the prose are lifted out of `\text{}` and emitted as math, and TeX specials in the remaining text runs (`$ & # _ { } %`) are escaped, so `rows $*$ columns` wraps as `\underbrace{\text{rows }*\text{ columns}}` instead of corrupting the line.
3. An empty selection, a selection that starts or ends _inside_ a formula (islands that close inside the selection are fine), code, or a selection whose wrap would not parse (e.g. `^` inside `\text{}`) writes nothing and shows a notice — never a broken document.
4. One command press is one undo step.
5. Both commands are in the command palette and the editor context menu (Format submenu).

### US3 — Re-bracket an existing matrix (P2)

The user has matrices written as `\begin{cases}…\end{cases}` — a habit that renders a lone left `{` instead of matrix brackets. With the caret anywhere inside the env (including a nested non-bracketed env like `aligned`), a "Matrix: …" command rewrites only the `\begin{…}`/`\end{…}` env names to `pmatrix`/`bmatrix`/`Bmatrix`/`vmatrix`/`Vmatrix`/`cases` — one undo step, rows and cells untouched.

**Acceptance**:

1. Caret inside `\begin{cases}` + "Matrix: square brackets" yields `\begin{bmatrix}…\end{bmatrix}`.
2. Caret inside a nested non-bracketed env (e.g. `aligned` inside `cases`) re-brackets the enclosing bracketed env.
3. `array` is never a target or a victim — its `{…}` colspec would be left as a literal group.
4. No bracketed matrix around the caret shows a notice and writes nothing.

## Requirements

- **FR-1**: Tab-out targets gain `&` (cell separator) and `\\` (row break), jumping just past them. This extends the latex-suite rule in `contracts/editor-extension.md` and FR-012a of that spec.
- **FR-2**: `matrixRowBreak(formula, caret)` is a pure function: the caret is inside an unclosed `\begin{env}` of a matrix-like env and the current row (text since the env's opening group — skipping an `{…}` colspec — or the last `\\`) is non-blank.
- **FR-3**: The Enter handler runs only on the primary caret with an empty selection, only in display math, only when `latex.matrix-rows` is on, and returns `false` otherwise so list continuation and plain newlines are untouched.
- **FR-4**: `emitBraceWrap(fragment, side, math)` is pure: it returns the insert text and the caret offset inside the annotation group.
- **FR-5**: The write is validated with `validateMath` before dispatch (the same "never write what won't render" rule as highlights); failures show an `editor-notice` and leave the document unchanged.
- **FR-6**: Commands are `insert.underbrace` / `insert.overbrace` in the `editorCommands` registry — one entry gives keymap, context-menu, and palette access per the registry contract.
- **FR-7**: A successful wrap puts Vim into insert mode (via `Vim.handleKey(cm, "i")` on the view's adapter), so the annotation can be typed immediately. No-op when Vim is off or already inserting.
- **FR-8**: The prose form splits the fragment into text runs and `$…$`/`$$…$$` math islands — the same spans the markdown math scanner recognises (unescaped delimiters, Pandoc opener/closer guards). Islands emit raw inside the brace; text runs emit inside `\text{}` with `$ & # _ { } %` escaped to `\x`. A selection ending exactly on a math node's closing `$` counts as prose-with-islands, not a mix; starting inside a formula or ending mid-formula still refuses. The emitted formula never contains a `$`, so it re-parses as one math node.
- **FR-9**: `enclosingMatrixEnv(formula, caret)` is pure: it returns the env name plus the two `\begin{…}`/`\end{…}` name spans of the nearest _re-bracketable_ env enclosing the caret (`[pbBvV]?matrix`, `[dr]?cases` — argument-free envs sharing the `\\`/`&` grammar). Six `matrix.*` registry commands rewrite just those spans; reachable from the palette and the context menu's Matrix submenu.
- **FR-10**: `matrixCellTarget(formula, caret)` is pure: inside a cell-capable env (`*matrix*`, `smallmatrix`, `array`, `subarray`, `[dr]?cases`, `aligned`, `alignedat`, `split` — not `gathered`, which has one column) it returns a `move` past the next top-level `&` or `\;`/`\,`/`\:` in the same row (skipping `{…}` groups and nested environments), or an `insert` that appends a separator matching the env's existing style (`&` or the thin space) after the last element when the row has none left. Null on an empty row, inside the `\\` pair, inside `\begin{…}`/`\end{…}`, or outside an env — plain tab-out keeps those. Runs between snippet expansion and tab-out in the Tab handler, gated by `latex.matrix-cells`, one undo step for the insert.

### US4 — Write out a general matrix from its size (P1)

Lecture notes spell out general matrices element by element (`a_{11} & a_{12} & \dots`). `Cmd+Alt+M` opens a one-line prompt at the caret; the user types a size and a letter (`3x3 a`, `2 4 b`, `2 by 3`, `3,3,\lambda`; the letter defaults to `a`) and Enter writes a `bmatrix` whose cells are the indexed elements.

**Acceptance**:

1. `2x3 a` inside display math writes `\begin{bmatrix}` / `a_{11} & a_{12} & a_{13}\\` / `a_{21} & a_{22} & a_{23}` / `\end{bmatrix}` at the caret, with the caret just past `\end{bmatrix}`.
2. Inside inline math the matrix is written on one line; in prose it arrives in its own `$$` block.
3. Once rows or columns exceed 9 the indices take a comma (`a_{1,10}`).
4. A size that does not parse (or exceeds 20) keeps the prompt open and marks it invalid; Escape, clicking back into the editor, or typing in it closes the prompt without writing. Code and `\text{}` refuse with a notice.
5. Reachable from the command palette ("Matrix: Insert Matrix of Size…") and the Matrix context submenu; one undo step.

## Requirements (continued)

- **FR-11**: `parseMatrixSpec(input)` and `matrixTemplate(spec, { inline })` are pure (`src/lib/latex-snippets/matrix-template.ts`). The prompt is a CodeMirror tooltip anchored at the caret (`matrix-insert.ts`) — not a panel, which the theme hides — registered as `insert.matrix` in the `editorCommands` registry.
- **FR-12**: A snippet's tabstop frame is abandoned once the caret leaves its span (see the latex-suite editor-extension contract), so after a subscript or fraction is finished, Tab reaches the FR-10 cell walk instead of jumping back to a stale stop.

## Non-goals

- A grid editor — the size prompt (US4) plus the env triggers cover matrix entry.
- Annotation rendering outside math (HTML/CSS braces over prose) — the portable LaTeX form is what Obsidian and other readers understand.
- Editing/removing an existing brace annotation — plain text edits already do that.
