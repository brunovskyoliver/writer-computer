# Implementation Plan: Color Highlights in Formulas and Prose

**Branch**: `formula-highlight-colors` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `SPECs/formula-highlight-colors/spec.md`

## Summary

Paint a selected fragment of a `$…$` / `$$…$$` formula, or a run of prose, in one of six
fixed palette colours. The colour is written into the Markdown file itself — `\textcolor{#hex}{…}`
inside math, `<span style="color:#hex">…</span>` in prose — so it survives in Obsidian, on
GitHub, and in any other reader (Constitution I).

The technical spine is **validate-before-write**: the math emitter walks a four-entry ladder of
candidate ranges — the user's exact selection first, then progressively wider structural ones —
screening each with three cheap syntactic guards and then with `katex.__parse`. The first candidate
that passes both is written; if none does, the document is left untouched and a notice is shown.
KaTeX is the parser that already ships with the app, so FR-008 and FR-009 cost a brace counter and
a short list instead of a LaTeX grammar.

The guards are not decoration. `\textcolor{c}{^2}` **parses** while meaning a superscript with no
base, so "first candidate that parses" would silently colour the wrong thing — the ladder and its
guards exist because of that measured result (see [research.md](./research.md) R2).

The second thing validation cannot catch: KaTeX accepts nested colour wrappers, so FR-013's
no-nesting rule gets no backstop from parsing. It is made structural instead — every write first
strips existing wrappers across the affected range, then re-emits per region, which also resolves
the partial-overlap edge case (research R8).

Everything else is reuse: `mathContext()` decides math vs prose and already excludes code;
`hidableNodeFacet` conceals the prose markup; `foldableSyntaxFacet`/`MathWidget` already repaint
the rendered formula on every doc change.

## Technical Context

**Language/Version**: TypeScript 5 (React 19 frontend); no Rust changes

**Primary Dependencies**: CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@lezer/markdown`),
KaTeX 0.16.47, Zustand. **No new dependency.**

**Storage**: The Markdown file on disk. No sidecar, no database, no app-private store (FR-003,
Constitution I).

**Testing**: `vp test` (node-only Vitest, no jsdom) for the pure modules — palette, emitters,
expand-and-validate, the round-trip removal. CodeMirror glue and the bar's placement are verified
by the manual walk in [quickstart.md](./quickstart.md), matching the precedent set by
`SPECs/latex-suite` (`EditorView` cannot be constructed in this runner).

**Target Platform**: Tauri v2 desktop (macOS primary)

**Project Type**: Desktop app — React frontend over a Rust backend; this feature is frontend-only.

**Performance Goals**: No visible flash of uncoloured output (SC-003). Satisfied for free: the write
is a single `view.dispatch`, and `renderMath` is synchronous and LRU-cached, so the widget repaints
in the same `toDOM` pass as any other edit (see `docs/editor.md`).

**Constraints**: Offline (no network on a document path). `trust: false` stays on in `renderMath` —
`\textcolor` needs no relaxation, verified empirically (research R1). Validation runs only on the
colour press, never per keystroke, so no interactive path gains work.

**Scale/Scope**: ~6 new frontend files plus 3 edited ones; six palette colours; two emitters.

No NEEDS CLARIFICATION remain — the two open questions (does expansion actually rescue the
failing cases; does this parser emit a node for inline HTML) were both resolved empirically before
this plan was written. See research R2 and R4.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — still passing._

| Principle                                     | Status | How                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Local-First Plain Text**                 | PASS   | The highlight _is_ the file text. No store, no account, no network. Both emitted forms render in other Markdown readers (SC-004).                                                                                                                                                                                                                                                               |
| **II. Smallest Correct Change**               | PASS   | No new parser, no new popover framework, no new dependency. The only hand-written scanning is a ~15-line brace-depth counter used to locate the ladder's wider candidates; it never learns command arity, `\left`/`\right` or environments, because `katex.__parse` owns those judgements. The one new abstraction — the emitter pair — has two implementations, which is what FR-007 asks for. |
| **III. One Place Per Concern**                | PASS   | Adding a colour edits `highlight-palette.ts` only; the bar, both emitters and the detector all iterate it. Adding a _context_ would edit the emitter registry only. The `#hex` written into the document derives from the same table that styles the bar — no parallel list.                                                                                                                    |
| **IV. Explicit Failure and Owned State**      | PASS   | FR-009's refusal is a visible `showEditorNotice`, not a silent no-op and not a fallback that writes something broken. FR-017's stale-position check closes the bar rather than writing to a mapped guess.                                                                                                                                                                                       |
| **V. Specs and Docs Move With the Code**      | PASS   | Spec exists and is linked from `TODOS.md:5`. `CHANGELOG.md` is updated in the implementing change; `docs/keyboard-shortcuts.md` only if a shortcut is bound (FR-018); `docs/editor.md` gains the validate-before-write rule since it owns editor-extension rules.                                                                                                                               |
| **VI. Code structure / no wheel reinvention** | PASS   | KaTeX is the LaTeX parser, `hidableNodeFacet` is the concealment engine, `foldableSyntaxFacet` is the repaint engine, `showEditorNotice` is the notice channel. Tests stay on the pure modules; UI is reviewed by hand per the "do not over-test UI" rule.                                                                                                                                      |

**No entries in Complexity Tracking** — no violation needed justifying.

### One correction to the spec's Assumptions

The spec assumes "the existing LaTeX source parser already used for math token highlighting is the
basis for the balanced-expansion rule". That parser (`latexSourceLanguage` in
`components/editor-area/latex-highlighting.ts`) is a flat `StreamLanguage` tokenizer — it emits six
token classes and **no nesting**, so it cannot report balanced groups. The assumption's _intent_ is
honoured (no new parser is introduced); its _mechanism_ is wrong and is replaced by `katex.__parse`.
Recorded in research R2 rather than silently ignored.

## Project Structure

### Documentation (this feature)

```text
SPECs/formula-highlight-colors/
├── spec.md              # Input
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── document-format.md   # What lands in the .md file — the portability promise
│   └── palette.md           # The single-source-of-truth colour table
├── checklists/          # Pre-existing
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
apps/desktop/src/
├── lib/highlight/                      # NEW — pure, node-testable, no CodeMirror imports
│   ├── palette.ts                      # FR-014: the six colours, one definition
│   ├── emit.ts                         # FR-005/FR-006: math + prose emitters, the detector
│   │                                   #   that reads a highlight back out, and the
│   │                                   #   normalise-then-re-emit rule (FR-013, research R8)
│   └── math-range.ts                   # FR-008/FR-009: the candidate ladder, the three guards,
│                                       #   and katex.__parse as adjudicator
├── components/editor-area/
│   ├── highlight-bar.tsx               # NEW — FR-001/FR-002/FR-017: selection-anchored bar
│   ├── highlight-command.ts            # NEW — FR-003/FR-011/FR-012/FR-013: the one write path
│   ├── highlight-decorations.ts        # NEW — FR-015/FR-016: conceal markup, colour the glyphs
│   ├── highlight.css                   # NEW
│   ├── editor-extensions.ts            # EDIT — register the decorations + the bar's plugin
│   └── math-renderer.ts                # EDIT — export a `validateMath` using katex.__parse
└── components/command-palette/index.tsx  # EDIT — FR-018: one command entry

apps/desktop/tests/
└── highlight.test.ts                   # NEW — palette, emitters, expand-and-validate, round-trip
```

**Structure Decision**: Existing Writer layout, unchanged. Pure logic goes in `lib/highlight/` so it
is exercisable in the node-only runner; every CodeMirror and React touch stays in
`components/editor-area/`, keeping side effects at the boundary (Constitution IV). The split is not
speculative layering — it is what makes the branch-heavy expansion logic testable at all.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
