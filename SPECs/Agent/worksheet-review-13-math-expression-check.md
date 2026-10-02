# Compare bare math expressions by value

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 13.

## Plan

Read evaluate.ts, math-evaluate.test.ts and math-workflow FR-7. Proportional residuals currently certify different bare expressions and constants. Classify both inputs using equalitySides before parsing: two bare expressions compare values directly; two single equations may compare residuals up to a constant nonzero factor. Mixed expression/equation input and equality chains report open rather than inventing semantics. Replace chain-folding differenceSource with explicit two-side residual construction. Retain sample failure/evidence behavior for the separate ticket14 fix. Tests cover scaled variables/constants as unequal, algebraic identities, equivalent scaled equations and unsupported mixed/chained inputs. Update FR-7 and changelog. QA reviews plan and implementation; no UI/API shape changes.

## Report

Implemented explicit two-form classification and pointwise expression comparison. Eight regression failures reproduced before the fix; eleven new cases include negative/complex scaling and retained equation transformations. Evaluator, plot and command suites pass 42 tests; targeted formatting/lint/types pass. QA approved with no findings. Full frontend suite passes 1,558 tests; vp check reports no errors and ten existing warnings. Browser execution confirms expression counterexamples, retained equation scaling and mixed-form refusal. Ticket14 handles unusable-sample evidence next.
