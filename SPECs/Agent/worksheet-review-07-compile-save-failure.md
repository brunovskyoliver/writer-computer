# Abort LaTeX commands after a failed save

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 7.

## Plan

Require a successful save before explicit compile and preview commands.

Both explicit commands await saveNow but ignore its boolean result. Add failed-save regressions using the actual commands, then require saved === true before proceeding. Preserve the existing reset checks. Formal plan/implementation review is skipped for this obvious two-guard correction in one file, per agent-review.md; no queue or save ownership changes. Existing success/reset tests cover the adjacent boundary.

## Report

Both commands now return after a false save result. Regression tests failed before the change and pass after, proving that neither command launches the compiler, checks/opens a PDF or bumps a revision. The three focused LaTeX suites pass all 33 tests, including successful commands and reset races. Targeted vp check passes. No native code changed. Formal review skipped for the two obvious single-file guards; the save layer still owns error reporting.
