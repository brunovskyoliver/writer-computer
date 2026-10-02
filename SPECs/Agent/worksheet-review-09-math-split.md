# Preserve surrounding source when splitting aligned math

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 9.

## Plan

Refuse splitting unless the aligned environment is the whole formula. Verify the actual editor dispatch path.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
