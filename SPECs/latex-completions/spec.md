# Feature Specification: LaTeX command completion

**Created**: 2026-09-30

**Status**: Implemented — e2e: `apps/desktop/e2e/specs/latex-completion.spec.js`

**Input**: "Can we also introduce suggestions when I type the slash command … like the suggestions in VS Code or Neovim." Read as: typing `\` in LaTeX opens a completion list, as LaTeX Workshop / texlab do.

**Builds on**: [`SPECs/latex-documents/spec.md`](../latex-documents/spec.md) (math-context facet, `.tex` sources), [`SPECs/latex-suite/spec.md`](../latex-suite/spec.md) (tabstop frames).

## Behaviour

- **US1 — Commands.** Typing `\` + letters opens a fuzzy-filtered list. Inside math (notes and `.tex`): the symbol palette's table (`src/lib/math/symbols.ts`) plus math constructions (`\frac`, `\sqrt`, `\sum`, `\underbrace`, …). In `.tex` prose: document commands (`\section`, `\textbf`, `\cite`, `\includegraphics`, …). Symbols show a KaTeX-rendered preview beside their name. Macros the document defines (`\newcommand`, `\renewcommand`, `\DeclareMathOperator`) come first, with one stop per argument. Nothing in note prose, `%` comments, or right after a `\\` row break.
- **US2 — Templates.** Accepting inserts the entry's template (`\frac{$0}{$1}$2`) through the snippet engine's tabstop frames, so Tab walks the arguments exactly like a snippet and the caret-leaves-frame rule applies.
- **US3 — Environments.** After `\begin{`, environment names for where the caret is (lists, figure, table, equation, align in prose; the matrix family, cases, aligned, array in math). Accepting writes the whole block through `\end{…}` with the caret inside. `\begin` itself reopens the list for the name.
- **US4 — References and citations.** After `\ref{` / `\eqref{` (and `\autoref`, `\cref`, `\pageref`): labels from `\label{…}` in the document, plus sibling `.tex` files for a LaTeX source. After `\cite{` (`\citep`, `\citet`, optional args): keys from `.bib` files in the same folder with their titles; with several keys, the one after the last comma.
- **US5 — Keys.** Tab or Enter accepts, arrows move, Escape closes, `Ctrl-Space` opens explicitly. While the list is open, the snippet engine's Tab (matrix cells, tab-out) and Enter (matrix rows) step aside.

## Requirements

- **FR-1**: One `autocompletion()` per view (`editorCompletion(sources)` in `latex-completion.ts`); CodeMirror rejects two configs with different `override`s. The note flavor passes the wiki-link and LaTeX sources, the LaTeX source flavor the LaTeX one.
- **FR-2**: The catalog (`src/lib/latex-completions/catalog.ts`) is pure data plus `renderTemplate`, `labelsIn`, `bibEntriesIn`, all unit-tested.
- **FR-3**: Where to complete comes from `mathContext` (the state facet), so notes and `.tex` sources share one rule.

## Non-goals

- A language server (texlab): package-aware command lists, macro discovery across files, diagnostics. The built-in catalog covers the common set with no process to manage.
