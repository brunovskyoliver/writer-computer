# Preserve integer zeros in evaluated values

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 15.

## Plan

Read formatComplex, evaluation tests and FR-6. Trim fractional trailing zeros only when toFixed returns a decimal without an exponent. Preserve integer place values and scientific exponent digits. Use the largest component to set the tiny-component threshold so large finite complex magnitudes cannot overflow it and erase both components. Add real/complex/scientific-format regressions. Formal review skipped under the obvious single-file correction exception; both changes directly guard numeric formatting boundaries.

## Report

Both formatting guards implemented. All eight new real/complex/scientific cases failed before the fix and pass afterward; the three relevant suites pass 60 tests. Targeted format/lint/type checks pass. Decimal formatting tests remain green. No view or interaction API changes and no remaining work for this finding.
