# Preserve integer zeros in evaluated values

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 15.

## Plan

Trim only fractional trailing zeros. Preserve large integer place values and complex components.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
