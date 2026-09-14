# Implementation Plan: PDF Viewing, Highlighting and Quote Links

**Branch**: `pdf-quote-links` | **Date**: 2026-09-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `SPECs/pdf-quote-links/spec.md`

## Summary

A `pdf` page kind joins the existing page-kind registry beside `drawing`, so a PDF opens
in its own tab, splits, and restores like any other surface. The viewer is `pdfjs-dist`,
lazy-imported and worker-backed so render work never touches the note's main thread. A
selection or dragged region raises one floating button that inserts a Markdown blockquote
plus a path-qualified `[[paper.pdf#page=..&…]]` wiki link into the visible note. Clicking
that link resolves through the existing wiki-link click path, reuses an already-open PDF
pane when there is one, scrolls to the anchor and flashes a fading highlight.

One refactor precedes the feature: the four `isDrawingPath` branches in `editor-store.ts`
collapse into a single registry-derived predicate, so adding the PDF kind touches one file
rather than four (Principle III). See `research.md` R4.

Two spec items are deliberately not built: FR-027 rests on a false premise and is deferred
with a recommendation (research.md R5); reopened-PDF highlight painting is already a
documented non-goal.

## Technical Context

**Language/Version**: TypeScript 5.8 (React 19), Rust (Tauri v2)

**Primary Dependencies**: `pdfjs-dist` (new, via `catalog:` in `pnpm-workspace.yaml`);
existing React 19, Zustand, CodeMirror 6, Tauri v2

**Storage**: Plain files on disk. The PDF is read-only. Anchors live in the note's
Markdown text — no sidecar, no database (Principle I).

**Testing**: `vp test` (Vitest) for the frontend; `cargo test` for the sidebar predicate.
Per Constitution VI, UI is not over-tested: pure logic (anchor grammar, coordinate mapping,
resolution ordering, the standalone-surface predicate) gets unit tests; rendering does not.

**Target Platform**: macOS desktop (Tauri v2), offline

**Project Type**: Desktop app — React frontend + Rust backend

**Performance Goals**: First page visible < 1 s (SC-001); no perceptible typing delay in an
adjacent note while a 500-page PDF scrolls (SC-002); flat memory across a full scroll
(SC-003); already-visible quote resolves < 300 ms (SC-006)

**Constraints**: Fully offline. PDF never written to. Page rendering and text extraction
confined to the pdf.js worker. Rendered pages bounded by a window around the viewport, not
by document length. No PDF content in the workspace index or search.

**Scale/Scope**: Documents up to thousands of pages / hundreds of MB; single-window
resolution; one new page kind, one new viewer component, one new lib module.

## Constitution Check

_GATE: checked before Phase 0, re-checked after Phase 1 design._

| Principle                            | Assessment                                                                                                                                                                                                                                                                                      | Verdict                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| I. Local-First Plain Text            | Anchors are text in the user's `.md`. Quote renders as a blockquote plus a named link in any editor (SC-007). `pdfjs-dist` is bundled, not fetched. No network path.                                                                                                                            | PASS                        |
| II. Smallest Correct Change          | No abstraction with one caller. The refactor in R4 _removes_ a branch chain rather than adding generality; it is justified by a second real case, not a speculative third. Every caller of the touched predicate was enumerated (R4 table) before planning the edit.                            | PASS                        |
| III. One Place Per Concern           | The page-kind registry already makes a kind a one-entry addition. The four `isDrawingPath` sites are the exception and are fixed _first_, so adding the PDF kind touches one file. The sidebar predicate `is_sidebar_file` is already single-source and mirrors `DRAWING_EXTENSION` by comment. | PASS, after the R4 refactor |
| IV. Explicit Failure and Owned State | Corrupt/encrypted PDF, missing path, unlocatable passage, absent target note each produce a named message (FR-012, FR-018, FR-025, FR-026, SC-009). No fallback masks a failure. Render tasks are cancelled on scroll-away rather than racing.                                                  | PASS                        |
| V. Specs and Docs Move With Code     | Spec exists and is linked from `TODOS.md`. `CHANGELOG.md` updated in the shipping change. `docs/consolidation.md` gains the R4 case; the page-kind registry comment stays accurate.                                                                                                             | PASS                        |
| VI. Code structure                   | `pdfjs-dist` used rather than writing a renderer. UI not over-tested; logic is.                                                                                                                                                                                                                 | PASS                        |
| VII. Scope of the user               | Reading papers beside notes with a round-trip back to the source is the core studying workflow this tool exists for.                                                                                                                                                                            | PASS                        |

**Post-Phase-1 re-check**: no new violation. The design adds one page-kind module, one
view, one lib module and one Rust one-liner. Nothing in `contracts/` introduces a second
write path or a second link syntax. FR-027 is recorded in Complexity Tracking rather than
implemented, with its reason.

## Project Structure

### Documentation (this feature)

```text
SPECs/pdf-quote-links/
├── spec.md              # Feature specification (input)
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── quote-link.md    # The `[[pdf#anchor]]` fragment grammar
│   └── page-kind.md     # The registry contract the `pdf` kind satisfies
├── checklists/
│   └── requirements.md  # Pre-existing
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
apps/desktop/src/
├── lib/
│   ├── pdf.ts                     # NEW — lazy pdfjs import, worker setup, document
│   │                              #       cache, page text extraction. Mirrors
│   │                              #       lib/drawings.ts's lazy-import boundary.
│   └── pdf-anchor.ts              # NEW — anchor encode/parse, region rect math,
│                                  #       passage re-find. Pure; unit-tested.
├── components/editor-area/
│   ├── pdf-pane.tsx               # NEW — viewer: virtualized page list, toolbar,
│   │                              #       text layer, region overlay, highlight flash
│   ├── pdf-quote-button.tsx       # NEW — floating selection/region action
│   ├── page-kinds/
│   │   ├── pdf.ts                 # NEW — the `pdf` page kind (behavior)
│   │   ├── index.ts               # EDIT — one registry entry + Location union member
│   │   └── views.tsx              # EDIT — one view entry
│   └── wiki-link-extension.ts     # EDIT — route .pdf targets to PDF resolution
├── lib/wiki-links.ts              # EDIT — extension-preserving PDF target resolution
│                                  #        (follows resolveWikiImage, not resolveWikiLink)
└── stores/
    └── editor-store.ts            # EDIT — R4 refactor: 4 isDrawingPath sites → 1
                                   #        registry-derived predicate; PDF pane resolution

apps/desktop/src-tauri/src/
└── commands/fs.rs                 # EDIT — `is_sidebar_file` accepts `.pdf` (one line)
```

**Structure Decision**: The existing desktop app layout is used unchanged. The feature
lands as one new page-kind module plus its view, two new `lib/` modules for logic that must
be testable away from the DOM, and single-line edits at the three registry/predicate points
that already exist to absorb a new kind. No new top-level directory, no new package.

## Phase Summary

**Phase 0** (`research.md`): renderer choice, worker strategy, anchor encoding, the R4
predicate audit, the FR-027 defect, passage re-find, region coordinates. All
NEEDS CLARIFICATION resolved.

**Phase 1** (`data-model.md`, `contracts/`, `quickstart.md`): entity shapes for Document,
Anchor, Quote and View; the quote-link fragment grammar; the page-kind contract; runnable
validation scenarios mapped to acceptance criteria.

## Complexity Tracking

> Recorded deviations, per the Compliance clause: principle named, reason, option chosen.

| Violation                                                                                                                                 | Why Needed                                                                                                                                                                                                   | Simpler Alternative Rejected Because                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refactor of 4 `isDrawingPath` sites in `editor-store.ts` — a change wider than the feature strictly needs (Principle II, smallest change) | Principle III forbids a per-case chain: without it, adding the PDF kind is a 4-site edit and the _next_ kind is a 5-site edit. The two principles conflict here and III governs the structure.               | Copying the drawing branches for PDF is a smaller diff but installs the exact drift `docs/consolidation.md` was written about — site 886 would keep drawings working while letting PDFs open twice, the failure verified in research.md R4.                                                                               |
| FR-027 (rename rewrites quote links in note bodies) **not implemented** (Principle V — a stated requirement left unbuilt)                 | The requirement's premise is false: no note-body link rewriting exists today (research.md R5). Building it PDF-only creates a second link-rewriting path, violating Principle III the moment it generalizes. | Implementing it for PDFs only was rejected for the reason above; implementing it workspace-wide is a separate feature affecting every `[[link]]`, with its own unspecified semantics for notes and drawings. Renamed-PDF links fail explicitly per FR-026, so no silent wrong behavior ships. Recommend a follow-up spec. |
