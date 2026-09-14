# Phase 0 Research: PDF Viewing, Highlighting and Quote Links

Resolves the unknowns in `plan.md` Technical Context. Every decision below was
checked against the code, not assumed.

## R1. Renderer library

**Decision**: `pdfjs-dist`, added to the `catalog:` in `pnpm-workspace.yaml`, loaded
through `await import()` from the PDF page-kind view only.

**Rationale**: Constitution VI — "do not reinvent the wheel". A PDF parser/renderer is
not a thing to write. `pdfjs-dist` is the only mature browser-side option, is offline,
MIT, and gives a text layer (FR-013), page-level rendering (FR-009) and an encryption
error we can surface (FR-012). The lazy-import boundary mirrors `lib/drawings.ts`, which
documents the same accommodation for the 1.13 MB Excalidraw bundle: the main module graph
must not pay for a dependency only one tab kind uses.

**Alternatives considered**: native `<embed>`/`<iframe>` PDF viewing — rejected, it gives
no text-layer access, no selection API, no region overlay, and its chrome cannot follow the
app theme (FR-008). A Rust-side rasterizer (`pdfium`) — rejected, it adds a large native
dependency and still leaves selection/text-layer work in the frontend.

## R2. pdf.js worker under Vite+

**Decision**: Resolve the worker with `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`
and assign it to `GlobalWorkerOptions.workerSrc`, inside the same lazy module as the import.

**Rationale**: pdf.js parses and rasterizes off the main thread. This is the mechanism
that delivers FR-010 and SC-002 — typing in the adjacent note cannot be blocked by render
work that is not on the main thread. Vite resolves the `new URL(..., import.meta.url)` form
at build time without extra config.

**Risk flagged**: this is the one item most likely to need iteration under Vite+
specifically. Per Constitution "Development Workflow", if it fails once, add a debug log
before changing approach — do not guess at worker paths twice.

**Alternatives considered**: `workerPort`, or disabling the worker (`useWorkerFetch: false`,
main-thread parsing) — the latter is rejected outright, it would make SC-002 unachievable.

## R3. Anchor encoding and link resolution

**Decision**: Quote links are ordinary `[[...]]` wiki links whose _fragment_ carries the
anchor, with an alias for display:
`[[papers/kant.pdf#page=3&text=...|kant.pdf p.3]]`.

**Rationale**: `lib/wiki-links.ts::parseWikiLink` already splits alias (`|`) and fragment
(`#`) and returns both. Parsing is therefore free and no new link syntax enters the
codebase, matching the spec's stated assumption.

**Correction to the spec's assumption — resolution is _not_ free.** `resolveWikiLink`
is Markdown-only in two ways: `normalizeWikiTarget` strips `.md`/`.markdown`, and the
path branch probes exactly `${base}.md` and `${base}.markdown`. The stem-lookup branch
cannot help either, because `commands/search.rs:194` filters the fuzzy index to `.md`
(which is also what gives FR-006 for free — PDFs are already absent from search).

**Consequence**: PDF quote links MUST be path-qualified at insert time. Because Writer
generates these links itself, this costs nothing: emit the workspace-relative path with
the `.pdf` extension intact. Resolution then needs only an extension-preserving
`fileExists` probe — the pattern `resolveWikiImage` already uses for `.png`/`.svg`
embeds, which resolves attachments without touching the Markdown index. We follow that
precedent rather than widening `resolveWikiLink`'s Markdown contract.

**Alternatives considered**: a separate `pdf://` link syntax — rejected by the spec and by
Principle III (a second link syntax means a second click path, a second rename path, and a
second render path). Storing anchors in a sidecar JSON — rejected, it violates Principle I
(the note must mean something without Writer) and SC-007.

## R4. Where the "standalone surface" rule lives

**Decision**: Generalize the four `isDrawingPath` checks in `editor-store.ts` into one
registry-derived predicate before adding the PDF kind.

**Rationale**: `isDrawingPath` appears at four sites (lines 186, 420, 516, 886) all
encoding a single concept: _this path opens as its own surface, is reused if already
open, and never enters `openFiles`_. Adding PDF by copying those four branches would make
"add the next page kind" a four-site change — exactly the per-case chain Principle III
forbids, and exactly what `docs/consolidation.md` describes.

The registry already carries the distinction: the `drawing` kind sets `primaryPath` to
`null` with a comment stating that a drawing "is not an open _file_", never enters
`openFiles`, and owns its own I/O. That is the predicate.

Verified site by site — they do not all ask the same question:

| Site                     | Question it asks                                     | Generalization                                                                                                             |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `locationForPath` (186)  | which kind does this path open as?                   | one line; add `.pdf`                                                                                                       |
| `ensureFileLoaded` (420) | keep this out of `openFiles`?                        | `primaryPath(loc) === null`                                                                                                |
| `openFile` (516)         | `activeTab.kind === "file" \|\| isDrawingPath(path)` | **only the right half** is a path predicate; the left half is about the _active tab_ and must stay                         |
| `navigateToFile` (886)   | is this surface already open?                        | hardcodes `kind === "drawing" && path === path`; must become "same kind and same path as the location about to be created" |

Site 886 is the one where a naive boolean swap would silently keep drawings working while
letting PDFs open twice. It generalizes, but only by matching on the _location_ built from
the path, not on a boolean about the path.

**Alternatives considered**: adding `isPdfPath` beside `isDrawingPath` at all four sites —
rejected, that is the Principle III violation itself. Deferring the refactor until a third
kind arrives — rejected, the second case is where the chain is cheapest to remove.

## R5. FR-027 (rename rewrites links inside notes) — spec defect

**Decision**: Out of scope for this feature. Recorded here and in `plan.md` Complexity
Tracking rather than silently dropped.

**Finding**: FR-027 says renaming a PDF must rewrite existing quote links "matching how
the app already handles renames of linked files". **The app does not do this today.**
`use-move-entry.ts` is the single write path for rename/move and it calls only
`renameOpenFile` and `rewritePathPrefix` — both of which retarget _open tabs_. Nothing
scans note bodies, and no Rust command rewrites link text. The premise of FR-027 is false.

**Why it is not in this feature**: workspace-wide link rewriting is a feature in its own
right that affects every `[[link]]`, not just PDF ones. Building it PDF-only would create a
second link-rewriting path and violate Principle III the moment it is generalized. It also
requires deciding rewrite-on-rename semantics for notes and drawings, which no spec covers.

**What ships instead**: renaming a PDF correctly retargets any _open_ PDF tab (the page
kind's `rewritePath`, free from the registry). A quote link whose PDF was renamed reports
the missing path per FR-026 — an explicit failure, satisfying Principle IV. Users are not
left guessing.

**Recommendation**: file workspace-wide link rewriting as its own spec.

## R6. Re-finding a passage after the PDF changes (FR-025)

**Decision**: Store the quoted text in the anchor (FR-019) and, on resolution, search the
recorded page first, then a small window of pages either side (±2). If not found, navigate
to the recorded page and report that the passage was not located.

**Rationale**: FR-025 requires never highlighting the wrong thing. A bounded window keeps
the failure explicit and the cost constant — a full-document text scan on every click would
violate the performance constraints for a case that is rare by definition.

**Alternatives considered**: fuzzy/full-document matching — rejected as disproportionate
cost and a source of confidently-wrong highlights, which FR-025 explicitly forbids.

## R7. Region coordinates (FR-020)

**Decision**: Store rectangles as page-relative fractions `x,y,w,h` in `[0,1]`, relative to
the page's unrotated crop box.

**Rationale**: Fractions are invariant under zoom and device pixel ratio, which is exactly
what FR-020 and acceptance scenario 4.5 demand. Converting to viewport pixels at paint time
is one multiply by the current viewport.

**Alternatives considered**: PDF user-space points — correct but requires carrying the page
box into the note to be interpretable; fractions are self-describing and survive a changed
PDF's re-scaling.
