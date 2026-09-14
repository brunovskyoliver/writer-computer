# LaTeX editing preview

Task: TODOS.md; spec: ../latex-edit-preview-spec.md.

Clean starting tree. Read editor, consolidation, Vite+, agent-loop and review docs; math parser, renderer, fold registry, tests, snippet context. Local vp is node_modules/.bin/vp; install passed.

Plan: retain the shared folding decoration on unfold, emit a block preview at the opening line for display math and leave source editable. Reuse MathWidget with preview identity and ignored pointer events. Avoid changing inline folding. Test exact expression, preview placement, updates and refolding. Run frontend checks and tests, browser verification if available. Parser failure not reproduced: exact expression passes already.

Initial targeted run: 18 passed, missing-preview assertion failed.

Outcome: screenshot suggested blank-line paragraph splitting; regression confirmed two failures. Added root-level display parser; reviewer caught nested-container crossing and mixed closer regression, both fixed and tested. Shared widget provides preview without click-to-edit collision. Real browser EditorView harness verified rendered KaTeX, preview above source, refold and reentry; snapshot tool failed, geometry/DOM checks passed. Temporary harness removed. No Rust changes.

Final validation: vp check passed (six existing warnings), all 69 frontend test files / 970 tests passed. First unescaped closer preserves trailing prose and separate math using the existing inline parser. No Rust files changed; Rust checks omitted.
