# Preserve argument and text spacing during tidy

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 12.

## Plan

Read tidy.ts, shared scan.ts, tidy/scanner/align/evaluator tests and math-workflow FR-4. Restrict separator edits to the top-level cell grammar of each matrix body using the shared topLevelMask. Nested cell environments are scanned separately; separators in text, fractions, script groups and other argument groups remain untouched. Keep ticket11's deduplication. QA added recognized optional arguments such as sqrt indices: extend the local command-role table with an optional-argument flag and mask those spans only for cell separator scanning. Use a local optional-argument scanner that skips escapes/comments/brace groups, leaving global bracket semantics unchanged. Require closed optional array position/starred matrix alignment arguments before scanning their bodies.

Make shared environment and top-level scans comment-aware, using an invocation-local comment mask so commented braces/environments/separators cannot change cell boundaries. Escaped percent signs remain literal. Skip TeX trivia before array/subarray column specifications and require a complete column group before admitting their body. Reuse shared comment/brace scanners rather than inventing a second nesting rule. Update FR-4 and the changelog. Add mixed literal/cell separators, nested matrices, comments with misleading braces/end tokens, whitespace/comment before column specs, and malformed-spec regressions. QA reviews plan and implementation; no CodeMirror or layout changes.

## Report

Implemented local cell masks, recognized optional-argument protection and complete column/optional environment admission. Shared comments/environment scans ignore commented tokens, and both characters of an escape inherit their brace nesting. Sixteen mixed tidy cases and three scanner regressions now pass; all seven relevant suites pass 167 tests. The initial nested-escape failure was diagnosed from actual mask bits in the browser before correcting the shared scanner. Full frontend suite passes 1,547 tests; vp check reports no errors and ten existing warnings. Browser command check preserves text and root-index spacing, edits only the cell separator and restores source with one undo. QA found argument-taking optional commands could expose star arguments. Both suffix and operand checks now distinguish them from bare operands; two mixed regressions cover preservation plus external products. QA implementation review approved with no remaining findings. No remaining work for this finding.
