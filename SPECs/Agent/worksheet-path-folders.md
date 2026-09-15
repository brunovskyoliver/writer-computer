# Path folder navigation

Spec: ../tab-chrome.md. Task: clickable, font-scaled path folders in TODOS.md.

Plan: use the existing editor font CSS variable at 90%. Render each folder as a native button with its cumulative workspace path. Extend revealPathInSidebar with an optional row-focus flag; reuse its sidebar opening, ancestor expansion and cancellation. Style focused directory rows and breadcrumb interaction using theme variables. Preserve the existing file reveal action. Check browser font scaling and folder actions plus frontend tests. Working tree started clean; vp install passed.

## Results

Implemented cumulative folder buttons, 90% editor font sizing and optional reveal-row focus. Theme variables drive breadcrumb hover/focus and sidebar folder highlights.

Validation: vp check passed with eight existing warnings; all 1,028 tests passed. Browser fixture verified 16/20/24px settings yield 14.4/18/21.6px path fonts. With a test sidebar row and settings persistence stub, clicking a folder requested sidebar visibility and the actual reveal helper focused the matching row. Browser focus check passed after allowing the animation frame to run. No native sidebar integration test was run. Frontend review had no findings; the UX reviewer could not complete due to its usage limit.
