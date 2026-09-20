# Implementation Plan: Global Content Search

**Branch**: `global-content-search` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/SPECs/global-content-search/spec.md`

## Summary

A `Cmd+Shift+F` content-search palette that finds literal substring matches
(smart-case) inside every workspace file — markdown, other text-decodable
files, and PDFs — mirroring the `Cmd+P` palette's cmdk dialog structure with an
added ~5-line context preview for the highlighted result. A new Rust
`content_search` command walks the workspace with the same gitignore-aware
`ignore` walker the file index uses, matches text files line-by-line in
parallel, and streams results over a `tauri::ipc::Channel` so matches render
progressively; the walk also emits the PDFs it finds, and the frontend extracts
and matches their page text through the existing `lib/pdf.ts` pdf.js boundary.
Results are one `SearchMatch` shape ordered by file mtime desc, capped ~20 per
file and ~200 total with a truncation indicator. Activation reuses the app's
existing handoffs: a pending line target for text files (extending
`lib/pending-anchor.ts`) and `requestPdfAnchor` with the `page=`/`text=`
fragment grammar for PDFs.

## Technical Context

**Language/Version**: TypeScript (React, Zustand, cmdk) + Rust 2021, Tauri v2

**Primary Dependencies**: `cmdk` (palette), `@tauri-apps/api` `Channel`
(progressive results), `pdfjs-dist` (PDF page text, via `lib/pdf.ts` lazy
boundary), `ignore` crate (gitignore-aware walk), `parking_lot` (state locks).
No new dependencies.

**Storage**: None — scans read files on disk at query time; no index or
persisted state is added.

**Testing**: `cargo test` (matching core, walk, caps, smart-case — pure seams
like `fuzzy_search_impl`), `vp test` (merge/truncate/preview-selection reducers,
PDF line splitting).

**Target Platform**: macOS desktop (Tauri webview; same code paths as the rest
of the app on other platforms).

**Project Type**: desktop-app (Tauri v2 — React frontend + Rust backend over
IPC).

**Performance Goals**: first results within ~250ms of typing on workspaces of a
few thousand files (SC-001); progressive rendering — matches appear as the
parallel walk finds them, not after the scan completes (FR-015).

**Constraints**: ~20 matches per file, ~200 results total, with a truncation
indicator (FR-010); literal smart-case matching only (FR-011); superseded
queries must not overwrite newer results (FR-012); scan is I/O+CPU work and
must run off the IPC hot path (`spawn_blocking`), with at most one active scan
per window.

**Scale/Scope**: workspaces of a few thousand files; bounded per-file read
(~4 MiB) so a large binary can't stall an interactive scan.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                            | Verdict | Notes                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Local-First Plain Text            | PASS    | Scan reads local files only; no network, no store, no new telemetry events.                                                                                                                                                                                                                                                                                                                                            |
| II. Smallest Correct Change          | PASS    | Reuses the `ignore` walker, `pending-anchor` handoff, `requestPdfAnchor`/`page=` fragment grammar, `openFile` tab-reuse, cmdk dialog, and the `lib/pdf.ts` lazy boundary. No index, no new crate, no new decoration machinery (the match highlight on arrival is a CodeMirror selection / the PDF pane's existing emphasis).                                                                                           |
| III. One Place Per Concern           | PASS    | Corpus enumeration lives only in the Rust walk; the result list lives only in the content-search store/hook; the PDF fragment grammar stays only in `lib/pdf-anchor.ts`. One acknowledged bounded duplication: the ~10-line smart-case line matcher exists once in Rust (text files) and once in TS (PDF page lines), because pdf.js cannot run in Rust — each side is pinned by its own tests (research R3).          |
| IV. Explicit Failure and Owned State | PASS    | One active scan per window via a `cancel_search` flag slot mirroring `cancel_index`; stale events dropped by a monotonic query seq; PDF extraction failures surface as that file simply not matching (scanned PDFs/binaries skipped per spec), and unreadable-file errors are skipped per entry like the index walker, never silently swallowed wholesale — scan errors on the command itself propagate as `AppError`. |
| V. Specs and Docs Move With Code     | PASS    | This spec dir is the feature's doc set; `docs/keyboard-shortcuts.md` gains `Cmd+Shift+F` and `CHANGELOG.md` is updated in the same change.                                                                                                                                                                                                                                                                             |
| VI. Don't Reinvent the Wheel         | PASS    | cmdk for the palette, pdf.js for PDF text, `ignore` for the walk — all existing deps. A Rust PDF extractor (`pdf-extract`/`lopdf`) was rejected (research R3).                                                                                                                                                                                                                                                         |

No violations → Complexity Tracking stays empty.

_Post-design re-check (Phase 1 complete): the design added no dependencies, no
persisted state, and no second write path — `cancel_search` mirrors the
`cancel_index` slot pattern, the result list has one owner (the content-search
hook), and both activation handoffs extend existing seams rather than
paralleling them. All gates still pass._

## Project Structure

### Documentation (this feature)

```text
SPECs/global-content-search/
├── plan.md              # This file
├── spec.md              # Feature spec (input)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── content-search-ipc.md
│   ├── palette.md
│   └── line-target.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
apps/desktop/src-tauri/src/
├── state.rs             # + cancel_search flag slot (mirrors cancel_index)
├── commands/search.rs   # + content_search command, matcher, walk, tests
└── lib.rs               # register content_search

apps/desktop/src/
├── types/fs.ts          # SearchMatch / ContentSearchEvent types (replaces
│                        #  the dead ContentSearchResult stub)
├── lib/tauri.ts         # contentSearch invoke binding (query → Channel)
├── lib/pending-anchor.ts            # PendingTarget union (slug | line target)
├── lib/pdf.ts                       # + pdfSearchLines(path) extraction export
├── lib/pdf-search.ts (new)          # page-line splitting + smart-case matcher
├── stores/ui-store.ts               # CommandPaletteIntent += "content-search"
├── components/content-search/ (new)
│   ├── index.tsx                    # CommandDialog + results + preview pane
│   └── use-content-search.ts        # debounce, channel, seq guard, merge/cap
├── components/command-palette/…     # unchanged — search stays filename-only
├── hooks/use-keyboard-shortcuts.ts  # Cmd+Shift+F, gated on workspace root
├── hooks/editor-api.ts              # + openSearchMatch route (text | pdf)
└── components/editor-area/
    └── use-prosemark-editor.ts      # consume line target → scroll + select

docs/keyboard-shortcuts.md           # Cmd+Shift+F entry
CHANGELOG.md                          # feature entry
```

**Structure Decision**: the scan lives in `commands/search.rs` beside
`fuzzy_search`/`index_workspace_impl` — it is the same subsystem (workspace
enumeration + matching) and shares the walker filters and `modified_time`
helper. The palette gets its own `components/content-search/` directory rather
than a new intent branch inside `command-palette/index.tsx`: the surfaces share
the cmdk dialog chrome and the ui-store open flag, but the result model,
preview pane, and data source are unrelated to file search — co-locating them
would put two result pipelines in one component.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations.
