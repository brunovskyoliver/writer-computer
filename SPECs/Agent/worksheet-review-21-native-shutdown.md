# Save text before native window close and quit

Status: In progress.

Adjacent issue found while implementing review finding 1. The native shutdown handshake currently saves drawings only, so text autosave can still be pending when the window closes.

## Plan

Use the shared editor input gate, drain asynchronous clipboard edits and flush all text through the save engine before acknowledging the native shutdown. Failed saves must cancel closure and retain buffers. Share the text flush orchestration with workspace closure and verify request supersession/cancellation.

Add `saveAllNow()` to the save engine with an injected open-file path accessor. Reuse it from workspace close and the native hook. Keep the native request ID checks after asynchronous work and preserve the drawing handshake's all-windows cancellation behavior. Use general save-failure feedback for the hook. Extend the existing hook tests with text-save ordering, failed saves and delayed clipboard input; the real-store workspace tests already cover buffered and in-flight writes. Update the editor doc and changelog.

## Report

Pending implementation and validation.
