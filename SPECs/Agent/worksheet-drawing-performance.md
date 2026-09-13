# Drawing performance and explicit saves

User request: prioritize drawing latency and battery use; save on Cmd+S, tab close and app quit, never after strokes or idle pauses.

Existing WIP in TODOS, command palette, editor-api, drawings helpers/tests and ui-store belongs to another task and will be preserved.

Plan: remove scene scans and save timers from drawing events. Keep the current scene in refs with constant work and no React/store updates. Compute a content signature and snapshot only at explicit save boundaries. Register mounted drawing save callbacks in a small persistence registry; tab close waits for its save and retains the tab on failure. Window close and native quit must await saves, including hidden drawings. Stop hidden drawing keyboard handling. Preserve serialized per-path SVG writes.

Read: drawing-editor, drawing-pane, drawings, editor-store close path, save engine, native menu/run events; React/Zustand/consolidation guidelines and agent loop/review. No CodeMirror changes planned.

Validation: regression for continuous drawing with zero exports/timers, snapshot consistency during async saves, failure/retry, close waiting; frontend checks/tests and native tests/clippy/fmt for shutdown integration. Runtime FPS/battery measurement requires a native drawing session; do not claim a measured improvement without one.
