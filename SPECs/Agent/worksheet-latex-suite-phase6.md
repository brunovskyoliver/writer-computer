# LaTeX Suite phase 6

Scope: [T046–T048](../latex-suite/tasks.md), linked from the LaTeX Suite task in TODOS.md. Follow the local speckit-implement skill. Requirements checklist passes (16/16); no extension hooks. Working tree started clean.

## Investigation and plan

Read the feature spec, plan, research, data model, contracts and quickstart; settings/store guidelines; settings command, config loader, global watcher, frontend watcher, snippet and highlighting subscriptions. Existing reload_global already replaces only the global layer and preserves memory on read error. All four toggle reads and variable subscriptions exist.

Reuse the global settings mutation helper for watcher reloads so the process lock covers disk reads and telemetry application. Reload each existing window, log errors, emit one unscoped settings event per debounced batch. Keep workspace layers untouched. Accept null settings-event payloads in the frontend. Test external edit/delete, two window state reload, null event dispatch and variable recompilation. Verify toggle behaviour in the isolated e2e app. Run frontend and Rust gates. Update tasks, TODO and changelog; phase 7 stays out of scope.

Risks: watcher events arriving during writes, windows closing during reload, read failures, duplicate filesystem notifications, and preserving caret/scroll on setting changes.

## Results

Rust/Tauri and QA plan reviews approved. Corrected quickstart §4.4: phi already exists in defaults, so remove it before restoring it.

Implemented the watcher branch using the shared global mutation helper; reload failures are logged without stopping other windows, and config events coalesce per batch. Added null-payload listener coverage and variable recompile/deduplication coverage. Reused existing reload_global and added LaTeX edit/delete and workspace-preservation tests.

QA found a newly exposed read/write race: delayed settings reads could overwrite optimistic edits. Three deferred-response tests failed before the fix and pass after it. Loads now wait for writes, retry when a mutation overtakes the read, discard older reloads, and skip identical hydration/theme effects.

The runtime toggle walk exposed two existing editor defects: disabling highlighting exposed generic syntax colours, and auto-fraction consumed the opening math delimiter. The plain LaTeX style now explicitly inherits colour. A computed-style dump showed the generic rules still won equal specificity; the LaTeX style now also uses high precedence, with a style-module-order regression test. Auto-fraction scans only formula content on the current line; four tests exercise the actual input facet against EditorState with a minimal dispatch adapter, covering inline, prose-prefixed, display and multiline formulas and caret placement. Editor and QA implementation reviews have no findings.

Validation: `vp check` and `vp test` pass (980 tests in 70 files); `cargo test` passes (186 tests); `cargo clippy` and `cargo fmt --check` pass. Existing frontend tool deprecation/lint warnings and Rust clippy warnings remain. `vp` was available through the repo's `node_modules/.bin`, added to PATH; `vp install` completed without dependency changes. Used `vp exec tauri build` because cargo-tauri is not installed.

Runtime: built with `e2e`, identifier `com.writer-computer.phase6-e2e`, isolated workspaces `/tmp/writer-phase6-a` and `-b`. Raw WebDriver drove Settings switches in one window, then verified the other window's existing editor and Settings. All four switches passed off/on assertions; every toggle preserved the editor instance and selection. Removing phi from the actual Settings field made it literal in the other window; restoring it restored expansion. Computed source colours with highlighting off were exactly formula foreground plus muted delimiters; on restored distinct token colours. The writer's unchanged reload is covered by the theme-side-effect count regression.

Harness limitation: WebDriver key actions do not insert text into contenteditables. Snippet and fraction checks called the running editor's installed input-handler facet one character at a time, with its normal input transaction fallback. Tab used WebDriver key events. Thus this verifies live editor/store integration, not native text input delivery. Run logs are `/tmp/phase6-runtime-results.log`; driver scripts are `/tmp/phase6-final-runtime.py` and `/tmp/phase6-runtime.py`.

Final Rust/Tauri, Editor, Zustand/State and QA reviews have no findings. Phase 7 remains untouched except the required changelog/task bookkeeping. No SpecKit extension hooks were registered.
