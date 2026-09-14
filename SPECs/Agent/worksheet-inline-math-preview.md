# Inline math preview

Follow-up to latex-edit-preview-spec.md. Clean starting tree. Remove the display-only guard so inline math uses the existing selection-driven preview. Retain display rendering within the preview panel. Extend transaction coverage to both delimiter styles with prose around the formula, checking anchoring, updates and refolding. Formal review skipped: one-line behavior change through the already-reviewed shared path.

Validation: vp check passed with six existing warnings; all 981 tests passed across 70 files.
