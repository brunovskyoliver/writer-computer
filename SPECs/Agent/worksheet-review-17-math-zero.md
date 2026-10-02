# Handle zero in complex powers and roots

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 17.

## Plan

Read complex pow/sqrt and inverse-function consumers, evaluation tests and FR-6. Before the log branch, return complex zero for an exactly zero base with a finite positive real exponent. Preserve the existing integer 0^0 convention and let negative/complex/nonfinite exponents remain nonfinite/open. This also repairs root and inverse-function boundary results. Formal review skipped for the obvious single-condition math boundary correction, with public evaluator regressions for success and excluded exponent domains.

## Report

Implemented the positive-real zero-base shortcut. Eight root/power/inverse-function boundary cases failed before the fix and now pass; thirteen new success/excluded-domain cases plus consumer suites pass 104 tests. Targeted format/lint/types pass. Existing 0^0 convention stays explicit in FR-6. No remaining work for this finding.
