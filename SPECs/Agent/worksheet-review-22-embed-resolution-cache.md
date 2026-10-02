# Bound wiki image resolution caching

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Adjacent memory finding discovered while checking image ownership.

## Plan

The module-level embedResolutionCache in components/editor-area/wiki-link-extension.ts retains every successful workspace/note/target resolution and never clears on editor reset. Add a bounded recency cache, clear it on reset, and prevent old async resolutions from repopulating it. Keep misses uncached so newly created images can resolve. Read the owning image spec and editor guidelines; add retention, eviction and delayed-reset regressions and review per agent-review.md before implementation.

## Report

Pending implementation and validation.
