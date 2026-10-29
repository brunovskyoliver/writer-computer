# AUD-02: preserve file identity and permissions on save

## Problem and acceptance

The comprehensive audit reproduced two defects in `write_file_impl`: a `0600`
note becomes `0644`, and a symlink becomes a regular file while its target stays
unchanged. Both follow from replacing the requested pathname with a newly created
default-permission temporary file. Real SDU notes were not modified.

Saving must preserve a symlink and update its resolved target, preserve existing
Unix permission bits, reject dangling symlinks and read-only files explicitly,
and leave no temporary file after a failed write or rename. New files must still
be creatable. The returned path remains the caller's path.

## Plan

- Keep one write path in `commands/fs.rs`.
- Inspect the destination without following a final symlink; resolve an existing
  symlink to its actual target before choosing the adjacent temporary path.
- Preserve existing file permissions and reject read-only destinations. Propagate
  unexpected metadata errors instead of treating them as a new file.
- Create the temporary file exclusively, with restrictive initial permissions on
  Unix. Write bytes, apply destination permissions, close it, then rename.
- Clean up temporary output on every failure after creation. Keep the original
  operation error; report cleanup failure if cleanup itself fails.
- Add filesystem regression tests for private/executable modes, relative symlinks,
  dangling links, read-only files, new files and failed replacements.
- Run Rust tests, clippy and fmt; exercise IPC on synthetic files in the native
  audit app when its build finishes.

## Limits

This is not external-editor conflict detection. Atomic replacement does not
preserve hardlink identity, ownership, ACLs or extended attributes; assess those
separately before claiming complete metadata preservation. No production install,
publish or vault migration is part of this ticket.

## Review and verification

Rust and QA plan reviews completed. Incorporated nonregular-target rejection,
explicit read-only behavior (no write bits plus an actual non-truncating write
open to check OS access), and a deterministic injected rename failure that
exercises cleanup after temporary creation. Pathname/permission TOCTOU races,
crash durability and full metadata preservation remain outside this ticket.

Baseline: 278 Rust tests pass; 1,692 frontend tests pass. Added regressions first:
six fail against the original implementation, including private permissions,
symlinks, read-only files, special files and failed-replacement cleanup.

## Result

Implemented in `commands/fs.rs`; independent Rust and QA implementation reviews
approved without findings. Eight added tests, 286 Rust tests pass. `cargo clippy`
passes with existing warnings; `cargo fmt --check` passes. Frontend `vp check`
passes with the same ten baseline warnings. No frontend implementation changed.

Built and launched the isolated release app (`com.writer-computer.audit`) and
exercised the actual `write_file` IPC. A `0600` target retained its permissions;
the relative symlink stayed a symlink; target bytes updated. A subsequent save to
the `0444` target failed explicitly and preserved its bytes. No temporary files
remained. Native evidence: `atomic-native.json`; full logs in
`~/agent-runs/2026-10-29-writer-audit/`.

The rebuild incorporates the starting uncommitted frontend changes, which are
not included in this fix's commit. Original SDU files were not opened for writing.
The metadata and concurrency limits above remain open audit work.
