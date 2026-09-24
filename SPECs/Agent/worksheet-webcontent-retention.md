# WebContent retention — is post-close RSS live JS or WebKit pools?

Picked up from the memory audit caveat in
[`SPECs/memory-performance-optimizations.md`](../memory-performance-optimizations.md).
Commits `705153c` (pass 1) and `b3f388a` (pass 2) landed every source-level
retention fix the audit found; this worksheet is the remaining open question.

## The caveat

After closing every tab in the perf fixture, WebContent **RSS stays ~790 MB**
(boot is ~123 MB). `footprint` on the WebContent process at that point shows
~264 MB physical footprint with ~544 MB marked **reclaimable** in WebKit
malloc zones — memory WebKit freed internally but keeps in its pools for the
OS to reclaim under pressure. So RSS substantially overstates live memory,
but nobody has yet proven _how much_ is reclaimable pool vs genuinely live
JS objects that a leak fix could actually return.

## The question to answer

Split the ~790 MB into three buckets and fix whatever is live:

1. **Reclaimable allocator pools** (WebKit GC/heap freed, not returned to
   OS) — expected, not actionable at source level.
2. **Live JS objects retained after tab close** — a real leak; actionable.
3. **WebCore/compositor resources** (canvas backing stores, image decodes,
   graphics layers) — partially actionable via explicit disposal calls.

## Suggested method

- **JS heap diff**: attach Safari Web Inspector to the e2e app's WKWebView
  (the `--features e2e` build has devtools; `Cmd+Opt+I` or
  `safari-web-inspector` via `__TAURI_INTERNALS__`), take a heap snapshot
  after boot, run the open-20-tabs→close-all cycle, take a second snapshot,
  diff by retained size. Anything whose count grew and isn't reachable from
  a deliberate cache is a leak candidate.
- **Process-level**: `heap <pid>`, `vmmap -summary <pid>`,
  `footprint -categories` on the WebContent PID at boot vs post-close —
  `footprint` already runs in `e2e/perf/perf-audit.spec.js` (`fp_web`
  fields in `/tmp/writer-perf-report.jsonl`); extend it or a new spec to
  dump `Malloc`/`WebKit`/`ImageIO`/`JavaScript` category rows so the split
  is recorded per run.
- Suspects worth checking first, in rough order: pdf.js
  `PDFDocumentProxy`/worker (destroy is refcounted — verify the last-close
  path actually fires), Excalidraw scene + image `files` base64 in
  `drawing-sessions` (survives detach by design — confirm it drops on tab
  close, not just workspace reset), `react-force-graph-2d`/cytoscape canvas
  resources, CodeMirror undo history (kept by design for dirty tabs),
  editor `viewStateByTab` entries (cleared on tab close — verify),
  `pendingDocs`/`pendingSaves` maps (cleared on flush/save).

## Already fixed — do not re-litigate

- keepAlive views are capped (`MAX_HIDDEN_VIEWS = 8`,
  `lib/keep-alive.ts`); suspended tabs unmount and remount on activation.
- `openFiles` cold-history entries are swept (`maybePruneFiles` full sweep,
  `WARM_HISTORY_DEPTH = 2`); dirty files never drop.
- PDF search text cache clears on workspace reset (`clearPdfTextCache`).
- `similarity_edges` caches by AI-index generation; `formula_relations`
  dedupes at note-pair granularity (the ~200 MB `Malloc Large` spike is
  gone).
- Deferred content mirror kills per-keystroke `doc.toString()` churn.

## Deferred (accepted design, revisit only at scale)

- Embedding vectors ~6 KB/note retained in `AiIndex` — quantization is a
  separate design.
- `AiJob` channel is unbounded — elements are small `PathBuf`s, the
  debounce drain coalesces; a bounded drop would lose index updates.
- `extract_title` per-directory-read I/O — invisible at this corpus size.

## Harness notes

- Fixture: `/tmp/writer-perf-ws` (62 files; regenerate if missing —
  `large-01.md` is the 1.1 MB doc, `note-01..20`, 40p + 200p PDFs,
  Excalidraw 800-element file).
- Build: `cd apps/desktop &&
PATH="$PWD/../node_modules/.bin:$PATH" node_modules/.bin/tauri build
--features e2e --bundles app --ignore-version-mismatches
--config '{"identifier":"com.writer-computer.e2e","bundle":{"createUpdaterArtifacts":false}}'`
- Run: `cd apps/desktop/e2e && pnpm exec wdio run ./wdio.conf.js --spec
./perf/perf-audit.spec.js` (also `perf-suspend.spec.js`,
  `perf-restore.spec.js`).
- **Regenerate `/tmp/writer-perf-baseline.txt` before every run** —
  `ps -axo pid=,comm= | grep -i webkit | awk '{print $1}' > ...`. A stale
  baseline attributes other apps' WebContent processes to the app (web_mb
  inflates by >1 GB). WebKit RSS is also noisy ±150 MB run-to-run — trust
  `fp_web` categories and repeat runs, not single numbers.
- Kill stray `Writer.app` instances before runs — a leftover instance
  double-counts into `app_mb`/`web_mb`.
- Specs live in `e2e/perf/` deliberately — `specs/` is the CI glob.
