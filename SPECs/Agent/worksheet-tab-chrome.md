# Tab chrome worksheet

Task: TODOS.md, [spec](../tab-chrome.md).

Read editor-tabs.tsx, pane-bounds.ts, pane-layout.tsx, scroll-fade.tsx, active-tab scrolling, page-kind registry, editor scroll container, React guidelines, consolidation and review workflow. Working tree started clean. vp is available through node_modules/.bin/vp; install passed.

Final plan: keep all live tabs visible. A colocated presentation hook retains inert removed tabs for 240ms while CSS animates entry/exit. Keep document/store actions intact. Update the file page-kind title to omit extensions. Render the active Markdown path in the existing pane chrome outside its document scroller. Existing document headroom accommodates the 32px path row. No scroll listeners or editor remounts.

Validation: focused reconciliation tests plus actual EditorTabs browser fixture, frontend checks and test suite. Reviewers cover React, UX and QA. Record final results before commit.

## Results

- Implemented always-visible tabs, entry/exit motion, inert exit chrome, keyboard close focus transfer, rounded active styling and a fixed Markdown path row. Extension-free file labels are owned by the file page-kind registry.
- `node_modules/.bin/vp check --fix`: passed, with eight existing warnings in unrelated code.
- `vp test`: 74 files / 1,028 tests passed (including four new reconciliation cases). React, UX and QA reviews reported no findings for the final scope.
- Browser fixture at `/tests/browser/editor-tabs.html`: verified all tabs remain visible, tab/path extensions omitted, relative directory path correct, path position unchanged during document scrolling, + adds a tab with live animation, launcher removes path row, exits inert and absent from drag hit testing immediately, focus moves to a neighbor, exit nodes disappear after motion. At 360px pane width, active tab stays visible after scrolling. Long paths truncate inside the pane and retain a complete extension-free tooltip.
- Native Tauri context-menu/drag gestures were not exercised; existing drag tests passed. No Rust changes.
