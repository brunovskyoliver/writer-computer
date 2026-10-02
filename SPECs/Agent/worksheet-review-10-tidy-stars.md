# Preserve TeX syntax stars during tidy

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 10.

## Plan

Only rewrite multiplication stars between operands. Preserve command stars, environment names and exponent groups.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
