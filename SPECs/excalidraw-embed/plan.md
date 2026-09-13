# Implementation Plan: Excalidraw Embed + Edit

**Branch**: `excalidraw-embed` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `SPECs/excalidraw-embed/spec.md`

## Summary

Drawings live as files beside the note, render inline in the markdown editor, and open in a
full Excalidraw editor tab on double-click. A drawing the user made last week must open,
edit, and re-save without loss — **repeatedly**, not once. That requirement is the spine of
this plan and it is what Phase 0 exists to guarantee.

Approach: `@excalidraw/excalidraw` behind a dynamic `import()`, a new `drawing` page kind,
and inline embeds carried by the image-embed path that already ships. The storage format is
**decided by a spike, not by preference** — see the branch gate below.

## The branch gate (read this before anything else)

Editability is non-negotiable, so the plan has two outcomes and both of them satisfy it.
The spike in Phase 0 decides only _how much the inline render costs_:

| Phase 0 result       | Format                                   | Inline render cost                                   | Interop                                                      |
| -------------------- | ---------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| **Round-trip holds** | `.excalidraw.svg`, scene in SVG metadata | Zero JS — plain `<img>`                              | Viewable anywhere; editable where the metadata is understood |
| **Round-trip fails** | `.excalidraw` raw JSON                   | Excalidraw chunk loads on notes containing a drawing | Opens natively on excalidraw.com and in Obsidian             |

Both branches keep drawings editable forever; only the second costs a bundle load on read.
The hybrid (JSON + sibling SVG) stays rejected — two files holding one truth, per
Constitution Principle III.

Phases 2–5 are written against the shared surface and are **identical on both branches**.
Only Phase 1 differs.

## Technical Context

**Language/Version**: TypeScript 5.8, React 19.1; Rust (Tauri v2) for the file-write path

**Primary Dependencies**: `@excalidraw/excalidraw@0.18.1` (new — peer-compatible with React
19, confirmed). Plus its mandatory `@excalidraw/excalidraw/index.css` import.

**Storage**: Plain files in the user's workspace, beside the note. No database, no app-owned
store.

**Testing**: `vp test` (Vitest) for pure logic — format detection, path derivation, name
collision. Per Constitution Principle VI, **no UI test suite for the editor tab**; it is
verified by hand and reviewed by the user.

**Target Platform**: macOS desktop (Tauri v2), offline-capable

**Project Type**: Desktop app — React frontend + Rust backend

**Performance Goals**: A note containing drawings scrolls indistinguishably from a note
containing PNGs. Zero Excalidraw code evaluated until a drawing tab is opened (branch A).

**Constraints**: Must work with no network. Excalidraw's CDN asset default has to be
retargeted at bundled assets.

**Scale/Scope**: Single user, personal notes. Tens of drawings per workspace, not thousands.

## Constitution Check

_GATE: evaluated before Phase 0, re-check after Phase 1._

| Principle                            | Status                               | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Local-First Plain Text            | ⚠️ **Tension — resolved by Phase 0** | Raw `.excalidraw` JSON is unambiguously local-first: it opens on excalidraw.com and in Obsidian today. An embedded-scene SVG is _viewable_ everywhere but _editable_ elsewhere only where the metadata convention is understood. This is a real cost of branch A, not a formality. Phase 0 settles whether the performance win is worth it; if the round-trip is at all fragile, Principle I points at branch B. No network is required on either branch. |
| II. Smallest Correct Change          | ✅                                   | One new dependency doing work we would never hand-write (Principle VI says so explicitly). Explicitly **not** generalizing `mermaid-canvas.ts` into a shared `svg-canvas.ts` — that is a refactor for a second caller that may never exist, and it stays out of this plan entirely, including as a later phase.                                                                                                                                           |
| III. One Place Per Concern           | ✅                                   | The one real risk, and Phase 2 is built around it: path → tab-location is currently constructed in five places. Consolidating to a single helper _before_ adding drawing dispatch is a prerequisite, not cleanup.                                                                                                                                                                                                                                         |
| IV. Explicit Failure and Owned State | ✅                                   | A drawing that fails to parse shows an error in the tab; it is never silently replaced with a blank canvas, which would destroy the user's work on the next save. Saves go through the existing `commands/fs.rs` write path so `watcher.rs` self-write detection applies.                                                                                                                                                                                 |
| V. Specs and Docs Move With the Code | ✅                                   | Spec exists and is linked from `TODOS.md`. `CHANGELOG.md` on completion. `docs/editor.md` gains the drawing widget/page-kind notes.                                                                                                                                                                                                                                                                                                                       |
| VI. No Reinvention, No Over-Testing  | ✅                                   | Third-party library over a hand-rolled canvas. Logic tests only; UI reviewed by the user at the checkpoints marked below.                                                                                                                                                                                                                                                                                                                                 |

No violations requiring justification. The Principle I tension is a decision the spike
makes, and it is recorded above rather than waved through.

## Project Structure

### Documentation (this feature)

```text
SPECs/excalidraw-embed/
├── spec.md              # Research + decision record (exists)
├── plan.md              # This file
└── tasks.md             # /speckit-tasks output — NOT created by this command
```

Deliberately under `SPECs/` rather than a new `specs/` tree: macOS's case-insensitive
filesystem would alias `specs/` onto the existing `SPECs/`, and a second spec home is the
drift Principle III exists to prevent.

**Running speckit commands for this feature requires
`SPECIFY_FEATURE_DIRECTORY=SPECs/excalidraw-embed` in the environment.** `setup-plan.sh`
also persisted that value to `.specify/feature.json`. Treat that file as generated pointer
state: it is not committed, and it must not be relied on — a later feature that forgets the
env var would otherwise plan silently into _this_ directory.

### Source Code

```text
apps/desktop/src/
├── components/editor-area/
│   ├── page-kinds/
│   │   ├── drawing.ts            # NEW — `drawing` page kind (behavior)
│   │   ├── index.ts              # +1 entry in the `kinds` tuple
│   │   └── views.tsx             # +1 entry in the view registry
│   ├── drawing-pane.tsx          # NEW — lazy-loaded Excalidraw host
│   └── wiki-link-extension.ts    # dblclick → open drawing tab
├── lib/
│   ├── drawings.ts               # NEW — format detect, path derive, collision
│   └── wiki-links.ts             # unchanged (svg already in the allowlist)
└── stores/
    └── editor-store.ts           # consolidate path → location, then dispatch

apps/desktop/tests/
└── drawings.test.ts              # NEW — logic only, no UI suite
```

**Structure Decision**: Slots into the existing editor-area layout. The page-kind registry
(`page-kinds/index.ts` + `views.tsx`) is already built so a new tab type costs exactly two
entries; nothing else in the tab system is touched.

## Phase 0 — The spike (gate; nothing else starts until this reports)

A throwaway module, deleted before Phase 1 commits. It answers four questions in one export
run. **Not** a "check the docs" task — an executed experiment.

1. **Repeated round-trip.** Export a scene with `appState.exportEmbedScene: true`, reimport
   with `loadFromBlob`, diff the element array. Then **edit and export again, and reimport
   again** — at least two full cycles. "Revisit and edit" is a repeated operation; a format
   can survive one cycle and degrade on the second.
2. **Image elements survive.** The spike drawing must contain an embedded image so the
   scene's `files` map is exercised. This is the likeliest thing to be dropped when a scene
   rides inside SVG metadata, and it fails silently — the drawing just loses its picture.
3. **Fonts.** The spike drawing must contain text. Grep the exported SVG for `@font-face`
   and `base64`; load it via `convertFileSrc` in an `<img>` and look at the glyphs. A remote
   `@font-face` cannot be fetched from inside a sandboxed `<img>`, so this fails visibly.
4. **Real chunk size.** `vp build` with a dynamic `import("@excalidraw/excalidraw")`; read
   the emitted chunk list. The 46 MB npm unpacked figure is tarball-with-sourcemaps and is
   not the number that matters.

**Gate:** losing `files`, `appState`, or elements on cycle two is a spike **failure**, not a
caveat — take branch B. Report all four results to the user before Phase 1 (Principle VI).

## Phase 1 — Storage format and I/O

_Branch A (round-trip holds):_ `lib/drawings.ts` gains `isDrawingPath()` (compound
`.excalidraw.svg` check — a plain `.svg` is an image, not a drawing), save via `exportToSvg`
with `exportEmbedScene: true` and `exportBackground: false` (so the drawing sits on the
note's own background and reads correctly in both themes; an `<img>`-hosted SVG is inert and
cannot react to theme changes afterward), load via `loadFromBlob`.

_Branch B (round-trip fails):_ `isDrawingPath()` matches `.excalidraw`. Save via the
package's own `serializeAsJSON` rather than a hand-rolled `JSON.stringify` — the format is
`{ type, version, source, elements, appState, files }`, and a bare scene object missing that
envelope is rejected by excalidraw.com and Obsidian, which would destroy branch B's only
advantage (Principle VI: don't re-derive what the library exports). Inline embeds need a
CodeMirror widget that dynamically
imports the bundle and calls `exportToSvg`, following the `MermaidWidget` shape in
`mermaid-decorations.ts` (bounded LRU cache, stable `estimatedHeight`, sync `toDOM`).

Both branches: write through the existing Rust `commands/fs.rs` path. Do **not** add a
second write path — `watcher.rs` self-write detection keys off it, and a save that bypasses
it reads back as an external change and can reload the tab under the user's cursor.

## Phase 2 — Open routing (prerequisite for Phase 3)

Consolidate before extending. `{ kind: "file", path }` is built in five places today:
`createFileTab` (`editor-store.ts:119`, called from lines 370, 412, 450, 532) plus one
inline construction in `navigateToFile` at line 660 that bypasses the factory. Route all six
through one `locationForPath(path)` helper, then add drawing dispatch **inside that helper
only**.

Branching in `openFile` instead would not work: it delegates to `replaceTabWithFile` and
`navigateToFile`, and `openFileInNewTab` is a separate entry — drawings would still open as
raw text from the sidebar and from wiki-link navigation. `open_target::classify` in Rust
stays untouched; it gates startup/CLI/Finder opens only.

Test: `locationForPath` over a table of extensions. Cheap, and it is the piece that silently
regresses.

## Phase 3 — The drawing tab

New `drawing` page kind (`kind`, `title` from the filename stem, `paths`, `primaryPath`,
`rewritePath`, `removePath`, `serialize` so tabs survive session restore) plus a
`drawing-pane.tsx` that `React.lazy`-loads Excalidraw.

- `window.EXCALIDRAW_ASSET_PATH` points at bundled assets — the app must work offline.
- `theme` mirrors `appearance.theme`. The editor otherwise keeps Excalidraw's own look;
  restyling it to match Writer is out of scope and would break on every upgrade.
- Save on a debounce, following `SOURCE_CHANGE_DEBOUNCE_MS = 150` in `mermaid-canvas.ts`.
  Excalidraw's `onChange` fires continuously; an undebounced write would hammer the disk and
  the watcher.
- A file that fails to parse renders an error in the tab. It must **not** fall back to an
  empty canvas — the next autosave would then overwrite the user's real drawing with
  nothing. Principle IV, and the highest-consequence failure mode in the feature.

**User review checkpoint** (Principle VI): stop here and have the user open, edit, close,
and reopen a drawing before proceeding.

## Phase 4 — Inline embed and double-click

Branch A needs no render code: `WIKI_IMAGE_EXTENSIONS` (`lib/wiki-links.ts:124`) already
contains `svg`, so `![[x.excalidraw.svg]]` renders today through `ImageEmbedWidget`. Branch B
needs the widget from Phase 1.

Both: a `dblclick` handler on the embed resolves the target to an absolute path and opens
the drawing tab through Phase 2's helper.

Out of scope, stated so it is not mistaken for a bug — **live-refreshing an already-open
note's embed after a save**. Three layers cache it: `embedResolutionCache`
(`wiki-link-extension.ts:116`), the per-URL measured-height cache behind
`attachStableImageHeight`, and the webview's cache of the stable `convertFileSrc` URL.
Reopening the note shows the new version. Making it live means cache-busting the asset URL
on the watcher event and re-measuring height — real work, deliberately deferred.

## Phase 5 — Creating a drawing

Without this the feature is unusable: the user would have to hand-author a drawing file and
type the embed themselves.

- **"New Drawing" command** in the command palette. Order is load-bearing: write the file,
  **then insert `![[name.excalidraw.svg]]` into the source document, then open the drawing
  tab** — opening the tab moves focus off the note, so an insert afterwards has no cursor to
  target.
- Invoked from anywhere that is not a file tab (launcher, settings, a drawing tab), there is
  no note and no cursor: create the file and open the tab, insert nothing.
- **Location**: the note's own directory. Writer has no attachment-folder concept and this
  plan does not add one (Principle II — a config key for a value that never varies).
- **Naming**: `drawing.excalidraw.svg`, and on collision `drawing-1`, `drawing-2`, … The
  suffix search is a loop over a file-existence check, so it gets a unit test.
- Also reachable from the sidebar's existing new-file context menus if that costs one
  registry entry; skip it if it costs more.

## Phase 6 — Docs and wrap

`docs/editor.md` gains the drawing page kind and (branch B only) the widget notes.
`CHANGELOG.md` gets the user-visible entry. `TODOS.md` moves the task to Done. One commit
per completed phase, per the Development Workflow section of the constitution.

## Complexity Tracking

> No Constitution Check violations require justification. Recorded here because they are
> decisions a reviewer should see, not violations.

| Decision                                                       | Why                                                                                                                 | Rejected alternative                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| New dependency `@excalidraw/excalidraw`                        | Principle VI is explicit: use the library rather than reinvent it. Hand-rolling a drawing canvas is months of work. | Hand-rolled canvas — absurd for the value.                                    |
| Phase 2 consolidates five call sites before adding one feature | Principle III: adding the next case must touch one file. Today it would touch six.                                  | Branch in `openFile` — leaves sidebar and wiki-link opens broken.             |
| Format chosen by spike, not up front                           | Editability is non-negotiable; the round-trip is unverified.                                                        | Assume branch A — risks shipping a format that loses work on the second edit. |
| `mermaid-canvas.ts` stays mermaid-specific                     | Principle II: no generalization for a caller that may never exist.                                                  | Extract `svg-canvas.ts` now — speculative.                                    |
