# AUD-10: publish new files without replacing a competing file

## Problem and scope

Discovered during AUD-03 plan review. `write_file_checked_impl` checks an expected
missing destination, then publishes its temporary file with replacing rename.
Another process can create the destination in that interval and lose its bytes.
The Writer path mutex only serializes Writer calls. This violates recreation and
import-copy safety. Priority P1. Do this prerequisite before AUD-03 implementation.

Baseline: source-confirmed gap at fs.rs conditional check/publication; 292 Rust
and 1,726 frontend tests previously passed. Existing file replacement, permission
preservation, symlink behavior and optimistic text conflict handling remain intact.

## Plan

1. Retain the current precondition check and per-path mutex. Select no-clobber
   publication when `expected.content` is null. Normal replacement still renames.
2. Publish a fully written adjacent temporary file with macOS `renamex_np` and
   `RENAME_EXCL`; use `fs::hard_link` on other platforms for the missing-file case.
   The OS creates that destination entry atomically or fails
   if any entry already occupies it. Do not fall back to replacing rename on a
   filesystem that lacks the required operation; report the IO failure explicitly.
3. Own temporary cleanup in the atomic-write helper for both success and failure.
   Rename consumes the temporary name; hard-link publication retains it until
   cleanup. Preserve the original operation error when cleanup succeeds. Report
   cleanup failure precisely, including whether publication already succeeded.
4. Map publication collision to existing `AppError::AlreadyExists`. The earlier
   expected-content mismatch retains its existing FileConflict contract. Local
   drafts remain dirty on failed writes. Future copy naming retries only these
   explicit collision outcomes, never arbitrary IO errors.
5. Add deterministic real-filesystem tests creating competing bytes at publication,
   verify they survive and temporary names are removed. Cover successful creation,
   two concurrent creators, dangling-link collision, existing replacement behavior,
   and injected failure cleanup. Tests must invoke the same publication helper as
   production, not simulate no-clobber behavior in a mock.
6. Run cargo test/clippy/fmt; build the isolated native app and exercise missing-file
   creation/collision via IPC. Record guarantees/limits in editor docs and changelog,
   review implementation and commit this task separately.

## Limits

This closes the missing-destination publication race. Comparing and replacing an
existing file is still not an OS-wide compare-and-swap transaction. No durability
claim beyond the existing write path; fsync policy is unchanged. Original vault
files are not used for verification.

## Status

Rust/Tauri and QA plan reviews approved. Add publication-boundary barriers for
concurrent creators; verify cleanup failure both after success and after failure,
and distinguish native precondition conflicts from publication collisions.
The deterministic regression failed against replacing rename and passes with no-clobber publication. Evidence remains under `~/agent-runs/2026-10-29-writer-audit/`.

## Implementation

`publish_temporary_file` chooses replacing rename or no-clobber publication.
macOS uses exclusive rename; other platforms use hard linking.
The atomic writer owns cleanup and distinguishes a consumed temporary name from
a newly linked destination. Only publication AlreadyExists maps to the collision
variant; temp-creation and cleanup failures remain IO errors. Normal replacements
incur no additional cleanup syscall.

The deterministic old-path regression failed because rename replaced the inserted
external file; the same publication-boundary scenario passes with the new helper.
Six new Rust regressions cover collision, successful cleanup, concurrent direct
publication without Writer locks, dangling-link collision and cleanup failures
following both successful and failed publication. All 298 Rust tests pass after the macOS revision.
Frontend recreation coverage verifies the draft survives AlreadyExists; `saveNow`
retries after the in-flight failure, meets the competing file at its precondition
and restores conflict choices. Diagnostic logging confirmed this transition;
the test observes both the intermediate error and final conflict.
No source vault files were modified. Native rebuilt verification is recorded below.

## Native validation and revised macOS plan

The first native recreation succeeded, but deleting its output again produced no
watcher notice. With `WRITER_WATCHER_LOG=1`, no destination deletion reached the
watcher. A controlled comparison reproduced this for temp → hard-link → unlink;
direct creation, ordinary rename and exclusive rename all delivered deletion
events. Evidence: `create-publication-event-comparison.json` in the audit folder.

Use macOS `renamex_np(..., RENAME_EXCL)` to preserve normal FSEvents behavior and
atomic no-replace publication. No fallback on unsupported volumes. Add `libc` as
a macOS direct dependency (already in the lockfile graph); use its platform
constant/signature, CString byte paths, and immediate errno capture. Successful
rename consumes the temporary file. Other platforms retain the hard-link path;
linked-temp cleanup is exercised with an injected real hard-link publication on
macOS too. Add a macOS regression asserting consumed temporary names and Unicode
path handling. The initial non-UTF8 fixture failed before publication because the
local filesystem rejected its name (EILSEQ); the test now uses Danish and Greek
characters and spaces. Paths still use lossless OsStr bytes for the FFI. Repeat the actual UI delete/recreate cycle three times after build.

Apple's reference tests verify the no-replace contract:
https://github.com/apple-oss-distributions/xnu/blob/main/tests/rename_excl.c
Native IPC creation, early collision, existing empty-file collision and ordinary
matching-baseline replacement passed before this revision. Post-check collisions
are forced by the Rust tests, not by native IPC timing.

## Final verification and report

Implemented and verified. Rust/Tauri and QA reviewed the initial and revised
implementation. Their only revised-code finding was the invalid-name test fixture;
that is fixed. No unresolved production-code findings.

- Full frontend suite: 1,727 tests in 114 files pass (`create-publication-tests.log`).
- Final Rust suite: 298 pass (`create-publication-exclusive-rust-tests.log`).
- `vp check`: 0 errors, 10 pre-existing warnings; cargo clippy: 13 pre-existing
  warnings, success; cargo fmt --check passes.
- Isolated release app rebuilt with the final runtime implementation
  (`create-publication-exclusive-build.log`). Only test/docs changes followed.
- Native IPC: three concurrent conditional creates have one winner and two early
  FileConflicts; winner bytes and an existing empty file are preserved; ordinary
  matching-baseline replacement passes. No leftover temporary names. Evidence:
  `create-publication-exclusive-native-results.json`.
- Native UI: three consecutive external deletions each produced the recovery
  notice. Recreate preserved exact bytes, left one link and no temporary names,
  and restored editor focus every time (`create-publication-ui-results.json`).
  Screenshot `create-publication-recreated-native.png` visually inspected.
  `create-publication-exclusive-watcher.log` records the final event sequence.

Native IPC cannot deterministically hit the tiny post-check race. The real-filesystem
Rust barrier tests cover that boundary without Writer's mutex. Non-macOS native
watchers and unsupported volumes were not available for validation; unsupported
operations fail explicitly without replacing the destination. Existing-file
compare/replace and durability limits above remain. No performance improvement
claimed. No install, push, deployment or original-vault mutation.

The AUD-03 drawing plan is ready to implement after this separate prerequisite
commit; full migration and broader academic-workflow findings remain open.
