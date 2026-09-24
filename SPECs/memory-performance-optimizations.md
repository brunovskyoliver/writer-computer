# Memory & Performance Optimizations

Implement the optimizations recommended by the runtime memory/performance
audit (harness: `apps/desktop/e2e/perf/`, baseline report:
`/tmp/writer-perf-report.jsonl`).

## Measured baseline (release build, RSS)

| Scenario                    | app    | WebContent | total   |
| --------------------------- | ------ | ---------- | ------- |
| Boot                        | 115 MB | 120 MB     | 282 MB  |
| 20 md tabs                  | 120 MB | 289 MB     | 468 MB  |
| 1.1 MB doc + 200 keystrokes | 141 MB | 550 MB     | 753 MB  |
| + graph tab                 | 600 MB | 575 MB     | 1313 MB |
| + content search            | 602 MB | 875 MB     | 1617 MB |
| all tabs closed +10 s       | 592 MB | 695 MB     | 1356 MB |

## Changes

### 1. `formula_relations` dedup (Rust, `src-tauri/src/ai.rs`)

`ai_graph` materializes a `FormulaRelation` (cloned `PathBuf`s + snippet
`String`s) for every cross-note pair of math blocks sharing a normalized
formula. The caller dedupes edges afterwards, so ~750k objects (~200 MB
retained `Malloc Large`) were allocated to produce ~3 edges.

Fix: group occurrences per normalized formula, dedupe at
`(note_a, note_b)` pair granularity before materializing the relation —
one relation per note pair per formula. Snippet/path clones happen only
for the surviving pair.

### 2. Deferred editor content mirror (frontend)

`editor-extensions.ts` calls `doc.toString()` on every `docChanged`;
`updateContent` re-parses frontmatter, clones the `openFiles` Map, and
stores a full copy — ~1 MB of garbage and ~7–9 ms per keystroke on a
1.1 MB document (+236 MB transient WebContent over 200 keys).

Fix: per-path deferred mirror. Keystrokes store the `Text` document in a
module-level `pendingDocs` map (no store write past the clean→dirty
transition) and schedule a ~300 ms debounced flush. The flush
materializes `doc.toString()` once and runs the existing
`updateContent` path (title inference, stats, save scheduling).
Consumers that need the current string flush first via
`editorApi.flushPendingEdit(path)`: save (`performSave`), stats refresh,
`updateFrontmatter`, duplicate-file, vim-ex dirty check, MCP writes,
AI frontmatter merge, same-doc anchor navigation, and
`use-prosemark-editor` mount.

Save supersession switches from a second `serializeForSave` comparison
to an O(1) `editSeq` + pending-doc check.

### 3. PDF search: streaming extraction + (path, mtime) cache

`pdfSearchLines` extracts every page's text before matching; the
20-match-per-file cap applies afterwards, so a search re-extracts whole
PDFs per keystroke (1.9 s, +300 MB transient on the fixture).

Fix: `searchPdfText(path, query, base, isCancelled)` interleaves
extraction and matching per page and stops once the per-file cap is
reached — a superseded scan stops pulling pages instead of finishing
an extraction nobody reads. Extracted page lines are cached keyed by
`(path, modified_at)` — `modified_at` already arrives on
`PdfCandidate` from the file index, so no extra I/O. Cache bounded
(LRU, 8 entries); a changed `modified_at` misses and re-extracts.
Partial extractions stay cached so the next query resumes where the
last stopped. A per-path promise chain serializes extraction so
concurrent searches share pages instead of double-extracting.

### 4. Warm-set session restore

`restoreSession` loads every file referenced by any tab's current
location plus full back/forward stacks — a 10-tab × 45-history session
eagerly loaded 62 files (+200 MB WebContent vs cold boot).

Fix: eager-load only current locations plus a small warm set (last
`RESTORE_HISTORY_WARM = 2` entries of `back`, first 2 of `forward`,
deduped). Cold history entries remain in `tab.back`/`tab.forward`;
`navigateBack`/`navigateForward` already lazy-load via
`ensureFileLoaded` with revert-on-failure. `restoreSession` trims
restored stacks to `NAV_HISTORY_LIMIT` so a crafted/old session cannot
exceed the runtime bound.

### 5. Watcher/sidebar coalescing (`use-file-watcher.ts`)

Each `fs:file-changed`/`fs:directory-changed`/`sidebar:metadata-changed`
event immediately bumped `sidebarMetadataVersion` (recents/pinned
refetch + directory-cache clone + full tree flatten) and fired its own
directory IPCs — a save storm or checkout produced dozens of redundant
fan-outs per second.

Fix: a 150 ms trailing-edge flush coalesces a burst into one
`bumpSidebarMetadataVersion`, one `refreshDrawingEmbeds` per drawing,
and one directory read per unique affected path (parents included,
deduped through a `Set`). Visible dirs refresh in place; hidden dirs
invalidate. A per-path in-flight guard prevents overlapping
`readDirectory` calls for the same directory, and a path re-dirtied
while in flight re-reads once after it lands. Open-file reloads keep
their immediate per-event path (content freshness). Timers are cleared
on unmount.

### 6. Small lifecycle fixes

- `drawing-embed-sync.ts`: `resetDrawingRevisions()` had no callers —
  wired into `resetEditorState`, so path-keyed cache-busting revisions
  don't outlive a workspace.
- `drawing-sessions.ts` serialize memoization was **reverted**: the
  scene's `elements` can be mutated in place by Excalidraw mid-stroke
  without a `change()` call, so a reference-keyed memo can report a
  stale "clean" and release a session holding unsaved edits.
  `isDirty`/`save` run at detach/save boundaries only — fresh
  serialization stays.
- `commands/search.rs` pre-existing fix: when the total match cap was
  already reached, the walk skipped files without setting `truncated`,
  so `Done{truncated:false}` could report a complete result while
  matches were silently dropped (racy, thread-count dependent). The
  cap-skip path now sets `truncated`.

## Pass 2 — WebContent retention

The pass-1 measurement left ~790 MB in WebContent after closing every
tab. Two structural causes were addressed here.

### 7. Hidden keepAlive view budget (`lib/keep-alive.ts`)

Every `keepAlive` page kind (file, drawing, pdf, graph, settings) kept
its mounted view for the tab's whole life — ~6–20 MB per background tab
in a live CodeMirror/Excalidraw/pdf.js tree, unbounded in tab count.

Fix: `publish` stamps every pane's active tab into a module-level
recency map. `isTabSuspended` (an `editor-store` selector, memoized on
`(tabs, layout, openFiles)`) evicts the least-recently-visible hidden
tabs once hidden keepAlive tabs exceed `MAX_HIDDEN_VIEWS = 8`; `TabHost`
returns `null` for a suspended tab exactly as it does for non-keepAlive
kinds. Activation remounts the body.

What a suspended tab loses is only what cannot outlive the view: the
CodeMirror undo stack. Cursor/scroll persist in `viewStateByTab`,
document text in `openFiles`/`pendingDocs`, drawing scenes in their
`drawing-sessions` session, PDF page in the location — the existing
mount path already restores all of it. Dirty file tabs are exempt:
their undo trail is the only way back to the saved text. Drawing
sessions need no exemption — `detach` never saves, and a dirty session
keeps its scene in the module map for the save boundaries.

### 8. Cold-history pruning (`maybePruneFiles`)

`openFiles` retained every file any tab's back/forward stack named —
the stacks outlive their usefulness by tens of entries.

Fix: `maybePruneFiles` became a full sweep: `collectWarmReferencedPaths`
keeps only each tab's current location plus the last
`WARM_HISTORY_DEPTH = 2` back entries and first 2 forward entries; every
non-dirty, non-pending entry outside that set is dropped (save
cancelled, pending edit dropped). Deeper history still navigates —
`ensureFileLoaded` re-reads on demand, and `navigateBack` already
reverts on failure. `navigateToFile` now runs the sweep on its success
commit too, so a file drops the moment it slides out of the warm window
rather than lingering until the tab closes.

### 9. Lifecycle cache clears

`pdf.ts` gained `clearPdfTextCache()`, wired into `resetEditorState`
beside `resetDrawingRevisions` — search-extracted page text is keyed by
absolute path and meant nothing under a new workspace root. In-flight
extractions stay correct: they complete into entries the map no longer
references, and the `(path, modified_at)` key guards any reuse.

### 10. Cached similarity edges (Rust)

`similarity_edges` scored every embedded pair on every `ai_graph` call.
`AiIndex` now carries a `generation` bumped by `touch()` at every
`notes` mutation (insert, remove, retain, extend, embedding writes,
suggested-tag writes, config-change clears) plus a
`similarity_cache` keyed by `(generation, floor, k)`.
`ai_graph` takes the write guard and calls
`similarity_edges_cached` — repeat renders serve the cached edge list.

### 11. Scroll restore survives deferred layout (`use-prosemark-editor.ts`)

Suspension made remounts common on large documents, which exposed a
latent bug shared with session restore: `restoreScrollPosition` issued
one `scrollTo` inside a single `requestAnimationFrame`. A fresh
`EditorView` hasn't measured the document yet — the scroller's
`scrollHeight` is a fraction of its final value, so the scroll clamps
to a small offset and never recovers as CodeMirror's heightmap grows
(~550 kpx on the 1.1 MB fixture, laid out over several frames after the
first rAF).

Fix: after the first scroll, a bounded rAF loop (~90 frames) re-applies
the target on every `scrollHeight` change and whenever `scrollTop` sits
clamped at the bottom short of the target. It exits as soon as the
position lands, when `scrollTop` passes the target (a user scroll wins
over restore), or when the frame budget runs out. Same code path serves
fresh mounts, tab switches, and session restore.

## Non-goals

- AI `AiJob` unbounded channel: elements are `PathBuf`s (~50 B) and the
  worker's 800 ms debounce drain already coalesces; a bounded drop would
  silently lose index updates. Documented as accepted design.
- `extract_title` per-directory-read I/O: invisible at measured corpus
  sizes; revisit for multi-thousand-file vaults.
- WKWebView high-water-mark RSS after heavy sessions: WebKit holds
  freed pages at the process level; the JS-heap-vs-RSS split needs a
  heap-snapshot diff, not more source changes.
- Embedding vectors retained per note (~6 KB each): bounded by index
  size; quantization is a separate design.

## Validation

- `vp check` — 0 errors; `vp test` — 1291 tests pass.
- `cargo test` — all pass; `cargo clippy` — only pre-existing warnings;
  `cargo fmt --check` — clean.
- Re-run of `e2e/perf/perf-audit.spec.js` + `perf-restore.spec.js`
  against the same fixture (release build):

| Scenario                    | app before → after | web before → after | total before → after |
| --------------------------- | ------------------ | ------------------ | -------------------- |
| Boot                        | 115 → 108 MB       | 120 → 123 MB       | 282 → 276 MB         |
| 20 md tabs                  | 120 → 103 MB       | 289 → 284 MB       | 468 → 441 MB         |
| +1.1 MB doc, 200 keystrokes | 141 → 122 MB       | 550 → 539 MB       | 753 → 712 MB         |
| + graph tab                 | **600 → 122 MB**   | 575 → 595 MB       | **1313 → 851 MB**    |
| + content search            | 602 → 125 MB       | 875 → 785 MB       | 1617 → 1042 MB       |
| all tabs closed +10 s       | 592 → 123 MB       | 695 → 790 MB       | 1356 → 974 MB        |

Pass-2 re-run (same fixture, hidden-view budget + cold-history pruning
live):

| Scenario                    | app | WebContent |
| --------------------------- | --- | ---------- |
| Boot                        | 113 | 123        |
| 20 md tabs                  | 110 | 223        |
| +1.1 MB doc, 200 keystrokes | 134 | 528        |
| + graph tab                 | 133 | 550        |
| + content search            | 136 | 768        |
| all tabs closed +10 s       | 136 | 787        |

- 20 markdown tabs now cost ~100 MB WebContent instead of ~170 MB —
  hidden views suspend past the `MAX_HIDDEN_VIEWS = 8` budget instead of
  every keepAlive tab holding a live editor.
- Post-close WebContent RSS is unchanged (~787 MB) but
  `phys_footprint` reads ~264 MB with ~544 MB marked reclaimable in
  WebKit malloc pools — RSS overstates live memory; a heap-snapshot
  diff would split this further.
- `e2e/perf/perf-suspend.spec.js` (not CI-gated): a scrolled 1.1 MB tab
  suspends past the budget, remounts in ~100 ms on activation, and
  restores content, scroll position (exact px), and editability.
- Graph open no longer allocates any `Malloc Large` regions in the app
  process (was 7 regions / ~195 MB per call, retained forever).
  Per-keystroke latency in the 1.1 MB doc: ~5.6 ms/key (was ~7–9 ms).
- Restore of a 10-tab × 45-history session: 301 ms, web = 248 MB
  (was ~321 MB loading every history-referenced file).
