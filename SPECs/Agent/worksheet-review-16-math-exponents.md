# Follow TeX token rules for superscripts

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 16.

## Plan

Parse unbraced math superscripts as one TeX token while preserving the plot language's existing power syntax.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
