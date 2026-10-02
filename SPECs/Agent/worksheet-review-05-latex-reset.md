# Reset LaTeX records with the editor workspace

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 5.

## Plan

Clear builds, root mappings and PDF revisions. Ignore stale build completions and cancel pending auto-compiles after reset.

Investigated latex-compile-store, pdf-revision-store, editor-store.resetEditorState, save callbacks and existing compile-store tests; read Zustand and consolidation guidelines. LaTeX already imports the editor store, so importing it back into editor reset would introduce a cycle.

Add a small editor-reset registry with a monotonically increasing generation, reset notification and callback registration. Editor reset advances the generation and calls registered owners. LaTeX clears builds/roots, timers, running references and rerun flags; PDF revision owner clears revisions. Keep the single save listener for the window lifetime. Capture the generation at each asynchronous operation (compile, root lookup, explicit command and saved-file callback); old work must neither republish state, bump revisions, open previews, report stale notices, schedule timers nor delete a newer promise after reset. Existing backend processes may finish, but lose publication authority; native root serialization is ticket06. State plan review approved with a save-event provenance edge: capture reset generation when a write starts and suppress stale publication/notifications so a same-path file reopened after reset cannot be treated as the old saved buffer. Add a deferred-write reset/reopen regression.

Tests will exercise actual editor reset wiring, deferred compile success/failure, queued rerun, new same-path compile overlapping old completion, pending timers and deferred root lookups. Update the state reset ownership rule and changelog. No native window/layout behavior changes.

## Report

Implemented the reset registry and owner cleanup for LaTeX/PDF records, debounce timers and queued reruns. All async publication paths check the reset generation; old promise cleanup also checks identity. File writes capture their generation before awaiting and suppress stale success/error publication after reset. Reset cancels pending saves.

Validation: new tests reproduced stale records/completions and both old save success/error cases before the fix. All 135 targeted compile/save/workspace/store tests pass; the strengthened timer test confirms a scheduled timer exists and is canceled. Browser store reset advances generation and clears all three path maps. vp check reports zero errors and ten pre-existing warnings. State, Systems and QA plan/implementation reviewers approved; QA independently ran 38 tests. Native engines can still finish writing old output; backend serialization is ticket06. Native WebKit allocation profiling remains unverified.
