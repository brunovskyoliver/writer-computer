# Preserve surrounding source when splitting aligned math

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 9.

## Plan

Investigated math/align.ts, math-commands.ts, math-align.test.ts, the shipped nested math parser in math.test.ts, math-context.ts and math-renderer.ts. Read docs/editor.md, agent-loop/review and the owning math-workflow FR-5. The pure splitter returns the first matched aligned body even when another expression or environment surrounds it; the command then replaces the entire Math node with those rows and loses the surrounding source.

Accept only an aligned-family environment covering the whole trimmed formula. Skip nested candidates with surrounding source so a valid whole outer aligned environment can still split. Consume alignedat's required column argument after whitespace, refusing a missing/unclosed argument. Keep nested matrix and group separators intact. Do not broaden the command's existing math-context behavior in this ticket.

Before dispatch, validate every resulting formula through the existing validateMath helper; if any row cannot render, show a notice and leave the source untouched. Local pinned KaTeX source shows that tags require displayMode, so extend validateMath with an optional display flag (existing default unchanged) and validate these new $$ formulas in display mode. Include a tagged-row success regression. This follows the editor doc's validation rule; this command intentionally owns delimiter conversion under FR-5, so highlight-specific range wrapping does not apply.

Add pure regressions for surrounding prefix/suffix expressions, nested and sibling environments, whole outer aligned environments, and alignedat column whitespace. Add actual StateCommand tests using the shipped Markdown/GFM/Prosemark/nested-LaTeX grammar, verifying rejected documents receive no transaction, valid output preserves surrounding prose and nested matrix content, invalid rows are refused, and one undo restores the original document. Check the real EditorView dispatch in the browser. Update math-workflow spec, worksheet and changelog. Request Editor and QA plan/implementation reviews.

## Report

Implemented the whole-formula gate and required alignedat argument handling. The actual split command validates every output row in display mode before one transaction; refused formulas keep all source. Existing validation callers keep their default mode. Updated FR-5, the editor doc's structural-rewrite exception and changelog.

The baseline reproduced 13 failures. The first correction left nested aligned openers consumed by the same closing token; a temporary candidate log identified that loop behavior. Breaking after the matched candidate fixed it, and the diagnostic was removed. All 113 targeted math/command/brace/highlight cases pass, as do the full 1,496 frontend tests. vp check reports zero errors with ten existing warnings; git diff --check passes. Editor and QA plan and implementation reviews approved.

Browser verification used real EditorViews with the shipped nested grammar and the actual command. Surrounding and invalid formulas stayed unchanged; valid and tagged formulas split correctly; one undo restored the complete source. Views, temporary host and notices were cleaned up. Whole native-app UI validation remains outside this isolated browser check; no Rust code changed.
