# Serialize LaTeX builds by resolved root

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 6.

## Plan

Resolve the canonical document root before queuing compiler requests and protect shared PDF output across windows.

Root lookup currently returns aliases unchanged, and the first request is queued by source before root is known. Investigated latex-compile-store and native latex_compile.rs; read state/architecture guardrails and LaTeX spec.

Resolve the root freshly before frontend queue lookup, then key running/build/rerun records by the canonical root. Keep generation guards from ticket05 and identity guards on internal queue promises. Resolve again for a queued rerun. A lookup failure yields a failed result/diagnostic; a missing root stays a named no-root result. Every requesting chapter learns its association from its own fresh lookup; joining another chapter must not publish that chapter's migrated root.

Canonicalize roots centrally in Rust for both lookup and compilation. Introduce a process-wide per-root mutex registry using Weak references, pruning expired entries on acquisition; release the registry lock before waiting for a document lock. Hold the document lock through the complete native engine/readers/result lifecycle. Different roots remain independent. Poison failures return explicit AppError. Rust plan review approved: select roots relative to the requested source before canonicalizing; document physical symlink target directory. Change latex_root worker failure to Result<Option<String>, AppError> so only successful absence is no-root. Test contended-root independence, dead-entry replacement and lock release after engine startup failure. No process cancellation or engine options change.

Regression checks: two initially unknown chapters share one engine and one rerun, stale root lookup/reset does not queue, path aliases/symlinks resolve identically, simultaneous fake-engine calls to one root never overlap, different root locks remain independent and dead registry entries are pruned. Update LaTeX concurrency contract and changelog. Existing async tests wait for root resolution instead of relying on synchronous IPC. State implementation review found out-of-order fresh lookups could hide a newer successful build. Pending per-source tokens now discard superseded success/null/error completions before publication or queueing; compileLatexSource returns null for a superseded request, and commands stop silently. Tokens are removed on completion/reset rather than retaining a counter for every source.

## Report

Implemented fresh canonical-root queueing and a process-wide native lock registry. Active compiles and waiters own strong references; expired root entries are pruned when acquiring a lock. Alias and chapter requests share one engine, while different roots remain independent. Failed engine startup releases the lock.

Implementation review found and fixed stale lookup publication, autosave canceling a foreground lookup, migrated results overwriting another root's active/newer build, and unhandled preview/autosave lookup failures. Pending lookup tokens, generation checks and WeakMap build ordering protect publication without retaining another path registry. Root lookup worker failures now reject IPC rather than masquerading as missing roots.

Rust, State, Systems and QA implementation reviews approved. QA also reproduced and verified fixes for synchronous root-subscriber reentry and a joined migration overwriting a fresh rerun association. Validation: all 1,437 frontend tests and 273 Rust tests pass; vp check, cargo fmt --check and cargo clippy pass with existing warnings. Focused regression coverage includes pending/null/error lookup races, workspace reset, active/newer destination build ownership, root migration, canonical symlinks, simultaneous fake-engine calls and different-root contention. No native two-window build or WebKit heap profile was performed. Save-failure and preview-selection corrections remain separate tickets 07/08.
