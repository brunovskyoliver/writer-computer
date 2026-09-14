# Excalidraw Embed + Edit Spec

**Status**: approved for implementation. **Branch A** chosen at the Phase 2 spike gate
(T009) — `.excalidraw.svg` with the scene in SVG metadata, embeds rendered as plain
`<img>`. The measurements behind that choice are in
[`../Agent/worksheet-excalidraw-embed.md`](../Agent/worksheet-excalidraw-embed.md); the
task breakdown is in [`tasks.md`](./tasks.md) and the phase rationale in
[`plan.md`](./plan.md).

## Summary

Drawings live as `.excalidraw.svg` files beside the note. A note embedding one renders it
inline with no Excalidraw code loaded at all — the file is an SVG, and Writer's existing
image-embed path already handles SVGs. Double-clicking the embed opens the drawing in a
full Excalidraw editor tab; edits save back to the same file. A "New Drawing" command
creates the file in the note's directory, inserts the embed at the cursor, and opens the
tab.

The scene rides in the SVG's metadata, so the same file is both the rendered picture and
the editable source. The Phase 2 spike confirmed this survives repeated export → import →
edit cycles with `elements`, `appState`, and the `files` map intact — that was the
condition for choosing this format over raw `.excalidraw` JSON.

## Goals

- A drawing is one file on disk, readable as a picture by anything that renders SVG.
- `![[drawing.excalidraw.svg]]` in a note renders inline at zero JavaScript cost —
  scrolling a note with ten drawings is indistinguishable from ten PNGs.
- Double-clicking an inline drawing opens it in an Excalidraw editor tab on that file.
- Edits save on Cmd+S, tab close, window close, or application quit back to the same path through the existing Rust write path, without the
  watcher reading the save as an external change.
- A drawing tab survives session restore.
- "New Drawing" creates the file, inserts the embed, and opens the tab in one command.
- Everything works with no network reachable.
- A file that fails to parse shows an error and **never** saves over the user's work.

## Non-Goals

- Rendering raw `.excalidraw` JSON inline (that was Branch B, not taken).
- Restyling the Excalidraw editor to match Writer's design language. It keeps its own look;
  only `theme` is mirrored from `appearance.theme`.
- Collaboration, the Excalidraw library/shapes browser, or excalidraw.com sync.
- Converting existing Obsidian-plugin drawings.
- An attachment-folder setting. Writer has no such concept and this feature does not add
  one — new drawings go in the note's own directory.
- A pan/zoom frame around the inline embed. `mountMermaidCanvas` could be generalised into
  a shared `svg-canvas.ts` for this, but that is a refactor for a second caller that may
  never exist. Not now, and not as a later phase of this spec.
- **Live-refreshing an already-open note's embed after a drawing is saved.** Three layers
  cache it: `embedResolutionCache` (`wiki-link-extension.ts:116`), the per-URL
  measured-height cache behind `attachStableImageHeight`, and the webview's cache of the
  stable `convertFileSrc` URL. Reopening the note shows the new version. Making it live
  means cache-busting the asset URL on the watcher event and re-measuring height — real
  work, deliberately deferred. Recorded here so it is not filed as a bug.

## UX Decisions

- **Extension.** `.excalidraw.svg`, matched as a compound extension. A plain `.svg` is an
  image, not a drawing, and must keep opening as one.
- **Inline embed is a plain `<img>`.** No widget, no decoration module, no lazy chunk.
- **Double-click, not single-click,** opens the editor tab — single-click must keep
  selecting the embed for the existing range-select-to-edit behaviour.
- **Transparent background.** Drawings export with `exportBackground: false` and sit on the
  note's own background. Accepted cost: Excalidraw bakes strokes at `#1e1e1e` and an
  `<img>`-hosted SVG is inert, so a drawing is hard to read on a dark background. The
  alternative — `exportBackground: true` with an explicit `viewBackgroundColor`, which the
  spike proved round-trips — puts a light card on a dark note instead. Neither is free;
  transparent is the smaller change and the one chosen.
- **Text in embeds renders in a serif fallback.** WebKit rejects the subset woff2 that
  Excalidraw inlines into the export (`Excalifont: error`; the shipped full font loads
  fine). Shapes, strokes, and embedded images are unaffected. This is a known cost of the
  `<img>` path, not a defect to chase — see Implementation Notes for the escape hatch.
- **Explicit saves only.** Cmd+S saves the focused drawing. Tab/window close and application
  quit await pending drawing saves and remain open on failure. Drawing callbacks do no
  exporting, serialization, file writes, or timer scheduling. Reopening or moving a tab
  reuses its live session without saving.
- **Parse failure shows an error in the tab and disables saving for that tab.** It must
  not fall back to an empty canvas — the next save would overwrite the real drawing
  with nothing. This is the highest-consequence failure mode in the feature.
- **New Drawing** names files `drawing`, then `drawing-1`, `drawing-2`, … on collision, in
  the note's own directory. Run from anywhere that is not a file tab (launcher, settings,
  another drawing tab), it creates the file in the workspace root and opens the tab with no
  insert and no error.

## Implementation Notes

- **One module owns the format.** `lib/drawings.ts`: `isDrawingPath()` (compound
  `.excalidraw.svg`), save via `exportToSvg({ exportEmbedScene: true, exportBackground:
false })`, load via `loadFromBlob` returning a parse error rather than an empty scene, and
  `nextAvailableDrawingPath()` for the collision suffix.
- **The export flags must be set on every write.** `loadFromBlob` returns them at their
  defaults (`exportEmbedScene: false`, `exportBackground: true`) regardless of what the
  file was written with, so they can never be read back off disk. User-facing appState —
  `viewBackgroundColor` was the probe — does round-trip correctly.
- **One write path.** Drawing saves go through `tauri.writeFile` (`lib/tauri.ts:31` →
  `write_file` in `commands/fs.rs:344`). A second write path would defeat `watcher.rs`
  self-write detection, and the save would read back as an external change and reload the
  tab under the user's cursor.
- **Open routing is consolidated before drawing dispatch is added, not after.** A tab
  location is built in six places in `editor-store.ts` today: `createFileTab` (line 119)
  and its four callers (370, 412, 450, 532), plus an inline `{ kind: "file", path }` in
  `navigateToFile` (line 660) that bypasses the factory. All six route through one
  `locationForPath(path)` helper, and the `isDrawingPath` dispatch lives **inside that
  helper only**. Branching in `openFile` would not work — it delegates to
  `replaceTabWithFile` and `navigateToFile`, and `openFileInNewTab` is a separate entry, so
  drawings would still open as raw text from the sidebar and from wiki-link navigation.
  `open_target::classify` in Rust stays untouched; it gates startup/CLI/Finder opens only.
- **The inline embed needs no render code.** `WIKI_IMAGE_EXTENSIONS`
  (`lib/wiki-links.ts:124`) already contains `svg`, so `![[x.excalidraw.svg]]` renders
  through `parseWikiImageEmbedTarget` → `ImageEmbedWidget`
  (`wiki-link-extension.ts:141`), and `![](x.excalidraw.svg)` resolves through
  `image-src-resolver.ts`. Confirm by hand; write nothing.
- **Offline assets are mandatory, not optional.** With `window.EXCALIDRAW_ASSET_PATH`
  unset, Excalidraw fetches fonts from `esm.sh`. Offline, that fetch fails and
  `exportToSvg` **does not throw** — it silently writes a smaller file whose `@font-face`
  points at a remote URL. The bundled asset path must be in place before the first save.
  Bundling every family costs 13 MB because Xiaolai (CJK) is 12 MB of it; the other eight
  total ~480 KB. **Decided at T028: bundle the eight, exclude Xiaolai** (596 KB copied). A
  drawing containing CJK text therefore falls back to a system font. The copy runs from
  `apps/desktop/vite.config.ts` into `public/excalidraw-assets/` — gitignored and
  regenerated on every dev start and build, so it cannot drift from the installed package.
  `window.EXCALIDRAW_ASSET_PATH` is set to an absolute href resolved from
  `window.location.href`: Excalidraw resolves a value starting with `/` or `./` against
  `window.location.origin`, which is not the right base under Tauri's custom scheme.
- **The lazy boundary is a module, not a component.** `views.tsx` is statically imported by
  the tab renderer, so `drawing-pane.tsx` holds only
  `React.lazy(() => import("./drawing-editor"))`. Everything that touches the package — the
  `Excalidraw` component, `@excalidraw/excalidraw/index.css`, and the
  `EXCALIDRAW_ASSET_PATH` assignment — lives in `drawing-editor.tsx`. Verified at the build:
  the entry chunk contains no occurrence of `excalidraw`, and the 142 KB of CSS emits as its
  own `drawing-editor-*.css`.
- **Change tracking is disarmed until the first non-empty change.** Excalidraw emits an `onChange`
  at mount that can carry an empty element array before `initialData` is applied; saving that
  would overwrite a real drawing with nothing, without any parse failure involved. Once
  armed, an empty scene is a genuine "user deleted everything" and does save. Dirty scenes remain owned by their path when a view unmounts. Closing a tab saves
  before removing it; detaching or reattaching a view does not export.
- **A drawing is never an open _file_.** `drawingKind.primaryPath` returns `null`, so a
  drawing tab publishes no `activeFilePath`, and `ensureFileLoaded` returns early on a
  drawing path (dropping any optimistic placeholder its callers inserted). That guard sits
  in the one shared function rather than at the six call sites, and it covers session
  restore too. A consequence worth knowing: because drawings never enter `openFiles`, the
  watcher's `fs:file-changed` handler returns before it can reload one, independent of
  `watcher.rs` self-write detection.
- **The drawing tab costs ~1.13 MB of JS** (~370 KB gzipped, 11 files) plus 144 KB of CSS
  on open, behind `React.lazy`. Excalidraw's own mermaid-to-excalidraw graph (7.7 MB
  emitted) is not fetched on open — it sits behind its text-to-diagram dialog. Nothing
  lands in the main entry.
- **Escape hatch for the font, if it ever matters.** Exporting with `skipInliningFonts:
true`, declaring a document-level `@font-face { font-family: Excalifont; src: url(<bundled
full woff2>) }`, and rendering the SVG **inlined into the DOM** renders correct glyphs in
  WKWebView — verified. That is a render-path change, not a format change: `.excalidraw.svg`
  files stay valid. It costs a widget and the JS Branch A exists to avoid, so it is not
  being built now.

## Files Expected To Change

- new `apps/desktop/src/lib/drawings.ts` — format detection, save, load, collision suffix.
- `apps/desktop/src/stores/editor-store.ts` — `locationForPath` helper, six call sites
  routed through it, drawing dispatch inside it.
- new `apps/desktop/src/components/editor-area/page-kinds/drawing.ts` — the `drawing` page
  kind.
- `apps/desktop/src/components/editor-area/page-kinds/index.ts` — one entry in the `kinds`
  tuple.
- `apps/desktop/src/components/editor-area/page-kinds/views.tsx` — one view entry, no
  footer.
- new `apps/desktop/src/components/editor-area/drawing-pane.tsx` — the `React.lazy` shell.
- new `apps/desktop/src/components/editor-area/drawing-editor.tsx` — the Excalidraw host
  itself: theme mirroring, shared drawing session, parse-error state, asset path.
- `apps/desktop/vite.config.ts` — copies Excalidraw's fonts into `public/excalidraw-assets/`.
- `apps/desktop/src/components/editor-area/wiki-link-extension.ts` — `dblclick` on the
  embed widget.
- `apps/desktop/src/components/command-palette/index.tsx` — the `new-drawing` command.
- new `apps/desktop/tests/drawings.test.ts` — `isDrawingPath` extension table,
  `locationForPath` extension table, collision-suffix search with the existence check
  injected.
- `apps/desktop/src-tauri/src/commands/fs.rs` — `is_sidebar_file`, so the sidebar lists
  drawings and a drawing-only folder stays visible. Not anticipated when this spec was
  written: the sidebar has only ever surfaced Markdown and directories, which made the
  "clicked in the sidebar" acceptance criterion untestable. See the worksheet.
- `docs/editor.md` — the `drawing` page kind and the no-live-refresh note.
- `CHANGELOG.md`, `TODOS.md`.

## Acceptance Criteria

- A note embedding a drawing renders it inline with **no Excalidraw chunk in the module
  graph** while the note is open.
- Scrolling a note with ten drawings is indistinguishable from ten PNGs.
- Double-clicking an inline drawing opens it in a drawing tab on that file; single-click
  still selects the embed and does not open anything.
- Edits in the drawing tab save back to the same file, and the watcher does not reload the
  tab as an external change.
- A drawing tab survives quit and relaunch with the edit intact.
- A `.excalidraw.svg` clicked in the sidebar opens as a drawing; a plain `.svg` still opens
  as an image; a `.md` still opens as a document.
- A drawing that fails to parse shows an error in the tab, and the file on disk is
  unchanged afterwards.
- Drawing and saving works with no network reachable, and the saved file's `@font-face` is
  a `data:` URI, not a remote URL.
- "New Drawing" from a note creates the file in that note's directory, inserts
  `![[name.excalidraw.svg]]` at the cursor, and opens the tab. Run twice more it yields
  `drawing-1`, `drawing-2`. Run from the launcher it creates a file and a tab with no
  insert and no error.

## Procedure in this repo

The loop is in [`docs/workflows/agent-loop.md`](../../docs/workflows/agent-loop.md):

1. Entry in [`TODOS.md`](../../TODOS.md), moved between sections as work progresses.
2. This spec. Section shape mirrors
   [`mermaid-canvas-widget-spec.md`](../mermaid-canvas-widget-spec.md), the closest
   precedent in the repo.
3. [`SPECs/Agent/worksheet-excalidraw-embed.md`](../Agent/worksheet-excalidraw-embed.md)
   carries per-phase findings.
4. Plan → persona review per
   [`docs/workflows/agent-review.md`](../../docs/workflows/agent-review.md) with
   fresh-context sub-agents → implement in small validated steps.
5. Validate: `vp check`, `vp test`, and `cargo test` / `cargo clippy` / `cargo fmt --check`
   from `apps/desktop/src-tauri/`.
6. Update [`CHANGELOG.md`](../../CHANGELOG.md). One commit per completed task.

### On speckit

`.specify/memory/constitution.md` is already adapted to this project (Local-First Plain
Text, Smallest Correct Change) rather than left as the fork's template, so it is genuinely
useful — treat it as a compact restatement of `CLAUDE.md`'s guardrails.

Keep `SPECs/` + `agent-loop.md` canonical. Speckit's slash commands are fine as drafting
aids as long as their output lands in `SPECs/` and `TODOS.md`. Do **not** let `.specify/`
accumulate a parallel copy of spec content — two spec systems holding one truth is the
exact drift `docs/consolidation.md` exists to prevent.

Running speckit commands for this feature requires
`SPECIFY_FEATURE_DIRECTORY=SPECs/excalidraw-embed` in the environment.
