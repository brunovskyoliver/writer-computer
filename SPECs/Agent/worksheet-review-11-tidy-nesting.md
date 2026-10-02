# Deduplicate nested matrix separator edits

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 11.

## Plan

Give each separator one rewrite even when matrix body spans overlap.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
