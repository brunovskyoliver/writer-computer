# Feature Specification: LaTeX documents with a live PDF preview

**Created**: 2026-09-30

**Status**: Implemented (2026-09-30) — e2e: `apps/desktop/e2e/specs/latex-preview.spec.js`

**Input**: "I'm going to write a lot of LaTeX for the semester project. Editing a `.tex` file, I'd like to see the preview beside it in the other pane, and toggle the preview on and off." Approved scope: the Tectonic plan (steps 1–5) plus the math snippets and matrix tools inside `.tex` files. SyncTeX click-to-jump and texlab autocomplete are later work.

**Builds on**: [`SPECs/pdf-quote-links/spec.md`](../pdf-quote-links/spec.md) (PDF pane, split beside a note), [`SPECs/latex-suite/spec.md`](../latex-suite/spec.md) (snippet engine, math context), [`SPECs/matrix-brace-tools/spec.md`](../matrix-brace-tools/spec.md).

## Decisions

- **Compile, don't approximate.** The preview is the real PDF from [Tectonic](https://tectonic-typesetting.github.io/) (XeTeX, packages fetched on demand and cached), shown in the existing PDF pane. What is on screen is what gets handed in. A browser-side renderer (latex.js) was rejected: no bibliography, partial package support, different layout.
- **Tectonic is found, not bundled.** Looked up on `PATH` and in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin` (a GUI app does not inherit the shell's `PATH`). Missing → an explicit notice naming `brew install tectonic`; nothing silently fails.
- **The PDF lands next to the root `.tex`** (`report.tex` → `report.pdf`), ready to submit. Intermediates are not kept.
- **Code editor, not the note editor.** `.tex` / `.bib` open in the plain code flavor (`src/lib/editor-flavor.ts`), not prosemark: Markdown parsing and math folding have no business in a LaTeX source.

## User Scenarios

### US1 — See my `.tex` files (P1)

`.tex` and `.bib` files appear in the sidebar, the file search index, the watcher, and MCP `list_files` (kind `latex`). They open as LaTeX source with highlighting and save like notes. Labels keep the extension (`report.tex`) so the source and its `report.pdf` are told apart.

### US2 — Toggle the preview (P1)

In a `.tex`/`.bib` tab, `Cmd+Alt+P` (also "LaTeX: Toggle PDF Preview" in the palette) opens the root's PDF in a split beside the source, compiling first when the PDF is missing or older than the source. Pressing it again closes every tab showing that PDF. A failed first compile opens nothing and shows the first error.

### US3 — The preview follows my edits (P1)

While the root's PDF is open anywhere, every save of the root or a file it compiles with (any `.tex`/`.bib` resolving to that root) recompiles, debounced so a burst of autosaves is one compile, and never two compiles of one root at once (a save during a compile queues exactly one more). `Cmd+Enter` saves and compiles immediately. A successful compile reloads the PDF pane in place: the previous rendering stays on screen until the new one is ready, and the scroll position is kept.

### US4 — Errors point at the line (P1)

A failed compile keeps the last good PDF. The source tab's footer shows the state — "Compiling…", "PDF updated · 1.3 s", or "2 errors · line 5: Undefined control sequence" — and clicking an error line jumps there. Errors and LaTeX warnings with a line are also marked in the editor (underline + hover text) for the file they belong to.

### US5 — Multi-file projects (P2)

The root is resolved per file: a `% !TEX root = main.tex` magic comment in the first 20 lines wins; else a `.tex` with `\documentclass` is its own root; else (a chapter, or a `.bib`) the one sibling `.tex` in the same folder that has `\documentclass`. No root found → a notice asking for the magic comment.

### US6 — Math tools inside `.tex` (P1)

The math snippets, auto-fraction, Tab/Enter matrix navigation, `Cmd+Alt+M` matrix prompt, and `Cmd+Alt+U`/`O` braces work in `.tex` files. Math is detected from the source text: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and the `equation`, `align`, `gather`, `multline`, `eqnarray`, `math`, `displaymath`, `flalign`, `alignat` environments (starred too), skipping `%` comments and `\$`. Everything else is prose; `\text{…}` inside math is prose as in notes.

## Requirements

- **FR-1**: `is_sidebar_file` accepts `.tex` and `.bib`; `is_markdown_file` does not. MCP `entry_kind` reports `latex`.
- **FR-2**: `compile_latex(path)` (Rust) resolves the root (US5), runs Tectonic with the root's folder as working directory, a 180 s timeout, and returns `{ status: "ok" | "failed" | "engine-missing" | "no-root", root, pdfPath, diagnostics, durationMs, log }`. Diagnostics come from Tectonic's `error: <file>:<line>: <message>` summaries and `LaTeX Warning: … on input line N` log lines; an error without a location is kept message-only. Compiler pipes are drained with 8 KiB read and line buffers and a 64 KiB retained byte tail per stream. The returned log is capped to its last 200 lines and 128 KiB after UTF-8 decoding, including truncation markers. At most 200 diagnostics are returned, prioritizing the earliest errors over warnings and reserving a slot for timeout/fallback/truncation notices. Output beyond the caps is still drained and truncation is reported. Startup, reader, process-management and root-lookup worker failures return IPC errors. Roots are canonical filesystem paths; magic comments resolve against the requested source directory before canonicalization. Symlinked roots compile and write their PDF in the physical root directory.
- **FR-3**: The frontend resolves roots before coalescing requests. Native compiles hold a process-wide lock per canonical root through process/reader cleanup, including calls from different windows. Other roots can run independently; expired lock entries are pruned. One compile per root in flight; saves during a compile set a single rerun flag. Auto-compile only while the root's PDF is open in a tab.
- **FR-4**: `acquirePdf`/`releasePdf` take a revision; the document cache is keyed by path + revision and the asset URL carries `?v=<revision>` so WebKit never serves a stale file. A compile bumps the revision of the PDF it wrote.
- **FR-5**: The math context used by the snippet engine and every math command is chosen by a state facet: Markdown syntax tree (notes) or the LaTeX source scanner (US6). The scanner is a pure function with its own tests.
- **FR-6**: `latex.togglePreview` and `latex.compile` are `editorCommands` registry entries (keymap, palette) bound in the LaTeX flavor only.

## Non-goals (this round)

- SyncTeX forward/inverse search; texlab completion and diagnostics.
- Bundling a TeX engine, or `pdflatex`/`latexmk` engines.
- Creating `.tex` files from the "New note" flow.
