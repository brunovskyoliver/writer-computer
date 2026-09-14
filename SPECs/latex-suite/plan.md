# Implementation Plan: LaTeX Suite — Math Snippets and Source Highlighting

**Branch**: `latex-suite` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `SPECs/latex-suite/spec.md`

## Summary

Add an Obsidian Latex Suite-style snippet engine to the Markdown editor (auto and Tab-triggered snippets with nested tabstops, tab-out, auto-fraction), fed from one global snippet file in the Obsidian object-list syntax that is created from shipped defaults, opens as a code tab from Settings, and hot-reloads silently through a process-wide watcher on the app's config directory. Unfolded math source and `latex`/`tex` fences get five-class token highlighting from one small stream tokenizer nested into the Markdown tree, with bracket matching scoped to math.

Technical approach in one line: parse the snippet file with `acorn` (no evaluation), compile it in the frontend into a pre-sorted regex set held in a Zustand store, match it per keystroke from a CodeMirror `inputHandler` against the post-insert state, keep tabstops as a mapped `DecorationSet` stack in a `StateField`, and reuse `@codemirror/language`'s `parseMixed`, `StreamLanguage` and `bracketMatching` for highlighting.

## Technical Context

**Language/Version**: TypeScript 5.8 (React 19, CodeMirror 6) frontend; Rust (Tauri v2) backend.

**Primary Dependencies**: `@codemirror/state`, `@codemirror/view`, `@codemirror/language` (`StreamLanguage`, `parseMixed`, `bracketMatching`, `ensureSyntaxTree`), `@codemirror/lang-markdown`, `@lezer/markdown` (`wrap`), `@lezer/highlight`, `@replit/codemirror-vim` (mode check only), `zustand`, `notify` (Rust watcher, already used). **New**: `acorn` (frontend, lazy-loaded) — JavaScript expression parser for the snippet file. No new Rust crates.

**Storage**: One plain-text file `latex-snippets.js` in the app's global config directory (`app_data_dir()`, next to `config`). Toggles and snippet variables are settings in `apps/desktop/shared/settings.schema.json` (Ghostty-style `config` file, existing write path).

**Testing**: `vp test` (vitest, `environment: "node"` — no jsdom; `EditorView` is mocked in existing tests, so all engine logic must be `EditorState`-pure), `cargo test` for the Rust path/watcher helpers. Manual runtime checks per [quickstart.md](./quickstart.md).

**Target Platform**: macOS desktop (Tauri v2); code must stay platform-neutral like the rest of the app.

**Project Type**: Desktop app — React frontend in `apps/desktop/src/`, Rust backend in `apps/desktop/src-tauri/src/`.

**Performance Goals**: SC-004 — p95 keystroke-to-paint within 2 ms of the snippets-off baseline in a 5,000-line document with the full default set (~180 snippets). Per keystroke: one `ensureSyntaxTree` up to the current line end, one syntax-tree walk, one string slice, ≤ ~180 anchored regex tests on a ≤ 200-char string.

**Constraints**: Offline; no code execution from the snippet file; no editor remount, scroll or caret change on reload (FR-015); expansion is one undo step (FR-009); no snippet work in vim Normal/Visual, during IME composition, inside code, or with multiple carets.

**Scale/Scope**: ~180 default snippets, a 437-line reference file, one settings section (5 keys), one new page-kind-free code flavor for the editor, one process-wide watcher, ~12 new frontend modules, 1 new Rust command module.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                         | Status                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Local-first plain text         | PASS                            | Snippet file is a plain-text file the user owns; no network; nothing new leaves the machine. No telemetry events added.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| II. Smallest correct change       | PASS                            | No interfaces with one implementation. The one abstraction added (`editorFlavorForPath`) has two callers by construction (extension assembly + language pick). Nesting stack and tokenizer exist because the third-party alternatives fail a stated requirement (see research R2, R5). No master on/off switch beyond the four FR-025 toggles.                                                                                                                                                                                                                                      |
| III. One place per concern        | PASS                            | Defaults live in one asset (`shared/latex-snippets.default.js`) read by Rust (`include_str!`) and TS (`?raw`). Settings keys declared only in `settings.schema.json`. Editor flavor decided in one function. Settings-section extras (buttons, error list) attach via one registry entry. Option letters, mode names and error codes are single `const` tables the parser, compiler, UI and tests all import.                                                                                                                                                                       |
| IV. Explicit failure, owned state | PASS                            | Load failures keep the last valid set and are surfaced in Settings (FR-017/18); a snippet that throws or blows its time budget is disabled and reported, never swallowed. The snippet store owns file read + parse + compile + fs-event subscription; editor views only read it. Global watcher reloads every window's global settings layer under the existing process lock before emitting.                                                                                                                                                                                       |
| V. Specs and docs move with code  | PASS                            | Spec exists and is linked from `TODOS.md`. This plan adds `docs/latex-suite.md` (owning doc), a Tab/Shift-Tab entry in `docs/keyboard-shortcuts.md`, and a `CHANGELOG.md` entry — all in the implementing tasks.                                                                                                                                                                                                                                                                                                                                                                    |
| VI. Code structure (no reinvent)  | PASS with 2 recorded deviations | Reused: `acorn`, `StreamLanguage`, `parseMixed`, `bracketMatching`, `ensureSyntaxTree`, `notify`, existing settings/list control, existing file open/save/reload path, existing watcher debounce pattern. **Deviation A**: own tabstop stack instead of `@codemirror/autocomplete`'s `snippet()` — it cannot nest (FR-008) and cannot resume an outer snippet. **Deviation B**: own ~50-line LaTeX stream tokenizer instead of `legacy-modes/stex` — stex maps commands and `^ _ &` to the same style and marks `\\` as an error, failing FR-020/SC-007. Both recorded in research. |
| VII. Scope of the user            | PASS                            | Study/lecture-note workflow; the reference file is the user's own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Quality gates                     | PASS                            | Parser, compiler, matcher, replacement template, auto-fraction, tab-out, context detection and the tabstop state field each get a pure unit test; Rust path/create/reset helpers get `cargo test`. UI (settings section) is not unit-tested beyond the schema-driven registry test that already exists.                                                                                                                                                                                                                                                                             |

**Post-design re-check (after Phase 1)**: unchanged — PASS. No new abstractions were introduced by the data model or contracts beyond the ones listed; the one behaviour change outside the feature's surface (enabling `allowMultipleSelections`, which also makes the already-bound Mod-d multi-cursor work) is called out in research R7 and goes in the CHANGELOG.

## Project Structure

### Documentation (this feature)

```text
SPECs/latex-suite/
├── spec.md              # Feature spec (input)
├── plan.md              # This file
├── research.md          # Phase 0: decisions with rationale and alternatives
├── data-model.md        # Phase 1: entities, validation, state transitions
├── quickstart.md        # Phase 1: end-to-end validation scenarios
├── contracts/
│   ├── snippet-file-format.md      # what the snippet file may contain; error codes
│   ├── ipc-and-events.md           # Rust commands + Tauri events added/changed
│   ├── editor-extension.md         # engine ordering, keymaps, transactions, state
│   └── settings.md                 # schema entries and the Settings section
├── checklists/          # existing
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
apps/desktop/shared/
├── latex-snippets.default.js          # NEW shipped default set (one source: Rust include_str! + TS ?raw)
└── settings.schema.json               # + 5 entries, category "LaTeX Suite"

apps/desktop/src/
├── lib/
│   ├── editor-flavor.ts               # NEW editorFlavorForPath(path) → "markdown" | { kind: "code", language }
│   └── latex-snippets/                # NEW pure engine (no CodeMirror view, no React)
│       ├── options.ts                 #   option letters, modes, error codes (single tables)
│       ├── parse-snippet-file.ts      #   acorn → SnippetEntry[] + EntryError[] (positions)
│       ├── compile.ts                 #   variables, regex compile, validation → CompiledSnippetSet
│       ├── replacement.ts             #   template → segments (literal | tabstop | capture | visual)
│       ├── math-context.ts            #   EditorState + pos → MathContext
│       ├── match.ts                   #   (lineBefore, context, set, kind, selection) → SnippetMatch | null
│       ├── expand.ts                  #   SnippetMatch → { changes, selection, tabstopRanges }
│       ├── auto-fraction.ts           #   operand finder → TransactionSpec | null
│       └── tab-out.ts                 #   next closer on line → pos | null
├── stores/
│   └── latex-snippet-store.ts         # NEW owns file path, load status, compiled set, fs-event subscription
├── hooks/
│   └── use-file-watcher.ts            # settings:changed payload becomes nullable; nothing else
├── components/editor-area/
│   ├── editor-extensions.ts           # flavor branch; adds latexSnippetsExtension + latexHighlighting
│   ├── latex-snippets-extension.ts    # NEW CM glue: inputHandler, tabstop StateField, keymap, decorations
│   ├── latex-highlighting.ts          # NEW latexSourceLanguage, MathFormula parseMixed wrap, fence resolver,
│   │                                  #     scoped bracketMatching, highlight-style compartment
│   └── latex-snippets.css             # NEW tabstop mark + bracket match colours (theme vars)
├── components/settings-panel/
│   ├── index.tsx                      # SECTION_EXTRAS registry: { "LaTeX Suite": LatexSuiteExtras }
│   └── latex-suite-extras.tsx         # NEW Edit snippets / Reset to defaults / load-error list
└── lib/prosemark-core/syntaxHighlighting.ts   # keep mathFormulaTag rule; highlight for nested tokens lives in latex-highlighting.ts

apps/desktop/src-tauri/src/
├── commands/latex.rs                  # NEW latex_snippets_path (ensure), reset_latex_snippets
├── commands/mod.rs, lib.rs            # register commands; start global config watcher in setup
├── config.rs                          # Settings::reload_global() (re-read global layer)
└── watcher.rs                         # start_global_config_watcher: app_data_dir, non-recursive, emits to all windows

apps/desktop/tests/
├── latex-snippet-file.test.ts         # parse: reference file loads; function entries by index; syntax error line
├── latex-snippet-compile.test.ts      # options, variables, capture-count validation, priority order
├── latex-snippet-match.test.ts        # modes, word boundary, prefix triggers, macro guard, visual
├── latex-snippet-expand.test.ts       # replacement template, tabstops, placeholders, repeated stops, nesting stack
├── latex-math-context.test.ts         # prose / inline / display / \text{} / code
├── latex-auto-fraction.test.ts
├── latex-tab-out.test.ts
├── latex-highlighting.test.ts         # tokenizer classes; MathFormula mounts; latex/tex fence resolves
└── latex-default-set.test.ts          # SC-001: every default snippet expands to its declared replacement

docs/
├── latex-suite.md                     # NEW owning doc: file location/format, engine rules, undo semantics, known diffs
└── keyboard-shortcuts.md              # + Tab / Shift-Tab / Escape inside math
```

**Structure Decision**: Follow the existing split — pure logic in `src/lib/`, CodeMirror glue in `components/editor-area/`, one Zustand store per owned domain in `src/stores/`, Rust IPC in `src-tauri/src/commands/`. The engine is `EditorState`-only so the node test runner can exercise it without a DOM.

## Complexity Tracking

| Violation                                            | Why Needed                                                                                                                                         | Simpler Alternative Rejected Because                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own tabstop stack (not `@codemirror/autocomplete`)   | FR-007/FR-008: nested snippets must resume the outer snippet's remaining stops; `$0` first; repeated stops as multi-selection.                     | `snippet()` replaces the active snippet on every new one and exposes no way to re-activate arbitrary ranges; its field state is not exported. Wrapping it would need a fork.           |
| Own LaTeX stream tokenizer (not `legacy-modes/stex`) | FR-020/SC-007 need five distinct classes incl. `^ _ & \\` as operators and numbers everywhere.                                                     | stex styles commands and `^ _ &` both as `tag`, styles `\\` as `error` in math mode, and only recognises numbers inside `$…$`. A `HighlightStyle` cannot split one token style in two. |
| Engine-level "mid-macro" guard (research R4)         | Replaces the reference file's priority-3 _function_ guard so raw `\text`, `\arcsin` typing is not mangled; declarative snippets cannot express it. | Dropping the guard breaks daily typing (`\text` → `\\text{}`); shipping the function would mean executing user code (forbidden by FR-002a).                                            |
