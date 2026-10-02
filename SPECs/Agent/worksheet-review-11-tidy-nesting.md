# Deduplicate nested matrix separator edits

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 11.

## Plan

Read tidy.ts and math-tidy.test.ts. Nested cell-body spans each collect the same separator position. Use a Set for separator positions before constructing rewrite events, so the same source token contributes exactly one edit and one count. Add a nested-matrix regression containing both outer and inner separators. Formal plan/implementation review skipped under the review protocol's obvious single-file correction exception; behavior is tested directly.

## Report

Separator collection now uses Set semantics. The regression failed before the fix with three edits and an extra inner column, then passed with exactly two edits and one separator per cell boundary. Tidy and real-command suites pass 44 tests; targeted format/lint/type checks pass. No view or interaction APIs changed. No remaining work for this finding.
