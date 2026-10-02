# Preserve TeX syntax stars during tidy

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 10.

## Plan

Read math/tidy.ts, scan.ts, math-tidy.test.ts, math-commands.ts and math-workflow FR-4. The implementation rewrites every unescaped star except literal text and stars immediately after a superscript opener. It does not establish operands or protect the rest of an exponent, command variants or metadata.

Build a compact per-character mask using the existing brace scanner: protect full superscript groups (including nested groups), text/operator-name and known metadata arguments, environment declarations/column specifications, and command suffix stars. One local command-role table supplies operand and literal-argument rules. Recognize common bare math-symbol/operator commands as operands, so Greek products still tidy. Unknown command suffix stars and their immediate argument groups remain untouched. Require plausible operand boundaries on both sides of an unprotected star; preserve lone/operator runs, and allow signed right operands. This is a conservative source rewrite, not a general TeX parser; ambiguous command syntax stays unchanged.

QA plan review added unescaped-percent comments. Mask through the line end while keeping escaped percent signs literal. Extend the shared matchBrace scanner to skip those comments too, so a brace inside a comment cannot prematurely end protected text or exponent groups. Add mixed real-product/comment and commented-brace regressions. The mask lives only during the command and avoids repeated span searches.

Keep the current separator pass unchanged for tickets11/12. Add preservation regressions for starred commands/environments/column specs/full exponents/text with whitespace/metadata, plus mixed formulas proving real products still change (Greek, grouped/fraction operands, signed operands). Include actual command dispatch coverage for a starred operator next to multiplication. Update FR-4, worksheet and changelog. Ask QA to review plan and implementation; no CodeMirror API or view layout changes are planned.

## Report

Implemented the invocation-local byte mask and operand checks; shared brace matching now skips TeX comments. Added 25 preservation/product cases, three shared-scanner cases and one real-command undo regression. The seven relevant suites pass 145 tests. Browser checks with real EditorView confirm mixed starred/exponent/product formulas and comments preserve source and undo in one step. Full frontend suite passes 1,525 tests; vp check reports zero errors and the ten existing warnings. QA found URL arguments and comments between commands/superscripts and argument groups could expose literal stars. Added href/url roles and comment-aware structural trivia scanning; five mixed regressions now pass. QA implementation review approved with both findings resolved. Comment preservation wording covers stars and brace matching; separator/comment handling belongs to ticket12.

Two initially failing assertions were corrected after diagnostics: the escaped-percent example closes at character 4, and a combined boundary fixture accidentally supplied a valid signed operand. Separate lone-star/operator-run formulas now test the intended rejection. Temporary diagnostics were removed. No native UI behavior changes.
