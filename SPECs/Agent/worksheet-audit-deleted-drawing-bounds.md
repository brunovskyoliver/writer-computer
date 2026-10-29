# AUD-12: deleted drawing elements inflate export bounds

## Reproduction

During AUD-11 fixture preparation, a deleted rectangle at (-10000,-10000) inflated
the mixed scene SVG viewBox to 10713.60×10870. The useful drawing occupies roughly
700×850; the preview therefore became tiny. Native evidence:
`drawing-fidelity-before.svg`, `drawing-fidelity-before-features.json` and
`drawing-fidelity-before-native.png` under the 2026-10-29 audit evidence directory.
The SVG rendering skips the deleted rectangle but its bounds still contribute.

## Cause and narrow fix

Writer passes restored scenes, including deleted entries, to the public Excalidraw
exportToSvg API. Its elements parameter is named NonDeletedExcalidrawElement; the
installed alias still has isDeleted:boolean, so TypeScript does not enforce the
contract. Filter deleted elements at Writer's single shared export boundary.
Preserve element order and the original scene array; source files and live undo
state must stay intact. Preview, copy and save all use this one export helper.

This is an obvious one-line correction in one production file. Formal persona
reviews are skipped under docs/workflows/agent-review.md's trivial-fix exception;
record that in the commit message. Add a targeted boundary regression for preview
and editable export, then verify actual native SVG bounds and appearance.

## Validation plan

- Reproduce with a failed export-input regression before changing the helper.
- Verify both export modes omit deleted entries, retain visible order and do not
  mutate the original scene.
- Run frontend checks/tests and rebuild the native app. No Rust changes.
- Reload the synthetic mixed fixture, capture its SVG and screenshot, confirm the
  deleted rectangle no longer affects bounds and all mixed visible features remain.
- Verify source hash unchanged and editable-copy roundtrip retains visible elements.
- Commit this fix alone, then return to AUD-11 using the corrected fidelity baseline.

## Result and verification

Fixed at the shared export boundary with a non-mutating deleted-element filter.
The regression failed before the fix and passes afterward for preview and editable
exports, including element order, identity and preservation of the original array.

- All 1,802 frontend tests in 119 files pass (`deleted-bounds-tests.log`).
- `vp check` passes with zero errors and ten existing warnings. A report-formatting
  issue was corrected before the final check (`deleted-bounds-check.log`).
- Release/e2e native build passes (`deleted-bounds-build.log`). No Rust code changed;
  the preceding 305-test Rust run remains the backend baseline.
- Native mixed-scene SVG bounds changed from 10713.60×10870 to 693.60×860. All 20
  visible path-data strings remain identical and ordered. Text, image, link and
  clip-definition counts remain unchanged. The corrected screenshot was inspected
  (`deleted-bounds-native-comparison.json`, `drawing-fidelity-corrected.svg`, `drawing-fidelity-corrected-native.png`).
- Copy/reload retained all 19 elements present in the first restored canvas,
  including pressure arrays, text, links and frame/container relationships. The
  deliberately degenerate zero-area single-point fixture was already removed by
  the existing restore path before that first canvas; no retention claim is made
  for it. The copy has corrected bounds and the source SHA-256 is unchanged
  (`deleted-bounds-copy-roundtrip.json`).
- Native source preservation also passes during preview generation. No original
  SDU notes, pre-existing math/Mermaid work, production installation or deployment
  changed.

The SVG's existing frame-clipping appearance needs further inspection before it
is used as a pixel-fidelity oracle for AUD-11. This fix retains the same clip nodes
and visible geometry; it does not claim to repair the upstream clipping behavior.
AUD-11 has a controlled benchmark and completed export architecture research, but
no performance implementation. Oliver requested a stop after this piece; pause
for review after committing AUD-12. Formal review was skipped only for this obvious
one-line correction, under the documented trivial-fix exception.
