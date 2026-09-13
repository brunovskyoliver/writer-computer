# Implementation Plan: Vim Mode

**Branch**: `vim-mode` (intended; planning done on `excalidraw-embed`) | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `SPECs/vim-mode/spec.md`

## Summary

Add an opt-in Vim editing mode to every markdown editor. The emulation itself comes from
`@replit/codemirror-vim` (the maintained CodeMirror 6 port of the CM5 Vim keymap, with
`@replit/codemirror-vim-core` as its engine). Writer contributes:

1. one new boolean setting (`editor.vim-mode`) in the JSON contract and a command-palette
   toggle;
2. a `vimModeExtension` in the editor extension list — a `Compartment` that holds `vim()`
   or nothing, flipped live by a settings-store subscription, with the library loaded
   lazily on first enable so the off path costs nothing;
3. Ex-command overrides (`:w`, `:q`, `:q!`, `:wq`, `:x`) wired to the app's own save
   engine and tab-close path;
4. a small Zustand store mirroring per-tab mode/pending-key/recording state, which the
   existing `DocumentFooter` renders in its own typography, plus a footer-owned "dialog
   host" element the library's `:` / `/` prompts and notifications are moved into;
5. clipboard bridging so the unnamed register and the system clipboard agree.

No Rust changes. No new floating UI.

## Technical Context

**Language/Version**: TypeScript ~5.8, React 19, CodeMirror 6 (`@codemirror/*` 6.x)

**Primary Dependencies**: `@replit/codemirror-vim` 6.4.0 (new; MIT; peer-deps
`@codemirror/{commands,language,search,state,view}` 6.x — all already installed),
Zustand (existing), `@tauri-apps/plugin-clipboard-manager` (existing)

**Storage**: settings persist through the existing `settings.schema.json` → Rust config →
`settings-store` path. Registers/marks/macros are library-global, in-memory, session-only.

**Testing**: `vp test` (Vitest, `environment: "node"`; existing tests build `EditorState`
and dispatch transactions without a DOM). Library behaviour is covered by the library's
own suite and is not re-tested here (constitution VI).

**Target Platform**: macOS desktop (Tauri v2 WKWebView)

**Project Type**: desktop-app (React frontend + Rust backend; frontend-only change)

**Performance Goals**: no measurable typing/scroll cost with Vim on (SC-003); zero work on
the typing path and no bundle growth on the startup path with Vim off (SC-004, FR-032).

**Constraints**: the dialog node must be attached to the DOM synchronously when the
library signals `dialog` (it calls `input.focus()` immediately); `vim()` must precede all
other keymaps in the extension list; the `Vim` API object is a module singleton so
`defineEx` registration must be idempotent.

**Scale/Scope**: ~6 new/changed frontend files, one JSON entry, one doc section, one
changelog entry. 10k-line notes are the reference workload.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                            | Status | Notes                                                                                                                                                                                                             |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Local-first plain text            | PASS   | No network, no new store. Files stay Markdown.                                                                                                                                                                    |
| II. Smallest correct change          | PASS   | One compartment, one store, one host element. No abstraction over the library; ex commands registered directly. The lazy import is justified by SC-004, not speculation.                                          |
| III. One place per concern           | PASS   | Setting declared once in `settings.schema.json`. Ex commands live in one registry call site (`vim-ex-commands.ts`). Mode labels come from one map. Extension list still assembled only in `editor-extensions.ts`. |
| IV. Explicit failure and owned state | PASS   | `:w` surfaces save errors through the existing `setSaveError` path; unknown ex commands surface the library's message. The vim store is written only by the extension (single writer); the footer only reads.     |
| V. Specs and docs move with the code | PASS   | Spec exists. `docs/keyboard-shortcuts.md` gains a Vim section; `CHANGELOG.md` entry; `docs/editor.md` file map updated; TODOS link.                                                                               |
| VI. Don't reinvent the wheel         | PASS   | Emulation is entirely the library's. Writer writes no motion/operator code. UI tests kept to the store + ex-command logic.                                                                                        |
| Quality gates                        | PASS   | Non-trivial logic (ex command dispatch, mode-label mapping, clipboard bridge decision) gets unit tests via injected dependencies; `vp check`/`vp test` run at each task.                                          |

No violations; Complexity Tracking left empty.

**Post-design re-check (Phase 1)**: unchanged. The design adds one accepted deviation from
"pure library": the `.cm-vim-panel` CodeMirror panel the library creates for prompts is
hidden via theme CSS and its content moved to the footer host. This is a two-line CSS rule
plus one `appendChild`, not a reimplementation — recorded in research.md R3.

## Project Structure

### Documentation (this feature)

```text
SPECs/vim-mode/
├── spec.md              # Feature spec (done)
├── plan.md              # This file
├── research.md          # Phase 0: library choice, integration decisions
├── data-model.md        # Phase 1: setting, per-tab mode state, session state
├── quickstart.md        # Phase 1: manual + automated validation
├── contracts/
│   └── vim-mode.md      # Phase 1: setting key, store shape, ex commands, DOM/CSS hooks
├── checklists/
│   └── requirements.md  # Spec quality checklist (done)
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
apps/desktop/
├── package.json                                   # + @replit/codemirror-vim (catalog)
├── shared/settings.schema.json                    # + editor.vim-mode (boolean, default false)
├── src/
│   ├── components/editor-area/
│   │   ├── editor-extensions.ts                   # + vimModeExtension() first in the list
│   │   ├── vim-mode.ts                            # NEW: compartment, lazy load, settings
│   │   │                                          #   subscription, event → store mirror,
│   │   │                                          #   dialog relocation, clipboard bridge
│   │   ├── vim-ex-commands.ts                     # NEW: :w :q :q! :wq :x → save/close
│   │   ├── vim-store.ts                           # NEW: per-tab mode state + dialog host
│   │   ├── document-footer.tsx                    # + mode indicator + dialog host slot
│   │   └── prosemark-theme.css                    # + fat-cursor / footer prompt styling
│   ├── components/command-palette/index.tsx       # + "Toggle Vim mode"
│   └── lib/editor-views.ts                        # + registration lookup by EditorView
├── tests/
│   ├── vim-store.test.ts                          # NEW
│   └── vim-ex-commands.test.ts                    # NEW
docs/keyboard-shortcuts.md                         # + Vim mode section
docs/editor.md                                     # + file-map entries
CHANGELOG.md, TODOS.md
```

**Structure Decision**: everything lives beside the other editor extensions in
`components/editor-area/`, following the existing pattern (`editor-search-*`,
`editor-clipboard.ts`). The only `lib/` touch is a lookup helper on the existing view
registry so ex-command callbacks can resolve `EditorView → tabId/path` without importing
the store from `lib/`.

## Complexity Tracking

> No constitution violations to justify.
