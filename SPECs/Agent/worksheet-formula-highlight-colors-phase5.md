# Formula highlight colours phase 5

Scope: [T033–T037](../formula-highlight-colors/tasks.md), linked from the colour-highlights task in TODOS.md. Followed the local speckit-implement skill. The requirements checklist passes (16/16); no extension hooks exist. The working tree started clean; the branch was ahead 7 and behind 2.

## Investigation and plan

Read the feature spec, plan, research, data model, document-format contract, quickstart, editor rules, React guidelines, Zustand guidelines, and the existing command, detector, bar, decorations, CSS, unit tests, and desktop journey. Phases 1–4 had already built the shared normalise-then-re-emit path, but exact recolour and removal still replaced a larger range than phase 5 requires, and the bar did not expose the selected highlight's colour.

Keep partial overlaps on the shared normalise/re-emit path. Add a narrow direct-edit plan for a selection exactly matching one highlight: recolour replaces only the seven-character hex; removal deletes only the additive prefix and suffix. Dispatch the resulting change set once and preserve the inner selection. Derive active state from the existing detector, leave off-palette values unmatched, disable remove outside a highlight, and avoid rescanning the document on viewport-only updates. Test math and prose byte identity, exact recolour changes, three-region overlap, and off-palette active detection.

Risks: accidentally nesting wrappers, changing inner bytes during removal, splitting one action into multiple undo steps, snapping hand-edited colours to the palette, stale selection positions, and adding a full-document scan to scrolling.

## Results

Implemented a direct edit planner shared by math and prose. Exact recolour changes only the existing wrapper's colour argument. Exact removal sends the prefix and suffix deletions in one CodeMirror transaction and maps the selection onto the restored inner text. Partial selections still use the existing normalise/re-emit path, including math validation and old/new/old overlap regions.

The bar snapshot now carries the covering highlight's raw hex. Palette matches use `aria-pressed` and a visible ring; the remove action is enabled only inside a recognised Writer highlight. Unknown lowercase hex values remain removable but activate no palette swatch. Active-state detection runs only after document or selection changes; viewport and tree-only measurements reuse the stored result.

Validation: the phase-five tests failed first because the direct-edit and covering-highlight APIs did not exist, then passed after implementation. `vp test` passes all 1,117 tests in 78 files. `vp check` passes formatting, lint, and type checks with eight unrelated pre-existing warnings. The isolated Tauri e2e app builds successfully. The existing highlighting WebDriver journey could not reach the feature because its Shift+Arrow gesture left the DOM selection collapsed; two instrumented retries confirmed the bar never received a non-empty selection. The temporary probes and attempted journey extension were removed, leaving the pre-existing e2e file unchanged.

Updated T033–T037, TODOS.md, and CHANGELOG.md. Phase 6 keyboard/palette access and phase 7 final gates remain outstanding.
