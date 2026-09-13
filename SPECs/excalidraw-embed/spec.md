# Excalidraw Embed + Edit Spec (Research)

Status: **research / not yet approved for implementation.** Feasibility verdict, the one
decision that has to be made before any code, and the open risks that must be settled by
experiment first.

## Summary

Render Excalidraw drawings inline in markdown notes, and double-click one to open the full
Excalidraw editor in a new tab. Feasible. The whole design hinges on one file-format
decision (below); pick the embedded-scene SVG branch and the inline render path costs
**zero new JavaScript** and reuses the image-embed code that already ships.

## Feasibility

Confirmed from the package metadata and docs:

- `@excalidraw/excalidraw@0.18.1` declares `react: ^17 || ^18 || ^19` / `react-dom` the
  same. This repo is on React 19.1 — supported, no hedge needed.
- It is a React component plus a utils surface (`exportToSvg`, `exportToBlob`,
  `loadFromBlob`, `loadSceneOrLibraryFromBlob`) exported from the same entry point. There
  is no separate lightweight render-only entry; `@excalidraw/utils` is a re-wrap, not a
  slimmer build.
- The `.excalidraw` file is plain JSON: `{ type, version, source, elements[], appState,
files }`. Local-first and git-diffable — compatible with the constitution's Principle I.
- `appState.exportEmbedScene: boolean` is a first-class field, and `loadFromBlob` restores
  a scene from a blob. Those two are the mechanism the format decision below rests on —
  but that they close into a working round-trip is **not** confirmed by the docs. See risk
  1; it is the one thing that has to be tested before the recommendation is final.

Nothing here requires a network hop. Drawing stays a file on disk beside the note.

## The decision: what a drawing is on disk

The discriminating question: **must a note containing a drawing render without loading the
Excalidraw bundle?**

### Option A — `.excalidraw.svg`, scene embedded in the SVG (recommended)

Save with `exportToSvg({ ..., appState: { exportEmbedScene: true } })`. The file is a
real SVG that any viewer can display, and the scene JSON is meant to ride along in its
metadata so the editor can load it back via `loadFromBlob`. That round-trip is the
unverified assumption this whole option stands on (risk 1).

- Inline embed: `![[diagram.excalidraw.svg]]` already works today. The wiki-embed widget in
  `wiki-link-extension.ts` resolves the target, `convertFileSrc`s it, and drops it in an
  `<img>`. **No new render code, no bundle, no parse.** Scrolling a note full of drawings
  costs the same as a note full of PNGs.
- The Excalidraw bundle is pulled only when a drawing tab is actually opened, behind a
  dynamic `import()`. A user who never edits a drawing never pays for it.
- One file holds one truth. Satisfies `docs/consolidation.md` on its first principle.
- Consequence to accept explicitly: `foo.excalidraw.svg` opens in the drawing editor,
  plain `foo.svg` does not. That is a compound-extension check, and it is a design
  decision, not a detail.
- Cost: not directly interoperable with excalidraw.com / the Obsidian plugin's default
  `.excalidraw` files, and the file is not meaningfully git-diffable.

### Option B — `.excalidraw` JSON, lazily rendered

Store the raw JSON; a widget dynamically imports the bundle and calls `exportToSvg` to
produce the inline preview.

- Buys interop with excalidraw.com and the Obsidian plugin, and clean git diffs.
- Costs the Excalidraw chunk load on any note containing a drawing, plus an async render
  per embed — exactly the drain the goal rules out.

### Rejected — the hybrid

`.excalidraw` JSON plus a sibling `.excalidraw.svg` for embedding. Two files holding one
truth, kept in sync by remembering to. This is the opening smell in
`docs/consolidation.md`; naming it here so it isn't rediscovered later.

**Recommendation: Option A, conditional on risk 1.** Editability on every revisit is a hard
requirement, so this is not a preference — it is a gate. If the spike in
[`plan.md`](./plan.md) Phase 0 shows the scene does not survive repeated round-trips through
SVG metadata, Option B is the design, not a fallback to argue about. Both options keep
drawings editable; only the inline-render cost differs.

## Open risks — test before writing the spec proper

Risk 1 gates the **recommendation itself**; the rest gate implementation details.

1. **Scene round-trip through the SVG (blocking).** Option A only works if a drawing is
   still editable after being saved. The docs confirm `exportEmbedScene` exists as an
   `AppState` field and that `loadFromBlob` restores a scene from a blob — but they do
   **not** confirm the pair closes. The `loadSceneOrLibraryFromBlob` signature branches on
   `MIME_TYPES.excalidraw` / `MIME_TYPES.excalidrawlib`, neither of which is
   `image/svg+xml`; and whether the standalone `exportToSvg` util honors
   `exportEmbedScene` (rather than excalidraw.com's own export layer doing the embedding)
   is unverified. **Check, in two halves:** export a scene with
   `appState.exportEmbedScene: true` and grep the SVG for the scene payload; then feed
   that exact file to `loadFromBlob` and diff the returned element array against the
   original. If either half fails, Option A collapses and Option B is the only branch.
2. **Fonts in the exported SVG.** Excalidraw's hand-drawn text needs Excalifont. If
   `exportToSvg` emits an `@font-face` pointing at a remote URL instead of an embedded
   base64 subset, text renders in a fallback font — and inside an `<img>`-sandboxed SVG
   the fetch is blocked outright, so it fails silently and visibly. **Check:** export one
   drawing containing text, `grep` the SVG for `@font-face` and `base64`, load it through
   `convertFileSrc` in an `<img>`, look at the glyphs. Degrades appearance, doesn't kill
   the feature.
3. **`window.EXCALIDRAW_ASSET_PATH`.** The editor loads fonts and workers from a CDN by
   default. This app is offline-first, so the assets have to be bundled and this global
   pointed at them. Verify what breaks without it (likely: fonts, and possibly nothing
   else).
4. **Real chunk size.** The 46 MB npm unpacked figure is tarball-with-sourcemaps and means
   nothing. **Check:** install, add a throwaway module with
   `import("@excalidraw/excalidraw")`, run `vp build`, read the emitted chunk list. Also
   note `@excalidraw/excalidraw/index.css` is a mandatory separate import.
5. **Theming, in two separate places.**
   - _The editor tab:_ Excalidraw ships its own light/dark theming (`theme` prop) and will
     not follow this app's CSS custom properties. Decide whether the drawing tab simply
     mirrors `appearance.theme` and otherwise looks like Excalidraw (honest, and what
     Obsidian does) or gets restyled (expensive, fragile across upgrades).
   - _The inline embed:_ an `<img>`-hosted SVG is inert — colors and background are baked
     in at export time, so no theme reaction is possible after the fact. The mermaid
     precedent solves the equivalent problem with `transparent: true` plus CSS custom
     properties; Excalidraw can't do the custom-property half, but exporting with
     `exportBackground: false` puts the drawing on the note's own background and so reads
     correctly in both themes. Make that the export default.

## Implementation shape (Option A)

Three pieces, roughly in dependency order:

- **Inline embed — nothing to build.** Confirmed: `WIKI_IMAGE_EXTENSIONS` in
  `lib/wiki-links.ts:124` already contains `svg`, so `![[x.excalidraw.svg]]` renders today
  through `parseWikiImageEmbedTarget` → `ImageEmbedWidget`. Markdown
  `![](x.excalidraw.svg)` likewise resolves through `image-src-resolver.ts`. Zero lines.
- **Double-click → editor tab.** New page kind `drawing` under
  `components/editor-area/page-kinds/`, one entry in the `kinds` tuple in `index.ts` and
  one in the view registry in `views.tsx` — the registry is built so nothing else needs
  touching. The view lazy-loads `<Excalidraw>` and saves through the existing fs command
  path.
  The routing change is the part to get right. Every open path currently produces a
  `file` (markdown) tab, so a `.png` clicked in the sidebar opens as text. `openFile`
  (`editor-store.ts:342`) is _not_ the chokepoint — it delegates to `replaceTabWithFile`
  and `navigateToFile`, and `openFileInNewTab` is a separate entry. The location object is
  actually built in five places: `createFileTab` (`editor-store.ts:119`), called from
  lines 370, 412, 450, and 532 — plus one inline `{ kind: "file", path }` in
  `navigateToFile` at line 660 that bypasses the factory. The change is to route path →
  location through a single helper (`createFileTab` generalized, with line 660 fixed to
  call it) so extension dispatch happens exactly once. Branching in `openFile` instead
  would still open drawings as text from the sidebar and from wiki-link navigation, and
  per-call-site branching is the registry smell in `docs/consolidation.md`.
  `open_target::classify` in Rust is out of scope unless `writer drawing.excalidraw.svg`
  from the terminal is wanted; it only gates startup/CLI/Finder opens.
- **Double-click affordance on the embed.** The wiki-embed widget needs a `dblclick`
  handler resolving the target path to an open. Small.

### Optional upgrade: pan/zoom frame

If a plain `<img>` turns out to be too static, `mountMermaidCanvas` in
`mermaid-canvas.ts` already implements a fixed-height frame with drag-pan, wheel/button
zoom, reset-to-fit, hover-revealed control clusters, keyboard bindings, and a fullscreen
overlay — and it takes arbitrary `svgHtml`, so it is reusable as-is. Note the file is not
fully generic (it also carries a mermaid stream-language highlighter and a nested source
editor for the Edit-code toggle), so reuse means splitting the frame out into a generic
`svg-canvas.ts` and leaving the mermaid-specific editing behind. Worth doing **only** if
the static image proves insufficient — not preemptively.

## Non-Goals

- Rendering `.excalidraw` JSON inline (that's Option B).
- Restyling the Excalidraw editor to match Writer's design language.
- Collaboration, the Excalidraw library/shapes browser, or excalidraw.com sync.
- Converting existing Obsidian-plugin drawings.
- Live-refreshing an already-open note's inline embed after a drawing is saved. Three
  layers cache it: `embedResolutionCache` (`wiki-link-extension.ts:116`), the per-URL
  measured-height cache behind `attachStableImageHeight`, and the webview's own cache of
  the stable `convertFileSrc` URL. Saving writes the same path, so the note keeps showing
  the old image until reopened. Promoting this to a goal means cache-busting the asset URL
  on the watcher event and confirming the height cache re-measures — a real piece of work,
  deliberately deferred rather than assumed.

## Acceptance Criteria (draft)

- A note embedding a drawing renders it inline with no Excalidraw code loaded — verifiable
  as an absent chunk in the network/module graph.
- Text in a drawing renders with the correct hand-drawn font inline and in the editor,
  offline, with no CDN reachable.
- Double-clicking an inline drawing opens it in a new tab, and edits save back to the
  same file.
- A drawing tab survives session restore (the page kind serializes its path).
- Scrolling a note with ten drawings is indistinguishable from ten PNGs.

## Procedure in this repo

The loop is in [`docs/workflows/agent-loop.md`](../../docs/workflows/agent-loop.md):

1. Entry in [`TODOS.md`](../../TODOS.md) under **Up Next**, linking this spec.
2. This spec, rewritten from research into a real spec once the five open risks above have
   been settled by the Phase 0 spike in [`plan.md`](./plan.md) — risk 1 first, since it
   decides which option is being specified at all. Keep the section shape of
   [`mermaid-canvas-widget-spec.md`](../mermaid-canvas-widget-spec.md) — Summary / Goals /
   Non-Goals / UX Decisions / Implementation Notes / Files Expected To Change / Acceptance
   Criteria. Mirroring that spec **is** the mechanism for preserving the repo's
   conventions and UI language; it is the closest precedent in every dimension (embedded
   canvas widget, fold-to-edit, fullscreen, page-kind adjacency).
3. `SPECs/Agent/worksheet-excalidraw-embed.md` when implementation starts.
4. Plan → persona review per [`docs/workflows/agent-review.md`](../../docs/workflows/agent-review.md)
   with fresh-context sub-agents → implement in small validated steps.
5. Validate: `vp check`, `vp test`, and `cargo test` / `cargo clippy` / `cargo fmt --check`
   from `apps/desktop/src-tauri/`.
6. Update [`CHANGELOG.md`](../../CHANGELOG.md). One commit for the task.

### On speckit

`.specify/memory/constitution.md` is already adapted to this project (Local-First Plain
Text, Smallest Correct Change) rather than left as the fork's template, so it is genuinely
useful — treat it as a compact restatement of `CLAUDE.md`'s guardrails.

Keep `SPECs/` + `agent-loop.md` canonical. Speckit's slash commands are fine as drafting
aids as long as their output lands in `SPECs/` and `TODOS.md`. Do **not** let `.specify/`
accumulate a parallel copy of spec content — two spec systems holding one truth is the
exact drift `docs/consolidation.md` exists to prevent.
