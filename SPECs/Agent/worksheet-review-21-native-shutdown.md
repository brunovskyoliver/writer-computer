# Save text before native window close and quit

Status: Done.

Adjacent issue found while implementing review finding 1. The native shutdown handshake currently saves drawings only, so text autosave can still be pending when the window closes.

## Plan

Use the shared editor input gate, drain asynchronous clipboard edits and flush all text through the save engine before acknowledging the native shutdown. Failed saves must cancel closure and retain buffers. Share the text flush orchestration with workspace closure and verify request supersession/cancellation.

Add `saveAllNow()` to the save engine with an injected open-file path accessor. Reuse it from workspace close and the native hook. Keep the native request ID checks after asynchronous work and preserve the drawing handshake's all-windows cancellation behavior. Use general save-failure feedback for the hook. Extend the existing hook tests with text-save ordering, failed saves and delayed clipboard input; the real-store workspace tests already cover buffered and in-flight writes. Update the editor doc and changelog.

Systems and Frontend plan reviews approved. Enumerate paths after the input drain and await all selected writes, including failures. Check disposal at callback entry and request ownership after every awaited stage. Test a listener delivered after cleanup as well as cancellation during input and text saves.

## Report

Added shared saveAllNow() to the save engine through an injected open-path accessor. Workspace close and native Close/Quit drain pending input and flush all text. Native shutdown then saves drawings and acknowledges only the active request. Failed saves preserve buffers; cancelled or disposed callbacks cannot freeze input, start another stage or acknowledge closure.

Plan and implementation reviews passed Systems and QA. Frontend review found that global Tauri listeners also receive events targeted at other windows; prepare-close now uses the current window listener, with a target-aware regression and event guidance in react-guidelines.md.

The new hook regressions first failed against the drawing-only implementation. Focused checks pass, including real-store wait-all failure while another file writes. Final full frontend suite passed 1,402 tests and vp check had 0 errors with 10 existing warnings. The target-aware hook suite passes all 9 tests; final Frontend review approved the targeting fix. Native two-window Close/Quit still needs a live runtime check.
