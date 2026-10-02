# Bound wiki image resolution caching

Status: Complete.

Spec: [Code review fixes](../review-fixes/spec.md). Adjacent memory finding discovered while checking image ownership.

## Plan

Read the image embed spec, wiki-link extension and lib/wiki-links.ts resolver, shared LruCache, editor-reset generation and editor/consolidation guidelines. The extension's module-level Map retains every successful workspace/note/target resolution across workspace resets. Its comment mistakes session growth for a bound. The uncached resolver already accepts filesystem dependencies and also serves PDF navigation; preserve that contract.

Move the embed-specific cached wrapper into the resolver owner as resolveWikiImageEmbed, with the same injected filesystem dependencies as resolveWikiImage. Reuse LruCache with 256 positive entries. Keep the existing workspace/note/target identity and skip caching entries whose combined key/value exceeds 8,192 UTF-16 characters, so redundant long path spellings cannot retain large keys. Check input length before building a cache key; serialize bounded inputs as a JSON tuple so concatenation or sliced targets cannot retain a large document through the key. The final entry limit includes serialized-key delimiters and escaping. Cache misses and failures remain uncached. Do not add an in-flight promise registry.

Register cache clearing once with onEditorReset and capture editorGeneration before awaiting resolution. A result that crosses reset can still finish its old caller, but cannot populate the new cache. The widget calls this wrapper with the current Tauri helpers; PDF resolution continues through the uncached resolver. No store import or new reset path is needed.

Editor, Systems and QA review plan and implementation under agent-review.md. Tests exercise the production wrapper through filesystem callbacks: repeat hit, context isolation, LRU eviction/refresh, reset re-probe, an old completion after a newer same-key result, repeated miss followed by creation, failure retry and oversized-key bypass. Use public resolver behavior rather than test-only cache accessors. Update the image spec, editor cache guidance, changelog and this report. Run targeted checks/tests, exercise the wrapper in the shared browser, then run final frontend and native gates before wrapping the full review.

## Report

The resolver now owns a 256-entry LRU of positive image/drawing resolutions. Each retained serialized key plus resolved path fits 8,192 UTF-16 characters; oversized inputs are checked before key construction and still resolve without caching. JSON tuple keys avoid keeping large document slices through concatenation. Misses and failures are retried, and filesystem errors propagate. Editor reset clears the cache, and generation checks prevent old completions from repopulating it. Both existing inline rendering and drawing-open call sites use the same wrapper; PDF resolution remains uncached.

Extracted the old wrapper without behavior changes to reproduce six independent failures for eviction, reset, both late-completion cases and oversized retention. All 11 cache regressions now pass, including context isolation, retry and exact 8,192/8,193-character boundaries. The six related suites pass 97 tests; QA independently passed 78 cache/wiki/PDF/LRU/image-fold cases. Editor, Systems and QA approved plan and implementation. Scoped checks have no warnings.

Final full frontend suite passes 1,687 tests in 110 files. vp check reports no errors and ten existing warnings. The desktop production build passes, including TypeScript compilation; existing toolchain/chunk warnings remain. Current native source passed all 276 Rust tests, cargo clippy with nine existing warnings and cargo fmt --check in ticket20.

The shared T3 browser disconnected during verification and explicitly reported its automation host unavailable. An isolated temporary Chrome profile then checked real EditorViews with the shipped Markdown/math grammar and the production wiki extension: two widgets shared one lookup, real editor-store reset caused a new lookup, source stayed intact and an old same-key completion left the newer cached result in place. Views, shim and store state were restored in finally. Native/WebKit allocator profiling remains a separate gap. Positive resolutions can remain stale until eviction or reset, preserving the existing policy. No implementation remains for this ticket.
