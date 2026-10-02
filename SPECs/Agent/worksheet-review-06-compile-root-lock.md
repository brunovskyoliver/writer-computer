# Serialize LaTeX builds by resolved root

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 6.

## Plan

Resolve the canonical document root before queuing compiler requests and protect shared PDF output across windows.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
