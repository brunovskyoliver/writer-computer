# Clear removed tab view states on editor reset

Status: Complete.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 19.

## Plan

Read editor-store reset, editor-views ownership, shared-buffer regressions and Zustand/editor guidelines. Close/remove paths already delete per-tab cursor/scroll records; reset drops all tabs without this cleanup. Add clearTabViewState to the existing removed-tab loop before publishing the empty layout. Assert both panes of one document lose their independent records, and a tab can start recording a fresh position after reset.

Formal plan/implementation reviews are skipped under agent-review.md's trivial-fix exception: one existing cleanup call in the established reset loop, with a public-getter regression. Run shared-buffer/layout/API/reset tests and scoped checks. Record verification in this worksheet and the changelog before committing.

## Report

Reset now clears each removed tab's view-state record alongside its pending navigation entry before publishing the empty layout. A two-pane shared-document regression failed with retained cursor/scroll values before the fix and now verifies both records are removed, the cache count is zero and a fresh cursor record has default scroll. Shared-buffer, layout, editor API and LaTeX reset tests pass. Scoped format/lint/type checks pass without warnings. Formal review skipped for the obvious existing-helper cleanup call, per the plan. No behavior or validation remains for this ticket.
