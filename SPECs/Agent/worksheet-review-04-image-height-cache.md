# Bound image height cache retention

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 4.

## Plan

Use bounded retention for measured heights and avoid retaining embedded image data in keys.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
