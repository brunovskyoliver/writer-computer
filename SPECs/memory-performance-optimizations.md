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

## Non-goals

- AI `AiJob` unbounded channel: elements are `PathBuf`s (~50 B) and the
  worker's 800 ms debounce drain already coalesces; a bounded drop would
  silently lose index updates. Documented as accepted design.
- `similarity_edges` recompute per `ai_graph` call: trivial at real
  corpus sizes; revisit with an index-generation counter if profiling
  shows it.
- `extract_title` per-directory-read I/O: invisible at measured corpus
  sizes; revisit for multi-thousand-file vaults.
- keepAlive tab cost (6–17 MB/tab) and post-close WebKit retention:
  deliberate design trade / platform behavior; no change.

## Validation

- `vp check` — 0 errors (10 pre-existing warnings in untouched files);
  `vp test` — 1287 tests pass.
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

- Graph open no longer allocates any `Malloc Large` regions in the app
  process (was 7 regions / ~195 MB per call, retained forever).
  Per-keystroke latency in the 1.1 MB doc: ~5.6 ms/key (was ~7–9 ms).
- Restore of a 10-tab × 45-history session: 301 ms, web = 248 MB
  (was ~321 MB loading every history-referenced file).
