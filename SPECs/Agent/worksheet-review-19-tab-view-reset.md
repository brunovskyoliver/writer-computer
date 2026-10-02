# Clear removed tab view states on editor reset

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 19.

## Plan

Delete cursor and scroll records for every removed tab when resetting the editor.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
