# Preserve argument and text spacing during tidy

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 12.

## Plan

Rewrite spacing separators only at matrix cell level, outside text and argument groups.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
