# Require valid evidence before reporting math equality

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 14.

## Plan

Read checkEquivalent/evaluateExpr, math-evaluate tests and FR-7. Skipped exceptions and nonfinite values currently contribute no evidence but still end in equal. Count usable trials: closed inputs need one finite comparison; inputs with free variables need three. Try the eight existing deterministic candidate assignments until enough comparisons succeed, or report open when the evidence remains insufficient. A finite counterexample still returns differs immediately. Equation ratios must themselves be finite and nonzero before counting that trial. Zero residuals on both sides are valid evidence. Normalize sameValue by the largest finite component before measuring relative complex distance, so finite large components cannot compare Infinity against Infinity. Reject nonfinite components explicitly. QA added large complex sign and overflowing/zero quotient regressions. No new random/stateful sampling or parser changes.

Regressions cover all-nonfinite closed/variable expressions and equations, two-only-valid samples, recovery past a pole, and a counterexample exposed after the original three trial positions. Update FR-7/changelog. QA reviews plan and implementation; no UI/API shape changes.

## Report

Implemented successful-trial counts, bounded recovery candidates, finite nonzero ratio admission and normalized complex comparisons. Six original regressions failed before the fix; ten new cases now pass, including QA overflow and invalid-ratio examples. Evaluator/plot/command suites pass 52 tests, targeted format/lint/types pass. QA approved with no findings. Full frontend suite passes 1,568 tests; vp check reports no errors and ten existing warnings. Browser execution confirms undefined formulas report open and both later/large-complex counterexamples report differs. The check remains numeric sampling, not proof. No remaining work for this finding.
