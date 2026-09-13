# Worksheet: Excalidraw Embed + Edit

## Task

- TODO: `Excalidraw embed + edit`
- Spec: [`../excalidraw-embed/spec.md`](../excalidraw-embed/spec.md) (research status)
- Plan: [`../excalidraw-embed/plan.md`](../excalidraw-embed/plan.md)
- Tasks: [`../excalidraw-embed/tasks.md`](../excalidraw-embed/tasks.md)

## Intent

Drawings live as files beside the note, render inline in the markdown editor, and open in a
full Excalidraw editor tab on double-click. A drawing must stay editable on every revisit,
not just the first.

The storage format is decided by the Phase 2 spike, not by preference. If a scene survives
repeated export/import round-trips through `.excalidraw.svg` metadata — including the image
`files` map and text fonts — inline embeds cost zero JavaScript (Branch A). If it does not,
the format falls back to raw `.excalidraw` JSON with a lazy render widget (Branch B). Both
branches keep drawings editable; only Branch B costs a bundle load on read.

Phase 4 consolidates the path-to-tab-location construction sites in `editor-store.ts` behind
a single `locationForPath` helper before any drawing dispatch is added.

## Progress

- **Phase 1 — Setup**: done. `@excalidraw/excalidraw` 0.18.1 added to `apps/desktop`.
- **Phase 2 — Spike**: complete. Findings reported at T009; user chose **Branch A**
  (`.excalidraw.svg`, `<img>` embeds) with a **transparent** export background, accepting the
  serif-text cost in embeds. Spike files deleted (T010); spec.md rewritten for Branch A (T011).
- **Phase 3 — Storage format and I/O**: done (T012–T014, T018–T019). `lib/drawings.ts` owns
  detection, load, and save; 12 `isDrawingPath` cases pass.
- Phases 4–8: ready. Branch B tasks (T015–T017, T035) are dead.

## Spike results (Phase 2, T004–T008)

Method: throwaway `apps/desktop/src/lib/__spike-excalidraw.ts` plus `apps/desktop/spike.html`,
run in a real browser against the running dev server. Not a docs check. Scene =
rectangle + text (`Hand-drawn text`) + an image element backed by a `files` entry, so
`elements`, `appState`, and `files` are all exercised. Three export → `loadFromBlob` → edit
cycles. Offline simulated by rejecting every cross-origin `fetch` before the module loads.

### 1. Repeated round-trip — **holds** (T004, T005)

| Cycle | Elements before/after | Missing | Added | Changed (volatile fields excluded)                                       | `files` preserved             | Image element | Text                    |
| ----- | --------------------- | ------- | ----- | ------------------------------------------------------------------------ | ----------------------------- | ------------- | ----------------------- |
| 1     | 3 / 3                 | none    | none  | `boundElements` on all three (`undefined` → `[]`, restore normalisation) | yes, `dataURL` byte-identical | present       | `Hand-drawn text`       |
| 2     | 3 / 3                 | none    | none  | **none**                                                                 | yes                           | present       | `Hand-drawn text +1`    |
| 3     | 3 / 3                 | none    | none  | **none**                                                                 | yes                           | present       | `Hand-drawn text +1 +2` |

The cycle-1 `boundElements` delta is a one-time normalisation, not loss: it does not recur on
cycles 2 or 3. Edits made between cycles (moving the rectangle, appending to the text) survive
intact. The embedded payload is tagged `payload-type:application/vnd.excalidraw+json`.

**No degradation on cycle two.** By the gate in plan.md this is a pass.

### 2. `appState` — user data survives; only the transient export flags reset

`loadFromBlob` returns 85 `appState` keys. The two export flags come back at their defaults on
every cycle — `exportEmbedScene: false`, `exportBackground: true` — regardless of what was
exported with.

To tell "preserved" from "reset to the default", cycles 2 and 3 were exported with a
**non-default** `viewBackgroundColor: "#ffeedd"`. It came back as `#ffeedd` both times. So
user-chosen canvas state does round-trip through the embedded payload; only the transient
export flags do not. The save path must set `exportEmbedScene` and `exportBackground`
explicitly on **every** write and never read them back off the file — which is what T013
already specifies. Element data and `files` are unaffected.

### 3. Fonts and `<img>` rendering — **works, but only with bundled assets** (T006, T008)

`exportToSvg` inlines fonts by default (there is a `skipInliningFonts` opt-out). Measured on
the same scene:

| Run | `EXCALIDRAW_ASSET_PATH` | Network | SVG bytes | `@font-face` `src:`          | Font fetched from                                                |
| --- | ----------------------- | ------- | --------- | ---------------------------- | ---------------------------------------------------------------- |
| A   | unset                   | online  | 6206      | `url(data:font/woff2…)`      | `https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/…` |
| B   | local dist dir          | online  | 6252      | `url(data:font/woff2…)`      | localhost only — **zero remote requests**                        |
| C   | bogus local dir         | online  | 6310      | `url(data:font/woff2…)`      | falls back to `esm.sh`                                           |
| D   | unset                   | offline | **3440**  | `url(https://esm.sh/…woff2)` | nothing — fetch failed                                           |
| E   | local dist dir          | offline | 6296      | `url(data:font/woff2…)`      | localhost only                                                   |

Run D is the failure mode: the export **does not throw**. It silently emits an SVG ~2.8 KB
smaller whose `@font-face` points at a remote URL, which a sandboxed `<img>` cannot fetch — so
the drawing renders in a fallback system font instead of Excalifont. Silent degradation, and it
is baked into the saved file.

Only one family is inlined (Excalifont — the one the scene uses), not all nine.

The image element's `href` is a `data:` URI in every run, so pictures survive the `<img>` path.

Visual check in **Chromium**: the final SVG loaded into a sandboxed `<img>` via a blob URL
rendered at 230×264 with hand-drawn glyphs and the embedded picture both correct.

### 3b. WebKit rejects the inlined subset font (the real target engine)

Writer runs in WKWebView, not Chromium, so the same file was rendered through a real
`WKWebView` (a small `swiftc` harness calling `takeSnapshot`, over both `file://` and
`http://`). Artifacts in `/tmp/wkfont/`.

| Hosting                           | Chromium   | WKWebView          |
| --------------------------------- | ---------- | ------------------ |
| `<img src=…svg>`                  | Excalifont | **serif fallback** |
| `<object type="image/svg+xml">`   | Excalifont | **serif fallback** |
| SVG inlined directly into the DOM | Excalifont | **serif fallback** |

All three fail in WebKit, so it is not the `<img>` sandbox and not SVG-as-image. Isolating it:
lifting the exported `@font-face` into a plain HTML document and reading `document.fonts` in
WKWebView gives

- inlined **subset** woff2 from the exported SVG → `Excalifont: error` (glyphs fall back)
- the shipped **full** `Excalifont-Regular-*.woff2` from `dist/prod/fonts` → `Excalifont: loaded`, glyphs correct

**WebKit rejects the subset woff2 that Excalidraw's subsetting worker inlines into the export.
Chromium accepts it.** The font data Excalidraw ships is fine; the subset it generates is not.

Consequences:

- A drawing containing text renders in a **serif fallback** wherever Writer displays the
  exported SVG. Shapes, strokes, and embedded images are unaffected.
- The drawing **editor tab** should be unaffected — it loads the full fonts from
  `EXCALIDRAW_ASSET_PATH`, a different path from the export subsetter. Not measured; verify at
  the US1 checkpoint.
- **The mitigation was tested and it works.** Exporting with `skipInliningFonts: true` (the
  `<style class="style-fonts">` block comes out empty), declaring a document-level
  `@font-face { font-family: Excalifont; src: url(<bundled full woff2>) }`, and inlining the
  SVG into the DOM renders correct Excalifont glyphs in WKWebView (`Excalifont: loaded`). The
  **same file shown through `<img>` in the same document still falls back to serif** — an
  `<img>`-hosted SVG cannot use the host document's fonts. So the fix exists, and it costs
  exactly the render path Branch A gives up to get "zero JS".
- The exported `font-family` is `"Excalifont, Xiaolai, Segoe UI Emoji"`, so a document-level
  face must use the family name `Excalifont` verbatim to be picked up.
- It is worth re-checking against a newer `@excalidraw/excalidraw` before building around it;
  this looks like a library bug, not a designed behaviour.

**Conclusion: T028 (bundle assets, set `EXCALIDRAW_ASSET_PATH`) is mandatory, not optional,
and it must be in place before the first save.**

Font payload on disk: `dist/prod/fonts` is 13 MB, of which **Xiaolai (CJK) is 12 MB**. The
other eight families total ~480 KB (Excalifont 80K, Assistant 80K, Liberation 72K, Cascadia
68K, Nunito 68K, Virgil 56K, ComicShanns 40K, Lilita 16K). Bundling everything except Xiaolai
costs half a megabyte; bundling Xiaolai too costs 13 MB. Worth a decision at T028.

### 4. Real chunk size (T007)

A separate `__spike-lazy.ts` with `import("@excalidraw/excalidraw")`, built with `vp build`
into a throwaway `outDir`, then loaded from a static server and measured by
`performance.getEntriesByType("resource")` — i.e. what the browser actually fetches when a
drawing tab opens, not what sits on disk.

- **Opening a drawing tab fetches 11 files, ~1.13 MB raw JS** (~370 KB gzipped).
  Dominated by two chunks: 573 KB (`prod-*.js`, 180 KB gzip) and 528 KB
  (`chunk-K2UTITRG-*.js`, 182 KB gzip).
- `@excalidraw/excalidraw/index.css` is a further 144 KB.
- The full emitted graph is 190 files / 7.7 MB, because Excalidraw ships
  `mermaid-to-excalidraw` (mermaid, cytoscape, katex, per-diagram chunks). **None of it is
  fetched on open** — it sits behind Excalidraw's own text-to-diagram dialog. The 46 MB npm
  figure is irrelevant, as plan.md predicted.
- Nothing lands in the main entry: the dynamic import splits cleanly.

## Recommendation

**The gate itself passes for Branch A**: the round-trip holds over three cycles with
`elements`, `appState`, and `files` intact. Nothing here forces Branch B.

But the branch decision now turns on finding 3b rather than on the round-trip, and the user
should weigh two things the spike cannot settle:

1. **Text in embeds renders in a serif fallback under WebKit.** Branch A's whole advantage is
   the zero-JS `<img>` path, and that path has no fix for this — an `<img>`-hosted SVG cannot
   borrow the host document's fonts. Branch B renders through a widget we control, where
   `skipInliningFonts: true` plus an app-level `@font-face` on the bundled full woff2 does fix
   it. A user whose drawings are mostly shapes and arrows will not notice; a user who labels
   everything will.
2. **Interop (Principle I).** `.excalidraw.svg` is viewable anywhere but editable only where
   the embedded payload is understood. Raw `.excalidraw` opens natively on excalidraw.com and
   in Obsidian.

One fact that bears on how reversible the choice is: the font fix is a **render-path** change,
not a format change. Branch A's `.excalidraw.svg` files stay valid if the embed renderer is
later swapped from `<img>` to an inline-SVG widget — at which point Branch A costs roughly what
Branch B costs on read. The format decision and the font decision are therefore separable.

Both branches also share an unrelated problem worth deciding at T011: with
`exportBackground: false` the strokes are baked dark (`#1e1e1e`) and the SVG is inert, so a
drawing is hard to read on a dark background. plan.md's claim that transparent "reads correctly
in both themes" does not hold. The concrete alternative is `exportBackground: true` with an
explicit `viewBackgroundColor` — which finding 2 proves does round-trip.

**Decision taken (T009): Branch A, transparent background.** Recorded in spec.md.

## Implementation

### Phase 3 — `lib/drawings.ts` (T012–T014, T018–T019)

- `isDrawingPath()` matches the compound extension on the **basename**, case-insensitively, and
  requires a stem. So `sketch.excalidraw.svg` matches; `logo.svg`, `sketch.excalidraw`,
  `.excalidraw.svg`, `sketch.excalidraw.svg.bak`, and a `.md` inside a directory that happens to
  be named `sketch.excalidraw.svg/` do not.
- **Excalidraw is behind `await import()` inside the function bodies, and the type imports are
  `import type`.** This is structural, not stylistic: Phase 4 wires `isDrawingPath` into
  `editor-store.ts`, which is in the main module graph. A static import would put ~1.13 MB in the
  entry chunk and fail the "no Excalidraw chunk in the module graph" acceptance criterion.
  Nothing imports the module yet, so this is verified at Phase 6's module-graph check.
- `loadDrawing()` returns `{ ok: true, scene } | { ok: false, error }`. The blob is constructed
  with type `image/svg+xml` — `loadFromBlob` gates the metadata decode on exactly that MIME type
  (`parseFileContents` in the bundle), and a blob without it is parsed as JSON and rejected.
- `files` (`BinaryFiles`) crosses in both directions — returned from the restore on load, passed
  to `exportToSvg` on save. Dropping it silently loses embedded images with no error; the spike
  exercised an image-backed `files` entry precisely because of this.
- `saveDrawing()` sets `exportEmbedScene: true` and `exportBackground: false` on **every** write
  and never reads them off the file (spike finding 2), serializes the returned `SVGSVGElement`
  with `XMLSerializer`, and writes through `tauri.writeFile` — the one write path, so
  `watcher.rs` self-write detection applies (T018).
- **Writes are chained per path** through a module-level `Map<string, Promise>`. `exportToSvg` is
  async (font subsetting runs in a worker), so under Phase 5's 150 ms debounce export N can
  resolve after N+1 and write a stale SVG over a newer one. ~5 lines, and it keeps the ordering
  guarantee in the module that owns the format rather than in a caller that does not exist yet.
- Tests are logic-only per Principle VI: the `isDrawingPath` table. `loadDrawing`/`saveDrawing`
  need a DOM and the real bundle, so they are verified at the US1 checkpoint, not in `vp test`.

## Phase 5 — the drawing tab (T022, T025–T033)

- **T022 landed as four mechanisms, not one.** Dispatch inside `locationForPath` was the easy
  part. The other three: `drawingKind.primaryPath` returns `null` so no drawing publishes as
  `activeFilePath`; the five sites that assigned `activeFilePath: path` directly (editor-store
  403, 455, 488, 576, 712) now derive through `locationPrimaryPath`; and `ensureFileLoaded`
  returns early on a drawing path, deleting any optimistic `createLoadingFile` placeholder its
  callers inserted before the await. The guard is in the shared function rather than at the six
  call sites, so it also covers session restore's `pathsToLoad.map(ensureFileLoaded)`.
- **Falling out of that**: drawings never enter `openFiles`, so `use-file-watcher.ts:36` returns
  on `!file` before it can reload one. T033 holds structurally as well as through `watcher.rs`
  self-write detection.
- **The lazy boundary had to be a module, not a component.** `views.tsx` is statically imported
  by the tab renderer, so a top-level `import "@excalidraw/excalidraw/index.css"` in
  `drawing-pane.tsx` would have put 142 KB of CSS in the entry. Split: `drawing-pane.tsx` is the
  `React.lazy` shell, `drawing-editor.tsx` holds the package, the CSS and the asset-path
  assignment. Build output confirms it — `grep -c excalidraw dist/assets/index-*.js` → 0, and the
  CSS emits as its own `drawing-editor-*.css`.
- **Autosave is disarmed until the first non-empty `onChange`.** Excalidraw's mount-time
  `onChange` can carry an empty element array before `initialData` is applied; the 150 ms
  debounce would have written that over a real drawing with no parse failure in sight — the T031
  catastrophe reached by a second entrance. Once armed, an empty scene saves (a real delete-all).
  The pending save is also flushed on unmount, or tab close drops the last 150 ms of edits.
- **`keepAlive: true`** on the drawing kind, matching `fileKind`. The default would remount
  Excalidraw and re-read from disk on every tab switch, losing zoom and scroll.
- **T028: eight font families bundled, Xiaolai (CJK) excluded** — 596 KB copied instead of 13 MB.
  Copy runs from `apps/desktop/vite.config.ts` into a gitignored `public/excalidraw-assets/`, so
  it regenerates on every dev start and build and cannot drift from the installed package.
  `EXCALIDRAW_ASSET_PATH` is an absolute href from `window.location.href`, not `/excalidraw-assets/`:
  a value matching `/^\.?\//` is resolved against `window.location.origin` by
  `FontFace.normalizeBaseUrl`, which is not the right base under Tauri's custom scheme. Wrong
  path degrades silently to esm.sh (spike Run C), so the discriminating check is the offline save
  → grep for `url(data:font/woff2` in the written file. **To verify at the checkpoint.**
- **Theme is the preference, not the DOM attribute** — `activeMode(useSetting("appearance.theme"))`.
  An OS theme flip while the preference is `system` does not repaint an open drawing tab until
  remount. Same gap the rest of the React tree has; a MutationObserver on `data-theme` would be a
  pattern the repo does not otherwise use.
- **Font path layout verified statically.** The URL literals Excalidraw hands `createUrls` are
  `./fonts/<Family>/<Family>-Regular-<hash>.woff2`, resolved against the base — so
  `public/excalidraw-assets/fonts/…` is the right target depth, and the hashed basenames in
  `dist/excalidraw-assets/fonts/Excalifont/` match the literals in the emitted JS exactly.
- **Fixture for the checkpoint**: the spike's export survives at
  `/tmp/wkfont/drawing.excalidraw.svg` (6260 bytes, text + embedded image, embedded scene).
- **Also check at the checkpoint:** `keepAlive: true` leaves an inactive drawing tab mounted and
  hidden, and Excalidraw sizes its canvas from a resize observer — a `display: none` host
  measures 0×0. Switch to a note tab and back and confirm the canvas repaints full size. If it
  does not, that is a keepAlive-vs-remount tradeoff, not a bug to chase.
- **Known rough edge, decide at the checkpoint:** `openFile` only navigates in place when the
  active tab's kind is `file`, so clicking the _same_ drawing in the sidebar while its tab is
  active opens a duplicate tab. Settings tabs behave identically today. T036 (Phase 6) hits this
  path harder.

## Review

_Pending._

## Validation

_Pending._
