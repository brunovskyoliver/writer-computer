# Prevent snippet regexes from blocking the editor

Status: Up next.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 18.

## Plan

Provide a bounded matcher for accepted custom regex patterns. Keep shipped patterns and captures compatible; reject unsupported patterns explicitly.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Pending implementation and validation.
