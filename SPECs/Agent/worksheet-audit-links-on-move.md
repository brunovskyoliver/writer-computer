# AUD-08: wiki fragments and links after a move

Audit findings: [comprehensive audit](worksheet-comprehensive-audit.md). The SDU vault moved to
`~/Documents/Obsidian/SDU` during the 2026-10-30 home-folder cleanup; it was read, never written.

## Why this before AUD-11

AUD-11 would patch Excalidraw's exporter to shorten a 127ms stall on a 1.4MB synthetic scene. SDU's
largest drawing is 394KB and most are under 45KB. No stall was measured on those real files, so this
is size evidence, not a timing result. Deferred until a real drawing shows a felt stall.

SDU notes use relative `<note>-assets/*.jpg` image links in 3 notes, which a folder move breaks.
It has no note-fragment wiki links today, so the fragment fix is correctness, not a daily need.

## Changes

- `lib/rewrite-links.ts`: pure edit computation. Markdown links, images and reference definitions are
  resolved relative to the note; wiki links as workspace paths or unique bare names. Code is skipped.
- `lib/update-links-after-move.ts`: open notes change through their view (undoable) or buffer; closed
  notes use conditional writes, so a note changed on disk is reported, not overwritten.
- `use-move-entry.ts`: the single move path runs this after a rename and shows the result as a notice.
- `use-tree-drag.ts`: batch drags run sequentially, so each rewrite sees the others' final paths.
- `list_workspace_notes`: a fresh walk, because the file index lags right after a move.
- `followWikiLink`: forwards fragments (last nested segment) and reports unresolved links.

## Found during native verification

- `resolveLocalImageSrc` kept `..` in asset URLs, so every `../` Markdown image failed to load. Fixed
  there; `resolveImagePath` in `paths.ts` has no production callers and was left alone.
- `scrollPosToSafeTop` aimed once from estimated heights, so a heading 80 paragraphs down landed under
  the footer. It now re-aims for 8 frames, cancelled by a new jump, a wheel event or a document swap.

## Verification

- 1,822 frontend tests in 122 files; `vp check` 0 errors, 10 existing warnings.
- 305 Rust tests, clippy clean for the new command, `cargo fmt --check`. No Rust test covers
  `list_workspace_notes`; the native run does.
- Native release build on a disposable vault, using synthetic pointer events
  (`link-rewrite-native.json`, `link-rewrite-moved-note.png`, `link-rewrite-fragment.png`): note and
  folder drags update incoming and outgoing links, code is untouched, an open note keeps unsaved typing
  and gains the new link, the `../` image loads, and the fragment heading lands at y=152.
- Read-only SDU dry run (`link-rewrite-sdu-dry-run.json`): 22 notes, 0 edits for an unrelated move; moving
  a note with assets gives 3 edits and moving it back restores identical text.
- One fresh review found 8 issues. Fixed: scroll settling, stale timer, batch drags, destination
  encoding, open-note frontmatter, reference definitions, destination overlap. Not a defect in the app:
  the bare-name collision, because the caller passes `newNameIsFree: false`.

## Not verified or not covered

- Sidebar inline rename was not driven natively: its menu is native. It shares `applyPathChange`.
- Multi-select drag was checked by unit test only.
- Still stale after a move: root-relative `/a/b.md`, extensionless `./foo`, case-mismatched `[[S/A]]`,
  and links inside `.excalidraw.md`. A note's `<stem>-assets` folder stays where it is; links still resolve.
- Reads every note once per move. Fine at vault scale; not measured on a very large workspace.
- Rewriting is always on, with no setting. It matches SDU's `alwaysUpdateLinks: true`.
