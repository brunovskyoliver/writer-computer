# Code review fixes

The user approved fixing the 20 findings from the full desktop code review on 2026-10-02.

## Requirements

- Preserve unsaved text across workspace closure and switching. Failed saves leave the current workspace and buffers intact.
- Bound retained compiler output, diagnostics and image metadata. Release resources on failure and reset, including asynchronous completions.
- Serialize builds by canonical root, respect save failures and follow changed root declarations when opening previews.
- Preserve TeX source during formatting and splitting. Numeric annotations must match rendered TeX; expression checks must not certify unsupported or unequal expressions.
- Keep plot power syntax and shipped snippet behavior compatible. Unsupported custom regex syntax must produce a clear load error rather than freezing the editor.
- Complete each finding separately, with a regression check and a local commit. Leave the user's existing AGENTS.md edit untouched.

## Tickets

1. [Save dirty text before closing or switching a workspace](../Agent/worksheet-review-01-workspace-save.md)
2. [Release failed PDF search acquisitions](../Agent/worksheet-review-02-pdf-search-release.md)
3. [Bound LaTeX compiler output](../Agent/worksheet-review-03-compiler-output.md)
4. [Bound image height cache retention](../Agent/worksheet-review-04-image-height-cache.md)
5. [Reset LaTeX records with the editor workspace](../Agent/worksheet-review-05-latex-reset.md)
6. [Serialize LaTeX builds by resolved root](../Agent/worksheet-review-06-compile-root-lock.md)
7. [Abort LaTeX commands after a failed save](../Agent/worksheet-review-07-compile-save-failure.md)
8. [Refresh roots when choosing LaTeX previews](../Agent/worksheet-review-08-preview-root.md)
9. [Preserve surrounding source when splitting aligned math](../Agent/worksheet-review-09-math-split.md)
10. [Preserve TeX syntax stars during tidy](../Agent/worksheet-review-10-tidy-stars.md)
11. [Deduplicate nested matrix separator edits](../Agent/worksheet-review-11-tidy-nesting.md)
12. [Preserve argument and text spacing during tidy](../Agent/worksheet-review-12-tidy-text.md)
13. [Compare bare math expressions by value](../Agent/worksheet-review-13-math-expression-check.md)
14. [Require valid evidence before reporting math equality](../Agent/worksheet-review-14-math-valid-samples.md)
15. [Preserve integer zeros in evaluated values](../Agent/worksheet-review-15-math-format.md)
16. [Follow TeX token rules for superscripts](../Agent/worksheet-review-16-math-exponents.md)
17. [Handle zero in complex powers and roots](../Agent/worksheet-review-17-math-zero.md)
18. [Prevent snippet regexes from blocking the editor](../Agent/worksheet-review-18-snippet-budget.md)
19. [Clear removed tab view states on editor reset](../Agent/worksheet-review-19-tab-view-reset.md)
20. [Unregister failed MCP handshakes](../Agent/worksheet-review-20-mcp-handshake-cleanup.md)

## Validation

Run the relevant regression tests for each ticket. Finish with vp check, vp test, cargo test, cargo clippy and cargo fmt --check. Native/WebKit allocation profiling is a separate remaining validation gap; unit tests cannot certify allocator behavior.
