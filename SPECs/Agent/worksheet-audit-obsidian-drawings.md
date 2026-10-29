# AUD-03: preview and import Obsidian drawings

## Scope and evidence

Next step in the comprehensive Writer audit, following `ba29d11` (small panes).
The previous goal turn made verified progress. Preserve original SDU files and
pre-existing math/Mermaid/dependency changes.

Current read-only scan finds seven `.excalidraw.md` files (the earlier audit
recorded eight). All contain LZString base64 compressed JSON in a Drawing fence;
none has an Embedded Files section or scene file assets. Largest source: 394,243
bytes, decoded scene: 1,102,694 bytes, 430 elements including 9 deleted elements.
One-shot Node decoding took 30.33ms for that scene; this is a diagnostic baseline,
not a native application performance measurement. Inventory contains counts, not
private drawing text: `drawing-format-inventory.json` in the evidence directory.

Installed Obsidian plugin source confirms compressed-json/json Drawing fences,
Text Elements mappings, Element Links, embedded-file references and optional
Markdown-image blocks. Those wrappers are part of the document, not disposable
formatting. Directly writing an SVG scene over that path would destroy them.

Native baseline uses synthetic `Drawings/Concept.excalidraw.md` and a referring
note in the isolated study fixture. Both open as Markdown. The embed becomes a
text link, with no image or canvas. Screenshot: `obsidian-drawing-before-1200.png`.

This task adds usable preview and an explicit editable-copy action. It does not
claim complete migration: original metadata and relationships remain in the
original Markdown file. In-place Obsidian serialization and reference migration
remain follow-up work under AUD-03, alongside the wider link-integrity audit.

## Plan

1. Define the supported drawing formats in the lightweight drawing module:
   Writer SVG (editable) and Obsidian `.excalidraw.md` (preview/import). Keep plain
   SVG and ordinary Markdown behavior. One classifier/name rule drives routing.
   Saved file locations for old Markdown drawing tabs normalize when restored.
2. Add a strict, testable Obsidian scene reader for compressed and plain JSON
   Drawing fences, CRLF and empty valid scenes. Use the small LZString codec,
   loaded behind the drawing boundary, rather than reimplement compression.
   Decode in a worker so the measured large scene cannot block typing. Enforce
   source/decoded size limits and worker timeout; reject malformed or ambiguous
   scenes explicitly. Preserve the source bytes. Respect Text Elements mappings.
   Unsupported external assets/Markdown images must be reported, never silently
   dropped into a plausible but incomplete drawing.
3. Open these paths in the existing lazy drawing surface, in view mode with no
   drawing session, edit callback, autosave or file write. Show a compact original
   format label and Create editable copy action. Loading/error/empty states must
   remain usable. Keep source paths and metadata intact. A read-only load cannot
   enter ordinary Markdown save scheduling.
4. Share lazy scene loading/export between preview and copy. Inline wiki embeds
   resolve both `.excalidraw` shorthand and explicit `.excalidraw.md`, render an
   image from the scene, and double-click into the same preview. Normal wiki links
   open that preview too. Resolution preserves workspace/relative/basename rules
   and ambiguity handling. Generated previews use bounded, workspace-owned cache
   and lifecycle cleanup; watcher invalidation refreshes them. Existing SVG embeds
   continue using direct file URLs without loading Excalidraw.
5. Create editable copies beside the source as `.excalidraw.svg`, using the
   existing export path and collision naming. Conditional missing-file writes
   protect existing destinations. Read the latest source for the operation; keep
   origin/generation checks around asynchronous navigation. Open the copy only
   after successful persistence. Original notes and links remain unchanged;
   communicate that this is a copy, not automatic migration.
6. Keep frontend/backend file classification consistent for sidebar/index/title
   metadata. Do not accidentally grant Markdown-only mutation commands permission
   to overwrite imported drawing documents. Update owning format and MCP docs if
   their observable contracts change. Review any dependency/lock edits separately
   from the user's existing dependency changes.

## Verification

- Strict parser tests: both encodings, newlines, empty scenes, text mappings,
  corrupt/base64/JSON, multiple Drawing blocks, unsupported/missing assets and
  bounded decode behavior. Synthetic fixture only in committed tests.
- Route and link tests: explicit/shorthand drawing embeds, basename ambiguity,
  existing image/SVG/PDF behavior, restoration and source-preserving copy writes,
  destination collision, import errors, workspace switch and late load results.
- Preview lifecycle tests: repeated embeds share work, cache bounds, invalidation,
  unmount/reset cleanup and stale results cannot repopulate a new workspace.
- Native before/after: note beside rendered drawing, double-click/open link,
  source hash unchanged across load/close/quit, copy opens editable, save/reopen
  retains elements and original hash; invalid source displays an explicit error.
- Native large-scene decode/render timings, typing during load, narrow/wide and
  light/dark views; AeroSpace live check for changed desktop content.
- `vp check`, `vp test`; if Rust changes, cargo test/clippy/fmt. Build actual app,
  visually inspect it, run implementation reviews, document limits and commit.

## Status

Implemented and verified for preview and explicit editable copies. Eight plan and
eight implementation persona reviews completed; accepted findings are fixed.
Final gates: 1,801 frontend tests, 305 Rust tests, check/clippy/fmt and native build
pass. Remaining migration and rendering work stays in the broader audit. Original
vault inspection was read-only and did not launch Obsidian or its synchronization.

## Plan-review refinements

Architecture, Editor, Rust, React, UX, QA, State and Startup reviews supported the
preserved-original/copy boundary. These refinements were incorporated:

- Shared lazy Excalidraw runtime initializes local font assets before import or
  export, including cold-start inline embeds without any drawing tab.
- One generated-preview owner bounds entries, retained bytes, decoded scenes,
  workers, queued work, revisions and object URL leases. Widget `destroy` releases
  its lease; late results cannot update detached DOM or repopulate a reset cache.
  Notify mounted readonly tabs and embeds on invalidation. Do not append query
  parameters to blob/data URLs. Check valid→corrupt→valid, delete, in-flight export,
  two consumers and final release. Request CodeMirror measurement on height change.
- Decoder allocation must be bounded during decompression, not merely checked
  afterwards. Evaluate a small attributed, bounded LZString decoder if the upstream
  codec cannot enforce an output/dictionary budget; worker timeout must terminate
  execution, and concurrency/queue limits must be explicit. Test expansion and
  successful retry in real WebKit.
- One resolver handles drawing links/embeds. `.excalidraw` shorthand continues to
  target its `.excalidraw.md` original after a Writer copy appears. Duplicate bare
  names fail explicitly; do not inherit image resolver's arbitrary first match.
- Capture drawing gestures per EditorView and original tab/path/generation. Preserve
  selection unfolding and code-fence exclusion, including treeChanged updates.
- A readonly drawing must never enter openFiles or attachDrawingView. Guard every
  placeholder/prefetch path, including compact opens and v1/v2 restoration of
  current/back/forward locations. Persist normalized locations on the next snapshot.
- Keep source reading, external opening, sidebar listing and recents separate from
  Markdown mutation eligibility. Reclassifying sources must not break Finder/CLI
  or compact watcher retargeting. Derive the active document path for watcher and
  recents separately from activeFilePath, which deliberately excludes drawings.
- Copy capture includes generation/tab/path/pane/focus. Recheck after read/decode/
  export and before persistence; after a successful write, retain the file but
  suppress stale navigation. Cover A→B→A, tab closure/replacement and focus changes.
- Label the preview/copy distinctly. Before copy, explain that it creates a separate
  drawing beside the source and existing notes still show the original. Provide
  readonly source inspection or external reveal. Empty drawings get an explicit
  empty state; errors have Retry; failed inline previews remain operable links.
- Keep copy access and pan/zoom usable at 240×160. Long preservation details belong
  outside the clipped pane. Test keyboard focus, harmless preview Cmd+S and saving
  an adjacent editable drawing. Add a pane-local render/lazy-load error boundary.
- Atomic no-clobber publication and its race tests are AUD-10. Existing-file
  compare/replace limits remain separately documented.

Owning drawing spec, editor docs, Zustand ownership notes and any changed MCP
contracts must be updated with the implementation. No complete-migration claim.

## Final implementation

- Shared format classification routes Obsidian Markdown sources to read-only
  previews and Writer SVGs to editable canvases. Restore, sidebar, recents,
  standalone startup and watchers use the same document identity. Source paths
  never enter text buffers, editable drawing sessions or Markdown mutations.
- Strict wrapper parsing honors Text Elements and Element Links. The attributed,
  bounded LZString decoder runs in a worker with cancellation and timeout.
  Rust caps source reads at 4 MiB; parser budgets also limit decoded output,
  dictionary growth, nesting and element counts. All seven current SDU drawings
  decode in a read-only diagnostic. External assets and unsupported content fail
  explicitly instead of producing an incomplete copy.
- Two jobs at a time and 12 current entries/32 MiB estimated current data bound
  shared preview work. A matching reserve retains old UI leases during refresh.
  DOM-owned cleanup survives CodeMirror equal-widget reuse. Reset and invalidation
  cancel stale work; the last release revokes URLs. Preview images omit editable
  metadata; actual copies and saves retain it.
- Copy creates a separate SVG beside the source using exclusive missing-file
  publication and collision naming. Focus/tab/workspace changes permanently
  cancel stale navigation, including A→B→A. Existing note links keep resolving
  to the original. Basename ambiguity produces a visible error.
- Preview has loading, error/retry, empty, fit and zoom states, source reveal and
  copy actions. Compact labels keep controls usable at 240×160. Dark-mode images
  use the existing drawing filter. CSP permits blob images only in img-src.
- Renaming a text note into a drawing source flushes pending text before rename;
  failure aborts the operation. Returning to a compact source refreshes it after
  watcher retargeting, including changes made while its copy was active.
- Test configuration skips unnecessary font asset copying, resolving a reproduced
  concurrent build/test EEXIST failure. The LaTeX highlight test explicitly
  finishes syntax parsing before checking nested marks; production behavior did
  not change. Existing user math/Mermaid/dependency changes remain separate.

## Verification results

Evidence directory: `/Users/oliver/agent-runs/2026-10-29-writer-audit/`.
All interactive data came from the synthetic study fixture and isolated audit app.

- Frontend: 1,801 tests in 119 files pass (`obsidian-drawings-tests-7.log`).
  Check: zero errors, ten existing warnings (`obsidian-drawings-check-7.log`).
- Rust: 305 tests pass; clippy completes with 13 existing warnings; fmt passes
  (`obsidian-final-rust.log`, `obsidian-final-clippy.log`, `obsidian-final-fmt.log`).
- Seventh release/e2e app build passes (`obsidian-drawings-build-7.log`).
- Native copy: Create editable copy opened the canvas. Native Cmd+A, Right Arrow
  and Cmd+S moved both elements by one pixel, changed the SVG hash, and retained
  element IDs and positions after a full reload. Original source hash remained
  unchanged (`obsidian-native-copy-roundtrip.json`).
- Source and inline preview share a URL. Valid→corrupt→valid and delete→recreate
  refresh both consumers; errors expose an operable link. Source hash was restored
  (`obsidian-native-invalidation.json`). Final native embed removal released its
  URLs (`obsidian-widget-lifecycle-final.json`). The precise equal-widget DOM
  reuse regression is covered by the real-widget unit test, not a claimed native
  red/green reproduction.
- Shorthand link after copies existed reused the original preview, with no
  editable canvas. Synthetic Cmd+S in that source issued no write_file call and
  preserved its hash (`obsidian-native-source-routing.json`). The first harness
  expected a duplicate preview; that assertion was wrong because navigation
  correctly reused the already-open tab.
- Cold Launch Services open of the source produced a compact drawing preview
  without a CodeMirror editor (`obsidian-native-compact-startup.json`). Direct
  executable argv is not the macOS open path and was excluded from this result.
  Returning through recents from a copy rendered the changed Text Elements text;
  empty→restored source transitions updated live, preserving original bytes
  (`obsidian-native-compact-watch.json`). Generated SVG text was inspected through
  a temporary createObjectURL observation hook because CSP correctly blocks
  fetch(blob:). No CSP relaxation was made for the diagnostic.
- A 240×160 pane leaves 42px fitted image height; all controls fit and Zoom out
  shrinks the portrait. Light/dark screenshots were inspected
  (`obsidian-native-small.json`, `obsidian-small-{dark,light}-800.png`).
- Cold opening automatically tiled beside Safari: neighboring width changed
  2998→1494px, Writer's parent was TilingContainer, and closing restored 2998px.
  Reopening the same source kept one window. Evidence: compact-tiling and
  compact-repeat-open JSON files. No AeroSpace configuration changed.
- Native before/after screenshots are retained. The original file named
  before-1200 is actually 1780×2238 physical pixels; matched after captures use
  that same geometry. Do not infer viewport size from the historical filename.

## Performance and remaining limits

Native profiling used a synthetic 1,399,841-byte source with 430 freehand strokes.
Before preview metadata removal, first display took 332ms with a 220ms maximum
frame gap and 189ms maximum scheduled insertion delay; all 30 synthetic CodeMirror
insertions completed. Warm repeats displayed in 282–310ms. Instrumented stages
showed roughly 55ms for editable metadata and 100ms for stroke SVG construction,
with worker decode off the main thread. This justified omitting metadata from
previews while preserving it in copies and saves.

A later diagnostic at 1494×1651 CSS pixels displayed in 246ms with a 143ms maximum
frame gap and 105ms maximum insertion delay (30/30 completed). It differs from the
1200×800 baseline geometry. Attempts at matching geometry lost foreground
visibility and are excluded. No controlled speedup percentage is claimed. These
are synthetic insertion timings, not hardware keyboard latency. AUD-11 tracks
remaining synchronous export and comparable foreground measurements.

Full Obsidian serialization, asset migration, relationship rewriting and itslearning
integration remain open in the comprehensive audit. This task preserves the entire
source and creates an explicit independent copy; it does not claim full migration.
No production installation, push or deployment occurred. The goal remains active.

Future subagents use gpt-6.1-sol with high reasoning, as requested by Oliver.
