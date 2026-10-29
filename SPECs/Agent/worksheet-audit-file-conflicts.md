# AUD-01: preserve local edits during external changes

## Evidence and acceptance

The current watcher cancels a pending save, reads the file asynchronously and
unconditionally reloads differing bytes. A deferred-read reproduction applies an
old external snapshot after a newer local edit and save. Dirty buffers are also
overwritten without a choice. Autosave has no expected-disk precondition.

Protect both local buffers and disk changes in ordinary Obsidian/Git/Writer
co-editing. Clean files still reload automatically. Dirty conflicts pause saving,
remain visible and prevent save-dependent closing. Explicit choices retain local
text or load current disk text. Deleted files keep their open buffer and offer an
explicit recreate action. Test only disposable notes.

## Plan

1. Add an optional expected-content precondition to the existing Rust write IPC,
   including an explicit expected-missing case. Serialize Writer writes per
   canonical path across windows, including unconditional callers. Return a typed
   conflict containing the current disk text (or missing state), without writing.
   Preserve existing permissions/symlink behavior. Unexpected IO errors remain IO
   errors. Keep the existing string error wire format for other errors.
2. Give each loaded text buffer an immutable instance id and a conflict field.
   `diskContent` may be null only after an explicit decision to recreate a deleted
   file. The editor store owns applying external content: clean buffers reload;
   dirty or pending buffers retain their text and record the competing version.
3. Use a small external-read coordinator called by the watcher. Wait for ongoing
   saves, retain only the latest read per path, and guard publication with editor
   generation, buffer instance, disk baseline and current workspace identity.
   If only the disk baseline changed during a read, re-read after the newer save
   settles so the sole external notification is not lost. Apply instance and
   generation guards to initial loads and save completions too; stale operations
   must not remove a newer operation's registry entry.
   Never cancel saves before a read succeeds. Surface read errors. Deleted events
   take the same guarded read path.
4. Autosave sends the known disk baseline; a conflict pauses automatic/manual
   saves and preserves all pending input. Explicit Keep my changes updates that
   baseline to the observed competing version, then uses the same conditional save
   path. A second external change must cause another conflict. Use disk version
   rereads disk and refuses to discard edits made after the action started.
5. Add a compact, accessible conflict notice above the editor, using existing
   theme tokens. Explain that autosave is paused and name both choices. Closing a
   dirty text tab waits for save success; conflict/failure keeps it reachable.
   Existing workspace and shutdown drains fail without resetting the editor.
   Enforce reachability at the store's existing `publish` exit: given the resulting
   open-file map, every conflicted file must retain a direct file tab. Add a
   background tab when a navigation/history mutation removes its last direct tab,
   without stealing focus. Pruning retains conflicts even if the buffer is clean.
   Capture pending-document identity as well as edit sequence for discard actions.
6. Closed-file AI tag changes and MCP read-modify-write paths send an expected
   baseline where they have one, so they participate in the same write ownership.
   Keep intentional unconditional file creation/drawing writes explicitly scoped.

## Verification

- Deferred/reordered reads; local edits and completed saves during read; pending
  CodeMirror input; close/reopen same path; workspace reset and watcher disposal.
- Clean reload, dirty conflict, external deletion, conflict resolution overtaken
  by another edit/change; no automatic retries overwrite a conflicting version.
- Native conditional-write tests for changed/deleted files, empty files, matching
  expected bytes, symlink aliases and simultaneous Writer writes.
- Close-tab and existing workspace/shutdown save failure gates.
- Native app fixture: dirty text plus external write, conflict notice, local text
  preserved, both resolution choices, explicit recreation, clean reload.
- Full frontend/Rust gates; independent State, Systems, Rust, Frontend, UX and QA
  reviews as relevant. Inspect the real notice at normal/minimum widths.

## Limits and open review questions

An expected-content check followed by rename is not an OS transaction with an
uncooperative external process. The per-path lock serializes Writer writers only;
document the check-to-rename race rather than claiming an atomic compare-and-swap.
This ticket does not implement crash recovery or change drawing session ownership.
Full ACL/xattr/hardlink preservation and save-during-rename are separate findings.
Review should challenge whether any close/navigation path can strand conflict
buffers or bypass their save gate.

## Status

Reliability work completed; AUD-07 layout follow-up remains. Rust plan approved. State/Systems requested conflict-tab reachability
and initial-load/save ownership guards; Frontend requested re-reading after an
overtaken baseline. All are now explicit in the plan. All plan reviews approved after revision.
Previous completed ticket: tab resize `7ae7721`.
Starting gates: 1,696 frontend and 286 Rust tests pass. Evidence directory:
`~/agent-runs/2026-10-29-writer-audit/`.

## Implementation and review

Conditional saves and typed conflicts preserve local and disk versions. The
watcher coordinates initial loads and saves, rejects stale reads and rereads when
its baseline changes. Conflicts retain a direct tab through navigation. The
notice offers conditional overwrite/recreation or a fresh disk read; new typing
prevents discard. AI tag edits and MCP replacement writes pass their baselines.

Review found and fixed stale initial-load waiters, stale openFile pruning after
reset, a disk-choice read overtaken by a watcher observation, hidden-pane flex
layout, and an MCP false conflict after reopening its just-written version.
Regression evidence: conflict-resolution-red.log and conflict-load-debug.log;
focused tests pass after fixes. Rust review has no P0/P1; added exact error payload,
wire serialization, and competing target/symlink writer tests. Rust suite: 292 pass.
Full frontend suite before the final review fixes: 1,708 pass. Final checks and native results are recorded below. Source design detector was run; WKWebView
has no CDP rendered detector, so screenshots and DOM measurements cover that step.

Native validation found that the existing 2-second self-write TTL also suppresses
real external updates after a failed conditional save. With WRITER_WATCHER_LOG=1,
a deliberate mismatch followed by an external write logged record_write and two
self-write suppressions; the clean buffer stayed stale. Conditional text saves now
leave echoes enabled; receiveDiskContent compares the baseline and no-ops on a
real echo. Unconditional creation/drawing callers retain existing suppression.
Evidence: conflict-watcher-debug.log. This adds a disk read on text-save watcher
echoes; no performance improvement is claimed for this reliability fix.

UX review found a P2 at the supported 240×160 minimum pane: 96px top chrome plus
a 64px conflict notice leaves zero editor height. A native mounted-pane geometry
probe confirms it (conflict-min-pane-\*.png). A 32px notice cap also clips actions,
so that experiment was discarded. This joins AUD-07's existing minimum-pane
chrome/strip problem for the next separate layout task. Normal 1200/800 layouts
and resolution controls remain usable. Do not mark the overall audit complete.

## Completed reliability verification

- `vp check`: 0 errors, 10 existing warnings. `vp test` from repo root:
  113 files, 1,720 tests passed. `cargo test`: 292 passed. `cargo clippy`
  completed with 13 existing warnings; `cargo fmt --check` passed.
- Independent Rust, State, Systems, Frontend, Editor, Startup, QA and UX
  implementation reviews completed. All reported P1s and the state/race P2s
  were fixed with focused regressions. Short-pane layout P2 is tracked as AUD-07.
- Final isolated release/e2e build completed. Native assertions in
  `conflict-native-results.json` and `conflict-native-keep-final.json` pass:
  local/disk preservation, close refusal, fresh disk choice, focus restoration,
  clean external reload, deletion without recreation, explicit recreation,
  local replacement and no false conflict on the subsequent save echo.
- `conflict-hidden-scroll.json` verifies 5000px before/after actual tab selection.
  An earlier harness attempt clicked the tab wrapper without selecting it; that
  invalid attempt was replaced with role-button selection plus active assertions.
- Native screenshots cover 1200/800 widths, local conflict, chosen disk and deleted
  file states. Source design detector returned no findings. Minimum-pane geometry
  probe found AUD-07; VoiceOver and full light-theme checks remain in the audit.
- AeroSpace placed the app in a TilingContainer; the neighboring window changed
  from 2998px to 1494px. The audit window was floated for controlled sizes and
  closed after checks. No production installation, vault writes, migration or push.

The conditional-write check is not atomic against an external process writing
between comparison and rename. Crash recovery, richer version comparison UI,
ACL/xattr/hardlink preservation, in-flight path renames, and the remaining
unconditional-writer watcher TTL are not implemented by this ticket. Conditional
text saves trade an extra echo read for reliable external-change detection;
large-note save/IPC profiling remains in the overall audit.
