# Bound LaTeX compiler output

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 3.

## Plan

Drain stdout and stderr without retaining unlimited bytes. Keep diagnostics and returned logs bounded and report truncation.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
