# Research: Global Content Search

Phase 0 output for `global-content-search`. Every open question from the
Technical Context was resolved against the codebase — no external unknowns
remained. Each entry: decision, rationale, alternatives considered.

## R1. Scan engine: live `ignore` walk in `commands/search.rs`, no content index

**Decision**: a new `content_search` Tauri command that walks the workspace
with `ignore::WalkBuilder` using the exact filters `index_workspace_impl` uses
(`hidden(true)`, `git_ignore(true)`, `git_global(true)`, `git_exclude(true)`,
`threads(≤8)`, `node_modules` safety net), reads each text-decodable file, and
matches lines in parallel inside the walker closure. The walk is re-run per
query; no content index is built or kept.

**Rationale**: FR-009 requires the search corpus to obey the same ignore rules
as the file index — using the same builder makes drift impossible. A live scan
matches this codebase's own precedent (`find_file_by_name` walks on demand
rather than maintaining a second index plus watcher plumbing) and the superseded
`fuzzy-search-grep-spec.md`, which explicitly deferred an inverted index.
Parallel walkers saturate the ~250ms first-results target on a few-thousand-file
workspace.

**Alternatives considered**:

- Extend `state.file_index` to all files — rejected: the index is shaped and
  sized for markdown paths feeding `fuzzy_search`; a content index adds memory
  and watcher invalidation for a problem a bounded live scan already solves.
- ripgrep's `grep-*` crates (the old spec's plan) — rejected: this spec
  requires only literal smart-case matching (~40 lines of Rust); the fuzzy
  ranking and `/`-grep mode were explicitly dropped. The dependency would be
  weight without need.

## R2. Progressive delivery: `tauri::ipc::Channel` per invocation; cancellation via a `cancel_search` flag slot

**Decision**: `content_search(query, on_event: Channel<ContentSearchEvent>)`
streams match batches and PDF candidates as the walk finds them. Each new
query installs a fresh `Arc<AtomicBool>` in a `cancel_search` slot on
`WorkspaceState` (mirroring `cancel_index`), first flipping the outgoing flag —
so at most one scan runs per window and the superseded walk exits at the next
directory entry. The frontend additionally drops stale events by a monotonic
query seq (FR-012).

**Rationale**: a Channel is bound to one invoke — ordered delivery, no event
name to namespace, no cross-window tagging (the `fs:file-changed` precedent
needs a `workspace` field precisely because events are ambient; channels are
not). Note: `Channel::send` does **not** reliably fail when the JS side stops
listening while the webview lives, so channel-drop is not the cancellation
mechanism — the flag slot is, matching how the index walker's cancellation
already works.

**Alternatives considered**:

- `app.emit` global events — rejected: needs a query id on every event plus
  listener lifecycle management; channels exist for exactly this per-call
  streaming case.
- Single request/response after the scan — rejected: FR-015 requires
  progressive rendering and a distinguishable scanning state.

## R3. PDF text: frontend extraction through the existing `lib/pdf.ts` pdf.js boundary

**Decision**: the Rust walk emits `PdfCandidate { path, modified_at }` events
for `.pdf` files instead of opening them. The frontend extracts each page's
lines via pdf.js `getTextContent` (items joined, split on `hasEOL`) behind a
new export in `lib/pdf.ts`, and matches them with a small smart-case line
matcher in a new `lib/pdf-search.ts`. Extraction runs with bounded concurrency
and its own staleness guard.

**Rationale**: pdf.js is already the app's PDF text authority — the viewer's
text layer, selection capture, and quote `refindPassage` all consume
`getTextContent`. FR-007 lands the user on the match the _viewer_ can re-find;
a second extractor would risk disagreeing with the text layer and is a heavy
new native dependency (constitution II and VI). `getTextContent` also runs in
the pdf.js worker, keeping the main thread free.

**Alternatives considered**:

- `pdf-extract` / `lopdf` in Rust — rejected: new dependency, different
  extraction quality than the viewer, and per-page page numbers still need
  page-aware iteration; no upside over the engine already shipped.
- Rendered page OCR/image matching — out of scope per FR-004.

**Acknowledged duplication**: the smart-case substring matcher exists once in
Rust (disk text) and once in TS (PDF page lines). It is ~10 lines, pinned by
tests on both sides, and unavoidable without moving PDF extraction into Rust —
the honest boundary, recorded here per constitution III.

## R4. One `SearchMatch` shape; preview context travels with the result

**Decision**: a single serializable result type (see
`contracts/content-search-ipc.md`): path, relative path, `modified_at`,
`kind: "text" | "pdf"`, location (`line` for text, `page` for PDF), the matched
line's `match_ranges`, and `context` — the ~5 surrounding lines the preview
shows (Rust emits ±2 around the match; the frontend builds the same array from
extracted PDF page lines).

**Rationale**: one shape → one sorted list, one preview renderer, one
activation switch on `kind`. Carrying context in the result removes a second
IPC per highlight change and any staleness window between selection and fetch;
payload stays small (≤ ~200 results × ~5 lines).

**Alternatives considered**:

- Lazy `search_context` IPC on highlight — rejected: a debounced async fetch
  per selection change is strictly more machinery and can go stale mid-hover.
- Separate `TextMatch`/`PdfMatch` types with a union — the tagged-union field
  on one struct expresses the same thing with less rendering branching.

## R5. Ordering and caps: merge in the frontend, sorted by file mtime desc, display-capped at 200

**Decision**: each result and candidate carries `modified_at`. The
content-search hook keeps the list sorted by file mtime desc (document order
within a file) as batches arrive — ≤ a few hundred items, so re-sorting per
batch is cheap. The displayed list is capped at ~200; `truncated` is shown when
Rust reports its per-file or total cap engaged, when PDF candidates outlast the
remaining budget, or when the merged list overflows.

**Rationale**: arrival order from a parallel walk plus a second async source is
arbitrary, so ordering must be a property of the store, not the stream. FR-014
(most recently modified file first) then holds of the rendered list at every
moment, not just at scan end.

**Alternatives considered**:

- Rust emits globally sorted — impossible: the walk is parallel and PDF
  matches are produced in the frontend.
- Cap enforced wholly in Rust — impossible for the same reason; Rust still
  enforces the ~20/file cap (cheap, at the match site) and self-caps text
  emission at ~200 to bound IPC.

## R6. Palette: `CommandPaletteIntent` += `"content-search"`; separate `ContentSearchPalette` component sharing the ui-store open flag

**Decision**: `openCommandPalette("content-search")` sets the existing
`isCommandPaletteOpen` + intent; `<CommandPalette>` renders for the existing
intents, the new `<ContentSearchPalette>` renders only for `"content-search"`,
both mounted in `App.tsx`. The component reuses cmdk `CommandDialog`,
`CommandInput`, `CommandList`, `CommandItem` (`shouldFilter={false}`, controlled
`value`) plus a preview pane bound to the selected value. `Cmd+Shift+F` is
registered in `use-keyboard-shortcuts` gated on `root` — a no-op in compact
windows per the spec's clarification, matching the `Cmd+W` gating pattern.
`docs/keyboard-shortcuts.md` gains the row in the same change.

**Rationale**: one open/close path (Esc, overlay click, `close()`) already
lives on the shared flag — duplicating it would create two sources of truth
for "a palette is open". cmdk's built-in pointer-hover selection feeds the
same `value` as arrow keys, so FR-006's "highlighted by keyboard _or_ pointer"
comes free.

**Alternatives considered**:

- New branch inside `command-palette/index.tsx` — rejected: that component
  already juggles three intents; adding a second result pipeline, a preview
  pane, and a streaming data source would put two unrelated domains in one file
  (structure decision, plan.md).
- A second ui-store flag — rejected: two "open" booleans can disagree; the
  intent union already exists for exactly this.

## R7. Activation: `PendingTarget` union for text; `requestPdfAnchor` + `page=`/`text=` for PDFs

**Decision**:

- **Text files**: `lib/pending-anchor.ts` generalizes from `string` slugs to a
  `PendingTarget` union — `{ anchor: string }` (existing heading links) or
  `{ line: number; offset: number; length: number; needle: string }`. The
  consume site in `use-prosemark-editor` gains a line branch: scroll
  `doc.line(n)` into view via `scrollPosToSafeTop`, select the needle's range
  in that line (re-found defensively — if the file changed since the scan, land
  on the clamped line rather than selecting wrong text). The selection _is_ the
  "briefly highlighted" marking.
- **PDFs**: activation goes through `openFile(path)` — which already implements
  "reuse an open tab, else open in the pane" (FR-007) — then
  `requestPdfAnchor(tabId, "page=N&text=<hint>")`. `pdf-pane` consumes anchors
  through a `usePdfAnchorStore` subscription gated on document readiness, so a
  request issued after the layout commit is still honoured on both fresh mounts
  and already-mounted panes. The `text=` hint drives the existing
  `refindPassage` + emphasis highlight — the PDF's "match briefly highlighted"
  for free, in the viewer's own text coordinates.

**Rationale**: both handoffs are the app's existing mechanisms, extended at
their seams rather than paralleled. A search result is one more _producer_ of a
pending target; the _consumers_ (editor mount, pdf pane) already own their
sides.

**Alternatives considered**:

- `revealPdfAnchor` for PDF results — rejected: its third branch always opens
  a _split_ beside the note, which is quote-link UX, not "open the result".
  `openFile` + `requestPdfAnchor` gets the same anchoring without the split.
- Timed/fading decoration for the text match — rejected as speculative; a
  CodeMirror selection is the standard jump-to-match marking and costs no new
  machinery.

## R8. Corpus scope: strict-UTF-8 decode, ≤ ~4 MiB, `.pdf` by extension — everything else skipped

**Decision**: per walked file — skip directories and `node_modules`; a `.pdf`
extension yields a `PdfCandidate`; otherwise `fs::metadata` size > ~4 MiB skips
the file, then `std::str::from_utf8` on the bytes decides text-decodability
(failure → skip). Office documents, images, and binaries fail decode or are
skipped outright — FR-011's scope honored with no denylist to maintain.
`.excalidraw.svg` drawings decode as UTF-8 and are legitimately searchable user
content.

**Rationale**: "decodes as text" is the spec's own scope phrase; strict UTF-8
is the cheapest honest test (UTF-16 files are skipped — acceptable for v1).
The size cap bounds worst-case read+decode cost on an interactive path
(constitution's no-casual-regressions rule).

**Alternatives considered**:

- Extension allowlist (md/txt/tex/…) — rejected: an allowlist is a second
  definition of "text file" that drifts from reality in both directions
  (excludes `.log`, `.csv`, source files the user may have; includes nothing
  decode can't already exclude).
- NUL-byte sniffing then lossy decode — rejected: lossy decode would match
  inside mojibake and produce garbage context lines; strict decode is simpler
  and fails explicitly.

## R9. Query lifecycle: ~150ms debounce + monotonic seq, mirroring `useFuzzySearch`

**Decision**: `use-content-search` debounces input (~150ms — heavier work than
the index lookup `useFuzzySearch`'s 50ms gates), bumps a seq per dispatch,
constructs a fresh `Channel`, and applies events only while its seq is current.
Cleanup clears the timer and invalidates the seq; Rust-side, the new invoke's
flag installation kills the prior walk (R2). Empty query → hint state, no
invoke (spec edge case).

**Rationale**: same lifecycle shape as the existing palette hook — proven, and
familiar to the next contributor. The seq guard is what actually enforces
FR-012 on the frontend; the Rust flag is what stops wasted work.

## Deferred

- **PDF extraction cache** keyed by path+mtime — deliberate omission for v1:
  correct without it, adds an eviction policy; revisit if large-PDF workspaces
  make re-query cost visible.
- **Content index / inverted index** — the superseded spec's own deferral;
  revisit only if live scans miss SC-001 on real workspaces.
- **UTF-16/latin-1 decoding** — v1 scope is UTF-8 text.
