# Drawing performance and explicit saves

User request: prioritize drawing latency and battery use; save on Cmd+S, tab close and app quit, never after strokes or idle pauses.

Existing WIP in TODOS, command palette, editor-api, drawings helpers/tests and ui-store belongs to another task and will be preserved.

Plan: remove scene scans and save timers from drawing events. Keep the current scene in refs with constant work and no React/store updates. Compute a content signature and snapshot only at explicit save boundaries. Register mounted drawing save callbacks in a small persistence registry; tab close waits for its save and retains the tab on failure. Window close and native quit must await saves, including hidden drawings. Stop hidden drawing keyboard handling. Preserve serialized per-path SVG writes.

Read: drawing-editor, drawing-pane, drawings, editor-store close path, save engine, native menu/run events; React/Zustand/consolidation guidelines and agent loop/review. No CodeMirror changes planned.

Validation: regression for continuous drawing with zero exports/timers, snapshot consistency during async saves, failure/retry, close waiting; frontend checks/tests and native tests/clippy/fmt for shutdown integration. Runtime FPS/battery measurement requires a native drawing session; do not claim a measured improvement without one.

## Result

Removed the per-change version scan and debounce/export loop. The first regression drove the original component callback 1,000 times and failed with one pending save timer. The retained session regression now asserts zero element/asset traversal, timers or writes for 1,000 single-view changes.

The tiling task landed canonical per-path drawing sessions while this task was paused. Integrated with that ownership: remounts reuse live scenes without saving; a pending save cannot release newer unsaved content; detach never writes. Native close/Quit uses an acknowledged barrier, including AppKit applicationShouldTerminate for menu/Dock Quit. Save failure preserves the tab/window. Sidebar deletion joins existing writes and blocks new exports until deletion completes. Queued Quit excludes a window already scheduled for native destruction.

Reviews: frontend, systems and native reviewers identified and rechecked reopen, deletion/quit, stale shutdown callback, and asynchronous window destruction races. Regression tests cover those state transitions.

Browser verification used the real DrawingEditor and Excalidraw with only filesystem IPC mocked: a freehand stroke produced zero writes after the former debounce period; explicit save produced one SVG with a path, and a second unchanged save kept the write count at one. This does not measure native FPS or battery draw. The temporary browser harness was removed.

Native AppKit Quit and physical battery/FPS measurements remain manual validation gaps; native unit tests exercise acknowledgement ordering and queued-close participation.

Final checks: `vp check` passed with existing warnings; `vp test` passed 864 tests; desktop TypeScript passed; `cargo test` passed 179 tests; `cargo clippy` and `cargo fmt --check` passed (existing Rust warnings). The strengthened hot-path test was rerun after adding asset-enumeration detection.
